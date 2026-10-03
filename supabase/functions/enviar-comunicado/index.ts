import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ================================================================
// ✅ v207y: WRAPPER SEGURIDAD TOTAL. Si hay crash de sintaxis o
// error en inicialización de módulos, devolvemos JSON claro.
// ================================================================
const __EF_VERSION = 'v207y';

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Método no permitido', ef_version: __EF_VERSION }), {
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const body = await req.json().catch(() => ({}));
    const urlImagen = typeof body.urlImagen === 'string' ? body.urlImagen : undefined;
    const mediaBase64 = typeof body.mediaBase64 === 'string' ? body.mediaBase64 : '';
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const mediatypeIn = typeof body.mediatype === 'string' ? body.mediatype : '';
    const mediatype = (mediatypeIn === 'document' || mediatypeIn === 'image' || mediatypeIn === 'video' || mediatypeIn === 'audio')
      ? mediatypeIn
      : ((filename || '').toLowerCase().endsWith('.pdf') ? 'document' : 'image');
    const items = Array.isArray(body.items) ? body.items : [];

    if (!items.length) {
      return new Response(JSON.stringify({ error: 'Faltan parámetros requeridos (items)', ef_version: __EF_VERSION }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }
    if (items.length > 80) {
      return new Response(JSON.stringify({ error: 'Demasiados destinatarios (máximo 80)', ef_version: __EF_VERSION }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }
    if (!urlImagen && (!mediaBase64 || !filename)) {
      return new Response(JSON.stringify({ error: 'Faltan parámetros requeridos (urlImagen o mediaBase64+filename)', ef_version: __EF_VERSION }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No autorizado', ef_version: __EF_VERSION }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Token inválido o expirado', ef_version: __EF_VERSION }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const colegioId = user.app_metadata?.colegio_id;
    const rolMeta = String(user.app_metadata?.rol || '');
    if (!colegioId) {
      return new Response(JSON.stringify({ error: 'Usuario no asociado a un colegio', ef_version: __EF_VERSION }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: usrRow, error: usrErr } = await supabaseAdmin
      .from('usuarios')
      .select('rol,permisos_extra')
      .eq('colegio_id', colegioId)
      .eq('id', user.id)
      .maybeSingle();

    if (usrErr) {
      return new Response(JSON.stringify({ error: usrErr.message, ef_version: __EF_VERSION }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const rolDb = String((usrRow as any)?.rol || '');
    const rol = rolDb || rolMeta;
    const px = ((usrRow as any)?.permisos_extra && typeof (usrRow as any)?.permisos_extra === 'object')
      ? (usrRow as any)?.permisos_extra
      : {};
    const extraSections = (px && typeof px.sections === 'object') ? px.sections : {};
    const canByRole = ['admin', 'director', 'coordinador', 'profesor', 'psicologo'].includes(rol);
    const canByExtra = !!(extraSections as any)?.comunicado;

    if (!canByRole && !canByExtra) {
      return new Response(JSON.stringify({ error: 'No permitido', ef_version: __EF_VERSION }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const { data: colegio, error: colegioError } = await supabaseAdmin
      .from('colegios')
      .select('factiliza_token, factiliza_instancia')
      .eq('id', colegioId)
      .single();

    if (colegioError || !colegio || !colegio.factiliza_token || !colegio.factiliza_instancia) {
      return new Response(JSON.stringify({ error: 'Configuración de WhatsApp no disponible para este colegio', ef_version: __EF_VERSION }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
      });
    }

    const tokenFactiliza = colegio.factiliza_token;
    const instancia = colegio.factiliza_instancia;
    const instanciaSafe = encodeURIComponent(String(instancia || '').trim());
    const factilizaBase = 'https://apiwsp.factiliza.com';
    const factilizaHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenFactiliza}`,
    };
    // Preview token for logs (no leak)
    const tokenPreview = (String(tokenFactiliza||'').slice(0,4) || '****') + '...' + (String(tokenFactiliza||'').slice(-4) || '****');

    async function sendFactiliza(num: string, mensaje: string): Promise<{ res: Response; mode: string; endpoint: string }> {
      // ============================================================
      // ✅ v207x: Devolvemos { res, mode, endpoint } para forense.
      // NO throw aquí. Si fetch throw, caller atrapa por item.
      // ============================================================
      if (mediaBase64 && filename) {
        const ep = `${factilizaBase}/api/v1/message/sendMedia/${instanciaSafe}`;
        const res = await fetch(ep, {
          method: 'POST',
          headers: factilizaHeaders,
          body: JSON.stringify({ number: num, mediatype, media: mediaBase64, filename, caption: mensaje }),
        });
        if (res.status !== 404 || !urlImagen) return { res, mode: 'sendMedia_b64', endpoint: ep };
      }

      if (urlImagen) {
        const ep = `${factilizaBase}/api/v1/message/sendMedia/${instanciaSafe}`;
        const resNew = await fetch(ep, {
          method: 'POST',
          headers: factilizaHeaders,
          body: JSON.stringify({ number: num, mediatype: 'image', media: urlImagen, caption: mensaje }),
        });
        if (resNew.status !== 404) return { res: resNew, mode: 'sendMedia_url', endpoint: ep };
        const ep2 = `${factilizaBase}/v1/message/sendimage/${instanciaSafe}`;
        return {
          res: await fetch(ep2, {
            method: 'POST',
            headers: factilizaHeaders,
            body: JSON.stringify({ number: num, url: urlImagen, caption: mensaje }),
          }),
          mode: 'sendimage_legacy',
          endpoint: ep2,
        };
      }

      const epText1 = `${factilizaBase}/api/v1/message/sendText/${instanciaSafe}`;
      const resNew = await fetch(epText1, {
        method: 'POST',
        headers: factilizaHeaders,
        body: JSON.stringify({ number: num, text: mensaje, numero: num, texto: mensaje }),
      });
      if (resNew.status !== 404) return { res: resNew, mode: 'sendText_v1', endpoint: epText1 };
      const epText2 = `${factilizaBase}/v1/message/sendtext/${instanciaSafe}`;
      return {
        res: await fetch(epText2, {
          method: 'POST',
          headers: factilizaHeaders,
          body: JSON.stringify({ number: num, text: mensaje }),
        }),
        mode: 'sendtext_legacy',
        endpoint: epText2,
      };
    }

    const results: any[] = [];
    let _itemIndex = 0;
    for (const it of items) {
      _itemIndex++;
      // ================================================================
      // ✅ v207x: TRY/CATCH POR ITEM = NUNCA MÁS un error mata todos.
      // ================================================================
      try {
        const telefono = typeof it?.telefono === 'string' ? it.telefono : '';
        const mensaje = typeof it?.mensaje === 'string' ? it.mensaje : '';
        let digits = telefono.replace(/\D/g, '');
        if (digits.startsWith('0')) digits = digits.slice(1);
        if (digits.length === 9) digits = '51' + digits;
        const num = digits;
        const telMask = '...' + String(num || '').slice(-9);

        if (!num || num.length < 11 || !mensaje) {
          results.push({
            telefono, ok: false, status: 400,
            error: 'Número inválido o mensaje vacío',
            debug: { colegio: String(colegioId).slice(0,8), usuario: String(user.id).slice(0,8), idx: _itemIndex, telMask, msgLen: String(mensaje||'').length, ef_version: __EF_VERSION }
          });
          continue;
        }

        // --- ENVIAR A FACTILIZA (con catch de red/timeout) ---
        let modoUsado = '';
        let endpointUsado = '';
        let res: Response;
        let fetchThrew: any = null;
        let sendStart = Date.now();
        try {
          const sf = await sendFactiliza(num, mensaje);
          res = sf.res;
          modoUsado = sf.mode;
          endpointUsado = sf.endpoint;
        } catch (fe) {
          fetchThrew = fe?.message || String(fe);
          const fetchMsg = String(fetchThrew || 'Error red Factiliza (fetch throwed)');
          const hint = (
            /timeout|timed out/i.test(fetchMsg) ? ' (timeout). Espera 1 minuto y vuelve a intentar.' :
            /dns|enotfound|getaddrinfo/i.test(fetchMsg) ? ' (DNS error). Factiliza servidor no resuelve.' :
            /econnrefused|network/i.test(fetchMsg) ? ' (network error). No hay conexión saliente a Factiliza.' :
            ''
          );
          const errHum = 'Fallo de red al contactar Factiliza: ' + fetchMsg + hint +
            ' 👉 Revisa tu conexión o escribe a SOPORTE FACTILIZA WHATSAPP: +51 949035687.';
          results.push({
            telefono: num, ok: false, status: 0,
            error: errHum,
            details: { raw: fetchMsg },
            debug: { colegio: String(colegioId).slice(0,8), usuario: String(user.id).slice(0,8), idx: _itemIndex, telMask, msgLen: String(mensaje).length, modoUsado, endpointUsado, fetchThrew: fetchMsg, fetchThrewStack: String((fe as any)?.stack || ''), tookMs: (Date.now()-sendStart), tokenPreview, instanciaSafe, ef_version: __EF_VERSION, mediatype, filename, captionLen: String(mensaje||'').length }
          });
          try { console.error(`[EF COM ${__EF_VERSION}] item ${_itemIndex} tel=${telMask} RED ERROR: ${fetchMsg}`); } catch(_) {}
          await sleep(1200);
          continue;
        }

        const tookMs = Date.now() - sendStart;
        const txt = await res.text().catch(() => '');
        let details: any = { raw: txt ?? '' };
        try { details = txt ? JSON.parse(txt) : { raw: (txt || '') }; } catch (e) { details = { raw: (txt || ''), __parseError: String((e as any)?.message || e) }; }
        const rawPreview = String(txt||'').slice(0, 240);
        const contentType = String(res.headers?.get?.('content-type') || '');
        const statusText = String(res.statusText || '');

        // ================================================================
        // ✅ v207w: CALCULAR CAMPO ERROR HUMANO CLARO
        //   (UI lee results[].error para mostrarle a Moises que pasó)
        // ✅ v207x: robustez extra.
        // ================================================================
        const dMessage =
          typeof details?.message === 'string' ? details.message :
          typeof details?.mensaje === 'string' ? details.mensaje :
          typeof details?.error === 'string' ? details.error :
          typeof details?.msg === 'string' ? details.msg :
          '';
        const dTextLower = (dMessage + ' ' + rawPreview).toLowerCase();

        // ================================================================
        // ✅ v207y: FIN DEL FALSO POSITIVO "FALTA DE PAGO" (Moises confirmó
        // que la asistencia SALIDA Luis Belleza 2C Virtual 11:20pm SÍ ENVÍA
        // OK = endpoint sendText_v1 SIN IMAGEN funciona PERO sendMedia_b64
        // (logo default) devuelve 500 Internal Server Error = NO es falta
        // pago! SOLO marcamos falta pago SI LOS STRINGS REALES APARECEN en
        // el body raw/message de Factiliza.
        // ================================================================
        let _huboFaltaPagoStrings = (
          dTextLower.includes('falta de pago') ||
          dTextLower.includes('falta pago') ||
          dTextLower.includes('sin saldo') ||
          dTextLower.includes('insufficient') ||
          dTextLower.includes('no credit') ||
          dTextLower.includes('credit') && (dTextLower.includes('expir') || dTextLower.includes('agotad') || dTextLower.includes('acabad')) ||
          dTextLower.includes('suspended') ||
          dTextLower.includes('suspendid') ||
          dTextLower.includes('vencid') ||
          res.status === 405 ||
          dTextLower.includes('949035687') ||
          dTextLower.includes('+51') && dTextLower.includes('soporte') ||
          dTextLower.includes('soporte') && dTextLower.includes('whatsapp') ||
          dTextLower.includes('token') && (dTextLower.includes('invalid') || dTextLower.includes('expired') || dTextLower.includes('inválido') || dTextLower.includes('vencido'))
        );
        // Si había strings reales de falta pago → confirmamos.
        let isFactilizaPago = _huboFaltaPagoStrings;
        // ================================================================
        // ✅ v207y: RETRY AUTOMÁTICO SOLO-TEXTO (como asistencia salida
        // Luis Belleza que funciona). Si sendMedia falla 400/500 y NO hay
        // strings de falta pago → reintentar MISMO item con sendText_v1
        // SIN imagen SIN caption (igual que EF enviar-whatsapp asistencia).
        // ================================================================
        let retryAsText = false;
        let secondStatus = 0;
        let secondOk = false;
        let secondRaw = '';
        let secondPreview = '';
        let secondMessage = '';
        const firstHadMedia = (mediaBase64 && filename) || !!urlImagen;
        const firstFailedMediaNoPago = firstHadMedia && !res.ok &&
          (res.status === 400 || res.status >= 500 || dTextLower.includes('internal server error')) &&
          !isFactilizaPago;
        if (firstFailedMediaNoPago) {
          retryAsText = true;
          try {
            const epText1 = `${factilizaBase}/api/v1/message/sendText/${instanciaSafe}`;
            const sf2 = await fetch(epText1, {
              method: 'POST',
              headers: factilizaHeaders,
              body: JSON.stringify({ number: num, text: mensaje, numero: num, texto: mensaje }),
            });
            secondStatus = sf2.status;
            secondOk = sf2.ok;
            const sf2txt = await sf2.text().catch(() => '');
            secondRaw = sf2txt || '';
            secondPreview = String(secondRaw || '').slice(0, 240);
            try {
              const sj = JSON.parse(secondRaw);
              secondMessage = String(sj?.message || sj?.mensaje || sj?.error || sj?.msg || '');
            } catch(_) {}
            const mergedLower = (secondMessage + ' ' + secondPreview).toLowerCase();
            if (
              mergedLower.includes('falta de pago') || mergedLower.includes('falta pago') ||
              mergedLower.includes('sin saldo') || mergedLower.includes('suspended') ||
              mergedLower.includes('suspendid') || mergedLower.includes('vencid') ||
              sf2.status === 405 || mergedLower.includes('949035687') ||
              mergedLower.includes('token') && (mergedLower.includes('invalid') || mergedLower.includes('expired') || mergedLower.includes('inválido'))
            ) {
              isFactilizaPago = true;
            }
            // Sobreescribir con el resultado del retry SOLO-TEXTO (que funciona para asistencia).
            res = sf2 as any;
            modoUsado = 'sendText_v1-retryLuisBelleza';
            endpointUsado = epText1;
            txt = secondRaw;
            rawPreview = secondPreview;
            contentType = String(sf2.headers?.get?.('content-type') || '');
            statusText = String(sf2.statusText || '');
            details = (function(){ try { return secondRaw ? JSON.parse(secondRaw) : { raw: secondRaw }; } catch(_){ return { raw: secondRaw }; } })();
            dMessage = secondMessage;
          } catch (fe2) {
            // Retry falló también: mantener el error original pero marcar retry fallido.
            retryAsText = false;
            try { console.error(`[EF COM ${__EF_VERSION}] item ${_itemIndex} RETRY sendText falló:`, String((fe2 as any)?.message || fe2)); } catch(_) {}
          }
        }

        // Ajustar final ok/errHumano después de retry (si lo hubo)
        const finalDMessage = dMessage;
        const finalDTextLower = (finalDMessage + ' ' + rawPreview).toLowerCase();
        // Rechequear pagos luego del retry (por si el retry devolvió 405 o strings reales)
        if (!isFactilizaPago && (
          res.status === 405 ||
          finalDTextLower.includes('falta de pago') || finalDTextLower.includes('falta pago') ||
          finalDTextLower.includes('sin saldo') || finalDTextLower.includes('suspended') ||
          finalDTextLower.includes('suspendid') || finalDTextLower.includes('949035687')
        )) { isFactilizaPago = true; }
        let errorHumano = finalDMessage;
        if (isFactilizaPago) {
          errorHumano =
            (finalDMessage ? (finalDMessage + ' — ') : '') +
            `[ESTADO FACTILIZA: HTTP ${res.status}${statusText?' ('+statusText+')':''}] ` +
            '👉 CONTACTA SOPORTE FACTILIZA WHATSAPP INMEDIATAMENTE: +51 949035687 (confirmado FALTA DE PAGO/SALDO o suspensión temporal del proveedor WhatsApp por ellos).' +
            (rawPreview ? ` Raw preview: ${rawPreview.replace(/\s+/g,' ').slice(0,160)}` : '');
        } else if (firstFailedMediaNoPago && !secondOk && retryAsText === false) {
          errorHumano = `Endpoint multimedia sendMedia falló (HTTP ${res.status}) y el reintento automático SOLO-TEXTO también falló. SOPORTE FACTILIZA WHATSAPP: +51 949035687.` +
            (rawPreview ? ` Raw: ${rawPreview.slice(0, 160)}` : '');
        } else if (!errorHumano) {
          if (res.status === 401 || res.status === 403) errorHumano = `Token Factiliza inválido/expirado (HTTP ${res.status}). Revisa Configuración → WhatsApp y vuelve a pegar el token. Token preview: ${tokenPreview}`;
          else if (res.status === 404) errorHumano = `Endpoint Factiliza no encontrado (HTTP 404) ${modoUsado} → endpointUsado: ${endpointUsado}`;
          else if (res.status === 429) errorHumano = `Demasiados envíos seguidos (rate-limit). Espera 1 minuto y vuelve a intentar. (HTTP 429)`;
          else if (res.status >= 500) errorHumano = `Servidor Factiliza devolvió error genérico (HTTP ${res.status}${statusText?' '+statusText:''}). Raw: ${rawPreview.slice(0, 160) || '(sin cuerpo)'} → SI PERSISTE, escribe a SOPORTE FACTILIZA WHATSAPP: +51 949035687. (Nota: los envíos SIN IMAGEN de asistencias SÍ funcionan).`;
          else if (res.status === 200 || res.ok) errorHumano = '';
          else errorHumano = `HTTP ${res.status}${statusText?' ('+statusText+')':''} sin detalle. Raw preview: ${rawPreview.slice(0, 160) || '(sin cuerpo)'}`;
        } else {
          // errorHumano tenía texto pero no era pago: añadir soporte si 4xx/5xx
          if (!res.ok && !String(errorHumano).includes('949035687')) {
            errorHumano = String(errorHumano) + ' 👉 Si el error persiste contacta a Factiliza WhatsApp: +51 949035687.';
          }
        }
        const okFinal = !!(res.ok && !errorHumano);

        results.push({
          telefono: num,
          ok: okFinal,
          status: res.status,
          statusText,
          error: okFinal ? '' : (errorHumano || `Error HTTP ${res.status}`),
          details,
          rawPreview,
          retryAsText,
          firstFailedMedia: firstFailedMediaNoPago,
          debug: {
            colegio: String(colegioId).slice(0,8),
            usuario: String(user.id).slice(0,8),
            idx: _itemIndex,
            telMask,
            msgLen: String(mensaje).length,
            modoUsado,
            endpointUsado,
            contentType,
            tookMs,
            tokenPreview,
            instanciaSafe,
            ef_version: __EF_VERSION,
            mediatype,
            filename,
            captionLen: String(mensaje||'').length,
            fetchThrew: null,
            resOk: res.ok,
            resStatus: res.status,
            rawLen: String(txt||'').length,
            retryAsText,
            secondStatus,
            secondOk,
            secondPreview: secondPreview ? secondPreview.slice(0, 120) : '',
            firstHadMedia,
            firstFailedMediaNoPago,
          },
        });
        try { console.log(`[EF COM ${__EF_VERSION}] item ${_itemIndex} tel=${telMask} ${modoUsado} → HTTP ${res.status}${statusText?' '+statusText:''} took=${tookMs}ms ok=${okFinal} retry=${retryAsText?'Y':'N'}${errorHumano?(' err='+String(errorHumano).slice(0,200)):''}`); } catch(_) {}
      } catch (itemLevelError) {
        // Catch de absolutamente TODO por item.
        try { console.error(`[EF COM ${__EF_VERSION}] item ${_itemIndex} ITEM-LEVEL CRASH:`, itemLevelError); } catch(_) {}
        results.push({
          telefono: String((it as any)?.telefono || ''),
          ok: false,
          status: 999,
          error: 'Error interno en este ítem: ' + String((itemLevelError as any)?.message || itemLevelError) + '. SOPORTE: WhatsApp +51 949035687.',
          details: {
            __itemCrash: true,
            msg: String((itemLevelError as any)?.message || itemLevelError),
            stack: String((itemLevelError as any)?.stack || ''),
            ef_version: __EF_VERSION,
          },
        });
      }

      await sleep(1200);
    }

    return new Response(JSON.stringify({ success: true, results, ef_version: __EF_VERSION, colegioPreview: String(colegioId).slice(0,8), usuarioPreview: String(user.id).slice(0,8) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
    });
  } catch (error) {
    try { console.error(`[EF COM ${__EF_VERSION}] TOP-LEVEL CRASH:`, error); } catch(_) {}
    return new Response(JSON.stringify({
      error: 'Error interno del servidor: ' + String((error as any)?.message || error),
      stack: String((error as any)?.stack || ''),
      ef_version: __EF_VERSION,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Ef-Version': __EF_VERSION },
    });
  }
});
