// ============================================================
// DB_SUPABASE — reemplazo drop-in de db.js para Supabase
// Misma API que DB en db.js → index.html no necesita cambios.
//
// Depende de:
//   - window._sb  (cliente Supabase, expuesto por compat.js)
//   - window.COLEGIO_ID (ej: 'sigece')
//   - LSC (cache localStorage, definido en index.html)
// ============================================================
// eslint-disable-next-line no-var
var supabase = window._sb; // sobreescribir referencia de librería con el cliente activo
const _CACHE_VER = 'v3';

const DB = {

  // ── ALUMNOS ───────────────────────────────────────────────

  _alumnosCache: null,
  _alumnosCacheKey: '',
  _alumnosScopedCache: {},

  async getAlumnos() {
    const uid = (window.currentUser && window.currentUser.uid) ? window.currentUser.uid : 'anon';
    const cacheKey = 'alumnos:' + _CACHE_VER + ':' + COLEGIO_ID + ':' + uid;
    if (this._alumnosCache && this._alumnosCacheKey === cacheKey) return this._alumnosCache;
    const lsData = LSC.get(cacheKey);
    if (lsData) { this._alumnosCache = lsData; this._alumnosCacheKey = cacheKey; return lsData; }
    try { LSC.del('alumnos'); } catch(_) {}

    const { data, error } = await supabase
      .from('alumnos')
      .select('*')
      .eq('colegio_id', COLEGIO_ID);

    if (error) {
      console.error('[DB] getAlumnos:', error.message);
      try { if(typeof window.toast === 'function') window.toast('No se pudo cargar alumnos: revisa RLS', 'warning'); } catch(_) {}
      return [];
    }
    if (!data || !data.length) { try { LSC.del(cacheKey); } catch(_) {} return []; }

    // ============================================================
    // NORMALIZACIÓN SÍNCRONA (CANON EXCEL):
    // ============================================================
    // PETICIÓN EXPLÍCITA USUARIO VERBATIM (2026-08-24):
    //   "se tiene q basar en el excel olvida otra regla anterior, si
    //    en excel inidca q son avaznado asi sera, y no dberia aparece
    //    enada de inicial/intermedio pq no hay ningun alumno
    //    registrado por ahora en ese nivel"
    //
    // => NUNCA tocamos el campo ciclo en runtime ni en persistencia.
    //    Respetamos el VALOR QUE VINO DEL EXCEL importado (y guardado
    //    tal cual en Supabase).
    // => Solo normalizamos GRADO, SECCIÓN y TURNO (razones obvias:
    //    limpiar strings extraños, mayus/minus, acentos, etc).
    // => AutoFix IIFE background: NO actualizamos ciclo en BD.
    // ============================================================
    try {
      for (let i = 0; i < data.length; i++) {
        const rowRaw = data[i];
        const orig = JSON.stringify({
          ciclo: String(rowRaw.ciclo||''),
          grado: String(rowRaw.grado||''),
          seccion: String(rowRaw.seccion||''),
          turno: String(rowRaw.turno||'')
        });

        // Grado: solo dígito
        let g = String(rowRaw.grado || '').trim();
        if (g) { const m = g.match(/(\d+)/); if (m) g = m[1]; }

        // Sección: letra mayúscula sola
        let s = String(rowRaw.seccion || '').trim().toUpperCase();
        if (s) { const m = s.match(/[A-Z]/); if (m) s = m[0]; }

        // Turno canon
        const t = _dbNormTurno(rowRaw.turno || '');

        // CICLO: LO RESPETAMOS TAL CUAL VINO DEL EXCEL.
        // NUNCA reclasificamos ni normalizamos ciclo.
        const c = String(rowRaw.ciclo || '').trim();

        // Aplicar al objeto row raw para runtime
        rowRaw.ciclo   = c;
        rowRaw.grado   = g;
        rowRaw.seccion = s;
        if (t) rowRaw.turno = t;

        // Marcar si cambió (solo grado/seccion/turno — CICLO NUNCA)
        const after = JSON.stringify({
          ciclo: String(rowRaw.ciclo||''),
          grado: String(rowRaw.grado||''),
          seccion: String(rowRaw.seccion||''),
          turno: String(rowRaw.turno||'')
        });
        rowRaw._dbAutoFixChanged = (orig !== after);
      }
    } catch(eSync) {
      console.warn('[DB syncFix] Error en normalización síncrona (continuamos de todos modos):', eSync?.message || eSync);
    }

    // ============================================================
    // REPARACIÓN AUTOMÁTICA TRANSPARENTE (IIFE BACKGROUND — PERSISTENCIA):
    // Solo actualizamos grado, seccion y turno canon. CICLO NUNCA.
    // ============================================================
    (async () => {
      try {
        let fixes = 0;
        let rlsFails = 0;
        const _norms = (s) => { try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); } catch(_){ return String(s||''); } };
        const _normModAtencionDB = (val) => {
          let s = String(val || '').trim();
          s = _norms(s).toUpperCase().replace(/[\s\-_\.·,;]/g, '');
          if (!s) return '';
          if (s.includes('PRESEN') || s === 'P' || s === 'PRE' || s.startsWith('PRES')) return 'PRESENCIAL';
          if (s.includes('SEMI') || s === 'S' || s === 'SEM' || s.includes('MIXTO') || s.includes('HIBRIDO') || s.startsWith('SEM')) return 'SEMIPRESENCIAL';
          if (s.includes('VIRT') || s === 'V' || s.includes('REMOTO') || s.includes('ONLINE') || s.startsWith('VIR')) return 'VIRTUAL';
          return String(val || '').trim();
        };
        for (const rowRaw of data) {
          if (!rowRaw._dbAutoFixChanged) continue;
          const orig = JSON.stringify({
            ciclo: String(rowRaw.ciclo||''),
            grado: String(rowRaw.grado||''),
            seccion: String(rowRaw.seccion||''),
            turno: String(rowRaw.turno||'')
          });
          let row = Object.assign({}, rowRaw);
          // ⚠️ CICLO LO RESPETAMOS (trim simple, sin cambio)
          row.ciclo   = String(row.ciclo || '').trim();
          row.grado   = String(row.grado   || '').trim();
          row.seccion = String(row.seccion || '').trim();
          row.turno   = String(row.turno   || '').trim();
          // Grado: solo dígito
          if (row.grado) {
            const m = String(row.grado).match(/(\d+)/);
            if (m) row.grado = m[1];
          }
          // Sección: letra mayúscula sola A-Z
          if (row.seccion) {
            const s = String(row.seccion).trim().toUpperCase().match(/[A-Z]/);
            if (s) row.seccion = s[0];
          }
          // Turno normalizado
          if (row.turno) {
            const nt = _normModAtencionDB(row.turno);
            if (nt) row.turno = nt;
          }
          const after = JSON.stringify({
            ciclo: String(row.ciclo||''),
            grado: String(row.grado||''),
            seccion: String(row.seccion||''),
            turno: String(row.turno||'')
          });
          if (orig !== after) {
            try {
              const cleanId = String(row.id || '').trim().replace(/\s+/g, '');
              if (cleanId) {
                const { error } = await supabase
                  .from('alumnos')
                  .update({
                    // ⚠️ NO actualizamos ciclo — respetamos el valor del Excel
                    grado:   row.grado || '',
                    seccion: row.seccion || '',
                    turno:   row.turno || '',
                  })
                  .eq('colegio_id', COLEGIO_ID)
                  .eq('id', cleanId);
                if (error) {
                  rlsFails++;
                  console.error('[DB autoFix] RLS bloqueó UPDATE (no crítico) id=' + cleanId + ':', error?.message || JSON.stringify(error));
                } else {
                  fixes++;
                }
              }
            } catch(_e) {
              rlsFails++;
              console.error('[DB autoFix] Excepción UPDATE id=' + (row?.id) + ':', _e?.message || _e);
            }
          }
        }
        if (fixes > 0 || rlsFails > 0) {
          console.info(`[DB autoFix] Persistencia finalizada. Guardados OK: ${fixes}/${data.length}. Fallos RLS/excepción: ${rlsFails}.`);
          try {
            try { LSC.del(cacheKey); } catch(_) {}
            try { LSC.del('alumnos'); } catch(_) {}
            DB._alumnosCache = null;
            DB._alumnosCacheKey = '';
            DB._alumnosScopedCache = {};
            if (typeof window._purgarCacheAlumnos === 'function') {
              try { window._purgarCacheAlumnos('auto-fix'); } catch(_) {}
            }
            if (typeof window.toast === 'function' && fixes > 0) {
              window.toast(`✅ Base actualizada: ${fixes} alumnos (grado/sección/turno) reparados automáticamente`, 'success', 4000);
            }
            if (typeof window.toast === 'function' && rlsFails > 0 && fixes === 0) {
              window.toast(`ℹ️ Normalización aplicada en pantalla (${rlsFails} registros pendientes de guardar en BD — permisos RLS)`, 'info', 5000);
            }
          } catch(_) {}
        }
      } catch(e) {
        console.warn('[DB autoFix] Reparación automática falló (no crítico):', e?.message || e);
      }
    })();

    // Normalizar nombres de campos (snake_case → camelCase).
    this._alumnosCache = data.map(_normAlumno);
    this._alumnosCacheKey = cacheKey;
    LSC.set(cacheKey, this._alumnosCache, LSC.TTL_ALUMNOS);
    return this._alumnosCache;
  },

  async getAlumnoById(id) {
    const sid = String(id || '').trim();
    if (!sid) return null;
    const { data, error } = await supabase
      .from('alumnos')
      .select('*')
      .eq('colegio_id', COLEGIO_ID)
      .eq('id', sid)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return _normAlumno(data);
  },

  // Carga solo los alumnos de los grados/secciones asignadas al profesor.
  // asignaciones: { 'grado': ['A','B'] }
  async getAlumnosScoped(asignaciones) {
    const grados = Object.keys(asignaciones || {});
    if (!grados.length) return this.getAlumnos();

    const uid = (window.currentUser && window.currentUser.uid) ? window.currentUser.uid : 'anon';
    const normAsig = {};
    grados.sort().forEach(g => {
      const arr = Array.isArray(asignaciones[g]) ? asignaciones[g] : [];
      const normArr = arr.map(x => String(x || '').trim().toUpperCase()).filter(Boolean).sort();
      normAsig[String(g)] = normArr;
    });
    const cacheKey = 'scoped:' + _CACHE_VER + ':' + COLEGIO_ID + ':' + uid + ':' + JSON.stringify(normAsig);
    if (this._alumnosScopedCache[cacheKey]) return this._alumnosScopedCache[cacheKey];
    const lsData = LSC.get(cacheKey);
    if (lsData) { this._alumnosScopedCache[cacheKey] = lsData; return lsData; }

    // Soporte para nuevas asignaciones con ciclo (CEBA): asignaciones es un array [{ciclo,grado,seccion}]
    const aulasList = Array.isArray(asignaciones) ? asignaciones :
      Object.entries(normAsig).flatMap(([g, secs]) => secs.map(s => ({ ciclo:'', grado: String(g||''), seccion: String(s||'') })));

    // Supabase: WHERE grado IN (...) — sin límite de 10 como Firestore
    const gradosUnicos = [...new Set(aulasList.map(a => String(a.grado||'')).filter(Boolean))];
    const { data, error } = await supabase
      .from('alumnos')
      .select('*')
      .eq('colegio_id', COLEGIO_ID)
      .in('grado', gradosUnicos);

    if (error) { console.error('[DB] getAlumnosScoped:', error.message); return []; }

    const result = data
      .map(_normAlumno)
      .filter(a => {
        // match con cualquier aula de la lista.
        // SEGURIDAD ANTI-AMBIGÜEDAD CEBA (versión relajada v2):
        //   Si la BD guarda `ciclo` en los alumnos (modalidad CEBA/EBA) y la aula del scope
        //   NO trae ciclo (x.ciclo = '' vacío, legado de asignaciones obj {grado:[secs]} sin ciclo)
        //   → PERMITIR match SÓLO SI el grado numérico APARECE EN UN SOLO CICLO según cfg.grados.
        //     Si aparece en 2+ ciclos (grado 1 en INICIAL e INTERMEDIO) → NO coincide (ambiguo).
        //   En EBR donde alumnos.ciclo está vacío → cicloMatch sigue siendo true y funciona igual.
        const cfgRef = (typeof window.getConfigCachedOnce === 'function')
          ? (window.getConfigCachedOnce() || {})
          : ((typeof window.getConfig === 'function') ? (window.configCache || {}) : {});
        const gradoAmbiguoCfg = (gradoRaw, oCfg) => {
          try {
            const gClean = String(gradoRaw || '').trim();
            const gNum = (gClean.match(/\d+/) || [])[0];
            if (!gNum) return { unico: false, ciclo: '' };
            const gRef = (oCfg && oCfg.grados) ? oCfg : {};
            const cycles = [];
            Object.keys(gRef.grados || {}).forEach(k => {
              const list = Array.isArray(gRef.grados[k]) ? gRef.grados[k] : [];
              const ok = list.some(x => (String(x || '').match(/\d+/) || [])[0] === gNum);
              if (!ok) return;
              const kUp = String(k || '').toUpperCase();
              let c = '';
              if (kUp.includes('INICIAL') && !kUp.includes('INTERMEDIO') && !kUp.includes('AVANZADO')) c = 'INICIAL';
              else if (kUp.includes('INTERMEDIO') && !kUp.includes('AVANZADO')) c = 'INTERMEDIO';
              else if (kUp.includes('AVANZADO')) c = 'AVANZADO';
              else if (typeof window._canonCicloJS === 'function') c = window._canonCicloJS(k) || '';
              if (c) cycles.push(c);
            });
            const u = [...new Set(cycles.filter(Boolean))];
            if (u.length === 1) return { unico: true, ciclo: u[0] };
            return { unico: false, ciclo: '' };
          } catch (_) { return { unico: false, ciclo: '' }; }
        };
        return aulasList.some(x => {
          const xCiclo = String(x.ciclo || '').trim().toUpperCase();
          const aCiclo = String(a.ciclo || '').trim().toUpperCase();
          let cicloMatch;
          if (!xCiclo && aCiclo) {
            const amb = gradoAmbiguoCfg(a.grado, cfgRef);
            if (amb && amb.unico && amb.ciclo) cicloMatch = (amb.ciclo === aCiclo);
            else cicloMatch = false;
          } else {
            cicloMatch = !xCiclo || !aCiclo || (xCiclo === aCiclo);
          }
          const gradoOk = String(a.grado||'').trim() === String(x.grado||'').trim();
          if (!gradoOk || !cicloMatch) return false;
          // si la aula pide seccion '' → todas las secciones de ese grado
          if (!x.seccion) return true;
          const secA = String(a.seccion || '').trim().toUpperCase();
          const secX = String(x.seccion || '').trim().toUpperCase();
          return secA === secX;
        });
      });

    this._alumnosScopedCache[cacheKey] = result;
    LSC.set(cacheKey, result, LSC.TTL_ALUMNOS);
    return result;
  },

  invalidarAlumnos() {
    this._alumnosCache = null;
    this._alumnosCacheKey = '';
    this._alumnosScopedCache = {};
    LSC.del('alumnos');
    try {
      Object.keys(localStorage)
        .filter(k => {
          const ks = String(k || '');
          return (
            ks.startsWith('scoped:') || ks.startsWith('asmqr_scoped:') ||
            ks.startsWith('alumnos:') || ks.startsWith('asmqr_alumnos:') ||
            ks.startsWith('aulas:') || ks.startsWith('asmqr_aulas:')
          );
        })
        .forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  },

  async bumpAlumnosVersion() {
    // En Supabase usamos Realtime — no necesitamos doc de versión.
    // El canal de Realtime notifica automáticamente a otros dispositivos.
    // Este método existe solo para compatibilidad con el código actual.
  },

  async saveAlumno(alumno) {
    const cleanId = (alumno.id || '').trim().replace(/\s+/g, '');
    const row = _alumnoToRow({ ...alumno, id: cleanId });

    const { error } = await supabase
      .from('alumnos')
      .upsert(row, { onConflict: 'colegio_id,id' });

    if (error) throw new Error(error.message);
    this.invalidarAlumnos();
  },

  async updateAlumnoFoto(id, foto) {
    const sid = String(id || '').trim();
    const f = String(foto || '').trim();
    if (!sid) throw new Error('ID inválido');
    const { data, error } = await supabase
      .from('alumnos')
      .update({ foto: f })
      .eq('colegio_id', COLEGIO_ID)
      .eq('id', sid)
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Alumno no encontrado en base de datos');
    this.invalidarAlumnos();
  },

  async deleteAlumno(id) {
    const { error } = await supabase
      .from('alumnos')
      .delete()
      .eq('colegio_id', COLEGIO_ID)
      .eq('id', id);

    if (error) throw new Error(error.message);
    this.invalidarAlumnos();
  },

  async updateAlumnoId(oldId, newData) {
    // En SQL: borrar viejo e insertar nuevo (igual que Firestore batch)
    const { error: errDel } = await supabase
      .from('alumnos').delete()
      .eq('colegio_id', COLEGIO_ID).eq('id', oldId);
    if (errDel) throw new Error(errDel.message);

    const { error: errIns } = await supabase
      .from('alumnos')
      .insert(_alumnoToRow(newData));
    if (errIns) throw new Error(errIns.message);

    this.invalidarAlumnos();
  },

  async getAulas() {
    const cacheKey = 'aulas:' + COLEGIO_ID;
    const lsData = LSC.get(cacheKey);
    if (Array.isArray(lsData) && lsData.length) return lsData;
    if (!supabase || typeof supabase.rpc !== 'function') return [];
    const { data, error } = await supabase.rpc('list_aulas', { p_colegio_id: COLEGIO_ID });
    if (error) {
      console.error('[DB] getAulas:', error.message);
      return [];
    }
    const out = (data || []).map(r => ({
      grado: r.grado || r.grado_text || r.grado_id || '',
      seccion: r.seccion || '',
      turno: r.turno || ''
    }));
    if (out && out.length) LSC.set(cacheKey, out, LSC.TTL_ALUMNOS);
    return out;
  },

  // ── REGISTROS ─────────────────────────────────────────────

  _registrosCache: {},
  _registrosCacheTime: {},
  _CACHE_TTL: 5 * 60 * 1000,

  _cacheKey(filtros) {
    let base = 'todos';
    if (filtros.fecha && filtros.alumnoId) base = 'fecha_alumno:' + filtros.fecha + '_' + filtros.alumnoId;
    else if (filtros.fecha)    base = 'fecha:' + filtros.fecha;
    else if (filtros.alumnoId) base = 'alumno:' + filtros.alumnoId;
    else if (filtros.mes)      base = 'mes:' + filtros.mes;
    else if (filtros.anio)     base = 'anio:' + filtros.anio;
    else if (filtros.desde && filtros.hasta) base = 'rango:' + filtros.desde + '_' + filtros.hasta;

    const extra = [];
    if (filtros.turno)  extra.push('n=' + filtros.turno);
    if (filtros.grado)  extra.push('g=' + filtros.grado);
    if (filtros.seccion) extra.push('s=' + filtros.seccion);
    if (filtros.tipo)   extra.push('t=' + filtros.tipo);
    if (filtros.estado) extra.push('e=' + filtros.estado);
    if (filtros.columns && filtros.columns !== '*') extra.push('c=' + filtros.columns);
    if (filtros.alumnoIds && Array.isArray(filtros.alumnoIds)) {
      const ids = filtros.alumnoIds.map(x => String(x)).sort();
      let h = 2166136261;
      const str = ids.join(',');
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      extra.push('ids=' + (h >>> 0) + ':' + ids.length);
    }
    return extra.length ? (base + '|' + extra.join('&')) : base;
  },

  _cacheValido(key) {
    const t = this._registrosCacheTime[key];
    if (!t) return false;
    const mesActual  = _mesLocalActual();
    const anioActual = new Date().getFullYear();
    const esMesPasado  = key.startsWith('mes:')  && key.slice(4) < mesActual;
    const esAnioPasado = key.startsWith('anio:') && parseInt(key.slice(5)) < anioActual;
    const esMesActual  = key === 'mes:' + mesActual;
    const ttl = (esMesPasado || esAnioPasado) ? LSC.TTL_REGISTROS_MES_PASADO
              : esMesActual                   ? 30 * 60 * 1000
              :                                 this._CACHE_TTL;
    return (Date.now() - t) < ttl;
  },

  async getRegistros(filtros = {}) {
    const key = this._cacheKey(filtros);
    if (this._registrosCache[key] && this._cacheValido(key)) return this._registrosCache[key];
    if (key === 'todos' || key.startsWith('fecha:')) {
      const lsData = LSC.get('reg_' + key);
      if (lsData) {
        this._registrosCache[key] = lsData;
        this._registrosCacheTime[key] = Date.now();
        return lsData;
      }
    }

    try {
      let selectCols = filtros.columns || '*';
      if (typeof selectCols === 'string' && selectCols !== '*') {
        const required = ['alumno_id', 'tipo', 'fecha', 'hora', 'estado'];
        const parts = selectCols.split(',').map(s => s.trim()).filter(Boolean);
        const set = new Set(parts);
        required.forEach(c => set.add(c));
        selectCols = [...set].join(',');
      }
      let q = supabase
        .from('registros')
        .select(selectCols)
        .eq('colegio_id', COLEGIO_ID);

      if (filtros.fecha)    q = q.eq('fecha', filtros.fecha);
      if (filtros.alumnoId) q = q.eq('alumno_id', filtros.alumnoId);
      if (filtros.grado)   q = q.eq('grado', filtros.grado);
      if (filtros.seccion) q = q.eq('seccion', filtros.seccion);
      if (filtros.ciclo)   q = q.eq('ciclo', String(filtros.ciclo||'').trim().toUpperCase());
      if (filtros.turno)   q = q.eq('turno', filtros.turno);
      if (filtros.tipo)     q = q.eq('tipo', filtros.tipo);
      if (filtros.estado)   q = q.eq('estado', filtros.estado);
      if (filtros.mes) {
        const [y, m] = filtros.mes.split('-').map(Number);
        const desde  = filtros.mes + '-01';
        const hasta  = filtros.mes + '-' + String(new Date(y, m, 0).getDate()).padStart(2, '0');
        q = q.gte('fecha', desde).lte('fecha', hasta);
      }
      if (filtros.anio) {
        q = q.gte('fecha', filtros.anio + '-01-01').lte('fecha', filtros.anio + '-12-31');
      }
      if (filtros.desde && filtros.hasta) {
        q = q.gte('fecha', filtros.desde).lte('fecha', filtros.hasta);
      }

      const needsPaging =
        key === 'todos' ||
        key.startsWith('mes:') ||
        key.startsWith('anio:') ||
        key.startsWith('rango:');

      let data = [];
      const PAGE = 1000;
      const qOrdered = (qb) => qb
        .order('fecha', { ascending: true })
        .order('alumno_id', { ascending: true })
        .order('hora', { ascending: true });

      const fetchPaged = async (qb) => {
        let out = [];
        let from = 0;
        while (true) {
          const { data: page, error } = await qb.range(from, from + PAGE - 1);
          if (error) { console.error('[DB] getRegistros:', error.message); return []; }
          if (!page || !page.length) break;
          out = out.concat(page);
          if (page.length < PAGE) break;
          from += PAGE;
          if (from > 200000) break;
        }
        return out;
      };

      if (filtros.alumnoIds && Array.isArray(filtros.alumnoIds) && filtros.alumnoIds.length) {
        const ids = [...new Set(filtros.alumnoIds.map(x => String(x)).filter(Boolean))];
        const CHUNK = 200;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          const base = qOrdered(q.in('alumno_id', chunk));
          const rows = await fetchPaged(base);
          if (rows.length) data = data.concat(rows);
        }
      } else if (needsPaging) {
        data = await fetchPaged(qOrdered(q));
      } else {
        const { data: one, error } = await qOrdered(q);
        if (error) { console.error('[DB] getRegistros:', error.message); return []; }
        data = one || [];
      }

      const resultado = data.map(_normRegistro);

      this._registrosCache[key] = resultado;
      this._registrosCacheTime[key] = Date.now();
      if (key === 'todos' || key.startsWith('fecha:') || key.startsWith('mes:')) {
        const mesActual   = _mesLocalActual();
        const esMesPasado = key.startsWith('mes:') && key.slice(4) < mesActual;
        const esMesActual = key === 'mes:' + mesActual;
        const ttlLS = esMesPasado ? LSC.TTL_REGISTROS_MES_PASADO
                    : esMesActual ? 30 * 60 * 1000
                    :               LSC.TTL_REGISTROS;
        LSC.set('reg_' + key, resultado, ttlLS);
      }
      return resultado;
    } catch (e) {
      console.error('[DB] getRegistros error:', e);
      return [];
    }
  },

  invalidarRegistros(fecha = null) {
    if (fecha) {
      delete this._registrosCache['fecha:' + fecha];
      delete this._registrosCacheTime['fecha:' + fecha];
      delete this._registrosCache['todos'];
      delete this._registrosCacheTime['todos'];
      LSC.del('reg_fecha:' + fecha);
      LSC.del('reg_todos');
      Object.keys(this._registrosCache)
        .filter(k => k.startsWith('fecha_alumno:' + fecha))
        .forEach(k => { delete this._registrosCache[k]; delete this._registrosCacheTime[k]; });
      const mes = fecha.substring(0, 7);
      delete this._registrosCache['mes:' + mes];
      delete this._registrosCacheTime['mes:' + mes];
      LSC.del('reg_mes:' + mes);
      delete this._resumenMesCache[mes];
      delete this._resumenMesCacheTime[mes];
    } else {
      this._registrosCache = {};
      this._registrosCacheTime = {};
      this._resumenMesCache = {};
      this._resumenMesCacheTime = {};
      try {
        Object.keys(localStorage).filter(k => k.startsWith('asmqr_reg_')).forEach(k => localStorage.removeItem(k));
      } catch (e) {}
    }
  },

  async saveRegistro(reg) {
    // Obtener usuario actual de Supabase Auth
    const { data: { user } } = await _sb.auth.getUser();
    if (!reg.registradoPor && user) reg.registradoPor = user.email || user.id;

    const row = {
      colegio_id:     COLEGIO_ID,
      alumno_id:      reg.alumnoId,
      tipo:           reg.tipo,
      fecha:          reg.fecha,
      hora:           reg.hora,
      estado:         reg.estado || 'Puntual',
      nombre:         reg.nombre  || '',
      grado:          reg.grado   || '',
      seccion:        reg.seccion || '',
      ciclo:          reg.ciclo   || '',
      turno:          reg.turno   || '',
      registrado_por: reg.registradoPor || '',
    };

    const { error } = await _sb.from('registros').insert(row);
    if (error) {
      const code = String(error.code || '');
      const msg = String(error.message || '');
      if (code === '23505' || msg.toLowerCase().includes('duplicate key')) {
        return;
      }
      throw new Error(error.message);
    }

    this.invalidarRegistros(reg.fecha);

    // Actualizar resumen_mensual usando la función SQL (equivale a FieldValue.increment)
    if (reg.tipo === 'INGRESO') {
      const mes        = reg.fecha.substring(0, 7);
      const esTardanza = (reg.estado || '').trim() === 'Tardanza';
      const { error: eRes } = await _sb.rpc('upsert_resumen_mensual', {
        p_colegio_id:  COLEGIO_ID,
        p_mes:         mes,
        p_alumno_id:   reg.alumnoId,
        p_es_tardanza: esTardanza,
      });
      if (eRes) console.warn('[DB] resumen_mensual update failed:', eRes.message);
    }
  },

  // ── RESUMEN MENSUAL ───────────────────────────────────────

  _resumenMesCache: {},
  _resumenMesCacheTime: {},

  async getResumenMes(mes) {
    const mesActual = _mesLocalActual();
    const esPasado  = mes < mesActual;
    const ttl       = esPasado ? (30 * 24 * 60 * 60 * 1000) : (5 * 60 * 1000);
    const cached    = this._resumenMesCache[mes];
    const t         = this._resumenMesCacheTime[mes];
    if (cached && t && (Date.now() - t) < ttl) return cached;

    const { data, error } = await supabase
      .from('resumen_mensual')
      .select('alumno_id, puntual, tardanza')
      .eq('colegio_id', COLEGIO_ID)
      .eq('mes', mes);

    if (error) { console.warn('[DB] getResumenMes:', error.message); return []; }

    const result = data.map(r => ({
      alumnoId: r.alumno_id,
      puntual:  r.puntual  || 0,
      tardanza: r.tardanza || 0,
    }));

    this._resumenMesCache[mes] = result;
    this._resumenMesCacheTime[mes] = Date.now();
    return result;
  },

  async getAlertasEnvios(opts = {}) {
    const desde  = typeof opts.desde === 'string'  ? opts.desde  : '';
    const hasta  = typeof opts.hasta === 'string'  ? opts.hasta  : '';
    const turno  = typeof opts.turno === 'string'  ? opts.turno  : '';
    const grado  = typeof opts.grado === 'string'  ? opts.grado  : '';
    const seccion= typeof opts.seccion === 'string'? opts.seccion: '';
    const limit  = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, opts.limit)) : 200;

    let q = supabase
      .from('alertas_envios')
      .select('id,created_at,tipo,periodo_key,contador,alumno_id,alumno_nombre,turno,grado,seccion,telefono_destino,estado,error,sent_at')
      .eq('colegio_id', COLEGIO_ID)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (desde) q = q.gte('created_at', desde + 'T00:00:00');
    if (hasta) q = q.lte('created_at', hasta + 'T23:59:59');
    if (turno) q = q.eq('turno', turno);
    if (grado) q = q.eq('grado', grado);
    if (seccion) q = q.eq('seccion', seccion);

    const { data, error } = await q;
    if (error) { console.warn('[DB] getAlertasEnvios:', error.message); return []; }

    const fmt = (ts) => {
      if (!ts) return '';
      const s = String(ts);
      return s.includes('T') ? s.replace('T', ' ').slice(0, 16) : s;
    };

    return (data || []).map(r => ({
      id: r.id,
      createdAt: fmt(r.created_at),
      tipo: r.tipo,
      periodoKey: r.periodo_key || '',
      contador: r.contador || 0,
      alumnoId: r.alumno_id || '',
      alumnoNombre: r.alumno_nombre || '',
      turno: r.turno || '',
      grado: r.grado || '',
      seccion: r.seccion || '',
      telefonoDestino: r.telefono_destino || '',
      estado: r.estado || '',
      error: r.error || '',
      sentAt: fmt(r.sent_at),
    }));
  },

  async deleteRegistrosByFecha(fecha) {
    // Obtener alumnoIds afectados antes de borrar (para recalcular resumen)
    const { data: prevData } = await supabase
      .from('registros')
      .select('alumno_id')
      .eq('colegio_id', COLEGIO_ID)
      .eq('fecha', fecha)
      .eq('tipo', 'INGRESO');

    const alumnoIds = [...new Set((prevData || []).map(r => r.alumno_id))];

    const { error } = await supabase
      .from('registros')
      .delete()
      .eq('colegio_id', COLEGIO_ID)
      .eq('fecha', fecha);

    if (error) throw new Error(error.message);
    this.invalidarRegistros(fecha);

    // Recalcular resumen para los alumnos afectados
    if (alumnoIds.length) {
      const mes = fecha.substring(0, 7);
      for (const alumnoId of alumnoIds) {
        _sb.rpc('recalcular_resumen_mes', {
          p_colegio_id: COLEGIO_ID,
          p_mes:        mes,
          p_alumno_id:  alumnoId,
        }).then(({ error: e }) => {
          if (e) console.warn('[DB] recalcular_resumen_mes:', alumnoId, e.message);
        });
      }
    }
  },

};  // fin DB

