WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY colegio_id, alumno_id, fecha, tipo
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.registros
)
DELETE FROM public.registros r
USING ranked
WHERE r.ctid = ranked.ctid
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS registros_colegio_alumno_fecha_tipo_uniq
ON public.registros (colegio_id, alumno_id, fecha, tipo);
