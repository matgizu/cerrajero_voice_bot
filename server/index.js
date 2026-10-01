/**
 * server/index.js — Servidor Express + WebSocket Proxy
 * 
 * Arquitectura:
 *   Browser ←──WebSocket──→ Este servidor ←──WebSocket──→ Gemini Live API
 * 
 * El servidor actúa como proxy seguro: la API Key NUNCA llega al cliente.
 * También intercepta Function Calls de Gemini y las ejecuta server-side.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const { buildSetupMessage, buildGeminiUrl } = require('./gemini');
const { initDB } = require('./db');
const { manejarFunctionCall, listarServicios, guardarServicio, consultarPrecio, actualizarEstado, reasignarCerrajero } = require('./services');
const { cotizarLlave } = require('./precios-llaves');
const { listarCerrajeros, toggleDisponibilidad } = require('./cerrajeros');
const { listarCatalogo, crearServicioCatalogo, actualizarServicioCatalogo, eliminarServicioCatalogo } = require('./catalogo');
const { getYears, getMakes, getModels, listarPreciosVehiculos, upsertPrecioVehiculo, eliminarPrecioVehiculo } = require('./precios-vehiculos');
const { listarPreciosAperturaMarca, upsertPrecioAperturaMarca, eliminarPrecioAperturaMarca } = require('./precios-apertura-marca');
const { handleTwilioStream } = require('./elevenlabs-bridge');
const centro = require('./centro');
const consultas = require('./consultas');
const dueno = require('./dueno');
const crypto = require('crypto');
const emitter = require('./events');

// ── Precios estimados Gemini Live API ────────────────────────────────────────
// Audio: ~25 tokens/segundo. Precios flash live aprox.
const INPUT_COST_PER_SEC  = 25 * 0.35  / 1_000_000; // $0.00000875/seg entrada
const OUTPUT_COST_PER_SEC = 25 * 1.05  / 1_000_000; // $0.00002625/seg salida

// ── Configuración ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1); // Railway: HTTPS termina en el proxy (cookies "secure")

// Un error de BD en una ruta async no debe tumbar el proceso completo.
process.on('unhandledRejection', (err) => {
  console.error('❌ unhandledRejection:', err?.stack || err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ uncaughtException:', err?.stack || err);
});

/** Envuelve un handler async: errores → 500 JSON en vez de crash. */
const safe = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`❌ Error en ${req.method} ${req.path}:`, err?.stack || err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // webhooks de Twilio (form POST)

