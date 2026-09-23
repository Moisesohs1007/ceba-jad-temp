import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const STAFF_ROLES = new Set(['admin', 'director', 'coordinador', 'profesor', 'psicologo', 'auxiliar', 'portero']);

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Método no permitido' }, 405);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'No autorizado' }, 401);

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) return jsonResponse({ error: 'Token inválido o expirado' }, 401);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const requesterRolMeta = String(user.app_metadata?.rol || '');
    const colegioIdMeta = String(user.app_metadata?.colegio_id || '');

    const { data: requesterRows, error: requesterRowError } = await supabaseAdmin
      .from('usuarios')
      .select('colegio_id,rol')
      .eq('id', user.id)
      .limit(1);

    if (requesterRowError) return jsonResponse({ error: requesterRowError.message }, 500);
    const requesterRow = Array.isArray(requesterRows) ? requesterRows[0] : null;
    const requesterRolDb = String((requesterRow as any)?.rol || '');
    const colegioIdDb = String((requesterRow as any)?.colegio_id || '');

    const requesterRol = requesterRolDb || requesterRolMeta;
    const colegioId = colegioIdDb || colegioIdMeta;

    if (!colegioId) return jsonResponse({ error: 'Usuario no asociado a un colegio' }, 400);
    if (!['admin', 'director'].includes(requesterRol)) return jsonResponse({ error: 'No permitido' }, 403);

    const body = await req.json().catch(() => ({}));

    // =============== Modo 1: targetEmail + newPassword (SET PASSWORD DIRECTO) ===============
    // Admin quiere cambiarle la pass a un usuario STAFF o APODERADO y NO depender del link por correo.
    // Debe proporcionar targetEmail y newPassword (min 6 caracs).
    // Si es DNI de 8 dígitos sin @ → asumimos que es apoderado: buscamos apo_domain del colegio.
    let targetEmailRaw = typeof body.targetEmail === 'string' ? body.targetEmail.trim() : '';
    let newPassword   = typeof body.newPassword   === 'string' ? body.newPassword : '';

    // =============== Modo 2: targetDni + newPassword (APODERADO SET PASS DIRECTO) ===============
    // Misma idea reset-apoderado original pero con contraseña ARBITRARIA nueva (no DNI).
    const targetDniRaw = typeof body.targetDni === 'string' ? body.targetDni.trim() : '';

    if (!targetEmailRaw && !targetDniRaw) {
      return jsonResponse({ error: 'Falta targetEmail o targetDni', code: 'bad-request' }, 400);
    }
    if (!newPassword) {
      return jsonResponse({ error: 'Falta newPassword', code: 'bad-request' }, 400);
    }
    if (newPassword.length < 6) {
      return jsonResponse({ error: 'newPassword debe tener al menos 6 caracteres', code: 'bad-request' }, 400);
    }

    // Resolver email real objetivo
    let targetEmail = '';
    if (targetEmailRaw) {
      const lo = targetEmailRaw.toLowerCase();
      if (/^\d{8}$/.test(lo)) {
        // DNI puro → apoderado virtual
        const { data: colegio, error: cerr } = await supabaseAdmin
          .from('colegios').select('id,apo_domain').eq('id', colegioId).maybeSingle();
        const domain = String((colegio as any)?.apo_domain || '').trim().toLowerCase();
        if (cerr || !domain) return jsonResponse({ error: 'Colegio sin apo_domain' }, 400);
        targetEmail = `${lo}@${domain}`;
      } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lo)) {
        targetEmail = lo;
      } else {
        return jsonResponse({ error: 'targetEmail inválido (debe ser un correo o un DNI de 8 dígitos)' }, 400);
      }
    } else {
      const dni = targetDniRaw.replace(/\D/g, '');
      if (!/^\d{8}$/.test(dni)) return jsonResponse({ error: 'targetDni debe ser un DNI de 8 dígitos' }, 400);
      const { data: colegio, error: cerr } = await supabaseAdmin
        .from('colegios').select('id,apo_domain').eq('id', colegioId).maybeSingle();
      const domain = String((colegio as any)?.apo_domain || '').trim().toLowerCase();
      if (cerr || !domain) return jsonResponse({ error: 'Colegio sin apo_domain' }, 400);
      targetEmail = `${dni}@${domain}`;
    }

    // Buscar usuario existente por email (STAFF listados + APODERADOS con email virtual o real)
    let foundId = '';
    let foundEmail = '';
    for (let page = 1; page <= 30; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 300 });
      if (error) break;
      const list = data?.users || [];
      for (const u of list) {
        const ue = String(u.email || '').toLowerCase();
        if (ue === targetEmail) {
          foundId = u.id; foundEmail = ue; break;
        }
      }
      if (foundId) break;
      if (list.length < 300) break;
    }

    // Autorización extra: director NO puede cambiar pass a admin
    if (foundId) {
      try {
        const { data: targetUsr } = await supabaseAdmin.auth.admin.getUserById(foundId);
        const targetRol = String((targetUsr?.user?.app_metadata as any)?.rol || '').toLowerCase();
        if (requesterRol === 'director' && targetRol === 'admin') {
          return jsonResponse({ error: 'No permitido: director no puede cambiar pass de admin' }, 403);
        }
      } catch (_) {}
    }

    if (foundId) {
      // Actualizar password existente
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(foundId, {
        password: newPassword,
      });
      if (updErr) return jsonResponse({ error: updErr.message, code: 'auth/update-failed' }, 500);
    } else {
      // Usuario no existe. Si es DNI/apoderado, lo creamos igual que reset-apoderado original.
      // Para STAFF (correo real NO-DNI) → no creamos nada: debe ser creado vía admin-crear-usuario primero.
      const isDniVirtual = /^\d{8}@/.test(targetEmail);
      if (!isDniVirtual) {
        return jsonResponse({
          error: 'No existe usuario con ese correo STAFF. Créalo primero desde el panel de usuarios (admin-crear-usuario).',
          code: 'auth/user-not-found'
        }, 404);
      }
      const dni = targetEmail.split('@')[0];
      // Validar que exista el alumno
      const { data: alumno, error: aErr } = await supabaseAdmin
        .from('alumnos').select('id').eq('colegio_id', colegioId).eq('id', dni).maybeSingle();
      if (aErr || !alumno) {
        return jsonResponse({ error: 'Alumno apoderado no encontrado', code: 'not-found' }, 404);
      }
      const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
        email: targetEmail,
        password: newPassword,
        email_confirm: true,
        app_metadata: { colegio_id: colegioId, rol: 'apoderado', alumno_id: dni },
      });
      if (cErr || !created?.user?.id) {
        return jsonResponse({ error: (cErr as any)?.message || 'Error creando usuario', code: 'auth/unknown' }, 500);
      }
      foundId = created.user.id;
      foundEmail = targetEmail;
      try {
        await supabaseAdmin.from('apoderados').upsert(
          { colegio_id: colegioId, id: dni, alumno_id: dni, primer_ingreso: true },
          { onConflict: 'colegio_id,id' }
        );
      } catch (_) {}
    }

    // Sync metadata colegio_id y rol si hace falta
    if (foundId) {
      try {
        const { data: tu } = await supabaseAdmin.auth.admin.getUserById(foundId);
        const cur = (tu?.user?.app_metadata as any) || {};
        const needsSync = (cur.colegio_id !== colegioId) || (!cur.rol && /^\d{8}@/.test(foundEmail));
        if (needsSync) {
          await supabaseAdmin.auth.admin.updateUserById(foundId, {
            app_metadata: { ...cur, colegio_id: colegioId, rol: cur.rol || 'apoderado' },
          });
        }
      } catch (_) {}
    }

    return jsonResponse({ ok: true, targetEmail: foundEmail || targetEmail, mode: foundId ? 'updated' : 'created' }, 200);
  } catch (e: any) {
    return jsonResponse({ error: e?.message || 'Error interno', code: 'internal' }, 500);
  }
});
