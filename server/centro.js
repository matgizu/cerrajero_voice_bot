'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  CENTRO DE MANDO — llamadas en vivo, historial, transcripciones y consumo
//  ------------------------------------------------------------------------------
//  - El bridge telefónico (elevenlabs-bridge.js) avisa aquí cada evento de la
//    llamada: inicio (con el número), mensajes, herramientas y fin.
//  - Las llamadas en curso viven en memoria; al terminar se guardan en la tabla
//    `llamadas` y se piden a ElevenLabs el costo, créditos y tokens.
//  - Todo cambio se emite por `events` y el panel lo recibe por SSE.
// ══════════════════════════════════════════════════════════════════════════════

const { pool } = require('./db');
const emitter = require('./events');

const EL_API = 'https://api.elevenlabs.io/v1';
const TZ = 'America/Puerto_Rico';

/** callSid → llamada en curso */
const activas = new Map();

// ── Llamadas en vivo (las llama el bridge) ───────────────────────────────────

function vistaActiva(l) {
  return {
    id: l.id,
    conversation_id: l.conversationId,
    numero: l.numero,
    direccion: l.direccion,
    inicio: l.inicio.toISOString(),
    transcript: l.transcript,
  };
}

function iniciarLlamada({ callSid, numero, direccion }) {
  if (!callSid || activas.has(callSid)) return;
  const l = {
    id: callSid,
    conversationId: null,
    numero: numero || '',
    direccion: direccion || '',
    inicio: new Date(),
    transcript: [],
  };
  activas.set(callSid, l);
  emitter.emit('llamada_iniciada', vistaActiva(l));
}

function asociarConversacion(callSid, conversationId) {
  const l = activas.get(callSid);
  if (!l) return;
  l.conversationId = conversationId;
  emitter.emit('llamada_actualizada', vistaActiva(l));
}

/** rol: 'agente' | 'cliente' | 'herramienta' */
function agregarMensaje(callSid, rol, texto) {
  const l = activas.get(callSid);
  if (!l || !texto) return;
  const msg = { rol, texto: String(texto), seg: Math.round((Date.now() - l.inicio) / 1000) };
  l.transcript.push(msg);
  emitter.emit('llamada_mensaje', { id: callSid, ...msg });
}

/** El agente fue interrumpido: ElevenLabs manda lo que alcanzó a decir. */
function corregirUltimoAgente(callSid, texto) {
  const l = activas.get(callSid);
  if (!l || !texto) return;
  for (let i = l.transcript.length - 1; i >= 0; i--) {
    if (l.transcript[i].rol === 'agente') { l.transcript[i].texto = texto; break; }
  }
  emitter.emit('llamada_actualizada', vistaActiva(l));
}

/** Número del cliente de una llamada en curso, buscando por conversation_id. */
function numeroDeConversacion(conversationId) {
  for (const l of activas.values()) if (l.conversationId === conversationId) return l.numero;
  return '';
}

async function finalizarLlamada(callSid, motivo = '') {
  const l = activas.get(callSid);
  if (!l) return;
  activas.delete(callSid);
  const fin = new Date();
  const duracion = Math.round((fin - l.inicio) / 1000);

  try {
    await pool.query(
      `INSERT INTO llamadas (id, conversation_id, numero, direccion, inicio, fin, duracion_seg, transcript, fin_motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         conversation_id = EXCLUDED.conversation_id, fin = EXCLUDED.fin,
         duracion_seg = EXCLUDED.duracion_seg, transcript = EXCLUDED.transcript, fin_motivo = EXCLUDED.fin_motivo`,
      [l.id, l.conversationId, l.numero, l.direccion, l.inicio, fin, duracion, JSON.stringify(l.transcript), motivo]
    );
  } catch (err) {
    console.error('❌ No pude guardar la llamada:', err.message);
  }
  emitter.emit('llamada_finalizada', { id: l.id, duracion_seg: duracion });

  // ElevenLabs tarda unos segundos en tener el costo; se reintenta.
  if (l.conversationId) {
    setTimeout(() => enriquecer(l.id).catch(() => {}), 15_000);
    setTimeout(() => enriquecer(l.id).catch(() => {}), 90_000);
  }
}

