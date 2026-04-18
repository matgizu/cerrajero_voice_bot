'use strict';

const WebSocket = require('ws');

// ── Tabla μ-law decode (precalculada) ─────────────────────────────────────────
const ULAW_DECODE = new Int16Array(256);
(function () {
  for (let i = 0; i < 256; i++) {
    let u = ~i;
    const sign = u & 0x80;
    u &= 0x7f;
    const exp      = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 1) | 0x21) << exp;
    sample -= 33;
    ULAW_DECODE[i] = sign ? -sample : sample;
  }
})();

// ── Conversiones de audio ─────────────────────────────────────────────────────

/** μ-law buffer → PCM16 buffer (8kHz) */
function ulawToPcm16(ulawBuf) {
  const out = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    out.writeInt16LE(ULAW_DECODE[ulawBuf[i]], i * 2);
  }
  return out;
}

/** PCM16 sample → μ-law byte */
function encodeSample(sample) {
  const MU  = 255;
  const MAX = 32767;
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MAX) sample = MAX;
  const mag     = Math.log(1 + MU * sample / MAX) / Math.log(1 + MU);
  const encoded = Math.min(Math.floor(mag * 128), 127);
  return (~(sign | encoded)) & 0xff;
}

/** PCM16 buffer → μ-law buffer */
function pcm16ToUlaw(pcmBuf) {
  const samples = pcmBuf.length / 2;
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = encodeSample(pcmBuf.readInt16LE(i * 2));
  }
  return out;
}

/** PCM16 8kHz → PCM16 16kHz (interpolación lineal) */
function upsample8to16(buf8) {
  const n = buf8.length / 2;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s0 = buf8.readInt16LE(i * 2);
    const s1 = i + 1 < n ? buf8.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0, i * 4);
    out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }
  return out;
}

/** PCM16 N-kHz → PCM16 8kHz (promedio por factor) */
function downsampleTo8(buf, fromRate) {
  const factor  = Math.round(fromRate / 8000);
  const nIn     = buf.length / 2;
  const nOut    = Math.floor(nIn / factor);
  const out     = Buffer.alloc(nOut * 2);
  for (let i = 0; i < nOut; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) {
      sum += buf.readInt16LE((i * factor + j) * 2);
    }
    out.writeInt16LE(Math.round(sum / factor), i * 2);
  }
  return out;
}

// ── Obtener sample rate del formato ElevenLabs ────────────────────────────────
function parseSampleRate(format) {
  // Formato: "pcm_16000", "pcm_24000", etc.
  const match = (format || '').match(/pcm_(\d+)/);
  return match ? parseInt(match[1], 10) : 16000;
}

// ── Bridge Twilio ↔ ElevenLabs ────────────────────────────────────────────────

/**
 * Conecta un WebSocket de Twilio Media Streams con ElevenLabs Conversational AI.
 * Convierte audio μ-law 8kHz (Twilio) ↔ PCM16 16kHz (ElevenLabs).
 *
 * @param {WebSocket} twilioWs - WebSocket de Twilio Media Streams
 */
function handleTwilioStream(twilioWs) {
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const apiKey  = process.env.ELEVENLABS_API_KEY;

  if (!agentId || !apiKey) {
    console.error('❌ ELEVENLABS_AGENT_ID o ELEVENLABS_API_KEY no configurados');
    twilioWs.close();
    return;
  }

  const elUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;
  const elWs  = new WebSocket(elUrl, { headers: { 'xi-api-key': apiKey } });

  let streamSid      = null;
  let elReady        = false;
  let outputRate     = 16000;
  const audioQueue   = [];   // Buffer hasta que ElevenLabs esté listo

  // ── ElevenLabs → Twilio ──────────────────────────────────────────────────

  elWs.on('open', () => {
    console.log('✅ ElevenLabs WS abierto (bridge telefónico)');
  });

  elWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {

        case 'conversation_initiation_metadata': {
          const meta = msg.conversation_initiation_metadata_event || {};
          outputRate = parseSampleRate(meta.agent_output_audio_format);
          elReady    = true;
          console.log(`🎙️ ElevenLabs listo | ID: ${meta.conversation_id} | Audio salida: ${outputRate}Hz`);
          // Vaciar cola de audio del cliente
          while (audioQueue.length > 0) {
            if (elWs.readyState === WebSocket.OPEN)
              elWs.send(JSON.stringify({ user_audio_chunk: audioQueue.shift() }));
          }
          break;
        }

        case 'audio': {
          if (!streamSid || twilioWs.readyState !== WebSocket.OPEN) break;
          // PCM16 N-kHz → μ-law 8kHz → Twilio
          const pcmEl  = Buffer.from(msg.audio_event.audio_base_64, 'base64');
          const pcm8   = downsampleTo8(pcmEl, outputRate);
          const ulaw   = pcm16ToUlaw(pcm8);
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: ulaw.toString('base64') }
          }));
          break;
        }

        case 'interruption':
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          break;

        case 'ping':
          if (elWs.readyState === WebSocket.OPEN)
            elWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
          break;

        case 'agent_response':
          console.log('🤖 Agente (tel):', msg.agent_response_event?.agent_response?.slice(0, 80));
          break;

        case 'user_transcript':
          console.log('👤 Cliente (tel):', msg.user_transcription_event?.user_transcript);
          break;
      }
    } catch (err) {
      console.error('Error msg ElevenLabs:', err.message);
    }
  });

  elWs.on('error', (err) => console.error('❌ ElevenLabs WS error:', err.message));
  elWs.on('close', () => {
    console.log('ElevenLabs WS cerrado');
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  // ── Twilio → ElevenLabs ──────────────────────────────────────────────────

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.event) {

        case 'connected':
          console.log('📞 Twilio Media Stream conectado');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          console.log(`📞 Llamada [${msg.start.callSid}] — Stream: ${streamSid}`);
          break;

        case 'media': {
          // μ-law 8kHz → PCM16 16kHz → ElevenLabs
          const ulaw  = Buffer.from(msg.media.payload, 'base64');
          const pcm8  = ulawToPcm16(ulaw);
          const pcm16 = upsample8to16(pcm8);
          const b64   = pcm16.toString('base64');
          if (elReady && elWs.readyState === WebSocket.OPEN) {
            elWs.send(JSON.stringify({ user_audio_chunk: b64 }));
          } else {
            audioQueue.push(b64);
          }
          break;
        }

        case 'stop':
          console.log('📞 Llamada finalizada');
          if (elWs.readyState === WebSocket.OPEN) elWs.close();
          break;
      }
    } catch (err) {
      console.error('Error msg Twilio:', err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio WS cerrado');
    if (elWs.readyState === WebSocket.OPEN) elWs.close();
  });

  twilioWs.on('error', (err) => console.error('❌ Twilio WS error:', err.message));
}

module.exports = { handleTwilioStream };
