# 🔑 Cerrajero Voice Agent — Gemini Multimodal Live API

> Agente de voz inteligente 24/7 para **Cerrajería Express**, construido con Node.js, WebSockets y la **Gemini Multimodal Live API**.

---

## 🚀 Inicio Rápido

### 1. Clonar / Entrar al directorio
```bash
cd AGENT_VOICE_GOOGLE_IA
```

### 2. Instalar dependencias
```bash
npm install
```

### 3. Configurar API Key
```bash
cp .env.example .env
# Edita .env y agrega tu GEMINI_API_KEY
```
> Obtén tu API Key gratis en: https://aistudio.google.com/app/apikey

### 4. Iniciar el servidor
```bash
npm start
# ó en modo desarrollo con auto-reload:
npm run dev
```

### 5. Abrir la interfaz
```
http://localhost:3000
```

Clic en **"Hablar con Cerrajero"** → permite el micrófono → ¡comienza la conversación!

---

## 🏗️ Arquitectura

```
Browser (Chrome/Edge)
  │
  │  WebSocket ws://localhost:3000/ws
  │
  ▼
Node.js + Express (server/index.js)
  │  ← Proxy seguro, API Key nunca llega al cliente
  │  ← Intercepta Function Calls y ejecuta lógica de negocio
  │
  │  WebSocket wss://generativelanguage.googleapis.com/ws/...
  │
  ▼
Gemini Multimodal Live API (gemini-2.0-flash-live-001)
```

---

## 📁 Estructura de Archivos

```
AGENT_VOICE_GOOGLE_IA/
├── server/
│   ├── index.js          # Servidor Express + WS proxy
│   ├── gemini.js         # Config Gemini: system prompt, tools, setup
│   └── services.js       # Lógica de guardar_servicio (function calling)
├── client/
│   ├── index.html        # UI del agente (HTML semántico)
│   ├── app.js            # Lógica cliente: WS, AudioWorklet, UI
│   ├── audio-processor.js# AudioWorkletProcessor (mic → PCM16)
│   └── styles.css        # UI dark premium con animaciones
├── .env.example          # Plantilla de variables de entorno
├── .gitignore
├── package.json
└── README.md
```

---

## ⚙️ Variables de Entorno

| Variable | Descripción | Default |
|---|---|---|
| `GEMINI_API_KEY` | Tu API Key de Google Gemini | *(requerida)* |
| `PORT` | Puerto del servidor | `3000` |
| `GEMINI_MODEL` | Modelo de Gemini Live | `gemini-2.0-flash-live-001` |
| `AGENT_VOICE` | Voz del agente | `Charon` |
| `NODE_ENV` | Entorno | `development` |

**Voces disponibles:** `Puck`, `Charon`, `Kore`, `Fenrir`, `Aoede`

---

## 🎙️ Flujo de Audio

### Captura (Micrófono → Gemini)
1. `navigator.mediaDevices.getUserMedia` — acceso al mic con AEC/NS/AGC
2. **AudioWorklet** (`audio-processor.js`) — captura en hilo dedicado, convierte Float32 → PCM16 @ 16kHz
3. Zero-copy buffer transfer al main thread via `postMessage`
4. Base64 encode → WebSocket → servidor → Gemini `realtimeInput`

### Reproducción (Gemini → Altavoz)
1. Gemini devuelve chunks de audio PCM16 @ 24kHz (base64)
2. Servidor reenvía chunks al browser
3. `pcm16ToAudioBuffer` convierte PCM16 → Float32 → `AudioBuffer`
4. **Reproducción secuencial** programada con `AudioContext.currentTime` (sin gaps)
5. **Anti-eco**: se silencia el micrófono mientras habla el agente

---

## 🔧 Function Calling — `guardar_servicio`

Cuando el agente recopila todos los datos, Gemini llama automáticamente a:

```json
{
  "nombre": "Juan García",
  "telefono": "+34 612 345 678",
  "ubicacion": "Calle Mayor 42, 3°B, Madrid",
  "tipo_servicio": "apertura_puerta",
  "es_emergencia": false,
  "notas_adicionales": "Puerta atasacada, no gira el pomo"
}
```

El servidor lo intercepta, ejecuta `guardar_servicio()`, lo loguea en consola y responde a Gemini para que el agente confirme al cliente.

**Ver servicios guardados:**
```
GET http://localhost:3000/api/servicios
```

---

## 🌐 Tipos de Servicio

| Código | Descripción |
|---|---|
| `apertura_puerta` | Apertura de puerta (olvido, rotura) |
| `cambio_cilindro` | Cambio o reparación de cilindro |
| `duplicado_llave` | Duplicado de llaves |
| `apertura_caja_fuerte` | Apertura de caja de seguridad |
| `instalacion_cerradura` | Instalación de nueva cerradura |
| `emergencia_vehiculo` | Apertura de vehículo |
| `otro` | Otro tipo de servicio |

---

## 🛠️ Requisitos

- **Node.js** >= 18.0.0
- **Navegador**: Chrome 89+ o Edge 89+ (requiere AudioWorklet + WebSocket)
- **API Key**: Google Gemini (gratuita en AI Studio)

---

## 🔒 Seguridad

- La `GEMINI_API_KEY` **nunca** se expone al cliente — solo el servidor la usa
- El servidor actúa como proxy seguro para la API de Gemini
- En producción, añadir autenticación y rate limiting al endpoint `/ws`

---

## 📝 Endpoints

| Endpoint | Descripción |
|---|---|
| `GET /` | Interfaz web del agente |
| `WS /ws` | WebSocket del agente de voz |
| `GET /api/health` | Estado del servidor |
| `GET /api/servicios` | Lista servicios guardados (debug) |

---

## 🏭 Producción

```bash
# Variables de entorno en producción
NODE_ENV=production
PORT=8080
GEMINI_API_KEY=tu_api_key_real

# Con PM2
npm install -g pm2
pm2 start server/index.js --name cerrajero-agent
pm2 save
```

---

*Desarrollado con ❤️ — Cerrajería Express 24/7*