// ── Métricas de ElevenLabs ───────────────────────────────────────────────────

async function elevenlabs(ruta) {
  const r = await fetch(`${EL_API}${ruta}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' } });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}`);
  return r.json();
}

/** Suma todos los tokens del LLM (entrada, caché y salida) de una conversación. */
function contarTokens(llmUsage) {
  let total = 0;
  for (const gen of Object.values(llmUsage || {})) {
    for (const uso of Object.values(gen?.model_usage || {})) {
      for (const parte of Object.values(uso || {})) total += Number(parte?.tokens) || 0;
    }
  }
  return total;
}

function transcriptDesdeElevenLabs(conv) {
  const out = [];
  for (const t of conv.transcript || []) {
    for (const tc of t.tool_calls || []) out.push({ rol: 'herramienta', texto: tc.tool_name, seg: t.time_in_call_secs || 0 });
    if (t.message) out.push({ rol: t.role === 'agent' ? 'agente' : 'cliente', texto: t.message.trim(), seg: t.time_in_call_secs || 0 });
  }
  return out;
}

/** Trae costo, créditos, tokens y resumen de ElevenLabs y los guarda. */
async function enriquecer(id) {
  const { rows } = await pool.query('SELECT * FROM llamadas WHERE id = $1', [id]);
  const fila = rows[0];
  if (!fila?.conversation_id || fila.metricas_ok) return fila;

  const conv = await elevenlabs(`/convai/conversations/${fila.conversation_id}`);
  if (conv.status !== 'done' && conv.status !== 'failed') return fila; // todavía procesando

  const m = conv.metadata || {};
  const c = m.charging || {};
  const transcript = Array.isArray(fila.transcript) && fila.transcript.length
    ? fila.transcript
    : transcriptDesdeElevenLabs(conv);
  const { rows: srv } = await pool.query('SELECT id FROM servicios WHERE conversation_id = $1 LIMIT 1', [fila.conversation_id]);

  const { rows: act } = await pool.query(
    `UPDATE llamadas SET
       costo_usd = $2, creditos = $3, tokens_llm = $4, tts_seg = $5, asr_seg = $6,
       resumen = $7, servicio_id = COALESCE(servicio_id, $8), transcript = $9,
       duracion_seg = COALESCE(duracion_seg, $10), metricas_ok = true
     WHERE id = $1 RETURNING *`,
    [
      id,
      m.cost_fiat ?? null,
      m.cost ?? null,
      contarTokens(c.llm_usage),
      c.tts_usage?.total_audio_output_seconds ?? null,
      c.asr_usage?.total_audio_input_seconds ?? null,
      conv.analysis?.call_summary_title || '',
      srv[0]?.id || null,
      JSON.stringify(transcript),
      m.call_duration_secs ?? null,
    ]
  );
  const llamada = filaAVista(act[0]);
  emitter.emit('llamada_historial', llamada);
  return act[0];
}

/**
 * Importa al historial las conversaciones de ElevenLabs que no estén en la BD
 * (llamadas anteriores al centro de mando). No traen el número del cliente.
 */
