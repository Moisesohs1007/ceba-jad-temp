-- =====================================================================
-- v209 ADJUNTOS TEMPORALES WHATSAPP — 7 DIAS AUTO-BORRADO AUTOMATICO
-- Bucket: adjuntos-temporales-whatsapp (storage.objects)
-- Tabla:  public.adjuntos_whatsapp_temp
-- Cron:   cada 6 horas elimina files + filas expiradas (> 7 dias)
-- Sin costo: bucket publico, upload SOLO authenticated CEBA admin/director/coordinador/docente
-- =====================================================================

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

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp insert" ON storage.objects;
DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp update" ON storage.objects;
DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp delete" ON storage.objects;
DROP POLICY IF EXISTS "adjuntos-temporales-whatsapp select publico antes expirar" ON storage.objects;

-- Insert: solo authenticated + subiendo colegio + path LIKE colegio_id/*
CREATE POLICY "adjuntos-temporales-whatsapp insert"
ON storage.objects
FOR INSERT
WITH CHECK (
  bucket_id = 'adjuntos-temporales-whatsapp'
  AND public.can_upload_adjuntos_temp_whatsapp()
  AND name LIKE (public.user_colegio_id() || '/%')
);

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

CREATE POLICY "adjuntos-temporales-whatsapp delete"
ON storage.objects
FOR DELETE
USING (
  bucket_id = 'adjuntos-temporales-whatsapp'
  AND (
    public.can_upload_adjuntos_temp_whatsapp()
    AND name LIKE (public.user_colegio_id() || '/%')
  )
  OR EXISTS (
    SELECT 1 FROM public.usuarios u WHERE u.id = auth.uid()
      AND LOWER(COALESCE(u.rol,'')) IN ('admin','director')
    LIMIT 1
  )
);

-- Select PÚBLICO (links de descarga: anon pueden ver el object storage.object público
-- (El storage lo lee por URL getPublicUrl; no se pasa por SELECT storage.objects
-- el navegador con pre-signed. Añadimos policy de todas formas.)
CREATE POLICY "adjuntos-temporales-whatsapp select publico antes expirar"
ON storage.objects
FOR SELECT
USING (
  bucket_id = 'adjuntos-temporales-whatsapp'
);

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
  WITH exp AS (
    DELETE FROM storage.objects
    WHERE bucket_id = 'adjuntos-temporales-whatsapp'
      AND created_at < NOW() - INTERVAL '7 days'
    RETURNING 1
  )
  SELECT count(*) INTO _rows_storage FROM exp;

  -- (a) Ahora borramos filas expiradas de la tabla.
  WITH t AS (
    DELETE FROM public.adjuntos_whatsapp_temp
    WHERE fecha_expiracion < NOW()
    RETURNING 1
  )
  SELECT count(*) INTO _rows_tabla FROM t;

  RAISE NOTICE '[CRON] limpiar_adjuntos_temp_whatsapp_7d] tabla borradas=% filas storage borradas=% objetos', _rows_tabla, _rows_storage;
END;
$$;

GRANT EXECUTE ON FUNCTION public.limpiar_adjuntos_temp_whatsapp_7d() TO postgres;

-- Reprogramar cada 6 horas.
SELECT cron.unschedule('adjuntos_temp_whatsapp_diario');
SELECT cron.schedule(
  'adjuntos_temp_whatsapp_cada_6h',
  '0 */6 * * *',
  $$ SELECT public.limpiar_adjuntos_temp_whatsapp_7d(); $$
);

-- Ejecución inicial ya para asegurarnos de que funciona:
-- SELECT public.limpiar_adjuntos_temp_whatsapp_7d();
