'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  Centro de mando — llamadas en vivo, indicadores, consumo e historial.
//  Usa el mismo canal SSE del panel (admin.js lo expone en window.__sse).
// ══════════════════════════════════════════════════════════════════════════════

(() => {
  const TZ = 'America/Puerto_Rico';
  const activas = new Map();     // id → llamada en curso
  let historial = [];
  let filtroHistorial = '';
  let ultimoResumen = null;

  // ── Formatos ─────────────────────────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtDuracion(seg) {
    if (seg == null) return '—';
    const s = Math.max(0, Math.round(seg));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }

  function fmtTelefono(n) {
    if (!n) return '<span class="muted">Sin número</span>';
    const d = String(n).replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) return esc(`(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`);
    if (d.length === 10) return esc(`(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);
    return esc(n);
  }

  const fmtDinero = (v, dec = 2) => (v == null ? '—' : `$${Number(v).toFixed(dec)}`);

  function fmtCompacto(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
  }

  const fmtFechaHora = iso => iso
    ? new Date(iso).toLocaleString('es-PR', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

  const $ = id => document.getElementById(id);

  // ── Indicadores ─────────────────────────────────────────────────────────────
  function renderKpis(r) {
    $('kpi-activas').textContent = activas.size;
    $('kpi-lineas').textContent = `${activas.size} de ${r.lineas.limite} líneas en uso`;
    $('kpi-hoy').textContent = r.hoy.llamadas;
    $('kpi-hoy-min').textContent = `${Math.round(r.hoy.segundos / 60)} min en total`;
    $('kpi-servicios').textContent = r.hoy.servicios_creados;
    $('kpi-conversion').textContent = r.hoy.llamadas
      ? `${Math.round((r.hoy.con_servicio / r.hoy.llamadas) * 100)}% de las llamadas terminan en servicio`
      : 'Sin llamadas hoy';
    $('kpi-costo-hoy').textContent = fmtDinero(r.hoy.costo_usd);
    $('kpi-costo-llamada').textContent = r.hoy.llamadas
      ? `${fmtDinero(r.hoy.costo_usd / r.hoy.llamadas, 3)} por llamada`
      : '—';
    $('kpi-costo-mes').textContent = fmtDinero(r.mes.costo_usd);
    $('kpi-llamadas-mes').textContent = `${r.mes.llamadas} llamadas · ${Math.round(r.mes.segundos / 60)} min`;
    $('kpi-tokens').textContent = fmtCompacto(r.mes.tokens_llm);
    $('kpi-creditos-mes').textContent = `${fmtCompacto(r.mes.creditos)} créditos de ElevenLabs`;
    document.querySelector('.kpi-vivo').classList.toggle('con-llamadas', activas.size > 0);
  }

  // ── Gráfica por hora ────────────────────────────────────────────────────────
  const fmtHoraPR = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  function claveHora(d) {
    const p = Object.fromEntries(fmtHoraPR.formatToParts(d).map(x => [x.type, x.value]));
    return { clave: `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}`, hora: Number(p.hour) % 24 };
  }

  function renderHoras(porHora) {
    const mapa = Object.fromEntries((porHora || []).map(x => [x.hora, x.n]));
    const slots = [];
    for (let i = 23; i >= 0; i--) {
      const { clave, hora } = claveHora(new Date(Date.now() - i * 3600e3));
      slots.push({ hora, n: mapa[clave] || 0 });
    }
    const max = Math.max(1, ...slots.map(s => s.n));
    const total = slots.reduce((a, s) => a + s.n, 0);
    $('horas-total').textContent = `${total} llamada${total === 1 ? '' : 's'}`;
    $('centro-horas').innerHTML = slots.map((s, i) => {
      const etiqueta = s.hora === 0 ? '12a' : s.hora < 12 ? `${s.hora}a` : s.hora === 12 ? '12p' : `${s.hora - 12}p`;
      return `<div class="barra" title="${etiqueta}: ${s.n} llamada${s.n === 1 ? '' : 's'}">
        <span class="barra-n">${s.n || ''}</span>
        <span class="barra-fill${i === slots.length - 1 ? ' actual' : ''}" style="height:${(s.n / max) * 100}%"></span>
        <span class="barra-h">${i % 3 === 2 || i === slots.length - 1 ? etiqueta : ''}</span>
      </div>`;
    }).join('');
  }

  // ── Consumo y saldos ────────────────────────────────────────────────────────
  function renderConsumo(r) {
    const el = r.elevenlabs, tw = r.twilio;
    let html = '';
    if (el) {
      const pct = el.creditos_limite ? Math.min(100, (el.creditos_usados / el.creditos_limite) * 100) : 0;
      const clase = pct > 90 ? 'peligro' : pct > 70 ? 'alerta' : '';
      html += `<div class="consumo-item">
        <div class="consumo-head"><strong>ElevenLabs</strong><span class="chip">${esc(el.plan || '')}</span></div>
        <div class="medidor ${clase}"><span style="width:${pct.toFixed(1)}%"></span></div>
        <div class="consumo-sub">${fmtCompacto(el.creditos_usados)} de ${fmtCompacto(el.creditos_limite)} créditos (${pct.toFixed(0)}%)` +
        (el.reinicio ? ` · se reinicia el ${new Date(el.reinicio).toLocaleDateString('es-PR', { day: '2-digit', month: 'short' })}` : '') + `</div>
      </div>`;
    } else {
      html += `<div class="consumo-item"><strong>ElevenLabs</strong><div class="consumo-sub">No disponible</div></div>`;
    }
    if (tw) {
      const prueba = String(tw.tipo_cuenta || '').toLowerCase() === 'trial';
      html += `<div class="consumo-item">
        <div class="consumo-head"><strong>Twilio</strong>${prueba ? '<span class="chip chip-alerta">Cuenta de prueba</span>' : '<span class="chip chip-ok">Activa</span>'}</div>
        <div class="consumo-saldo ${tw.saldo < 5 ? 'peligro' : ''}">${fmtDinero(tw.saldo)} <small>${esc(tw.moneda || '')}</small></div>
        <div class="consumo-sub">${prueba ? 'En modo prueba solo entran llamadas de números verificados y suena un mensaje en inglés.' : 'Saldo disponible para llamadas.'}</div>
      </div>`;
    } else {
      html += `<div class="consumo-item"><strong>Twilio</strong><div class="consumo-sub">Configura TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN para ver el saldo.</div></div>`;
    }
    $('centro-consumo').innerHTML = html;
    $('consumo-actualizado').textContent = `Actualizado ${new Date().toLocaleTimeString('es-PR', { hour: '2-digit', minute: '2-digit' })}`;
  }

  // ── Llamadas en curso ───────────────────────────────────────────────────────
  function burbuja(m) {
    if (m.rol === 'herramienta') {
      const nombre = { consultar_precio: 'Consultó precio', cotizar_llave: 'Cotizó llave', guardar_servicio: 'Guardó el servicio' }[m.texto] || m.texto;
      return `<div class="msg msg-tool">⚙️ ${esc(nombre)}</div>`;
    }
    return `<div class="msg msg-${m.rol === 'agente' ? 'agente' : 'cliente'}">
      <span class="msg-quien">${m.rol === 'agente' ? '🤖 Bot' : '👤 Cliente'} · ${fmtDuracion(m.seg)}</span>
      <span class="msg-texto">${esc(m.texto)}</span>
    </div>`;
  }

  function renderActivas() {
    const cont = $('centro-activas');
    if (!activas.size) {
      cont.innerHTML = '<div class="vacio">No hay llamadas en este momento.</div>';
    } else {
      cont.innerHTML = [...activas.values()].map(l => `
        <div class="llamada-viva" data-id="${esc(l.id)}">
          <div class="llamada-head">
            <span class="punto-vivo"></span>
            <strong>${fmtTelefono(l.numero)}</strong>
            <span class="chip">${l.direccion === 'saliente' ? 'Saliente' : 'Entrante'}</span>
            <span class="llamada-timer" data-inicio="${esc(l.inicio)}">${fmtDuracion((Date.now() - new Date(l.inicio)) / 1000)}</span>
          </div>
          <div class="llamada-transcript">${l.transcript.length ? l.transcript.map(burbuja).join('') : '<div class="vacio">Esperando que hablen…</div>'}</div>
        </div>`).join('');
      cont.querySelectorAll('.llamada-transcript').forEach(t => { t.scrollTop = t.scrollHeight; });
    }
    if (ultimoResumen) renderKpis(ultimoResumen);
  }

  setInterval(() => {
    document.querySelectorAll('.llamada-timer').forEach(t => {
      t.textContent = fmtDuracion((Date.now() - new Date(t.dataset.inicio)) / 1000);
    });
  }, 1000);

  // ── Historial ───────────────────────────────────────────────────────────────
  function renderHistorial() {
    const q = filtroHistorial.toLowerCase();
    const filas = historial.filter(l => !q ||
      String(l.numero || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '\u0000') ||
      String(l.resumen || '').toLowerCase().includes(q));
    $('historial-tbody').innerHTML = filas.length ? filas.map(l => `
      <tr class="fila-llamada" data-id="${esc(l.id)}">
        <td>${fmtFechaHora(l.inicio)}</td>
        <td>${fmtTelefono(l.numero)}</td>
        <td>${fmtDuracion(l.duracion_seg)}</td>
        <td class="resumen-celda">${esc(l.resumen) || '<span class="muted">—</span>'}</td>
        <td>${l.servicio_id ? `<span class="chip chip-ok">${esc(l.servicio_id)}</span>` : '<span class="muted">No</span>'}</td>
        <td>${fmtDinero(l.costo_usd, 3)}</td>
        <td>${l.tokens_llm == null ? '—' : fmtCompacto(l.tokens_llm)}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="vacio">Sin llamadas todavía.</td></tr>';
    document.querySelectorAll('.fila-llamada').forEach(tr => tr.addEventListener('click', () => abrirLlamada(tr.dataset.id)));
  }

  async function abrirLlamada(id) {
    const overlay = $('modal-overlay');
    const body = $('modal-body');
    body.innerHTML = '<div class="vacio">Cargando llamada…</div>';
    overlay.classList.remove('hidden');
    try {
      const r = await fetch(`/api/centro/llamadas/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error();
      const l = await r.json();
      const metricas = [
        ['Duración', fmtDuracion(l.duracion_seg)],
        ['Costo', fmtDinero(l.costo_usd, 3)],
        ['Créditos', l.creditos ?? '—'],
        ['Tokens IA', l.tokens_llm == null ? '—' : fmtCompacto(l.tokens_llm)],
        ['Voz del bot', l.tts_seg == null ? '—' : `${Math.round(l.tts_seg)} s`],
        ['Audio escuchado', l.asr_seg == null ? '—' : `${Math.round(l.asr_seg)} s`],
      ];
      body.innerHTML = `
        <h2 class="detalle-titulo">${fmtTelefono(l.numero)}</h2>
        <p class="detalle-sub">${fmtFechaHora(l.inicio)}${l.resumen ? ` · ${esc(l.resumen)}` : ''}${l.servicio_id ? ` · Servicio <strong>${esc(l.servicio_id)}</strong>` : ''}</p>
        <div class="detalle-metricas">${metricas.map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>
        ${l.conversation_id ? `<audio class="detalle-audio" controls preload="none" src="/api/centro/llamadas/${encodeURIComponent(l.id)}/audio"></audio>` : ''}
        <div class="detalle-transcript">${(l.transcript || []).length ? l.transcript.map(burbuja).join('') : '<div class="vacio">Sin transcripción.</div>'}</div>`;
    } catch (_) {
      body.innerHTML = '<div class="vacio">No pude cargar esta llamada.</div>';
    }
  }

  // ── Carga de datos ──────────────────────────────────────────────────────────
  async function cargarResumen() {
    try {
      const r = await (await fetch('/api/centro/resumen')).json();
      ultimoResumen = r;
      activas.clear();
      for (const l of r.activas) activas.set(l.id, l);
      renderKpis(r);
      renderHoras(r.por_hora);
      renderConsumo(r);
      renderActivas();
    } catch (_) {}
  }

  async function cargarHistorial() {
    try {
      historial = await (await fetch('/api/centro/llamadas?limite=200')).json();
      renderHistorial();
    } catch (_) {}
  }

  // ── Tiempo real ─────────────────────────────────────────────────────────────
  function sonar() {
    try {
      const ctx = new AudioContext(), osc = ctx.createOscillator(), g = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.frequency.value = 520;
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(); osc.stop(ctx.currentTime + 0.5);
    } catch (_) {}
  }

  const registrados = new WeakSet();
  function registrar(es) {
    if (!es || registrados.has(es)) return;
    registrados.add(es);
    es.addEventListener('conectado', () => { cargarResumen(); cargarHistorial(); });
    es.addEventListener('llamada_iniciada', e => {
      const l = JSON.parse(e.data);
      activas.set(l.id, l);
      renderActivas();
      sonar();
      if (typeof showToast === 'function') showToast(`📞 Llamada entrando: ${l.numero || 'número desconocido'}`, 'info');
    });
    es.addEventListener('llamada_actualizada', e => {
      const l = JSON.parse(e.data);
      if (activas.has(l.id)) { activas.set(l.id, l); renderActivas(); }
    });
    es.addEventListener('llamada_mensaje', e => {
      const m = JSON.parse(e.data);
      const l = activas.get(m.id);
      if (!l) return;
      l.transcript.push({ rol: m.rol, texto: m.texto, seg: m.seg });
      const cont = document.querySelector(`.llamada-viva[data-id="${CSS.escape(m.id)}"] .llamada-transcript`);
      if (cont) {
        cont.querySelector('.vacio')?.remove();
        cont.insertAdjacentHTML('beforeend', burbuja(m));
        cont.scrollTop = cont.scrollHeight;
      } else renderActivas();
    });
    es.addEventListener('llamada_finalizada', e => {
      const { id } = JSON.parse(e.data);
      activas.delete(id);
      renderActivas();
      setTimeout(() => { cargarResumen(); cargarHistorial(); }, 1500);
    });
    es.addEventListener('consulta_nueva', e => {
      consultas.unshift(JSON.parse(e.data));
      renderConsultas();
      sonar();
      if (typeof showToast === 'function') showToast('🧑‍💼 El bot está consultando un precio — el cliente espera en la línea', 'info');
    });
    es.addEventListener('consulta_actualizada', e => {
      const c = JSON.parse(e.data);
      const i = consultas.findIndex(x => x.id === c.id);
      if (i >= 0) consultas[i] = c; else consultas.unshift(c);
      renderConsultas();
    });
    es.addEventListener('ajustes_actualizados', e => {
      const d = JSON.parse(e.data);
      if (d.consulta_dueno) pintarAjustesConsulta(d.consulta_dueno);
    });
    es.addEventListener('llamada_historial', e => {
      const l = JSON.parse(e.data);
      const i = historial.findIndex(x => x.id === l.id);
      if (i >= 0) historial[i] = l; else historial.unshift(l);
      renderHistorial();
    });
  }
  document.addEventListener('sse-conectado', e => registrar(e.detail));
  registrar(window.__sse);

  // ── Llamadas de prueba ──────────────────────────────────────────────────────
  async function cargarNumerosPrueba() {
    const cont = $('prueba-botones');
    try {
      const r = await fetch('/api/centro/numeros-prueba');
      if (!r.ok) throw new Error();
      const numeros = await r.json();
      if (!numeros.length) {
        cont.innerHTML = '<span class="panel-hint">No hay números verificados en Twilio.</span>';
        return;
      }
      cont.innerHTML = numeros.map(n => {
        const tel = fmtTelefono(n.numero);
        // En Twilio el "friendly name" a veces es el mismo número: solo se muestra si es un nombre.
        const nombre = n.nombre && /[a-záéíóúñ]/i.test(n.nombre) ? esc(n.nombre) : '';
        return `<button class="btn btn-primary btn-llamar" data-numero="${esc(n.numero)}">
          📞 Llamar ${nombre ? `a ${nombre} <small>${tel}</small>` : tel}
        </button>`;
      }).join('');
      cont.querySelectorAll('.btn-llamar').forEach(b => b.addEventListener('click', () => llamar(b)));
    } catch (_) {
      cont.innerHTML = '<span class="panel-hint">No pude cargar los números de Twilio.</span>';
    }
  }

  async function llamar(boton) {
    const numero = boton.dataset.numero;
    if (!confirm(`¿Llamar ahora al ${numero}? El bot va a marcar y la llamada se cobra del saldo de Twilio.`)) return;
    const original = boton.innerHTML;
    boton.disabled = true;
    boton.innerHTML = '📞 Marcando…';
    try {
      const r = await fetch('/api/centro/llamar-prueba', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      if (typeof showToast === 'function') showToast(`📞 Llamando al ${numero}… contesta y marca una tecla`, 'info');
    } catch (err) {
      if (typeof showToast === 'function') showToast(`No se pudo llamar: ${err.message}`, 'error');
    }
    // Evita doble clic mientras la llamada arranca
    setTimeout(() => { boton.disabled = false; boton.innerHTML = original; }, 15_000);
  }

  // ── Consulta de precio al dueño ─────────────────────────────────────────────
  let consultas = [];

  function pintarAjustesConsulta(a) {
    $('consulta-activa').checked = a.activa;
    $('consulta-estado').textContent = a.activa ? 'Prendida' : 'Apagada';
    $('consulta-estado').classList.toggle('on', a.activa);
    if (document.activeElement !== $('consulta-whatsapp')) $('consulta-whatsapp').value = a.whatsapp || '';
    $('consulta-apikey').placeholder = a.apikey_configurada ? `Guardada (${a.apikey_vista}) — pega otra para cambiarla` : 'Pegar la clave';
    $('consulta-espera').value = String(a.espera_max_seg || 120);
  }

  function renderConsultas() {
    const cont = $('consultas-lista');
    if (!consultas.length) { cont.innerHTML = ''; return; }
    const etiqueta = { pendiente: ['⏳ Esperando respuesta', 'chip-alerta'], respondida: ['✅ Respondida', 'chip-ok'], expirada: ['⏱️ Sin respuesta a tiempo', ''] };
    cont.innerHTML = consultas.slice(0, 8).map(c => {
      const [txt, clase] = etiqueta[c.estado] || [c.estado, ''];
      return `<div class="consulta ${c.estado}" data-id="${esc(c.id)}">
        <div class="consulta-head">
          <span class="chip ${clase}">${txt}</span>
          <span class="panel-hint">${fmtFechaHora(c.creada_en)}${c.numero_cliente ? ` · ${fmtTelefono(c.numero_cliente)}` : ''}${c.whatsapp_ok ? ' · WhatsApp enviado' : ' · <span style="color:var(--warning)">WhatsApp no enviado</span>'}</span>
        </div>
        <div class="consulta-caso">${esc(c.resumen)}</div>
        <div class="consulta-pregunta">❓ ${esc(c.pregunta)}</div>
        ${c.estado === 'respondida'
          ? `<div class="consulta-respuesta">💬 ${esc(c.respuesta)} <span class="panel-hint">(${esc(c.respondida_por)})</span></div>`
          : `<div class="consulta-responder">
               <input type="text" placeholder="Escribe lo que el bot le debe decir…" data-resp="${esc(c.id)}">
               <button class="btn btn-primary" data-enviar="${esc(c.id)}">Responder</button>
             </div>`}
      </div>`;
    }).join('');
    cont.querySelectorAll('[data-enviar]').forEach(b => b.addEventListener('click', () => responderConsulta(b.dataset.enviar)));
    cont.querySelectorAll('[data-resp]').forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') responderConsulta(i.dataset.resp); }));
  }

  async function cargarConsultas() {
    try {
      const d = await (await fetch('/api/centro/consulta-dueno')).json();
      pintarAjustesConsulta(d.ajustes);
      consultas = d.consultas || [];
      renderConsultas();
    } catch (_) {}
  }

  async function guardarAjustesConsulta(cambios) {
    try {
      const r = await fetch('/api/centro/consulta-dueno', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cambios),
      });
      if (!r.ok) throw new Error();
      pintarAjustesConsulta(await r.json());
      return true;
    } catch (_) {
      if (typeof showToast === 'function') showToast('No se pudo guardar', 'error');
      return false;
    }
  }

  async function responderConsulta(id) {
    const input = document.querySelector(`[data-resp="${CSS.escape(id)}"]`);
    const respuesta = input?.value.trim();
    if (!respuesta) return;
    try {
      const r = await fetch(`/api/centro/consultas/${encodeURIComponent(id)}/responder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ respuesta }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      if (typeof showToast === 'function') showToast('✅ Respuesta enviada al bot', 'info');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'No se pudo responder', 'error');
    }
  }

  $('consulta-activa').addEventListener('change', async e => {
    const activa = e.target.checked;
    if (activa && !$('consulta-whatsapp').value.trim()) {
      if (typeof showToast === 'function') showToast('Pon el WhatsApp del dueño. Mientras tanto se puede responder desde aquí.', 'info');
    }
    if (await guardarAjustesConsulta({ activa }) && typeof showToast === 'function') {
      showToast(activa ? '🧑‍💼 Consulta al dueño PRENDIDA' : 'Consulta al dueño apagada: el bot promete llamar en breve', 'info');
    }
  });
  $('consulta-guardar').addEventListener('click', async () => {
    const cambios = { whatsapp: $('consulta-whatsapp').value, espera_max_seg: Number($('consulta-espera').value) };
    const k = $('consulta-apikey').value.trim();
    if (k) cambios.callmebot_apikey = k;
    if (await guardarAjustesConsulta(cambios)) {
      $('consulta-apikey').value = '';
      if (typeof showToast === 'function') showToast('Configuración guardada', 'info');
    }
  });

  // ── Controles ───────────────────────────────────────────────────────────────
  $('historial-buscar').addEventListener('input', e => { filtroHistorial = e.target.value.trim(); renderHistorial(); });
  $('historial-recargar').addEventListener('click', () => { cargarResumen(); cargarHistorial(); });

  cargarResumen();
  cargarHistorial();
  cargarNumerosPrueba();
  cargarConsultas();
  setInterval(cargarResumen, 20_000);
})();
