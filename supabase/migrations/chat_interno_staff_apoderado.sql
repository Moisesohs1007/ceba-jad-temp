-- ============================================================
-- CHAT INTERNO: Staff (colegio) <-> Apoderados
-- Tablas: chat_conversaciones, chat_mensajes
-- Alcance: Unico por colegio_id, participación controlada por RLS
-- ============================================================

-- Habilitar pgcrypto si no lo está
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ------------------------------------------------------------
-- Tabla: chat_conversaciones
-- Una conversación = un hilo entre (staff X apoderado) con scope
-- sobre un alumno o un canal general (por grado/sección o admin).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_conversaciones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  colegio_id TEXT NOT NULL DEFAULT '',

  -- Scope / tipo de vínculo (quién puede ver esta conversación)
  -- 'TUTOR_ALUMNO'  : Tutor de aula <-> Apoderado de un alumno concreto
  -- 'ALUMNO_GENERAL': Cualquier staff autorizado <-> Apoderado de un alumno
  -- 'ADMIN_APOD'    : Admin/Director/Coordinador <-> Apoderado (sin alumno específico)
  scope_type TEXT NOT NULL DEFAULT 'TUTOR_ALUMNO',

  -- Participantes
  staff_user_id UUID NOT NULL,         -- FK a public.usuarios.id
  apoderado_auth_uid UUID NOT NULL,    -- FK a auth.users.id (app_metadata rol=apoderado)

  -- Contexto (opcional, depende de scope_type)
  alumno_id TEXT DEFAULT '',
  grado TEXT NOT NULL DEFAULT '',
  seccion TEXT NOT NULL DEFAULT '',

  -- Meta última actividad (para ordenar la bandeja)
  last_message TEXT NOT NULL DEFAULT '',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sender_type TEXT NOT NULL DEFAULT '',  -- 'staff' | 'apoderado'

  -- Flags lectura
  read_by_staff BOOLEAN NOT NULL DEFAULT TRUE,
  read_by_apoderado BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_conv_colegio ON public.chat_conversaciones(colegio_id);
CREATE INDEX IF NOT EXISTS idx_chat_conv_staff ON public.chat_conversaciones(colegio_id, staff_user_id);
CREATE INDEX IF NOT EXISTS idx_chat_conv_apoderado ON public.chat_conversaciones(colegio_id, apoderado_auth_uid);
CREATE INDEX IF NOT EXISTS idx_chat_conv_alumno ON public.chat_conversaciones(colegio_id, alumno_id);
CREATE INDEX IF NOT EXISTS idx_chat_conv_last_at ON public.chat_conversaciones(last_message_at DESC);

-- Unicidad: No duplicar conversaciones del mismo (scope,staff,apoderado,alumno)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conv_unique
ON public.chat_conversaciones(colegio_id, scope_type, staff_user_id, apoderado_auth_uid, COALESCE(alumno_id,''));

ALTER TABLE public.chat_conversaciones ENABLE ROW LEVEL SECURITY;

-- Helper: ¿Es el usuario staff participante de la conversación?
CREATE OR REPLACE FUNCTION public.chat_is_staff_in_conv(conv public.chat_conversaciones)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT (auth.uid() IS NOT NULL AND conv.staff_user_id = auth.uid() AND public.is_staff());
$$;

-- Helper: ¿Es el usuario apoderado participante de la conversación?
CREATE OR REPLACE FUNCTION public.chat_is_apoderado_in_conv(conv public.chat_conversaciones)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT (auth.uid() IS NOT NULL AND conv.apoderado_auth_uid = auth.uid() AND public.is_apoderado());
$$;

-- Helper staff adicional: Admin/Director/Coordinador pueden ver TODAS las
-- conversaciones de su colegio (para soporte/intervención).
CREATE OR REPLACE FUNCTION public.chat_may_see_all_convs()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT (
    public.is_staff() AND
    public.auth_rol() IN ('admin','director','coordinador')
  );
$$;

-- ---------- POLICIES chat_conversaciones ----------
CREATE POLICY chat_conv_colegio_scope ON public.chat_conversaciones
  FOR ALL USING (colegio_id = public.auth_colegio_id());

CREATE POLICY chat_conv_select ON public.chat_conversaciones FOR SELECT
  USING (
    (colegio_id = public.auth_colegio_id()) AND (
      public.chat_is_staff_in_conv(chat_conversaciones) OR
      public.chat_is_apoderado_in_conv(chat_conversaciones) OR
      public.chat_may_see_all_convs()
    )
  );

CREATE POLICY chat_conv_insert_staff ON public.chat_conversaciones FOR INSERT
  WITH CHECK (
    (colegio_id = public.auth_colegio_id()) AND
    public.is_staff() AND
    staff_user_id = auth.uid() AND
    -- Restricción scope:
    -- - TUTOR_ALUMNO / ALUMNO_GENERAL: alumno_id no vacío
    -- - ADMIN_APOD: debe ser admin/director/coordinador
    (
      (scope_type IN ('TUTOR_ALUMNO','ALUMNO_GENERAL') AND alumno_id <> '') OR
      (scope_type = 'ADMIN_APOD' AND public.auth_rol() IN ('admin','director','coordinador'))
    )
  );

