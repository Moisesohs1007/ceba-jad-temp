-- ============================================================
-- Habilitar REALTIME publication para las tablas del chat
-- Postgres 15 requiere añadir tablas explicitamente a
-- 'supabase_realtime' para que el canal de Supabase envie eventos.
-- ============================================================

BEGIN;

-- Asegurar que existe la publication
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete');
  END IF;
END
$$;

-- Añadir tablas (chequeo manual para evitar "table already in publication")
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT 1 INTO v_count
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename  = 'chat_conversaciones';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_conversaciones;
  END IF;

  SELECT 1 INTO v_count
  FROM pg_publication_tables
  WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename  = 'chat_mensajes';
  IF NOT FOUND THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_mensajes;
  END IF;
END
$$;

COMMIT;
