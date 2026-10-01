'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  CONSULTA DE PRECIO AL DUEÑO (mientras el cliente espera en línea)
//  ------------------------------------------------------------------------------
//  Cuando el bot no tiene precio para un caso:
//   1. El agente llama a la herramienta consultar_dueno con un resumen breve.
//   2. Aquí se crea la consulta y se manda un WhatsApp al dueño (CallMeBot) con
//      el caso y un enlace /r/<token> para responder desde el celular. También
//      se puede responder desde el Centro de mando.
//   3. El agente llama a esperar_respuesta_dueno en bucle: cada llamada espera
//      hasta ~15 s. Entre una y otra el agente le habla al cliente ("deme otro
//      momentito…"), así nunca hay más de ~20 s de silencio.
//   4. Si el dueño no responde a tiempo, se le dice al cliente que lo llaman en
//      breve para confirmar el costo.
//  Se prende/apaga desde el panel (ajuste "consulta_dueno").
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { pool } = require('./db');
const emitter = require('./events');
const { enviarWhatsApp } = require('./whatsapp');

const ESPERA_POR_LLAMADA_MS = 15_000;

const AJUSTES_DEFECTO = {
  consulta_dueno: {
    activa: false,
    whatsapp: '',            // número del dueño, ej. 17876650980
    callmebot_apikey: '',
    espera_max_seg: 120,     // tiempo máximo con el cliente en espera
  },
};

// ── Ajustes ──────────────────────────────────────────────────────────────────

async function leerAjuste(clave) {
  const { rows } = await pool.query('SELECT valor FROM ajustes WHERE clave = $1', [clave]);
  return { ...(AJUSTES_DEFECTO[clave] || {}), ...(rows[0]?.valor || {}) };
}

async function guardarAjuste(clave, valor) {
  const actual = await leerAjuste(clave);
  const nuevo = { ...actual, ...valor };
  await pool.query(
    `INSERT INTO ajustes (clave, valor) VALUES ($1, $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [clave, JSON.stringify(nuevo)]
  );
  return nuevo;
}

/** Versión para el panel: la apikey no viaja completa. */
function ajustesPublicos(a) {
  const k = a.callmebot_apikey || '';
  return {
    activa: Boolean(a.activa),
    whatsapp: a.whatsapp || '',
    apikey_configurada: Boolean(k),
    apikey_vista: k ? `••••${k.slice(-3)}` : '',
    espera_max_seg: Number(a.espera_max_seg) || 120,
  };
}

async function obtenerAjustesConsulta() {
  return ajustesPublicos(await leerAjuste('consulta_dueno'));
}

async function actualizarAjustesConsulta(cambios = {}) {
  const permitido = {};
  if ('activa' in cambios) permitido.activa = Boolean(cambios.activa);
  if ('whatsapp' in cambios) permitido.whatsapp = String(cambios.whatsapp || '').replace(/[^\d+]/g, '');
  if (cambios.callmebot_apikey) permitido.callmebot_apikey = String(cambios.callmebot_apikey).trim();
  if ('espera_max_seg' in cambios) {
    permitido.espera_max_seg = Math.min(300, Math.max(30, Number(cambios.espera_max_seg) || 120));
  }
  const nuevo = ajustesPublicos(await guardarAjuste('consulta_dueno', permitido));
  emitter.emit('ajustes_actualizados', { consulta_dueno: nuevo });
  return nuevo;
}

async function consultaActiva() {
  const a = await leerAjuste('consulta_dueno');
  return Boolean(a.activa);
}

// ── Consultas ────────────────────────────────────────────────────────────────

/** consultaId → [resolve] de los esperar_respuesta_dueno pendientes */
const esperando = new Map();

function vista(f) {
  if (!f) return null;
  return {
    id: f.id,
    conversation_id: f.conversation_id,
    numero_cliente: f.numero_cliente,
    resumen: f.resumen,
    pregunta: f.pregunta,
    estado: f.estado,
    respuesta: f.respuesta,
    respondida_por: f.respondida_por,
    whatsapp_ok: f.whatsapp_ok,
    creada_en: f.creada_en instanceof Date ? f.creada_en.toISOString() : f.creada_en,
    respondida_en: f.respondida_en instanceof Date ? f.respondida_en.toISOString() : f.respondida_en,
  };
}

/**
 * Crea la consulta y avisa al dueño por WhatsApp.
 * @returns {{ activa: boolean, consulta?: object }}
 */
async function crearConsulta({ resumen, pregunta, conversation_id, numero_cliente }, baseUrl) {
  const ajustes = await leerAjuste('consulta_dueno');
  if (!ajustes.activa) return { activa: false };

  const id = `CONS-${Date.now().toString(36).toUpperCase()}`;
  const token = crypto.randomBytes(18).toString('base64url');
  const { rows } = await pool.query(
    `INSERT INTO consultas (id, token, conversation_id, numero_cliente, resumen, pregunta)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, token, conversation_id || '', numero_cliente || '', String(resumen || '').slice(0, 600), String(pregunta || '¿Qué precio le damos?').slice(0, 300)]
  );
  let consulta = rows[0];
  emitter.emit('consulta_nueva', vista(consulta));

  const enlace = `${baseUrl}/r/${token}`;
  const texto = [
    '🔑 *CONSULTA DE PRECIO* — Tu Cerrajero Puerto Rico',
    '',
    '📞 Cliente esperando en la línea' + (numero_cliente ? ` (${numero_cliente})` : ''),
    `📝 ${consulta.resumen}`,
    `❓ ${consulta.pregunta}`,
    '',
    `👉 Responde aquí: ${enlace}`,
  ].join('\n');
  const r = await enviarWhatsApp(ajustes.whatsapp, ajustes.callmebot_apikey, texto);
  console.log(`📱 Consulta ${id} → WhatsApp dueño: ${r.ok ? '✅' : `❌ ${r.status || r.error}`}`);
  if (r.ok) {
    ({ rows: [consulta] } = await pool.query('UPDATE consultas SET whatsapp_ok = true WHERE id = $1 RETURNING *', [id]));
    emitter.emit('consulta_actualizada', vista(consulta));
  }
  return { activa: true, consulta: vista(consulta), whatsapp_ok: r.ok };
}

