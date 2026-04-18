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
const { manejarFunctionCall, listarServicios, guardarServicio, actualizarEstado, reasignarCerrajero } = require('./services');
const { listarCerrajeros, toggleDisponibilidad } = require('./cerrajeros');
const { listarCatalogo, crearServicioCatalogo, actualizarServicioCatalogo, eliminarServicioCatalogo } = require('./catalogo');
const { handleTwilioStream } = require('./elevenlabs-bridge');
const emitter = require('./events');

// ── Precios estimados Gemini Live API ────────────────────────────────────────
// Audio: ~25 tokens/segundo. Precios flash live aprox.
const INPUT_COST_PER_SEC  = 25 * 0.35  / 1_000_000; // $0.00000875/seg entrada
const OUTPUT_COST_PER_SEC = 25 * 1.05  / 1_000_000; // $0.00002625/seg salida

// ── Configuración ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const app = express();

app.use(cors());
app.use(express.json());

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
app.get('/api/servicios', (_req, res) => {
  const lista = listarServicios();
  res.json({ total: lista.length, servicios: lista });
});

app.patch('/api/servicios/:id/estado', (req, res) => {
  const { estado } = req.body;
  const resultado  = actualizarEstado(req.params.id, estado);
  res.status(resultado.exito ? 200 : 400).json(resultado);
});

app.patch('/api/servicios/:id/asignar', (req, res) => {
  const { cerrajero_id } = req.body;
  const resultado        = reasignarCerrajero(req.params.id, cerrajero_id);
  res.status(resultado.exito ? 200 : 400).json(resultado);
});

// Cerrajeros
app.get('/api/cerrajeros', (_req, res) => {
  res.json(listarCerrajeros());
});

app.patch('/api/cerrajeros/:id/disponibilidad', (req, res) => {
  const cerrajero = toggleDisponibilidad(req.params.id);
  if (!cerrajero) return res.status(404).json({ error: 'Cerrajero no encontrado' });
  emitter.emit('cerrajero_actualizado', cerrajero);
  res.json(cerrajero);
});

// Catálogo de servicios
app.get('/api/catalogo', (_req, res) => {
  res.json(listarCatalogo());
});

app.post('/api/catalogo', (req, res) => {
  const resultado = crearServicioCatalogo(req.body);
  res.status(resultado.exito ? 201 : 400).json(resultado);
});

app.patch('/api/catalogo/:id', (req, res) => {
  const resultado = actualizarServicioCatalogo(req.params.id, req.body);
  res.status(resultado.exito ? 200 : 404).json(resultado);
});

app.delete('/api/catalogo/:id', (req, res) => {
  const resultado = eliminarServicioCatalogo(req.params.id);
  res.status(resultado.exito ? 200 : 404).json(resultado);
});

// Admin panel
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '../client/admin.html'));
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
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
});

// ── ElevenLabs — Webhook de Tool Calls (guardar_servicio) ────────────────────
app.post('/api/tools/guardar_servicio', (req, res) => {
  // ElevenLabs envía los parámetros en req.body o req.body.parameters
  const params  = req.body?.parameters || req.body || {};
  console.log('\n📥 Tool webhook guardar_servicio:', JSON.stringify(params));
  const resultado = guardarServicio(params);
  res.json({ result: resultado.mensaje || 'Servicio procesado' });
});

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

console.log('🔐 Servidor arrancando...');

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

    geminiWs.on('open', () => {
      console.log(`   [${clientId}] ✅ Conectado a Gemini. Enviando setup...`);

      // Enviar setup inicial con system instruction y configuración de audio
      const setupMsg = buildSetupMessage();
      geminiWs.send(JSON.stringify(setupMsg));
      setupSent = true;
    });

    geminiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // ── Manejar diferentes tipos de mensajes de Gemini ──
        if (msg.setupComplete) {
          sessionActive = true;
          console.log(`   [${clientId}] 🎙️  Setup completado. Sesión activa.`);
          clientWs.send(JSON.stringify({ type: 'session_ready' }));
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

            const resultado = manejarFunctionCall(fc.name, fc.args || {});

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

module.exports = server;
