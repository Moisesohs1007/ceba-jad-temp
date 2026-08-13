-- Modalidad educativa por colegio (venta: EBR / CEBA / EBA)
-- Tabla: colegios

ALTER TABLE public.colegios
  ADD COLUMN IF NOT EXISTS modalidad_educativa TEXT NOT NULL DEFAULT '';

-- Valor por defecto para el colegio actual CEBA JAD
UPDATE public.colegios
   SET modalidad_educativa = 'CEBA'
 WHERE id IN (SELECT current_setting('app.current_colegio_id', true) AS cid)
   AND COALESCE(modalidad_educativa, '') = '';

-- Fallback general: si no hay current_setting, marcar los que no tienen modalidad
DO $$
BEGIN
  UPDATE public.colegios
     SET modalidad_educativa = 'CEBA'
   WHERE COALESCE(modalidad_educativa, '') = ''
     AND EXISTS (SELECT 1 FROM public.alumnos a WHERE a.colegio_id = public.colegios.id AND LOWER(a.ciclo) IN ('inicial','intermedio','avanzado'));

  UPDATE public.colegios
     SET modalidad_educativa = 'EBR'
   WHERE COALESCE(modalidad_educativa, '') = ''
     AND modalidad_educativa NOT IN ('CEBA','EBA');
END $$;

CREATE INDEX IF NOT EXISTS idx_colegios_modalidad ON public.colegios(modalidad_educativa);
