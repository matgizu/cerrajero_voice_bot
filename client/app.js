'use strict';

/**
 * app.js — Cliente de Voz con ElevenLabs Conversational AI
 *
 * Flujo:
 *  1. Obtener signed URL del servidor (API key nunca llega al browser)
 *  2. Abrir WebSocket directo a ElevenLabs
 *  3. Capturar mic con AudioWorklet → PCM16 16kHz → ElevenLabs
 *  4. Recibir audio del agente → reproducir con AudioContext
 *  5. Mostrar transcripciones en tiempo real
 */

// ── Estado global ─────────────────────────────────────────────────────────────
const state = {
  ws:              null,   // WebSocket a ElevenLabs
  audioContext:    null,   // Para reproducción
  captureContext:  null,   // Para captura de mic
  micStream:       null,
  workletNode:     null,
  isSessionActive: false,
  isAgentSpeaking: false,
  nextPlayTime:    0,
  outputSampleRate: 16000, // Se actualiza con el metadata de ElevenLabs
};

// ── DOM ───────────────────────────────────────────────────────────────────────
const DOM = {
  talkBtn:         document.getElementById('talk-btn'),
  hangupBtn:       document.getElementById('hangup-btn'),
  statusText:      document.getElementById('status-text'),
  statusDot:       document.getElementById('status-dot'),
  waveform:        document.getElementById('waveform'),
  transcriptInput: document.getElementById('transcript-input'),
  transcriptOutput:document.getElementById('transcript-output'),
  serviceCard:     document.getElementById('service-card'),
  serviceDetails:  document.getElementById('service-details'),
  notification:    document.getElementById('notification'),
  agentAvatar:     document.getElementById('agent-avatar'),
  callTimer:       document.getElementById('call-timer'),
};

// ── Timer ─────────────────────────────────────────────────────────────────────
let callTimerInterval = null;