async function importarHistorial(max = 100) {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!agentId || !process.env.ELEVENLABS_API_KEY) return 0;
  let cursor = '';
  let nuevas = 0;
  const pendientes = [];
  while (pendientes.length + nuevas < max) {
    const d = await elevenlabs(`/convai/conversations?agent_id=${agentId}&page_size=50${cursor ? `&cursor=${cursor}` : ''}`);
    for (const c of d.conversations || []) {
      const { rowCount } = await pool.query(
        `INSERT INTO llamadas (id, conversation_id, inicio, duracion_seg, resumen, fin, fin_motivo)
         VALUES ($1, $1, to_timestamp($2), $3, $4, to_timestamp($2 + COALESCE($3, 0)), $5)
         ON CONFLICT DO NOTHING`,
        [c.conversation_id, c.start_time_unix_secs, c.call_duration_secs ?? null, c.call_summary_title || '', c.termination_reason || '']
      );
      if (rowCount) { nuevas++; pendientes.push(c.conversation_id); }
    }
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  // Métricas en segundo plano, una a la vez para no saturar la API.
  (async () => {
    for (const id of pendientes) {
      await enriquecer(id).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    }
  })();
  return nuevas;
}

// ── Consultas para el panel ──────────────────────────────────────────────────

function filaAVista(f) {
  if (!f) return null;
  return {
    id: f.id,
    conversation_id: f.conversation_id,
    numero: f.numero,
    direccion: f.direccion,
    inicio: f.inicio instanceof Date ? f.inicio.toISOString() : f.inicio,
    duracion_seg: f.duracion_seg,
    resumen: f.resumen,
    servicio_id: f.servicio_id,
    costo_usd: f.costo_usd == null ? null : Number(f.costo_usd),
    creditos: f.creditos,
    tokens_llm: f.tokens_llm,
    tts_seg: f.tts_seg == null ? null : Number(f.tts_seg),
    asr_seg: f.asr_seg == null ? null : Number(f.asr_seg),
    fin_motivo: f.fin_motivo,
    mensajes: Array.isArray(f.transcript) ? f.transcript.filter(m => m.rol !== 'herramienta').length : 0,
  };
}

async function listarLlamadas(limite = 100) {
  const { rows } = await pool.query(
    'SELECT * FROM llamadas ORDER BY inicio DESC LIMIT $1',
    [Math.min(Number(limite) || 100, 500)]
  );
  return rows.map(filaAVista);
}

async function obtenerLlamada(id) {
  let { rows } = await pool.query('SELECT * FROM llamadas WHERE id = $1 OR conversation_id = $1 LIMIT 1', [id]);
  let fila = rows[0];
  if (!fila) return null;
  const sinTranscript = !Array.isArray(fila.transcript) || fila.transcript.length === 0;
  if (fila.conversation_id && (!fila.metricas_ok || sinTranscript)) {
    fila = (await enriquecer(fila.id).catch(() => null)) || fila;
  }
  return { ...filaAVista(fila), transcript: fila.transcript || [] };
}

async function conversationIdDe(id) {
  const { rows } = await pool.query('SELECT conversation_id FROM llamadas WHERE id = $1 OR conversation_id = $1 LIMIT 1', [id]);
  return rows[0]?.conversation_id || null;
}

// Saldos externos: se cachean 60 s para no llamar a las APIs en cada refresco.
let cacheExternos = { t: 0, data: null };

async function datosExternos() {
  if (cacheExternos.data && Date.now() - cacheExternos.t < 60_000) return cacheExternos.data;
  const out = { elevenlabs: null, twilio: null };

  try {
    const s = await elevenlabs('/user/subscription');
    out.elevenlabs = {
      plan: s.tier,
      creditos_usados: s.character_count,
      creditos_limite: s.character_limit,
      reinicio: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null,
    };
  } catch (_) {}

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (sid && tok) {
    const auth = { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64') };
    try {
      const [bal, cta] = await Promise.all([
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, { headers: auth }).then(r => r.json()),
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, { headers: auth }).then(r => r.json()),
      ]);
      out.twilio = { saldo: Number(bal.balance), moneda: bal.currency, tipo_cuenta: cta.type };
    } catch (_) {}
  }

  cacheExternos = { t: Date.now(), data: out };
  return out;
}

