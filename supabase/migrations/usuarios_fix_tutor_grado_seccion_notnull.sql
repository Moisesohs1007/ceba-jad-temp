-- ============================================================
-- Asegurar que usuarios.tutor_grado / tutor_seccion acepten
-- valores vacíos y tengan DEFAULT '' (soluciona error
-- "tutor_grado NOT NULL violates not-null" al editar usuarios
-- que no son tutores / no son profesores desde el panel admin).
-- ============================================================

DO $$
BEGIN
  -- Asegurar DEFAULT ''
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='usuarios' AND column_name='tutor_grado'
      AND column_default IS DISTINCT FROM '''''::text'
  ) THEN
    ALTER TABLE public.usuarios ALTER COLUMN tutor_grado SET DEFAULT '';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='usuarios' AND column_name='tutor_seccion'
      AND column_default IS DISTINCT FROM '''''::text'
  ) THEN
    ALTER TABLE public.usuarios ALTER COLUMN tutor_seccion SET DEFAULT '';
  END IF;

  -- Si hubiera filas antiguas con NULL, normalizarlas a ''
  UPDATE public.usuarios SET tutor_grado = '' WHERE tutor_grado IS NULL;
  UPDATE public.usuarios SET tutor_seccion = '' WHERE tutor_seccion IS NULL;

  -- Asegurar que NO es NOT NULL (por si una migración antigua lo forzó sin default)
  BEGIN
    ALTER TABLE public.usuarios ALTER COLUMN tutor_grado DROP NOT NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER TABLE public.usuarios ALTER COLUMN tutor_seccion DROP NOT NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Volver a establecer NOT NULL ahora que todas las filas tienen valor y DEFAULT ''
  BEGIN
    ALTER TABLE public.usuarios ALTER COLUMN tutor_grado SET NOT NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  BEGIN
    ALTER TABLE public.usuarios ALTER COLUMN tutor_seccion SET NOT NULL;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END
$$;