// ============================================================
// REALTIME — reemplaza onSnapshot de Firestore
// Notifica a todos los dispositivos conectados cuando cambian
// alumnos o config, invalidando su cache automáticamente.
// ============================================================

let _realtimeChannel = null;

function iniciarRealtimeListeners() {
  if (_realtimeChannel) return;

  _realtimeChannel = supabase
    .channel('db-changes')

    // Cambios en alumnos → invalidar cache (equivale a onSnapshot config/alumnos_ts)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'alumnos', filter: `colegio_id=eq.${COLEGIO_ID}` },
      () => {
        DB.invalidarAlumnos();
        const secAlumnos = document.getElementById('sec-alumnos');
        if (secAlumnos && secAlumnos.style.display !== 'none' && secAlumnos.style.display !== '') {
          if (typeof renderAlumnos === 'function') renderAlumnos();
        }
      }
    )

    // Cambios en config (colegios) → invalidar cache de config
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'colegios', filter: `id=eq.${COLEGIO_ID}` },
      () => {
        if (typeof invalidateConfig === 'function') invalidateConfig();
        const secConfig = document.getElementById('sec-config');
        if (secConfig && secConfig.style.display !== 'none' && secConfig.style.display !== '') {
          if (typeof renderConfig === 'function') renderConfig();
        }
      }
    )

    .subscribe();
}