// ── Contraseña del panel ──────────────────────────────────────────────────────
// El panel muestra teléfonos, direcciones, transcripciones y grabaciones de
// clientes. Con ADMIN_PASSWORD definida en Railway, /admin y la API del panel
// piden usuario/contraseña (HTTP Basic; el usuario puede ser cualquiera).
// Quedan públicas solo las rutas que usan Twilio, ElevenLabs y la web del bot.
const RUTAS_PUBLICAS = [
  /^\/api\/tools\//, /^\/api\/health$/, /^\/api\/voice-config$/, /^\/api\/elevenlabs\/signed-url$/,
];
function igualSeguro(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
app.use((req, res, next) => {
  const clave = process.env.ADMIN_PASSWORD;
  const esPanel = req.path.startsWith('/admin') ||
    (req.path.startsWith('/api/') && !RUTAS_PUBLICAS.some(r => r.test(req.path)));
  if (!clave || !esPanel) return next();
  const [tipo, valor] = (req.headers.authorization || '').split(' ');
  if (tipo === 'Basic' && valor) {
    const pass = Buffer.from(valor, 'base64').toString().split(':').slice(1).join(':');
    if (igualSeguro(pass, clave)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Panel Tu Cerrajero Puerto Rico", charset="UTF-8"');
  res.status(401).send('Acceso restringido');
});

// Servir archivos estáticos del cliente
app.use(express.static(path.join(__dirname, '../client')));

// ── SSE — Panel Admin (tiempo real) ───────────────────────────────────────────
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

emitter.on('servicio_nuevo',       data => broadcast('servicio_nuevo', data));
emitter.on('servicio_actualizado', data => broadcast('servicio_actualizado', data));
emitter.on('cerrajero_actualizado',data => broadcast('cerrajero_actualizado', data));
// Centro de mando
for (const ev of ['llamada_iniciada', 'llamada_actualizada', 'llamada_mensaje', 'llamada_finalizada', 'llamada_historial',
                  'consulta_nueva', 'consulta_actualizada', 'ajustes_actualizados']) {
  emitter.on(ev, data => broadcast(ev, data));
}

app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.write('event: conectado\ndata: {}\n\n');
  req.on('close', () => sseClients.delete(res));
});

// ── Rutas HTTP ─────────────────────────────────────────────────────────────────

// Servicios
app.get('/api/servicios', safe(async (_req, res) => {
  const lista = await listarServicios();
  res.json({ total: lista.length, servicios: lista });
}));

app.patch('/api/servicios/:id/estado', async (req, res) => {
  const { estado } = req.body;
  const resultado  = await actualizarEstado(req.params.id, estado);
  res.status(resultado.exito ? 200 : 400).json(resultado);
});

app.patch('/api/servicios/:id/asignar', async (req, res) => {
  const { cerrajero_id } = req.body;
  const resultado        = await reasignarCerrajero(req.params.id, cerrajero_id);
  res.status(resultado.exito ? 200 : 400).json(resultado);
});

// Cerrajeros
app.get('/api/cerrajeros', safe(async (_req, res) => {
  res.json(await listarCerrajeros());
}));

app.patch('/api/cerrajeros/:id/disponibilidad', async (req, res) => {
  const cerrajero = await toggleDisponibilidad(req.params.id);
  if (!cerrajero) return res.status(404).json({ error: 'Cerrajero no encontrado' });
  emitter.emit('cerrajero_actualizado', cerrajero);
  res.json(cerrajero);
});

// Catálogo de servicios
app.get('/api/catalogo', safe(async (_req, res) => {
  res.json(await listarCatalogo());
}));

app.post('/api/catalogo', async (req, res) => {
  const resultado = await crearServicioCatalogo(req.body);
  res.status(resultado.exito ? 201 : 400).json(resultado);
});

app.patch('/api/catalogo/:id', async (req, res) => {
  const resultado = await actualizarServicioCatalogo(req.params.id, req.body);
  res.status(resultado.exito ? 200 : 404).json(resultado);
});

app.delete('/api/catalogo/:id', async (req, res) => {
  const resultado = await eliminarServicioCatalogo(req.params.id);
  res.status(resultado.exito ? 200 : 404).json(resultado);
});

// Precios por vehículo
app.get('/api/vehiculos/years',  (_req, res) => res.json(getYears()));
app.get('/api/vehiculos/makes',  (req, res)  => res.json(getMakes(req.query.year)));
app.get('/api/vehiculos/models', (req, res)  => res.json(getModels(req.query.year, req.query.make)));

app.get('/api/precios-vehiculos', async (_req, res) => {
  res.json(await listarPreciosVehiculos());
});
app.post('/api/precios-vehiculos', async (req, res) => {
  const resultado = await upsertPrecioVehiculo(req.body);
  res.status(resultado.exito ? 200 : 400).json(resultado);
});
app.delete('/api/precios-vehiculos/:id', async (req, res) => {
  const resultado = await eliminarPrecioVehiculo(req.params.id);
  res.status(resultado.exito ? 200 : 404).json(resultado);
});

// Precios apertura por marca
app.get('/api/precios-apertura-marca', async (_req, res) => {
  res.json(await listarPreciosAperturaMarca());
});
app.post('/api/precios-apertura-marca', async (req, res) => {
  const resultado = await upsertPrecioAperturaMarca(req.body);
  res.status(resultado.exito ? 200 : 400).json(resultado);
});
app.delete('/api/precios-apertura-marca/:id', async (req, res) => {
  const resultado = await eliminarPrecioAperturaMarca(req.params.id);
  res.status(resultado.exito ? 200 : 404).json(resultado);
});

// ── Centro de mando ──────────────────────────────────────────────────────────
app.get('/api/centro/resumen', safe(async (_req, res) => {
  res.json(await centro.resumen());
}));

app.get('/api/centro/llamadas', safe(async (req, res) => {
  res.json(await centro.listarLlamadas(req.query.limite));
}));

app.get('/api/centro/llamadas/:id', safe(async (req, res) => {
  const llamada = await centro.obtenerLlamada(req.params.id);
  if (!llamada) return res.status(404).json({ error: 'Llamada no encontrada' });
  res.json(llamada);
}));

// Grabación de la llamada (proxy a ElevenLabs: la API key no sale del servidor)
app.get('/api/centro/llamadas/:id/audio', safe(async (req, res) => {
  const cid = await centro.conversationIdDe(req.params.id);
  if (!cid) return res.status(404).json({ error: 'Esta llamada no tiene grabación' });
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${cid}/audio`, {
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' },
  });
  if (!r.ok) return res.status(r.status).json({ error: 'Grabación no disponible todavía' });
  res.set('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// Llamada de prueba desde el panel (solo a números verificados en Twilio)
app.get('/api/centro/numeros-prueba', safe(async (_req, res) => {
  res.json(await centro.numerosPrueba());
}));

app.post('/api/centro/llamar-prueba', safe(async (req, res) => {
  try {
    res.json(await centro.llamarPrueba(String(req.body?.numero || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/centro/importar', safe(async (_req, res) => {
  res.json({ importadas: await centro.importarHistorial(200) });
}));

// Admin panel
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '../client/admin.html'));
});

// ── Config de voz para el browser ─────────────────────────────────────────────
// El cliente pregunta qué motor usar: ElevenLabs si está configurado; si no,
// Gemini vía el proxy /ws (ideal para pruebas locales).
app.get('/api/voice-config', (_req, res) => {
  const elevenlabs = Boolean(process.env.ELEVENLABS_AGENT_ID && process.env.ELEVENLABS_API_KEY);
  const gemini     = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'TU_API_KEY_AQUI');
  // Web usa Gemini (rápido y barato); ElevenLabs queda para la vía telefónica.
  res.json({ engine: gemini ? 'gemini' : elevenlabs ? 'elevenlabs' : 'none' });
});

// ── ElevenLabs — Signed URL para el browser ────────────────────────────────────
app.get('/api/elevenlabs/signed-url', async (_req, res) => {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  if (!agentId || !apiKey) {
    return res.status(500).json({ error: 'ELEVENLABS_AGENT_ID o ELEVENLABS_API_KEY no configurados' });
  }
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      { headers: { 'xi-api-key': apiKey } }
    );
    const data = await resp.json();
    if (!data.signed_url) throw new Error(data.detail || 'Sin signed_url en respuesta');
    res.json({ signedUrl: data.signed_url });
  } catch (err) {
    console.error('❌ Error obteniendo signed URL:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Twilio — Webhook llamada entrante ─────────────────────────────────────────
app.post('/twilio/incoming', (req, res) => {
  const host  = process.env.PUBLIC_URL
    ? process.env.PUBLIC_URL.replace('https://', 'wss://').replace('http://', 'ws://')
    : `wss://${req.headers.host}`;
  const wsUrl = `${host}/twilio-stream`;
  // Número del cliente para el centro de mando: en una llamada entrante es
  // From; en una que hacemos nosotros (pruebas, devoluciones) es To.
  const b = req.body || {};
  const entrante = !String(b.Direction || 'inbound').startsWith('outbound');
  const numero = (entrante ? b.From : b.To) || '';
  const xml = v => String(v).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="numero" value="${xml(numero)}" />
      <Parameter name="direccion" value="${entrante ? 'entrante' : 'saliente'}" />
    </Stream>
  </Connect>
</Response>`);
});

// ── ElevenLabs — Webhooks de Tool Calls ──────────────────────────────────────
app.post('/api/tools/guardar_servicio', safe(async (req, res) => {
  const params  = req.body?.parameters || req.body || {};
  console.log('\n📥 Tool webhook guardar_servicio:', JSON.stringify(params));
  const resultado = await guardarServicio(params);
  res.json({ result: resultado.mensaje || 'Servicio procesado' });
}));

/**
 * Instrucción para el agente cuando no hay precio: consultar al dueño (si la
 * opción está prendida en el panel) o prometer la llamada de confirmación.
 */
async function instruccionSinPrecio(contexto) {
  if (await consultas.consultaActiva()) {
    return `NO HAY PRECIO para este caso (${contexto}). Dile al cliente: "Deme un momento en la línea, por favor, que ya le estoy consultando el precio." y enseguida llama a consultar_dueno con resumen = una frase con el caso (${contexto}, más lo que te haya contado el cliente) y pregunta = lo que necesitas saber (normalmente "¿Qué precio le damos?").`;
  }
  return 'NO HAY PRECIO para este caso. No inventes ninguno. Dile al cliente: "Ese precio se lo confirmamos; en breve lo llamamos para darle el costo exacto." y sigue tomando los datos para guardar el servicio (en notas pon "precio por confirmar").';
}

app.post('/api/tools/consultar_precio', safe(async (req, res) => {
  const params  = req.body?.parameters || req.body || {};
  console.log('\n📥 Tool webhook consultar_precio:', JSON.stringify(params));
  const resultado = await consultarPrecio(params);
  if (resultado.sin_precio) {
    return res.json({ result: await instruccionSinPrecio(resultado.contexto || params.tipo_servicio) });
  }
  res.json({ result: resultado.respuesta_sugerida || resultado.mensaje || 'Sin precio disponible' });
}));

app.post('/api/tools/cotizar_llave', safe(async (req, res) => {
  const params  = req.body?.parameters || req.body || {};
  console.log('\n📥 Tool webhook cotizar_llave:', JSON.stringify(params));
  const r = cotizarLlave(params);
  if (r.sin_precio) return res.json({ result: await instruccionSinPrecio(r.contexto) });
  // Texto para decir + reglas de negociación en un solo string para el agente
  res.json({ result: [r.texto && `Dile al cliente: ${r.texto}`, r.instrucciones].filter(Boolean).join('\n') });
}));

// ── Consulta de precio al dueño (cliente en espera) ─────────────────────────
const urlPublica = req => (process.env.PUBLIC_URL || `https://${req.headers.host}`).replace(/\/$/, '');

app.post('/api/tools/consultar_dueno', safe(async (req, res) => {
  const params = req.body?.parameters || req.body || {};
  console.log('\n📥 Tool webhook consultar_dueno:', JSON.stringify(params));
  const r = await consultas.crearConsulta({
    resumen: params.resumen,
    pregunta: params.pregunta,
    conversation_id: params.conversation_id,
    numero_cliente: centro.numeroDeConversacion(params.conversation_id),
  }, urlPublica(req));
  if (!r.activa) return res.json({ result: await instruccionSinPrecio(params.resumen || '') });
  res.json({
    result: `Consulta enviada (consulta_id: ${r.consulta.id}). Si todavía no se lo dijiste, dile al cliente: "Deme un momento en la línea, por favor, que ya le estoy consultando el precio." Luego llama a esperar_respuesta_dueno con consulta_id ${r.consulta.id}.`,
  });
}));

app.post('/api/tools/esperar_respuesta_dueno', safe(async (req, res) => {
  const params = req.body?.parameters || req.body || {};
  const id = String(params.consulta_id || '').trim();
  const r = await consultas.esperarRespuesta(id);
  console.log(`📥 esperar_respuesta_dueno ${id}: ${r.estado} (${r.segundos} s)`);
  if (r.estado === 'respondida') {
    return res.json({ result: `Ya tenemos la respuesta: "${r.respuesta}". Agradécele la espera y díselo al cliente con tus palabras, en frases cortas y tratándolo de usted (no menciones al dueño ni el WhatsApp). Si es un precio, ese es el precio que cotizas. Después sigue con el flujo normal (pueblo, dirección, nombre y teléfono).` });
  }
  if (r.estado === 'pendiente') {
    return res.json({ result: `Todavía sin respuesta (${r.segundos} s). Dile al cliente algo como: "Gracias por su paciencia en la línea. Deme otro momentito, por favor, que ya casi termino." (varía la frase cada vez) y vuelve a llamar a esperar_respuesta_dueno con consulta_id ${id}.` });
  }
  res.json({ result: 'No llegó la respuesta a tiempo. Dile al cliente: "Gracias por esperar. Para no tenerlo más tiempo en la línea, le tomo los datos y en breve lo llamamos para confirmarle el costo exacto." Sigue tomando los datos y al guardar pon en notas "precio por confirmar".' });
}));

// Página para que el dueño responda desde el enlace del WhatsApp (sin contraseña:
// el token de la URL es secreto y solo sirve para esa consulta).
const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

app.get('/r/:token', safe(async (req, res) => {
  const c = await consultas.consultaPorToken(req.params.token);
  res.set('Cache-Control', 'no-store');
  if (!c) return res.status(404).send('<h2 style="font-family:sans-serif">Esta consulta no existe.</h2>');
  res.type('html').send(paginaRespuesta(c, req.params.token));
}));

app.post('/r/:token', safe(async (req, res) => {
  try {
    const c = await consultas.responderConsulta({ token: req.params.token }, req.body?.respuesta, 'Enlace');
    res.json({ ok: true, estado: c.estado });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
}));

function paginaRespuesta(c, token) {
  const respondida = c.estado === 'respondida';
  const expirada = c.estado === 'expirada';
  const rapidas = ['Dile que lo llamamos en breve para darle el precio', 'Dile que el técnico le cotiza en el sitio'];
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consulta de precio — Tu Cerrajero Puerto Rico</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --borde:#30363d; --texto:#e6edf3; --tenue:#8b949e; --acento:#f0b429; --ok:#3fb950; --alerta:#e3a008; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--texto); font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  main { max-width:560px; margin:0 auto; padding:20px 16px 40px; }
  h1 { font-size:20px; margin:0 0 4px; } .tenue { color:var(--tenue); font-size:14px; }
  .card { background:var(--card); border:1px solid var(--borde); border-radius:12px; padding:16px; margin:16px 0; }
  .etq { font-size:12px; color:var(--tenue); text-transform:uppercase; letter-spacing:.4px; } .val { margin:2px 0 12px; }
  textarea { width:100%; min-height:110px; background:#0b0f14; color:var(--texto); border:1px solid var(--borde); border-radius:10px; padding:12px; font:inherit; }
  button { width:100%; border:0; border-radius:10px; padding:14px; font-family:inherit; font-size:16px; font-weight:600; cursor:pointer; margin-top:10px; }
  .principal { background:var(--acento); color:#000; } .rapida { background:transparent; color:var(--texto); border:1px solid var(--borde); font-weight:500; font-size:15px; padding:12px; }
  .aviso { padding:12px; border-radius:10px; margin-top:12px; font-size:14px; } .ok { background:rgba(63,185,80,.12); color:var(--ok); } .alerta { background:rgba(227,160,8,.12); color:var(--alerta); }
</style></head><body><main>
  <h1>🔑 Consulta de precio</h1>
  <div class="tenue">Tu Cerrajero Puerto Rico · ${escHtml(c.id)}</div>
  <div class="card">
    <div class="etq">Cliente</div><div class="val">${escHtml(c.numero_cliente || 'En la línea')}</div>
    <div class="etq">Caso</div><div class="val">${escHtml(c.resumen)}</div>
    <div class="etq">Pregunta</div><div class="val"><strong>${escHtml(c.pregunta)}</strong></div>
  </div>
  ${respondida ? `<div class="aviso ok">✅ Ya respondida: “${escHtml(c.respuesta)}”</div>` : `
  ${expirada ? '<div class="aviso alerta">⏱️ El cliente ya no está esperando en la línea. Tu respuesta queda guardada para cuando lo llamen.</div>' : '<div class="aviso alerta">📞 El cliente está esperando en la línea. Escribe lo que el bot le debe decir.</div>'}
  <form id="f">
    <textarea id="r" placeholder="Ej.: Dile que son 90 dólares con varilla. Si hay que trabajar la cerradura son 150." required></textarea>
    <button class="principal" type="submit">Enviar respuesta</button>
    ${rapidas.map(t => `<button class="rapida" type="button" data-t="${escHtml(t)}">${escHtml(t)}</button>`).join('')}
  </form>
  <div id="msg"></div>`}
</main>
${respondida ? '' : `<script>
  const f = document.getElementById('f'), r = document.getElementById('r'), msg = document.getElementById('msg');
  document.querySelectorAll('.rapida').forEach(b => b.onclick = () => { r.value = b.dataset.t; f.requestSubmit(); });
  f.onsubmit = async e => {
    e.preventDefault();
    f.querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      const res = await fetch(${JSON.stringify(`/r/${token}`)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ respuesta: r.value }) });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      f.remove();
      msg.innerHTML = '<div class="aviso ok">✅ Enviado. El bot se lo dice al cliente ahora mismo.</div>';
    } catch (err) {
      msg.innerHTML = '<div class="aviso alerta">' + (err.message || 'No se pudo enviar') + '</div>';
      f.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  };
</script>`}
</body></html>`;
}

// ── App del dueño (/dueno): PWA con notificaciones push ─────────────────────
// Acceso con enlace secreto generado en el panel → cookie de sesión por celular.
const DIR_DUENO = path.join(__dirname, '../dueno');
const COOKIE_DUENO = 'dueno_sesion';
const leerCookie = (req, nombre) => {
  const par = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${nombre}=`));
  return par ? decodeURIComponent(par.slice(nombre.length + 1)) : null;
};

// Express no distingue "/dueno" de "/dueno/": se redirige mirando la URL real
// (el service worker controla el scope "/dueno/", con barra).
app.get('/dueno/', (req, res) => {
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(302, '/dueno/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(DIR_DUENO, 'index.html'));
});
for (const archivo of ['sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  app.get(`/dueno/${archivo}`, (_req, res) => {
    if (archivo === 'sw.js') res.set({ 'Service-Worker-Allowed': '/dueno/', 'Cache-Control': 'no-cache' });
    if (archivo.endsWith('.webmanifest')) res.type('application/manifest+json');
    res.sendFile(path.join(DIR_DUENO, archivo));
  });
}

app.get('/dueno/acceso/:token', safe(async (req, res) => {
  const sesion = await dueno.canjearEnlace(req.params.token, req.headers['user-agent']);
  if (!sesion) {
    return res.status(403).type('html').send('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:24px"><h2>Este enlace ya no sirve</h2><p>Pídele al administrador un enlace nuevo desde el panel (Centro de mando → App del dueño).</p></body>');
  }
  res.cookie(COOKIE_DUENO, sesion, {
    httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/dueno', maxAge: 365 * 24 * 3600 * 1000,
  });
  res.redirect('/dueno/');
}));

/** Solo celulares conectados con el enlace de acceso. */
const soloDueno = (req, res, next) => {
  dueno.sesionValida(leerCookie(req, COOKIE_DUENO))
    .then(s => {
      if (!s) return res.status(401).json({ error: 'sin acceso' });
      req.dueno = { sesion: leerCookie(req, COOKIE_DUENO), avisos: s.avisos };
      next();
    })
    .catch(err => res.status(500).json({ error: err.message }));
};

app.get('/dueno/api/estado', soloDueno, safe(async (req, res) => {
  res.json({ ok: true, vapid: await dueno.clavePublica(), avisos: req.dueno.avisos });
}));
app.get('/dueno/api/consultas', soloDueno, safe(async (_req, res) => {
  res.json(await consultas.listarConsultas(20));
}));
app.post('/dueno/api/consultas/:id/responder', soloDueno, safe(async (req, res) => {
  try {
    res.json(await consultas.responderConsulta({ id: req.params.id }, req.body?.respuesta, 'App del dueño'));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));
app.post('/dueno/api/suscripcion', soloDueno, safe(async (req, res) => {
  await dueno.guardarSuscripcion(req.dueno.sesion, req.body);
  res.json({ ok: true });
}));
app.post('/dueno/api/prueba', soloDueno, safe(async (_req, res) => {
  res.json({ enviados: await dueno.notificar({ titulo: '🔔 Aviso de prueba', cuerpo: 'Así te va a sonar cuando un cliente espere un precio.', tag: 'prueba' }) });
}));

// Panel: enlace de acceso, celulares conectados y prueba de aviso
app.get('/api/centro/dueno', safe(async (_req, res) => {
  res.json({ dispositivos: await dueno.listarDispositivos() });
}));
app.post('/api/centro/dueno/enlace', safe(async (req, res) => {
  res.json({ url: await dueno.generarEnlace(urlPublica(req)) });
}));
app.post('/api/centro/dueno/prueba', safe(async (_req, res) => {
  res.json({ enviados: await dueno.notificar({ titulo: '🔔 Aviso de prueba', cuerpo: 'Enviado desde el panel. Así suena cuando un cliente espera un precio.', tag: 'prueba' }) });
}));
app.delete('/api/centro/dueno/dispositivos', safe(async (_req, res) => {
  await dueno.desconectarTodos();
  res.json({ ok: true });
}));

// Panel: interruptor, configuración y respuestas a consultas
app.get('/api/centro/consulta-dueno', safe(async (_req, res) => {
  res.json({ ajustes: await consultas.obtenerAjustesConsulta(), consultas: await consultas.listarConsultas(30) });
}));

app.put('/api/centro/consulta-dueno', safe(async (req, res) => {
  res.json(await consultas.actualizarAjustesConsulta(req.body || {}));
}));

app.post('/api/centro/consultas/:id/responder', safe(async (req, res) => {
  try {
    res.json(await consultas.responderConsulta({ id: req.params.id }, req.body?.respuesta, 'Panel'));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001',
    voice: process.env.AGENT_VOICE || 'Charon'
  });
});

// ── Servidor HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket Servers (noServer = ruteamos manualmente el upgrade) ────────────
// Necesario cuando hay múltiples WS servers en el mismo HTTP server.
const wss       = new WebSocket.Server({ noServer: true });
const wssTwilio = new WebSocket.Server({ noServer: true });

wssTwilio.on('connection', (ws) => {
  console.log('\n📞 Twilio Media Stream conectado');
  handleTwilioStream(ws);
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === '/twilio-stream') {
    wssTwilio.handleUpgrade(req, socket, head, (ws) => wssTwilio.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs, req) => {
  const clientId = `cliente-${Date.now().toString(36)}`;
  console.log(`\n✅ [${clientId}] Cliente conectado desde ${req.socket.remoteAddress}`);

  let geminiWs = null;
  let setupSent = false;
  let sessionActive = false;

  // Contadores de costo por sesión
  const cost = { inputBytes: 0, outputBytes: 0 };

  function sendCostUpdate() {
    const inputSec  = cost.inputBytes  / 32000; // PCM16 16kHz = 32000 bytes/seg
    const outputSec = cost.outputBytes / 48000; // PCM16 24kHz = 48000 bytes/seg
    const totalUSD  = inputSec * INPUT_COST_PER_SEC + outputSec * OUTPUT_COST_PER_SEC;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: 'cost_update',
        inputSec:  +inputSec.toFixed(1),
        outputSec: +outputSec.toFixed(1),
        totalUSD:  +totalUSD.toFixed(7)
      }));
    }
  }

  // ── Conexión con Gemini API ─────────────────────────────────────────────────
  function conectarGemini() {
    let geminiUrl;
    try {
      geminiUrl = buildGeminiUrl();
    } catch (err) {
      console.error('❌ Error de configuración:', err.message);
      clientWs.send(JSON.stringify({ type: 'error', message: err.message }));
      return;
    }

    console.log(`   [${clientId}] Conectando a Gemini API...`);
    geminiWs = new WebSocket(geminiUrl);

    geminiWs.on('open', async () => {
      console.log(`   [${clientId}] ✅ Conectado a Gemini. Enviando setup...`);

      // Enviar setup inicial con system instruction y configuración de audio
      // (async: inyecta los precios del catálogo desde la BD en el prompt)
      const setupMsg = await buildSetupMessage();
      geminiWs.send(JSON.stringify(setupMsg));
      setupSent = true;
    });

    geminiWs.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // ── Manejar diferentes tipos de mensajes de Gemini ──
        if (msg.setupComplete) {
          sessionActive = true;
          console.log(`   [${clientId}] 🎙️  Setup completado. Sesión activa.`);
          clientWs.send(JSON.stringify({ type: 'session_ready' }));

          // El agente saluda primero (no espera a que el cliente hable)
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: '(Acaba de entrar la llamada. Da el saludo inicial ahora.)' }] }],
              turnComplete: true
            }
          }));
          return;
        }

        // Transcripción del input del usuario
        if (msg.serverContent?.inputTranscription) {
          const transcripcion = msg.serverContent.inputTranscription.text;
          if (transcripcion) {
            console.log(`   [${clientId}] 👤 Usuario: "${transcripcion}"`);
            clientWs.send(JSON.stringify({
              type: 'input_transcription',
              text: transcripcion
            }));
          }
        }

        // Transcripción de la respuesta del agente
        if (msg.serverContent?.outputTranscription) {
          const transcripcion = msg.serverContent.outputTranscription.text;
          if (transcripcion) {
            console.log(`   [${clientId}] 🤖 Agente: "${transcripcion}"`);
            clientWs.send(JSON.stringify({
              type: 'output_transcription',
              text: transcripcion
            }));
          }
        }

        // Audio del agente — pasarlo al cliente
        if (msg.serverContent?.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.inlineData?.mimeType?.startsWith('audio/')) {
              cost.outputBytes += Math.floor(part.inlineData.data.length * 3 / 4);
              clientWs.send(JSON.stringify({
                type: 'audio_chunk',
                mimeType: part.inlineData.mimeType,
                data: part.inlineData.data
              }));
            }
          }
        }

        // Turn completado — enviar costo actualizado
        if (msg.serverContent?.turnComplete) {
          clientWs.send(JSON.stringify({ type: 'turn_complete' }));
          sendCostUpdate();
        }

        // ── Function Call desde Gemini ──────────────────────────────────────
        if (msg.toolCall?.functionCalls?.length > 0) {
          for (const fc of msg.toolCall.functionCalls) {
            console.log(`\n🔧 [${clientId}] Function Call: ${fc.name}`);

            const resultado = await manejarFunctionCall(fc.name, fc.args || {});

            // Notificar al cliente que se guardó el servicio
            if (fc.name === 'guardar_servicio' && resultado.exito) {
              clientWs.send(JSON.stringify({
                type: 'service_saved',
                data: resultado
              }));
            }

            // Enviar respuesta de función de vuelta a Gemini
            const toolResponse = {
              toolResponse: {
                functionResponses: [
                  {
                    id: fc.id,
                    name: fc.name,
                    response: {
                      output: resultado
                    }
                  }
                ]
              }
            };

            if (geminiWs.readyState === WebSocket.OPEN) {
              geminiWs.send(JSON.stringify(toolResponse));
            }
          }
          return;
        }

        // Errores de Gemini
        if (msg.error) {
          console.error(`   [${clientId}] ❌ Error de Gemini:`, msg.error);
          clientWs.send(JSON.stringify({
            type: 'error',
            message: `Error de API: ${msg.error.message || JSON.stringify(msg.error)}`
          }));
        }

      } catch (err) {
        console.error(`   [${clientId}] Error procesando mensaje de Gemini:`, err.message);
      }
    });

    geminiWs.on('error', (err) => {
      console.error(`   [${clientId}] ❌ Error WS Gemini:`, err.message);
      clientWs.send(JSON.stringify({
        type: 'error',
        message: 'Error en la conexión con el servicio de IA. Intenta de nuevo.'
      }));
    });

    geminiWs.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || '';
      console.log(`   [${clientId}] Gemini WS cerrado. Código: ${code} | Razón: "${reasonStr}"`);
      sessionActive = false;
      if (clientWs.readyState === WebSocket.OPEN) {
        if (code !== 1000 && code !== 1001) {
          // Error — informar al cliente con razón del cierre
          clientWs.send(JSON.stringify({
            type: 'error',
            message: `Error Gemini API (${code}): ${reasonStr || 'Conexión rechazada. Verifica tu API key y modelo.'}`
          }));
        } else {
          clientWs.send(JSON.stringify({ type: 'session_ended' }));
        }
      }
    });
  }

  // ── Mensajes del cliente browser ───────────────────────────────────────────
  clientWs.on('message', (data) => {
    try {
      // Detectar si es dato binario (audio raw) o JSON
      if (Buffer.isBuffer(data) && data[0] !== 0x7B) {
        // Binary audio data — enviar directamente a Gemini como realtimeInput
        if (geminiWs?.readyState === WebSocket.OPEN && sessionActive) {
          const audioB64 = data.toString('base64');
          const audioMsg = {
            realtimeInput: {
              audio: {
                data: audioB64,
                mimeType: 'audio/pcm;rate=16000'
              }
            }
          };
          geminiWs.send(JSON.stringify(audioMsg));
        }
        return;
      }

      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'start_session':
          console.log(`   [${clientId}] 🚀 Iniciando sesión...`);
          conectarGemini();
          break;

        case 'audio_chunk':
          // Audio en base64 desde el cliente
          if (geminiWs?.readyState === WebSocket.OPEN && sessionActive) {
            cost.inputBytes += Math.floor(msg.data.length * 3 / 4);
            const audioMsg = {
              realtimeInput: {
                audio: {
                  data: msg.data,
                  mimeType: 'audio/pcm;rate=16000'
                }
              }
            };
            geminiWs.send(JSON.stringify(audioMsg));
          }
          break;

        case 'end_turn':
          // El cliente indica que terminó de hablar
          if (geminiWs?.readyState === WebSocket.OPEN && sessionActive) {
            // En Gemini Live API, el VAD (Voice Activity Detection) es automático,
            // pero podemos enviar un audio vacío para forzar el turno
            console.log(`   [${clientId}] ⏹️  Cliente terminó de hablar`);
          }
          break;

        case 'interrupt':
          // Interrupción del usuario (barge-in)
          if (geminiWs?.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'interrupted' }));
          }
          break;

        case 'end_session':
          console.log(`   [${clientId}] 🔚 Cliente cerró sesión`);
          if (geminiWs) {
            geminiWs.close();
          }
          break;

        default:
          console.log(`   [${clientId}] Mensaje desconocido:`, msg.type);
      }
    } catch (err) {
      // No JSON — podría ser audio binario
      if (geminiWs?.readyState === WebSocket.OPEN && sessionActive) {
        try {
          const audioB64 = data.toString('base64');
          const audioMsg = {
            realtimeInput: {
              audio: { data: audioB64, mimeType: 'audio/pcm;rate=16000' }
            }
          };
          geminiWs.send(JSON.stringify(audioMsg));
        } catch (e) {
          // ignorar
        }
      }
    }
  });

  clientWs.on('close', () => {
    console.log(`\n❌ [${clientId}] Cliente desconectado`);
    if (geminiWs) {
      geminiWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error(`   [${clientId}] Error de cliente:`, err.message);
  });
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────
async function start() {
  console.log('🔐 Servidor arrancando...');
  console.log('  Conectando a la base de datos...');
  await initDB();
  // Llamadas anteriores al centro de mando → historial (en segundo plano)
  centro.importarHistorial(200)
    .then(n => n && console.log(`  📞 Historial: ${n} llamadas importadas de ElevenLabs`))
    .catch(err => console.warn('  ⚠️  No pude importar el historial de llamadas:', err.message));

  server.listen(PORT, () => {
    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║        🔑 CERRAJERO VOICE AGENT — Servidor Activo        ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  🌐 Interfaz web:  http://localhost:${PORT}                 ║`);
    console.log(`║  🔌 WebSocket:     ws://localhost:${PORT}/ws               ║`);
    console.log(`║  📊 Servicios:     http://localhost:${PORT}/api/servicios   ║`);
    console.log(`║  ❤️  Health:        http://localhost:${PORT}/api/health      ║`);
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Modelo: ${(process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001').padEnd(46)} ║`);
    console.log(`║  Voz:    ${(process.env.AGENT_VOICE || 'Charon').padEnd(46)} ║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('\n  Esperando conexiones...\n');

    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'TU_API_KEY_AQUI') {
      console.warn('  ⚠️  ADVERTENCIA: GEMINI_API_KEY no está configurada.');
      console.warn('     Copia .env.example → .env y añade tu API key.\n');
    }
  });
}

start().catch(err => {
  console.error('❌ Error fatal al iniciar:', err.message);
  process.exit(1);
});

module.exports = server;
