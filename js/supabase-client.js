// v2/js/supabase-client.js
// Configuración y conexión directa a Supabase

const SUPABASE_URL = 'https://uezhytctcrhmkmznwtyv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVlemh5dGN0Y3JobWttem53dHl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMzUwNDksImV4cCI6MjA5NjcxMTA0OX0.uJ3iR4Z8ah6MeWat0rRSHiMzY7N-OcmtFOj8GLLjM8g';

window.COLEGIO_ID = 'sigece';
window.COLEGIO_NOMBRE  = 'I.E. Nº 1049 Juana Alarco De Dammert';
window.COLEGIO_ESLOGAN = '';
window.COLEGIO_LOGO    = 'img/logo-colegio.png';
window.COLEGIO_ANIO    = '2026';

// Inicializar Supabase de forma nativa
window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, storageKey: 'v2_auth_' + window.COLEGIO_ID }
});