/**
 * Espera hasta ~15 s la respuesta del dueño (long-poll para el agente).
 * @returns {{ estado: 'respondida'|'pendiente'|'expirada'|'no_existe', respuesta?, segundos }}
 */
async function esperarRespuesta(id) {
  const leer = async () => (await pool.query('SELECT * FROM consultas WHERE id = $1', [id])).rows[0];
  let c = await leer();
  if (!c) return { estado: 'no_existe', segundos: 0 };

  const segundos = () => Math.round((Date.now() - new Date(c.creada_en)) / 1000);
  if (c.estado !== 'pendiente') return { estado: c.estado, respuesta: c.respuesta, segundos: segundos() };

  const { espera_max_seg } = await leerAjuste('consulta_dueno');
  const restanteMs = Math.max(0, espera_max_seg * 1000 - (Date.now() - new Date(c.creada_en)));
  if (restanteMs > 0) {
    await new Promise(resolve => {
      const t = setTimeout(resolve, Math.min(ESPERA_POR_LLAMADA_MS, restanteMs));
      const lista = esperando.get(id) || [];
      lista.push(() => { clearTimeout(t); resolve(); });
      esperando.set(id, lista);
    });
    c = await leer();
    if (c.estado !== 'pendiente') return { estado: c.estado, respuesta: c.respuesta, segundos: segundos() };
  }

  if (segundos() >= espera_max_seg) {
    ({ rows: [c] } = await pool.query(
      `UPDATE consultas SET estado = 'expirada' WHERE id = $1 AND estado = 'pendiente' RETURNING *`, [id]
    ));
    if (c) emitter.emit('consulta_actualizada', vista(c));
    return { estado: 'expirada', segundos: espera_max_seg };
  }
  return { estado: 'pendiente', segundos: segundos() };
}

/** Respuesta del dueño (desde el enlace de WhatsApp o desde el panel). */
async function responderConsulta({ id, token }, respuesta, por) {
  const texto = String(respuesta || '').trim().slice(0, 600);
  if (!texto) throw new Error('Escribe la respuesta');
  const { rows } = await pool.query(
    `UPDATE consultas SET estado = 'respondida', respuesta = $2, respondida_por = $3, respondida_en = NOW()
     WHERE (id = $1 OR token = $1) AND estado IN ('pendiente', 'expirada') RETURNING *`,
    [id || token, texto, por || '']
  );
  if (!rows[0]) throw new Error('Esta consulta ya fue respondida o no existe');
  const c = rows[0];
  for (const despertar of esperando.get(c.id) || []) despertar();
  esperando.delete(c.id);
  emitter.emit('consulta_actualizada', vista(c));
  return vista(c);
}

async function consultaPorToken(token) {
  const { rows } = await pool.query('SELECT * FROM consultas WHERE token = $1', [token]);
  return vista(rows[0]);
}

async function listarConsultas(limite = 30) {
  const { rows } = await pool.query('SELECT * FROM consultas ORDER BY creada_en DESC LIMIT $1', [Math.min(Number(limite) || 30, 200)]);
  return rows.map(vista);
}

module.exports = {
  obtenerAjustesConsulta,
  actualizarAjustesConsulta,
  consultaActiva,
  crearConsulta,
  esperarRespuesta,
  responderConsulta,
  consultaPorToken,
  listarConsultas,
};
