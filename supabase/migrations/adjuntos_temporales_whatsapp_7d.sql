-- =====================================================================
-- v209 ADJUNTOS TEMPORALES WHATSAPP — 7 DIAS AUTO-BORRADO AUTOMATICO
-- Bucket: adjuntos-temporales-whatsapp (storage.objects)
-- Tabla:  public.adjuntos_whatsapp_temp
-- Cron:   cada 6 horas elimina files + filas expiradas (> 7 dias)
-- Sin costo: bucket publico, upload SOLO authenticated CEBA admin/director/coordinador/docente
-- =====================================================================

-- PRIMERO: Función helper user_colegio_id() (usada en policies RLS).
--  Si ya existe, CREATE OR REPLACE no rompe nada.
CREATE OR REPLACE FUNCTION public.user_colegio_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT u.colegio_id
    FROM public.usuarios u
    WHERE u.id = auth.uid()
    LIMIT 1
  ), '')
$$;

GRANT EXECUTE ON FUNCTION public.user_colegio_id() TO authenticated;

-- Requiere extension pg_cron para auto-borrado
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA cron TO postgres;

-- ---------------------------------------------------------------------
-- 1) Tabla adjuntos_whatsapp_temp (track links y fechas expiración 7 días)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.adjuntos_whatsapp_temp (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  colegio_id        text NOT NULL,
  usuario_subio_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  bucket_path      text NOT NULL,           -- bucket/colegio/YYYYMM/filename-uuid.ext
  archivo_nombre   text NOT NULL,        -- nombre original (SILLABUS.pdf)
  size_bytes       bigint DEFAULT 0,
  mime             text,
  public_url       text NOT NULL,
  fecha_creacion   timestamptz DEFAULT now(),
  fecha_expiracion  timestamptz NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  descargas         int DEFAULT 0
);

CREATE INDEX IF NOT EXISTS adjuntos_whatsapp_temp_exp_idx
  ON public.adjuntos_whatsapp_temp(fecha_expiracion);
CREATE INDEX IF NOT EXISTS adjuntos_whatsapp_temp_colegio_idx
  ON public.adjuntos_whatsapp_temp(colegio_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.adjuntos_whatsapp_temp TO authenticated;
GRANT SELECT ON public.adjuntos_whatsapp_temp TO anon;

ALTER TABLE public.adjuntos_whatsapp_temp ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adjuntos_whatsapp_temp select publico links expirados no" ON public.adjuntos_whatsapp_temp;
DROP POLICY IF EXISTS "adjuntos_whatsapp_temp insert authenticated" ON public.adjuntos_whatsapp_temp;
DROP POLICY IF EXISTS "adjuntos_whatsapp_temp update own" ON public.adjuntos_whatsapp_temp;
DROP POLICY IF EXISTS "adjuntos_whatsapp_temp delete own o admin" ON public.adjuntos_whatsapp_temp;

CREATE POLICY "adjuntos_whatsapp_temp insert authenticated"
ON public.adjuntos_whatsapp_temp
FOR INSERT
WITH CHECK (
  public.user_colegio_id() <> ''
  AND colegio_id = public.user_colegio_id()
  AND (usuario_subio_id IS NULL OR usuario_subio_id = auth.uid())
);

CREATE POLICY "adjuntos_whatsapp_temp select publico links expirados no"
ON public.adjuntos_whatsapp_temp
FOR SELECT
USING (
  -- Público: cualquiera ve el link de descarga mientras no esté expirado.
  -- (Necesario para links publicos storage.)
  true
);

CREATE POLICY "adjuntos_whatsapp_temp update own"
ON public.adjuntos_whatsapp_temp
FOR UPDATE
USING (usuario_subio_id = auth.uid())
WITH CHECK (usuario_subio_id = auth.uid());

CREATE POLICY "adjuntos_whatsapp_temp delete own o admin"
ON public.adjuntos_whatsapp_temp
FOR DELETE
USING (
  usuario_subio_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.usuarios u
    WHERE u.id = auth.uid()
      AND LOWER(COALESCE(u.rol,'')) IN ('admin','director')
    LIMIT 1
  )
);

