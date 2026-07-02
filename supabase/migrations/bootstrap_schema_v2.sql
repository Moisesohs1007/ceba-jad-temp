BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.auth_colegio_id()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'colegio_id', '')
$$;

CREATE OR REPLACE FUNCTION public.auth_rol()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'rol', '')
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT auth_rol() IN ('admin','director','coordinador','profesor','psicologo','auxiliar','portero')
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT auth_rol() = 'admin'
$$;

CREATE OR REPLACE FUNCTION public.is_apoderado()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT auth_rol() = 'apoderado'
$$;

CREATE OR REPLACE FUNCTION public.auth_alumno_id()
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alumno_id TEXT;
  v_rol       TEXT;
  v_email     TEXT;
BEGIN
  v_alumno_id := COALESCE(auth.jwt() -> 'app_metadata' ->> 'alumno_id', '');
  IF v_alumno_id <> '' THEN
    RETURN v_alumno_id;
  END IF;

  v_rol := COALESCE(auth.jwt() -> 'app_metadata' ->> 'rol', '');
  IF v_rol <> 'apoderado' THEN
    RETURN '';
  END IF;

  v_email := COALESCE(auth.jwt() ->> 'email', '');
  IF v_email LIKE '%@apo.marello.pe' THEN
    RETURN split_part(v_email, '@', 1);
  END IF;

  RETURN '';
END;
$$;

CREATE TABLE IF NOT EXISTS public.colegios (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL DEFAULT '',
  anio TEXT NOT NULL DEFAULT '',
  eslogan TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  apo_domain TEXT NOT NULL DEFAULT '',
  niveles JSONB NOT NULL DEFAULT '[]'::jsonb,
  grados JSONB NOT NULL DEFAULT '{}'::jsonb,
  secciones JSONB NOT NULL DEFAULT '[]'::jsonb,
  banner_imagenes JSONB NOT NULL DEFAULT '[]'::jsonb,
  rol_examenes_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  factiliza_token TEXT NOT NULL DEFAULT '',
  factiliza_instancia TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.usuarios (
  id UUID PRIMARY KEY,
  colegio_id TEXT NOT NULL REFERENCES public.colegios(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL DEFAULT '',
  cargo TEXT NOT NULL DEFAULT '',
  rol TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  es_tutor BOOLEAN NOT NULL DEFAULT false,
  tutor_grado TEXT NOT NULL DEFAULT '',
  tutor_seccion TEXT NOT NULL DEFAULT '',
  incidentes_dia_lectura BOOLEAN NOT NULL DEFAULT false,
  permisos_extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usuarios_colegio_idx ON public.usuarios (colegio_id);

CREATE TABLE IF NOT EXISTS public.alumnos (
  colegio_id TEXT NOT NULL REFERENCES public.colegios(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  nombres TEXT NOT NULL DEFAULT '',
  apellidos TEXT NOT NULL DEFAULT '',
  grado TEXT NOT NULL DEFAULT '',
  seccion TEXT NOT NULL DEFAULT '',
  turno TEXT NOT NULL DEFAULT '',
  limite TEXT NOT NULL DEFAULT '08:00',
  foto TEXT NOT NULL DEFAULT '',
  apoderado_nombres TEXT NOT NULL DEFAULT '',
  apoderado_apellidos TEXT NOT NULL DEFAULT '',
  telefono TEXT NOT NULL DEFAULT '',
  apoderado2_nombres TEXT NOT NULL DEFAULT '',
  apoderado2_apellidos TEXT NOT NULL DEFAULT '',
  telefono2 TEXT NOT NULL DEFAULT '',
  correo_apoderado TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (colegio_id, id)
);

CREATE TABLE IF NOT EXISTS public.registros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  colegio_id TEXT NOT NULL,
  alumno_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('INGRESO','SALIDA')),
  fecha DATE NOT NULL,
  hora TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'Puntual' CHECK (estado IN ('A tiempo','Tardanza','Salida normal','Sin ingreso previo','Puntual')),
  nombre TEXT NOT NULL DEFAULT '',
  grado TEXT NOT NULL DEFAULT '',
  seccion TEXT NOT NULL DEFAULT '',
  turno TEXT NOT NULL DEFAULT '',
  registrado_por TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT registros_colegio_id_fkey FOREIGN KEY (colegio_id) REFERENCES public.colegios(id) ON DELETE CASCADE,
  CONSTRAINT registros_colegio_id_alumno_id_fkey FOREIGN KEY (colegio_id, alumno_id) REFERENCES public.alumnos(colegio_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS registros_colegio_alumno_fecha_tipo_uniq
ON public.registros (colegio_id, alumno_id, fecha, tipo);

ALTER TABLE public.colegios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alumnos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS colegios_read ON public.colegios;
CREATE POLICY colegios_read ON public.colegios FOR SELECT
  USING (id = auth_colegio_id() AND is_staff());

DROP POLICY IF EXISTS colegios_write ON public.colegios;
CREATE POLICY colegios_write ON public.colegios FOR ALL
  USING (id = auth_colegio_id() AND is_admin());

DROP POLICY IF EXISTS usuarios_read_staff ON public.usuarios;
CREATE POLICY usuarios_read_staff ON public.usuarios FOR SELECT
  USING (colegio_id = auth_colegio_id() AND is_staff());

DROP POLICY IF EXISTS usuarios_update_admin_director ON public.usuarios;
CREATE POLICY usuarios_update_admin_director ON public.usuarios FOR UPDATE
  USING (colegio_id = auth_colegio_id() AND auth_rol() IN ('admin','director'))
  WITH CHECK (colegio_id = auth_colegio_id() AND auth_rol() IN ('admin','director'));

DROP POLICY IF EXISTS alumnos_apoderado_read ON public.alumnos;
CREATE POLICY alumnos_apoderado_read ON public.alumnos FOR SELECT
  USING (colegio_id = auth_colegio_id() AND is_apoderado() AND id = auth_alumno_id());

DROP POLICY IF EXISTS alumnos_staff_read ON public.alumnos;
CREATE POLICY alumnos_staff_read ON public.alumnos FOR SELECT
  USING (colegio_id = auth_colegio_id() AND is_staff());

DROP POLICY IF EXISTS alumnos_admin_write ON public.alumnos;
CREATE POLICY alumnos_admin_write ON public.alumnos FOR ALL
  USING (colegio_id = auth_colegio_id() AND auth_rol() IN ('admin','director','coordinador'))
  WITH CHECK (colegio_id = auth_colegio_id() AND auth_rol() IN ('admin','director','coordinador'));

DROP POLICY IF EXISTS registros_apoderado_read ON public.registros;
CREATE POLICY registros_apoderado_read ON public.registros FOR SELECT
  USING (colegio_id = auth_colegio_id() AND is_apoderado() AND alumno_id = auth_alumno_id());

DROP POLICY IF EXISTS registros_staff_rw ON public.registros;
CREATE POLICY registros_staff_rw ON public.registros FOR ALL
  USING (colegio_id = auth_colegio_id() AND is_staff())
  WITH CHECK (colegio_id = auth_colegio_id() AND is_staff());

COMMIT;

