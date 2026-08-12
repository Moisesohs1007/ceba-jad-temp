-- =====================================================================
-- CEBA + EBR: Compatibilidad con CICLOS y varias aulas por docente
-- NUEVOS CAMPOS: alumnos.ciclo, usuarios.tutor_aulas (JSON), usuarios.grados_asignados_json
-- MANTIENE 100% COMPATIBILIDAD hacia atras con tutor_grado/tutor_seccion (EBR)
-- =====================================================================

-- 1. Alumnos: campo ciclo (CEBA: INICIAL / INTERMEDIO / AVANZADO | EBR: PRIMARIA / SECUNDARIA)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='alumnos' AND column_name='ciclo') THEN
    ALTER TABLE public.alumnos ADD COLUMN ciclo TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

-- 2. Usuarios: tutor_aulas_json (CEBA: varias aulas del tutor con ciclo)
--    Formato: [{"ciclo":"INICIAL","grado":"1","seccion":"A"}, {"ciclo":"INTERMEDIO","grado":"3","seccion":"A"}]
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usuarios' AND column_name='tutor_aulas_json') THEN
    ALTER TABLE public.usuarios ADD COLUMN tutor_aulas_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- 3. Usuarios: grados_asignados_json (profesores polivalentes no tutores: Ingles, Religion)
--    Formato igual que tutor_aulas_json
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='usuarios' AND column_name='grados_asignados_json') THEN
    ALTER TABLE public.usuarios ADD COLUMN grados_asignados_json JSONB NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- 4. Alumnos: indice para filtro ciclo+aula+colegio (ahorra mucho en plan gratis)
CREATE INDEX IF NOT EXISTS idx_alumnos_ciclo_grado_seccion ON public.alumnos(colegio_id, ciclo, grado, seccion);

-- 5. Actualizar la funcion de chat _chat_staff_may_talk_alumno para que soporte tutor_aulas_json y alumnos.ciclo
CREATE OR REPLACE FUNCTION public._chat_staff_may_talk_alumno(p_staff_uid UUID, p_alumno_id TEXT)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
  v_colegio TEXT;
  v_rol     TEXT;
  v_al_gs   RECORD;
  v_tutor_aulas JSONB;
  v_asig_aulas  JSONB;
  v_match   boolean;
