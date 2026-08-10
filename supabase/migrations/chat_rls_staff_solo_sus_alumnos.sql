-- ============================================================
-- CHAT: Blindar INSERT en chat_conversaciones para que el
-- TUTOR de aula solo pueda abrir conversaciones con alumnos
-- de SU grado + sección. Admin/Director/Coord siguen viendo
-- todos los casos.
-- ============================================================

-- Helper: ¿El staff actual tiene permiso para hablar con este alumno?
CREATE OR REPLACE FUNCTION public._chat_staff_may_talk_alumno(alumno_id text)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_rol           TEXT;
  v_al_gs         RECORD;
  v_sta           RECORD;
BEGIN
  -- 0. Si no es staff, false (no debe pasar, policies anteriores filtran)
  IF NOT public.is_staff() OR public.auth_rol() IS NULL OR auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;

  v_rol := public.auth_rol();

  -- 1. Admin / Director / Coordinador: permiso total
  IF v_rol IN ('admin','director','coordinador') THEN
    RETURN TRUE;
  END IF;

  -- 2. Si no hay alumno (ej: scope ADMIN_APOD): solo admin, ya prohibido arriba
  IF alumno_id IS NULL OR btrim(alumno_id) = '' THEN
    RETURN FALSE;
  END IF;

  -- 3. Datos del alumno: grado / seccion
  BEGIN
    SELECT grado, seccion INTO STRICT v_al_gs
    FROM public.alumnos
    WHERE id = alumno_id AND colegio_id = public.auth_colegio_id()
    LIMIT 1;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RETURN FALSE;
  END;

  -- 4. Datos del staff actual (usuarios.esTutor, tutorGrado, tutorSeccion)
  BEGIN
    SELECT es_tutor, tutor_grado, tutor_seccion, cargo, rol INTO STRICT v_sta
    FROM public.usuarios
    WHERE id = auth.uid() AND colegio_id = public.auth_colegio_id()
    LIMIT 1;
  EXCEPTION WHEN NO_DATA_FOUND THEN
    RETURN FALSE;
  END;

  -- 5. Si es TUTOR (es_tutor = true): solo si su aula coincide
  IF COALESCE(v_sta.es_tutor::boolean, false) = true THEN
    RETURN (
      btrim(COALESCE(v_sta.tutor_grado,'')) = btrim(COALESCE(v_al_gs.grado,'')) AND
      btrim(COALESCE(v_sta.tutor_seccion,'')) = btrim(COALESCE(v_al_gs.seccion,''))
    );
  END IF;

  -- 6. Resto de staff (profesor, psicologo, auxiliar, portero): permitimos
  --    (su restricción de grados/secciones la maneja la UI. Si quieres
  --     endurecer después, añade aquí check por grados asignados.)
  RETURN TRUE;
END;
$$;

-- Actualizamos la policy INSERT de staff para añadir esta comprobación
DROP POLICY IF EXISTS chat_conv_insert_staff ON public.chat_conversaciones;

CREATE POLICY chat_conv_insert_staff ON public.chat_conversaciones FOR INSERT
  WITH CHECK (
    (colegio_id = public.auth_colegio_id()) AND
    public.is_staff() AND
    staff_user_id = auth.uid() AND
    (
      (scope_type IN ('TUTOR_ALUMNO','ALUMNO_GENERAL') AND alumno_id <> '' AND public._chat_staff_may_talk_alumno(alumno_id)) OR
      (scope_type = 'ADMIN_APOD' AND public.auth_rol() IN ('admin','director','coordinador'))
    )
  );

-- También la policy INSERT del apoderado: solo puede abrir conversación
-- con alumnos SUYOS (el alumno_id debe estar asociado a su cuenta).
-- Como validación sencilla: el apoderado (auth.uid()) debe estar vinculado
-- al alumno, bien porque existe una relación en alumnos, o bien por
-- app_metadata (email virtual DNI_alumno@apo.marello.pe, o por el id del
-- alumno). Aceptamos ambos:
--  a) Si la tabla alumnos tiene apoderado_auth_uid (columna opcional),
--     debería coincidir.
--  b) Si no, damos permiso y se filtra por UI.
DROP POLICY IF EXISTS chat_conv_insert_apoderado ON public.chat_conversaciones;

CREATE OR REPLACE FUNCTION public._chat_apoderado_may_talk_alumno(alumno_id text)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_al  RECORD;
BEGIN
  IF NOT public.is_apoderado() OR auth.uid() IS NULL OR alumno_id IS NULL THEN
    RETURN FALSE;
  END IF;
  -- Si existe columna apoderado_auth_uid en alumnos → validar (por si la migración
  -- futura la agrega). De lo contrario, aprobamos por compatibilidad.
  BEGIN
    EXECUTE 'SELECT apoderado_auth_uid FROM public.alumnos WHERE id=$1 AND colegio_id=$2 LIMIT 1'
      INTO v_al USING alumno_id, public.auth_colegio_id();
    IF FOUND AND v_al.apoderado_auth_uid IS NOT NULL THEN
      RETURN (v_al.apoderado_auth_uid = auth.uid());
    END IF;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;
  RETURN TRUE;
END;
$$;

CREATE POLICY chat_conv_insert_apoderado ON public.chat_conversaciones FOR INSERT
  WITH CHECK (
    (colegio_id = public.auth_colegio_id()) AND
    public.is_apoderado() AND
    apoderado_auth_uid = auth.uid() AND
    scope_type IN ('TUTOR_ALUMNO','ALUMNO_GENERAL') AND
    alumno_id <> '' AND
    public._chat_apoderado_may_talk_alumno(alumno_id)
  );