CREATE POLICY chat_conv_insert_apoderado ON public.chat_conversaciones FOR INSERT
  WITH CHECK (
    (colegio_id = public.auth_colegio_id()) AND
    public.is_apoderado() AND
    apoderado_auth_uid = auth.uid() AND
    scope_type IN ('TUTOR_ALUMNO','ALUMNO_GENERAL') AND
    alumno_id <> ''
    -- nota: el apoderado solo puede abrir conversación con staff que ya
    -- tiene vinculación por aula/alumno (se valida en trigger o en app)
  );

CREATE POLICY chat_conv_update_flags ON public.chat_conversaciones FOR UPDATE
  USING (
    (colegio_id = public.auth_colegio_id()) AND (
      public.chat_is_staff_in_conv(chat_conversaciones) OR
      public.chat_is_apoderado_in_conv(chat_conversaciones)
    )
  )
  WITH CHECK (
    (colegio_id = public.auth_colegio_id()) AND (
      public.chat_is_staff_in_conv(chat_conversaciones) OR
      public.chat_is_apoderado_in_conv(chat_conversaciones)
    )
  );

-- ------------------------------------------------------------
-- Tabla: chat_mensajes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chat_mensajes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  colegio_id TEXT NOT NULL DEFAULT '',
  conversacion_id UUID NOT NULL REFERENCES public.chat_conversaciones(id) ON DELETE CASCADE,

  sender_type TEXT NOT NULL,   -- 'staff' | 'apoderado'
  sender_id UUID NOT NULL,     -- auth.uid() de quien envía

  texto TEXT NOT NULL DEFAULT '',
  attachment_url TEXT NOT NULL DEFAULT '',
  attachment_name TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_colegio ON public.chat_mensajes(colegio_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON public.chat_mensajes(conversacion_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_msg_sender ON public.chat_mensajes(colegio_id, sender_id, created_at DESC);

ALTER TABLE public.chat_mensajes ENABLE ROW LEVEL SECURITY;

-- ---------- POLICIES chat_mensajes ----------
-- Lectura: solo participantes de la conversación (o staff con visión total)
CREATE POLICY chat_msg_select ON public.chat_mensajes FOR SELECT
  USING (
    colegio_id = public.auth_colegio_id() AND
    EXISTS (
      SELECT 1 FROM public.chat_conversaciones c
      WHERE c.id = chat_mensajes.conversacion_id
        AND c.colegio_id = public.auth_colegio_id()
        AND (
          public.chat_is_staff_in_conv(c) OR
          public.chat_is_apoderado_in_conv(c) OR
          public.chat_may_see_all_convs()
        )
    )
  );

-- Inserción: solo el participante correcto (staff en su lado, apoderado en el suyo)
CREATE POLICY chat_msg_insert ON public.chat_mensajes FOR INSERT
  WITH CHECK (
    colegio_id = public.auth_colegio_id() AND
    auth.uid() IS NOT NULL AND
    sender_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.chat_conversaciones c
      WHERE c.id = chat_mensajes.conversacion_id
        AND c.colegio_id = public.auth_colegio_id()
        AND (
          (sender_type = 'staff'      AND public.is_staff()      AND c.staff_user_id = auth.uid()) OR
          (sender_type = 'apoderado'  AND public.is_apoderado()  AND c.apoderado_auth_uid = auth.uid())
        )
    )
  );

-- ------------------------------------------------------------
-- Trigger: actualizar last_message / last_message_at en
-- chat_conversaciones cada vez que se inserta un mensaje,
-- y marcar como no-leído para el receptor.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_touch_conv_on_msg()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_read_staff BOOLEAN;
  v_read_apod  BOOLEAN;
BEGIN
  IF NEW.sender_type = 'staff' THEN
    v_read_staff  := TRUE;
    v_read_apod   := FALSE;
  ELSE
    v_read_staff  := FALSE;
    v_read_apod   := TRUE;
  END IF;

  UPDATE public.chat_conversaciones
  SET
    last_message      = LEFT(NEW.texto, 240),
    last_message_at   = NEW.created_at,
    last_sender_type  = NEW.sender_type,
    read_by_staff     = v_read_staff,
    read_by_apoderado = v_read_apod,
    updated_at        = NOW()
  WHERE id = NEW.conversacion_id
    AND colegio_id = NEW.colegio_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_msg_touch_conv ON public.chat_mensajes;
CREATE TRIGGER trg_chat_msg_touch_conv
AFTER INSERT ON public.chat_mensajes
FOR EACH ROW EXECUTE FUNCTION public.chat_touch_conv_on_msg();

-- ------------------------------------------------------------
-- Trigger: actualizar updated_at en chat_conversaciones
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chat_conv_updated_at ON public.chat_conversaciones;
CREATE TRIGGER trg_chat_conv_updated_at
BEFORE UPDATE ON public.chat_conversaciones
FOR EACH ROW EXECUTE FUNCTION public.chat_set_updated_at();

-- ------------------------------------------------------------
-- Habilitar REALTIME para chat_mensajes (mensajes en vivo)
-- y chat_conversaciones (actualizaciones de bandeja / lectura)
-- ------------------------------------------------------------
ALTER TABLE public.chat_conversaciones REPLICA IDENTITY FULL;
ALTER TABLE public.chat_mensajes       REPLICA IDENTITY FULL;

-- El app debe suscribirse al channel 'realtime:public:chat_conversaciones'
-- y 'realtime:public:chat_mensajes' con filtro por usuario actual.
