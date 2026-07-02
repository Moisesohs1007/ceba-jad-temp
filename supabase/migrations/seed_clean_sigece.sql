BEGIN;

CREATE OR REPLACE FUNCTION public.get_colegio_public(p_colegio_id TEXT)
RETURNS TABLE (
  id TEXT,
  nombre TEXT,
  anio TEXT,
  eslogan TEXT,
  logo_url TEXT,
  apo_domain TEXT,
  niveles JSONB,
  grados JSONB,
  secciones JSONB,
  banner_imagenes JSONB,
  rol_examenes_config JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.nombre,
    c.anio,
    c.eslogan,
    c.logo_url,
    c.apo_domain,
    c.niveles,
    c.grados,
    c.secciones,
    c.banner_imagenes,
    c.rol_examenes_config
  FROM public.colegios c
  WHERE c.id = p_colegio_id
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION public.get_colegio_public(TEXT) TO anon, authenticated;

INSERT INTO public.colegios (
  id, nombre, anio, eslogan, logo_url, apo_domain, niveles, grados, secciones, banner_imagenes, rol_examenes_config
) VALUES (
  'sigece',
  'CEBA JAD',
  '2026',
  '',
  '',
  'apo.jad.pe',
  '[]'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS restringir BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS asignaciones JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS usuarios_colegio_id_id_uniq
ON public.usuarios (colegio_id, id);

COMMIT;