BEGIN
  IF p_staff_uid IS NULL THEN RETURN false; END IF;
  v_colegio := public.auth_colegio_id();
  v_rol     := public.auth_rol(p_staff_uid);

  -- 1. Admin / Director / Coordinador → permiso total
  IF public._isAdminDirectorOrCoord(v_rol) THEN RETURN true; END IF;

  -- 2. Si no hay alumno → permitido solo a admin/director/coord (ya cubierto arriba)
  IF COALESCE(p_alumno_id,'') = '' THEN RETURN false; END IF;

  -- 3. Cargar datos del alumno (ciclo, grado, seccion)
  BEGIN
    SELECT a.ciclo, a.grado, a.seccion
      INTO STRICT v_al_gs
      FROM public.alumnos a
      WHERE a.id = p_alumno_id AND a.colegio_id = v_colegio
      LIMIT 1;
  EXCEPTION WHEN NO_DATA_FOUND THEN RETURN false; END;

  -- 4. Cargar listas JSON de aulas del staff
  SELECT COALESCE(u.tutor_aulas_json,'[]'::jsonb),
         COALESCE(u.grados_asignados_json,'[]'::jsonb)
    INTO v_tutor_aulas, v_asig_aulas
    FROM public.usuarios u
    WHERE u.id = p_staff_uid AND u.colegio_id = v_colegio;
  IF NOT FOUND THEN RETURN false; END IF;

  -- 5. Si ES TUTOR: validar contra (a) tutor_aulas_json, y (b) fallback legacy tutor_grado/tutor_seccion
  -- Match helper: busca en un JSON array de aulas si coincide ciclo+grado+seccion (con ciclo opcional '')
  DECLARE
    v_norm_ciclo TEXT := btrim(COALESCE(v_al_gs.ciclo,''));
    v_norm_grado TEXT := btrim(COALESCE(v_al_gs.grado,''));
    v_norm_secc  TEXT := btrim(COALESCE(v_al_gs.seccion,''));
    v_leg_grado  TEXT;
    v_leg_secc   TEXT;
    v_leg_es_tut boolean;
  BEGIN
    -- 5a) Match en JSON aulas (ciclo, grado, seccion)
    v_match := false;
    IF v_norm_grado <> '' AND v_norm_secc <> '' THEN
      SELECT true INTO v_match
        FROM jsonb_array_elements(COALESCE(v_tutor_aulas,'[]'::jsonb) || COALESCE(v_asig_aulas,'[]'::jsonb)) AS el
        WHERE btrim(COALESCE(el->>'ciclo','')) IN (v_norm_ciclo, '')
          AND btrim(COALESCE(el->>'grado','')) = v_norm_grado
          AND btrim(COALESCE(el->>'seccion','')) = v_norm_secc
        LIMIT 1;
    END IF;
    v_match := COALESCE(v_match, false);
    IF v_match THEN RETURN true; END IF;

    -- 5b) Fallback: legacy tutor_grado / tutor_seccion si no hay JSON
    SELECT COALESCE(es_tutor,false),
           btrim(COALESCE(tutor_grado,'')),
           btrim(COALESCE(tutor_seccion,''))
      INTO v_leg_es_tut, v_leg_grado, v_leg_secc
      FROM public.usuarios u
      WHERE u.id = p_staff_uid AND u.colegio_id = v_colegio;
    IF v_leg_es_tut = true
       AND v_leg_grado <> '' AND v_leg_secc <> ''
       AND v_leg_grado = v_norm_grado
       AND v_leg_secc = v_norm_secc THEN
      RETURN true;
    END IF;

    -- 6. Resto staff (profesor no tutor, psicologo, auxiliar) → TRUE si su asignaciones JSON contiene el aula
    --    (admin ya devuelto al principio; este OR da flexibilidad a los profesores de curso)
    IF v_rol IN ('profesor','psicologo','auxiliar','portero') THEN
      -- Envio libre a los alumnos de los grados asignados (lo mismo que restriccion UI hoy)
      v_match := false;
      IF jsonb_array_length(COALESCE(v_asig_aulas,'[]'::jsonb)) = 0 THEN
        RETURN true;  -- sin restriccion explicita → habilitado (igual que antes)
      ELSE
        SELECT true INTO v_match
          FROM jsonb_array_elements(v_asig_aulas) AS el
          WHERE btrim(COALESCE(el->>'ciclo','')) IN (v_norm_ciclo, '')
            AND (btrim(COALESCE(el->>'grado','')) = v_norm_grado OR btrim(COALESCE(el->>'grado','')) = '')
            AND (btrim(COALESCE(el->>'seccion','')) = v_norm_secc OR btrim(COALESCE(el->>'seccion','')) = '')
          LIMIT 1;
        RETURN COALESCE(v_match, false);
      END IF;
    END IF;

    RETURN false;
  END;
END;
$func$;

-- 6. Tabla chat_conversaciones: ciclo
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='chat_conversaciones' AND column_name='ciclo') THEN
    ALTER TABLE public.chat_conversaciones ADD COLUMN ciclo TEXT NOT NULL DEFAULT '';
  END IF;
END $$;

-- 7. Tabla registros (asistencia): ciclo (para filtros CEBA)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='registros' AND column_name='tipo') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='registros' AND column_name='ciclo') THEN
      ALTER TABLE public.registros ADD COLUMN ciclo TEXT NOT NULL DEFAULT '';
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_registros_ciclo_grado_seccion ON public.registros(colegio_id, ciclo, grado, seccion, fecha DESC);

-- 8. Helpers SQL de normalizacion de ciclo para usar en el front desde SQL si hace falta
CREATE OR REPLACE FUNCTION public._canon_ciclo(c TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $func$
SELECT CASE upper(btrim(COALESCE(c,'')))
  WHEN 'INICIAL'        THEN 'INICIAL'
  WHEN 'CICLO INICIAL'  THEN 'INICIAL'
  WHEN 'INTERMEDIO'     THEN 'INTERMEDIO'
  WHEN 'CICLO INTERMEDIO' THEN 'INTERMEDIO'
  WHEN 'AVANZADO'       THEN 'AVANZADO'
  WHEN 'CICLO AVANZADO' THEN 'AVANZADO'
  WHEN 'PRIMARIA'       THEN 'PRIMARIA'
  WHEN 'SECUNDARIA'     THEN 'SECUNDARIA'
  WHEN 'EBR PRIMARIA'   THEN 'PRIMARIA'
  WHEN 'EBR SECUNDARIA' THEN 'SECUNDARIA'
  ELSE btrim(COALESCE(c,''))
END;
$func$;