// ── Llamadas de prueba desde el panel ────────────────────────────────────────
// Solo a números verificados en Twilio (Verified Caller IDs): así el botón no
// sirve para llamar a cualquiera y los números no quedan escritos en el código
// (el repo es público).

function twilio(ruta, opciones = {}) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error('Faltan TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN');
  return fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${ruta}`, {
    ...opciones,
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), ...(opciones.headers || {}) },
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || `Twilio ${r.status}`);
    return data;
  });
}

async function numerosPrueba() {
  const d = await twilio('/OutgoingCallerIds.json?PageSize=50');
  return (d.outgoing_caller_ids || []).map(c => ({ numero: c.phone_number, nombre: c.friendly_name }));
}

let numeroDelBot = process.env.TWILIO_PHONE_NUMBER || null;

async function llamarPrueba(numero) {
  const permitidos = await numerosPrueba();
  if (!permitidos.some(n => n.numero === numero)) {
    throw new Error('Ese número no está verificado en Twilio');
  }
  if (!numeroDelBot) {
    const d = await twilio('/IncomingPhoneNumbers.json?PageSize=1');
    numeroDelBot = d.incoming_phone_numbers?.[0]?.phone_number;
    if (!numeroDelBot) throw new Error('No encontré el número del bot en Twilio');
  }
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) throw new Error('Falta PUBLIC_URL');
  const r = await twilio('/Calls.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: numero, From: numeroDelBot, Url: `${base}/twilio/incoming`, Method: 'POST' }),
  });
  return { sid: r.sid, estado: r.status, numero };
}

async function resumen() {
  const hoyCond = `(inicio AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`;
  const mesCond = `date_trunc('month', inicio AT TIME ZONE '${TZ}') = date_trunc('month', NOW() AT TIME ZONE '${TZ}')`;
  const agregados = cond => pool.query(`
    SELECT COUNT(*)::int                          AS llamadas,
           COALESCE(SUM(duracion_seg), 0)::int     AS segundos,
           COALESCE(SUM(costo_usd), 0)::float      AS costo_usd,
           COALESCE(SUM(tokens_llm), 0)::bigint    AS tokens_llm,
           COALESCE(SUM(creditos), 0)::bigint      AS creditos,
           COUNT(servicio_id)::int                 AS con_servicio
      FROM llamadas WHERE ${cond}`);

  const [hoy, mes, porHora, srvHoy, externos] = await Promise.all([
    agregados(hoyCond),
    agregados(mesCond),
    pool.query(`
      SELECT to_char(date_trunc('hour', inicio AT TIME ZONE '${TZ}'), 'YYYY-MM-DD"T"HH24') AS hora, COUNT(*)::int AS n
        FROM llamadas WHERE inicio > NOW() - INTERVAL '24 hours'
       GROUP BY 1 ORDER BY 1`),
    pool.query(`SELECT COUNT(*)::int AS n FROM servicios WHERE (creado_en AT TIME ZONE '${TZ}')::date = (NOW() AT TIME ZONE '${TZ}')::date`),
    datosExternos(),
  ]);

  const num = r => ({ ...r, tokens_llm: Number(r.tokens_llm), creditos: Number(r.creditos) });
  return {
    activas: [...activas.values()].map(vistaActiva),
    lineas: { en_uso: activas.size, limite: Number(process.env.LIMITE_LLAMADAS_SIMULTANEAS) || 10 },
    hoy: { ...num(hoy.rows[0]), servicios_creados: srvHoy.rows[0].n },
    mes: num(mes.rows[0]),
    por_hora: porHora.rows,
    ...externos,
  };
}

module.exports = {
  iniciarLlamada,
  asociarConversacion,
  agregarMensaje,
  corregirUltimoAgente,
  finalizarLlamada,
  importarHistorial,
  listarLlamadas,
  obtenerLlamada,
  conversationIdDe,
  resumen,
  numerosPrueba,
  llamarPrueba,
  numeroDeConversacion,
};
