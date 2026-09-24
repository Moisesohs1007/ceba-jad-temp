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
    let targetEmailRaw = typeof body.targetEmail === 'string' ? body.targetEmail.trim() : '';
    let newPassword   = typeof body.newPassword   === 'string' ? body.newPassword : '';
    const targetDniRaw = typeof body.targetDni === 'string' ? body.targetDni.trim() : '';
    // v172: Si user-not-found y es STAFF correo real: crear auth y vincular con row existente DB si la hay.
    // createIfMissing default true (para uso interno admin)
    const createIfMissing = body.createIfMissing === undefined ? true : !!body.createIfMissing;

    if (!targetEmailRaw && !targetDniRaw) {
      return jsonResponse({ error: 'Falta targetEmail o targetDni', code: 'bad-request' }, 400);
    }
    if (!newPassword) {
      return jsonResponse({ error: 'Falta newPassword', code: 'bad-request' }, 400);
    }
    if (newPassword.length < 6) {
      return jsonResponse({ error: 'newPassword debe tener al menos 6 caracteres', code: 'bad-request' }, 400);
    }

    // ====== Resolver email real objetivo ======
    let targetEmail = '';
    let targetMode: 'staff-email' | 'apo-dni' = 'staff-email'; // por defecto
    if (targetEmailRaw) {
      const lo = targetEmailRaw.toLowerCase();
      if (/^\d{8}$/.test(lo)) {
        const { data: colegio, error: cerr } = await supabaseAdmin
          .from('colegios').select('id,apo_domain').eq('id', colegioId).maybeSingle();
        const domain = String((colegio as any)?.apo_domain || '').trim().toLowerCase();
        if (cerr || !domain) return jsonResponse({ error: 'Colegio sin apo_domain' }, 400);
        targetEmail = `${lo}@${domain}`;
        targetMode = 'apo-dni';
      } else if (/^\d{8}@/.test(lo)) {
        targetEmail = lo; targetMode = 'apo-dni';
      } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lo)) {
        targetEmail = lo; targetMode = 'staff-email';
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
      targetMode = 'apo-dni';
    }

    // ====== Buscar en Auth por email ======
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

    // ====== Regla seguridad: director NO puede cambiar pass admin ======
    if (foundId) {
      try {
        const { data: targetUsr } = await supabaseAdmin.auth.admin.getUserById(foundId);
        const targetRol = String((targetUsr?.user?.app_metadata as any)?.rol || '').toLowerCase();
        if (requesterRol === 'director' && targetRol === 'admin') {
          return jsonResponse({ error: 'No permitido: director no puede cambiar pass de admin' }, 403);
        }
      } catch (_) {}
    }

    // ====== Si encontramos en Auth → ACTUALIZAR ======
    let actionMode: 'created' | 'updated' = 'updated';
    if (foundId) {
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(foundId, {
        password: newPassword,
      });
      if (updErr) return jsonResponse({ error: updErr.message, code: 'auth/update-failed' }, 500);
    } else {
      // ====== Usuario NO EXISTE en Auth ======
      if (!createIfMissing) {
        return jsonResponse({
          error: 'No existe usuario con ese correo en auth.',
          code: 'auth/user-not-found'
        }, 404);
      }

      if (targetMode === 'apo-dni') {
        // Apoderado: validar alumno existente y crear (mismo reset-apoderado original)
        const dni = targetEmail.split('@')[0];
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
        actionMode = 'created';
        try {
          await supabaseAdmin.from('apoderados').upsert(
            { colegio_id: colegioId, id: dni, alumno_id: dni, primer_ingreso: true },
            { onConflict: 'colegio_id,id' }
          );
        } catch (_) {}
      } else {
        // v172: STAFF correo REAL (maryflo1260@gmail.com etc) y no existe auth.
        // 1) Buscar row en tabla "usuarios" por (colegio_id, email) para rescatar datos + uid existente
        // 2) Crear auth user con el password nuevo.
        // 3) Si la row DB ya tenía un id distinto → borrar row antigua e insertar con uid nuevo (row huérfana sin auth era el bug C1).
        const { data: rows, error: rowsErr } = await supabaseAdmin
          .from('usuarios')
          .select('*')
          .eq('colegio_id', colegioId)
          .eq('email', targetEmail)
          .limit(5);
        if (rowsErr) return jsonResponse({ error: rowsErr.message }, 500);
        const rowOld = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

        // Sacar rol objetivo (para app_metadata y row nueva)
        let rolObjetivo = String((rowOld as any)?.rol || 'auxiliar').trim().toLowerCase();
        if (rolObjetivo === 'portero') rolObjetivo = 'auxiliar';
        if (!STAFF_ROLES.has(rolObjetivo)) rolObjetivo = 'auxiliar';

        // Seguridad extra: director NO puede crear admin
        if (requesterRol === 'director' && rolObjetivo === 'admin') {
          return jsonResponse({ error: 'No permitido: director no puede crear admin' }, 403);
        }

        // Nombre objetivo (para row nueva si no existe row)
        const nombreObjetivo = String((rowOld as any)?.nombre || targetEmail.split('@')[0]).trim();

        // 1. Crear Auth user
        const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
          email: targetEmail,
          password: newPassword,
          email_confirm: true,
          app_metadata: { colegio_id: colegioId, rol: rolObjetivo },
        });
        if (cErr || !created?.user?.id) {
          const msg = (cErr as any)?.message || 'Error creando usuario auth';
          const code = msg.toLowerCase().includes('already') ? 'auth/email-already-in-use' : 'auth/unknown';
          return jsonResponse({ error: msg, code }, code === 'auth/email-already-in-use' ? 409 : 500);
        }
        foundId = created.user.id;
        foundEmail = targetEmail;
        actionMode = 'created';

        // 2. Armar row usuarios (mezclar rowOld si existía, PERO con el id NUEVO del auth user creado)
        const rowToUpsert: Record<string, unknown> = {};
        if (rowOld && typeof rowOld === 'object') {
          // Copiar todos los campos (permisos, asignaciones, etc), pero pisar id + colegio_id + campos que siempre deben coincidir
          for (const k of Object.keys(rowOld)) {
            if (k === 'id') continue; // vamos a pisar id con el nuevo uid auth
            (rowToUpsert as any)[k] = (rowOld as any)[k];
          }
        }
        rowToUpsert.id = foundId;
        rowToUpsert.colegio_id = colegioId;
        rowToUpsert.nombre = String(rowToUpsert.nombre || nombreObjetivo || '').trim();
        rowToUpsert.email = targetEmail;
        rowToUpsert.rol = rolObjetivo;
        if (rowToUpsert.colegioId) delete rowToUpsert.colegioId;

        try {
          // Borrar row huérfana antigua (id viejo, sin auth) para no tener duplicado
          const oldId = String((rowOld as any)?.id || '').trim();
          if (oldId && oldId !== foundId) {
            await supabaseAdmin.from('usuarios').delete().eq('colegio_id', colegioId).eq('id', oldId);
          }
        } catch (_) {}

        // Upsert row nueva con id = uid auth creado
        let { error: upsErr } = await supabaseAdmin
          .from('usuarios')
          .upsert(rowToUpsert, { onConflict: 'colegio_id,id' });
        if (upsErr && String(upsErr.message || '').toLowerCase().includes('permisos_extra')) {
          delete (rowToUpsert as any).permisos_extra;
          const r2 = await supabaseAdmin.from('usuarios').upsert(rowToUpsert, { onConflict: 'colegio_id,id' });
          upsErr = r2.error as any;
        }
        if (upsErr) {
          // Warning: auth user ya se creó, no lo deshacemos, pero reportamos
          return jsonResponse({
            error: 'Usuario auth creado y contraseña asignada. Hubo un error guardando datos en tabla usuarios (permisos/grados): ' + upsErr.message,
            code: 'db-upsert-warning',
            warning: true,
            targetEmail: foundEmail,
            mode: actionMode,
          }, 202);
        }
      }
    }

    // ====== Sync metadata colegio_id/rol si hace falta ======
    if (foundId) {
      try {
        const { data: tu } = await supabaseAdmin.auth.admin.getUserById(foundId);
        const cur = (tu?.user?.app_metadata as any) || {};
        const needsSync = (cur.colegio_id !== colegioId) || (!cur.rol && /^\d{8}@/.test(foundEmail));
        if (needsSync) {
          await supabaseAdmin.auth.admin.updateUserById(foundId, {
            app_metadata: { ...cur, colegio_id: colegioId, rol: cur.rol || (targetMode === 'apo-dni' ? 'apoderado' : 'auxiliar') },
          });
        }
      } catch (_) {}
    }

    return jsonResponse({
      ok: true,
      targetEmail: foundEmail || targetEmail,
      mode: actionMode,
      authUid: foundId || undefined,
    }, 200);
  } catch (e: any) {
    return jsonResponse({ error: e?.message || 'Error interno', code: 'internal' }, 500);
  }
});