function detenerRealtimeListeners() {
  if (_realtimeChannel) {
    _sb.removeChannel(_realtimeChannel);
    _realtimeChannel = null;
  }
}

// ============================================================
// NORMALIZACIÓN — convierte snake_case (SQL) ↔ camelCase (JS)
// ============================================================

// Helper NFD + remover acentos/diacríticos (reutilizable)
function _dbNFD(s) { try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,''); } catch(_){ return String(s||''); } }

// Normalizador de modalidad atención (igual que AutoFix + _normModAtencion index.html):
//  - PRESENCIAL, SEMIPRESENCIAL, VIRTUAL (nunca otras variantes)
//  - Robusto ante acentos, espacios, caracteres especiales
function _dbNormTurno(val) {
  let s = String(val || '').trim();
  if (!s) return '';
  s = _dbNFD(s).toUpperCase().replace(/[\s\-_\.·,;\/\\]/g, '');
  if (!s) return String(val || '').trim();
  if (s.includes('PRESEN') || s === 'P' || s === 'PRE' || s.startsWith('PRES')) return 'PRESENCIAL';
  if (s.includes('SEMI') || s === 'S' || s === 'SEM' || s.includes('MIXTO') || s.includes('HIBRIDO') || s.startsWith('SEM')) return 'SEMIPRESENCIAL';
  if (s.includes('VIRT') || s === 'V' || s.includes('REMOTO') || s.includes('ONLINE') || s.startsWith('VIR')) return 'VIRTUAL';
  return String(val || '').trim();
}