function startCallTimer() {
  const start = Date.now();
  callTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    if (DOM.callTimer)
      DOM.callTimer.textContent = `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  }, 1000);
}

function stopCallTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  if (DOM.callTimer) DOM.callTimer.textContent = '00:00';
}

// ── Notificaciones ────────────────────────────────────────────────────────────
function showNotification(msg, type = 'info') {
  if (!DOM.notification) return;
  DOM.notification.textContent = msg;
  DOM.notification.className = `notification notification--${type} notification--show`;
  setTimeout(() => DOM.notification.classList.remove('notification--show'), 4000);
}

// ── UI States ─────────────────────────────────────────────────────────────────
function setUIState(s) {
  const cfg = {
    idle:       { text:'Listo para atenderle',       dot:'dot--idle',       talk:true,  hangup:false, wave:false, pulse:false },
    connecting: { text:'Conectando con el agente...', dot:'dot--connecting', talk:false, hangup:true,  wave:false, pulse:false },
    listening:  { text:'Escuchando...',               dot:'dot--listening',  talk:false, hangup:true,  wave:true,  pulse:false },
    speaking:   { text:'Agente hablando...',           dot:'dot--speaking',   talk:false, hangup:true,  wave:false, pulse:true  },
    error:      { text:'Error de conexión',            dot:'dot--error',      talk:true,  hangup:false, wave:false, pulse:false },
  }[s] || {};
  if (DOM.statusText)  DOM.statusText.textContent = cfg.text;
  if (DOM.statusDot)   DOM.statusDot.className    = `status-dot ${cfg.dot}`;
  if (DOM.talkBtn)     DOM.talkBtn.style.display   = cfg.talk   ? 'flex' : 'none';
  if (DOM.hangupBtn)   DOM.hangupBtn.style.display  = cfg.hangup ? 'flex' : 'none';
  if (DOM.waveform)    DOM.waveform.classList.toggle('waveform--active', cfg.wave);
  if (DOM.agentAvatar) DOM.agentAvatar.classList.toggle('avatar--pulse', cfg.pulse);
}

// ── ElevenLabs — Obtener Signed URL ──────────────────────────────────────────
async function getSignedUrl() {
  const res  = await fetch('/api/elevenlabs/signed-url');
  const data = await res.json();
  if (!data.signedUrl) throw new Error(data.error || 'No se pudo obtener signed URL');
  return data.signedUrl;
}

// ── ElevenLabs — Conexión WebSocket ──────────────────────────────────────────
function conectarElevenLabs(signedUrl) {
  const ws = new WebSocket(signedUrl);

  ws.onopen = () => console.log('✅ ElevenLabs WS abierto');

  ws.onmessage = (event) => {
    try {
      handleElevenLabsMessage(JSON.parse(event.data));
    } catch (err) {
      console.error('Error procesando msg ElevenLabs:', err);
    }
  };

  ws.onerror = (err) => {
    console.error('❌ ElevenLabs WS error:', err);
    showNotification('Error de conexión con el agente', 'error');
    setUIState('error');
  };

  ws.onclose = () => {
    console.log('🔌 ElevenLabs WS cerrado');
    if (state.isSessionActive) {
      endSession();
      showNotification('Sesión terminada', 'warning');
    }
  };

  return ws;
}

// ── ElevenLabs — Manejar mensajes ─────────────────────────────────────────────
function handleElevenLabsMessage(msg) {
  switch (msg.type) {

    case 'conversation_initiation_metadata': {
      const meta = msg.conversation_initiation_metadata_event || {};
      // Detectar sample rate de salida del agente
      const fmt = meta.agent_output_audio_format || 'pcm_16000';
      state.outputSampleRate = parseInt(fmt.replace('pcm_', ''), 10) || 16000;
      console.log(`🎙️ Sesión lista | Audio salida: ${state.outputSampleRate}Hz`);
      state.isSessionActive = true;
      setUIState('listening');
      startCallTimer();
      showNotification('Conectado con el Asistente de Cerrajería', 'success');
      break;
    }

    case 'audio': {
      const b64 = msg.audio_event?.audio_base_64;
      if (b64) {
        reproducirAudio(b64);
        if (!state.isAgentSpeaking) {
          state.isAgentSpeaking = true;
          setUIState('speaking');
          muteMicrophone(true);
        }
      }
      break;
    }

    case 'agent_response_correction':
    case 'agent_response': {
      const text = msg.agent_response_event?.agent_response;
      if (text?.trim()) addTranscriptLine('agent', text);
      break;
    }

    case 'user_transcript': {
      const text = msg.user_transcription_event?.user_transcript;
      if (text?.trim()) addTranscriptLine('user', text);
      break;
    }

    case 'interruption':
      state.isAgentSpeaking = false;
      state.nextPlayTime    = 0;
      muteMicrophone(false);
      setUIState('listening');
      break;

    case 'ping':
      if (state.ws?.readyState === WebSocket.OPEN)
        state.ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
      break;

    case 'internal_tentative_agent_response':
      // Vista previa interna — ignorar
      break;

    default:
      if (msg.type) console.log('ElevenLabs msg:', msg.type);
  }
}

// ── Reproducción de audio ─────────────────────────────────────────────────────
async function reproducirAudio(base64Data) {
  try {
    if (!state.audioContext || state.audioContext.state === 'closed') {
      state.audioContext = new AudioContext({ sampleRate: state.outputSampleRate });
    }
    if (state.audioContext.state === 'suspended') await state.audioContext.resume();

    // Base64 → ArrayBuffer → Float32 (PCM16 → float)
    const bytes    = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const int16    = new Int16Array(bytes.buffer);
    const float32  = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buf    = state.audioContext.createBuffer(1, float32.length, state.outputSampleRate);
    buf.copyToChannel(float32, 0);

    const src = state.audioContext.createBufferSource();
    src.buffer = buf;
    src.connect(state.audioContext.destination);

    const now   = state.audioContext.currentTime;
    const start = Math.max(now, state.nextPlayTime);
    src.start(start);
    state.nextPlayTime = start + buf.duration;

    // Cuando termina el turno de audio, volver a escuchar
    src.onended = () => {
      if (state.nextPlayTime <= state.audioContext.currentTime + 0.05) {
        state.isAgentSpeaking = false;
        muteMicrophone(false);
        setUIState('listening');
      }
    };
  } catch (err) {
    console.error('Error reproduciendo audio:', err);
  }
}

// ── Captura de micrófono ──────────────────────────────────────────────────────
async function startMicrophone() {
  try {
    state.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    state.captureContext = new AudioContext({ sampleRate: 16000 });
    await state.captureContext.audioWorklet.addModule('/audio-processor.js');

    const source = state.captureContext.createMediaStreamSource(state.micStream);
    state.workletNode = new AudioWorkletNode(state.captureContext, 'microphone-capture-processor', {
      processorOptions: { bufferSize: 2048 }
    });

    state.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'audio_chunk' && state.ws?.readyState === WebSocket.OPEN) {
        if (!state.isAgentSpeaking && state.isSessionActive) {
          const b64 = arrayBufferToBase64(e.data.pcm16.buffer);
          state.ws.send(JSON.stringify({ user_audio_chunk: b64 }));
        }
      }
    };

    source.connect(state.workletNode);
    state.workletNode.connect(state.captureContext.destination);
    console.log('🎤 Micrófono iniciado');
    return true;
  } catch (err) {
    if (err.name === 'NotAllowedError') showNotification('⚠️ Permite el acceso al micrófono', 'error');
    else showNotification(`Error de micrófono: ${err.message}`, 'error');
    return false;
  }
}

function muteMicrophone(muted) {
  state.workletNode?.port.postMessage({ type: muted ? 'mute' : 'unmute' });
}

function stopMicrophone() {
  state.workletNode?.port.postMessage({ type: 'stop_capture' });
  state.workletNode?.disconnect();
  state.workletNode = null;
  state.micStream?.getTracks().forEach(t => t.stop());
  state.micStream = null;
  state.captureContext?.close();
  state.captureContext = null;
}

// ── Utilidades ────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function escapeHTML(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Transcripciones ───────────────────────────────────────────────────────────
function addTranscriptLine(speaker, text) {
  const el = speaker === 'user' ? DOM.transcriptInput : DOM.transcriptOutput;
  if (!el) return;
  const line  = document.createElement('div');
  line.className = `transcript-line transcript-line--${speaker}`;
  const time  = new Date().toLocaleTimeString('es-PR', { hour:'2-digit', minute:'2-digit' });
  line.innerHTML = `<span class="transcript-time">${time}</span><span class="transcript-text">${escapeHTML(text)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// ── Tarjeta de servicio ───────────────────────────────────────────────────────
const TIPO_LABELS = {
  apertura_puerta:'Apertura de Puerta', cambio_cilindro:'Cambio de Cilindro',
  duplicado_llave:'Duplicado de Llave', apertura_caja_fuerte:'Apertura de Caja Fuerte',
  instalacion_cerradura:'Instalación de Cerradura', emergencia_vehiculo:'Emergencia de Vehículo',
  otro:'Otro Servicio'
};

function showServiceCard(d) {
  if (!DOM.serviceCard || !DOM.serviceDetails) return;
  const badge = d.es_emergencia
    ? '<span class="badge badge--emergency">🚨 EMERGENCIA</span>'
    : '<span class="badge badge--normal">✅ Normal</span>';
  DOM.serviceDetails.innerHTML = `
    <div class="service-row"><span class="service-label">ID:</span><span class="service-value service-id">${d.id}</span></div>
    <div class="service-row"><span class="service-label">Cliente:</span><span class="service-value">${escapeHTML(d.nombre)}</span></div>
    <div class="service-row"><span class="service-label">Teléfono:</span><span class="service-value">${escapeHTML(d.telefono)}</span></div>
    <div class="service-row"><span class="service-label">Ubicación:</span><span class="service-value">${escapeHTML(d.ubicacion)}</span></div>
    <div class="service-row"><span class="service-label">Tipo:</span><span class="service-value">${TIPO_LABELS[d.tipo_servicio] || d.tipo_servicio}</span></div>
    <div class="service-row"><span class="service-label">Prioridad:</span><span class="service-value">${badge}</span></div>
    <div class="service-row"><span class="service-label">Cerrajero:</span><span class="service-value">${escapeHTML(d.cerrajero_nombre || 'Asignando...')}</span></div>
    <div class="service-row"><span class="service-label">ETA:</span><span class="service-value">~${d.tiempo_estimado_minutos} minutos</span></div>
  `;
  DOM.serviceCard.classList.add('service-card--visible');
}

// ── SSE — Notificación de servicio guardado ───────────────────────────────────
function conectarSSE() {
  const es = new EventSource('/api/eventos');
  es.addEventListener('servicio_nuevo', (e) => {
    const s = JSON.parse(e.data);
    showServiceCard(s);
    showNotification('✅ Servicio registrado correctamente', 'success');
  });
}

// ── Sesión ────────────────────────────────────────────────────────────────────
async function startSession() {
  setUIState('connecting');
  try {
    const signedUrl = await getSignedUrl();
    state.ws = conectarElevenLabs(signedUrl);

    const micOk = await startMicrophone();
    if (!micOk) {
      state.ws?.close();
      setUIState('idle');
      return;
    }
  } catch (err) {
    console.error('Error iniciando sesión:', err);
    showNotification(err.message || 'Error al conectar', 'error');
    setUIState('error');
  }
}

function endSession() {
  state.isSessionActive = false;
  state.isAgentSpeaking = false;
  state.nextPlayTime    = 0;

  stopMicrophone();
  stopCallTimer();

  if (state.ws?.readyState === WebSocket.OPEN) state.ws.close();
  state.ws = null;

  state.audioContext?.close();
  state.audioContext = null;

  setUIState('idle');
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setUIState('idle');
  conectarSSE();

  DOM.talkBtn?.addEventListener('click', startSession);
  DOM.hangupBtn?.addEventListener('click', () => {
    endSession();
    showNotification('Llamada finalizada', 'info');
  });

  if (!navigator.mediaDevices || !window.AudioContext || !window.AudioWorklet) {
    showNotification('⚠️ Usa Chrome o Edge para esta app', 'warning');
    if (DOM.talkBtn) DOM.talkBtn.disabled = true;
  }
});