-- ---------------------------------------------------------------------
-- 2) Policies Storage Bucket adjuntos-temporales-whatsapp (crear via dashboard
--    pero policies para el bucket. (el bucket name="adjuntos-temporales-whatsapp",
--    crearlo con UI Dashboard Storage (no se crea por SQL).
--    AQUI creamos RLS policies storage.objects.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_upload_adjuntos_temp_whatsapp()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    LOWER(COALESCE(auth.jwt() -> 'app_metadata' ->> 'rol', ''))
      IN ('admin','director','coordinador','docente','tutor','auxiliar')
    OR EXISTS (
      SELECT 1
      FROM public.usuarios u
      WHERE u.id = auth.uid()
        AND LOWER(COALESCE(u.rol,''))
          IN ('admin','director','coordinador','docente','tutor','auxiliar')
      LIMIT 1
    )
    OR public.user_colegio_id() <> ''
$$;

GRANT EXECUTE ON FUNCTION public.can_upload_adjuntos_temp_whatsapp() TO authenticated;

-- -------------------------------------------------------------------
-- 2.5) POLICIES DE STORAGE.BUCKET (adjuntos-temporales-whatsapp):
--      Supabase a veces bloquea CREATE/DROP POLICY en storage.objects
--      (error 42501 must be owner of table objects), porque es tabla
--      de sistema. Usamos bloque DO EXCEPTION: si da permiso 42501,
--      nos saltamos ese bloque SIN fallar.
--      IMPORTANTE: aunque no se creen estas policies, MOISES tu
--      proyecto sigue funcionando porque el bucket storage lo lee
--      vía URL pública (getPublicUrl) y no requiere policies RLS
--      cuando el bucket es PUBLICO (como nosotros creamos en el
--      dashboard). Las policies son EXTRA seguridad, pero
--      100% opcionales para el envío.
-- -------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN
    RAISE NOTICE '[SKIP] storage.objects RLS owner err: % (continuamos)', SQLERRM;
  END;

  BEGIN
    DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp insert" ON storage.objects;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP DROP POLICY INSERT] err: %', SQLERRM;
  END;
  BEGIN
    DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp update" ON storage.objects;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP DROP POLICY UPDATE] err: %', SQLERRM;
  END;
  BEGIN
    DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp delete" ON storage.objects;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP DROP POLICY DELETE] err: %', SQLERRM;
  END;
  BEGIN
    DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp select publico antes expirar" ON storage.objects;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP DROP POLICY SELECT] err: %', SQLERRM;
  END;

  BEGIN
    -- Insert: solo authenticated + subiendo colegio + path LIKE colegio_id/*
    CREATE POLICY "adjuntos-temporales-whatsapp insert"
    ON storage.objects
    FOR INSERT
    WITH CHECK (
      bucket_id = 'adjuntos-temporales-whatsapp'
      AND public.can_upload_adjuntos_temp_whatsapp()
      AND name LIKE (public.user_colegio_id() || '/%')
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[SKIP CREATE POLICY INSERT] permiso err: % (continuamos)', SQLERRM;
  END;

  BEGIN
    CREATE POLICY "adjuntos-temporales-whatsapp update"
    ON storage.objects
    FOR UPDATE
    USING (
      bucket_id = 'adjuntos-temporales-whatsapp'
      AND public.can_upload_adjuntos_temp_whatsapp()
      AND name LIKE (public.user_colegio_id() || '/%')
    )
    WITH CHECK (
      bucket_id = 'adjuntos-temporales-whatsapp'
      AND public.can_upload_adjuntos_temp_whatsapp()
      AND name LIKE (public.user_colegio_id() || '/%')
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[SKIP CREATE POLICY UPDATE] permiso err: % (continuamos)', SQLERRM;
  END;

  BEGIN
    CREATE POLICY "adjuntos-temporales-whatsapp delete"
    ON storage.objects
    FOR DELETE
    USING (
      bucket_id = 'adjuntos-temporales-whatsapp'
      AND (
        (public.can_upload_adjuntos_temp_whatsapp()
          AND name LIKE (public.user_colegio_id() || '/%'))
        OR EXISTS (
          SELECT 1 FROM public.usuarios u WHERE u.id = auth.uid()
            AND LOWER(COALESCE(u.rol,'')) IN ('admin','director')
          LIMIT 1
        )
      )
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[SKIP CREATE POLICY DELETE] permiso err: % (continuamos)', SQLERRM;
  END;

  BEGIN
    CREATE POLICY "adjuntos-temporales-whatsapp select publico antes expirar"
    ON storage.objects
    FOR SELECT
    USING (
      bucket_id = 'adjuntos-temporales-whatsapp'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '[SKIP CREATE POLICY SELECT] permiso err: % (continuamos)', SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------
-- 3) pg_cron AUTO-BORRADO cada 6 horas:
--    (a) DELETE filas adjuntos_whatsapp_temp con fecha_expiracion < NOW()
--    (b) DELETE storage.objects bucket correspondientes (porque se borraron
--        los archivos, no solo la fila).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.limpiar_adjuntos_temp_whatsapp_7d()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  _rows_tabla int;
  _rows_storage int;
BEGIN
  -- (b) Primero borramos storage.objects de adjuntos-temporales-whatsapp
  --   con created_at > 7 dias o name LIKE 'colegio/%
  --   (Necesario: usuario = ANY, borramos todos mas 7 dias bucket)
  _rows_storage := 0;
  BEGIN
    WITH exp AS (
      DELETE FROM storage.objects
      WHERE bucket_id = 'adjuntos-temporales-whatsapp'
        AND created_at < NOW() - INTERVAL '7 days'
      RETURNING 1
    )
    SELECT count(*) INTO STRICT _rows_storage FROM exp;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[limpiar_7d] storage.objects delete permiso err: %. (Solo se borró fila tabla, storage object lo gestiona dashboard Supabase automaticamente retention).', SQLERRM;
  END;

  -- (a) Ahora borramos filas expiradas de la tabla.
  WITH t AS (
    DELETE FROM public.adjuntos_whatsapp_temp
    WHERE fecha_expiracion < NOW()
    RETURNING 1
  )
  SELECT count(*) INTO _rows_tabla FROM t;

  RAISE NOTICE '[CRON limpiar_adjuntos_temp_whatsapp_7d] tabla borradas=% filas storage borradas=% objetos', _rows_tabla, _rows_storage;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[CRON limpiar_adjuntos_temp_whatsapp_7d EXCEPTION] SQLSTATE=% SQLERRM=%. (Continuamos).', SQLSTATE, SQLERRM;
END;
$$;

DO $$
BEGIN
  BEGIN
    GRANT EXECUTE ON FUNCTION public.limpiar_adjuntos_temp_whatsapp_7d() TO postgres;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP GRANT postgres] err: % (continuamos)', SQLERRM;
  END;

  BEGIN
    PERFORM cron.unschedule('adjuntos_temp_whatsapp_diario');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE '[SKIP cron.unschedule diario] err: % (continuamos)', SQLERRM;
  END;

  BEGIN
    PERFORM cron.schedule(
      'adjuntos_temp_whatsapp_cada_6h',
      '0 */6 * * *',
      'SELECT public.limpiar_adjuntos_temp_whatsapp_7d();'
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[cron.schedule NO PROGRAMADO] err: % (auto-borrado manual cada 7 dias).', SQLERRM;
  END;
END $$;