// Normalizador de ciclo CANON EXCEL (NO reclasifica):
// Respetamos el valor que vino del Excel importado.
// Solo: trim + uppercase limpio para comparaciones consistentes.
// NUNCA cambiamos INICIAL/INTERMEDIO ↔ AVANZADO.
function _dbNormCiclo(val) {
  const cicloTrim = String(val || '').trim();
  if (!cicloTrim) return '';
  const cicloUp = _dbNFD(cicloTrim).toUpperCase();
  // Unificar variantes del MISMO nivel EXCEL:
  if (
    cicloUp === 'INICIAL/INTERMEDIO' || cicloUp === 'INICIAL / INTERMEDIO' ||
    cicloUp === 'INICIAL' || cicloUp === 'INTERMEDIO' ||
    cicloUp === 'INI/INT' || cicloUp === 'INICI/INTER'
  ) {
    return 'INICIAL/INTERMEDIO';
  }
  if (cicloUp.includes('AVANZADO') || cicloUp.includes('AVANZ') || cicloUp === 'AV') {
    return 'AVANZADO';
  }
  return cicloTrim;
}

function _normAlumno(row) {
  // ⚠️ CANON EXCEL: Respetamos ciclo tal cual vino del Excel/BD.
  const r = Object.assign({}, row || {});

  // (1) Grado: quitar (Inicial)/(Intermedio)/(Avanzado) → solo dígito
  let gradoOut = String(r.grado || '').trim();
  if (gradoOut) {
    const m = gradoOut.match(/(\d+)/);
    if (m) gradoOut = m[1];
  }

  // (2) Sección: letra mayúscula sola A-Z
  let seccionOut = String(r.seccion || '').trim().toUpperCase();
  if (seccionOut) {
    const m = seccionOut.match(/[A-Z]/);
    if (m) seccionOut = m[0];
  }

  // (3) Turno canon (PRES/SEMI/VIRT)
  const turnoOut = _dbNormTurno(r.turno || '');

  // (4) Ciclo: SOLO normalizar formato (unificar variantes de escritura).
  //     NUNCA reclasificar según grado/turno. Respetar Excel.
  const cicloOut = _dbNormCiclo(r.ciclo || '');

  return {
    id:                  r.id,
    nombres:             r.nombres             || '',
    apellidos:           r.apellidos           || '',
    ciclo:               cicloOut,
    grado:               gradoOut,
    seccion:             seccionOut,
    turno:               turnoOut,
    limite:              r.limite              || '08:00',
    foto:                r.foto                || '',
    apoderadoNombres:    r.apoderado_nombres   || '',
    apoderadoApellidos:  r.apoderado_apellidos || '',
    telefono:            r.telefono            || '',
    apoderado2Nombres:   r.apoderado2_nombres  || '',
    apoderado2Apellidos: r.apoderado2_apellidos|| '',
    telefono2:           r.telefono2           || '',
    correoApoderado:     r.correo_apoderado    || '',
  };
}

function _alumnoToRow(alumno) {
  return {
    colegio_id:           COLEGIO_ID,
    id:                   alumno.id,
    nombres:              alumno.nombres             || '',
    apellidos:            alumno.apellidos           || '',
    ciclo:                String(alumno.ciclo||'').trim().toUpperCase(),
    grado:                alumno.grado               || '',
    seccion:              alumno.seccion             || 'A',
    turno:                alumno.turno               || 'Primaria',
    limite:               alumno.limite              || '08:00',
    foto:                 alumno.foto                || '',
    apoderado_nombres:    alumno.apoderadoNombres    || '',
    apoderado_apellidos:  alumno.apoderadoApellidos  || '',
    telefono:             alumno.telefono            || '',
    apoderado2_nombres:   alumno.apoderado2Nombres   || '',
    apoderado2_apellidos: alumno.apoderado2Apellidos || '',
    telefono2:            alumno.telefono2           || '',
    correo_apoderado:     alumno.correoApoderado     || '',
  };
}

function _normRegistro(row) {
  return {
    // El código actual usa alumnoId (camelCase)
    alumnoId:      row.alumno_id,
    tipo:          row.tipo,
    fecha:         typeof row.fecha === 'string' ? row.fecha : row.fecha.toISOString().slice(0, 10),
    hora:          row.hora,
    estado:        row.estado || 'Puntual',
    nombre:        row.nombre  || '',
    grado:         row.grado   || '',
    seccion:       row.seccion || '',
    ciclo:         String(row.ciclo||'').trim().toUpperCase(),
    turno:         row.turno   || '',
    registradoPor: row.registrado_por || '',
  };
}

function _mesLocalActual() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
