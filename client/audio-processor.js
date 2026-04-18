/**
 * audio-processor.js — AudioWorkletProcessor
 * 
 * Este script corre en el AudioWorklet thread (fuera del main thread),
 * garantizando procesamiento de audio en tiempo real sin latencia.
 * 
 * Responsabilidades:
 * - Capturar audio del micrófono en tiempo real
 * - Convertir float32 → PCM 16-bit (16kHz)
 * - Enviar chunks al main thread via postMessage
 * - Reproducir audio entrante (del agente) en tiempo real
 */

class MicrophoneCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Buffer para acumular muestras antes de enviar
    this._bufferSize = options.processorOptions?.bufferSize || 2048;
    this._buffer = new Float32Array(this._bufferSize);
    this._bufferIndex = 0;

    // Estado de actividad
    this._isCapturing = true;
    this._isMuted = false;

    // Escuchar comandos del main thread
    this.port.onmessage = (event) => {
      const { type } = event.data;
      if (type === 'stop_capture') {
        this._isCapturing = false;
      } else if (type === 'start_capture') {
        this._isCapturing = true;
      } else if (type === 'mute') {
        this._isMuted = true;
      } else if (type === 'unmute') {
        this._isMuted = false;
      }
    };
  }

  process(inputs) {
    // inputs[0] = primer canal de entrada (micrófono)
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0]; // Mono
    if (!channelData) return true;

    if (!this._isCapturing || this._isMuted) return true;

    // Acumular muestras en el buffer
    for (let i = 0; i < channelData.length; i++) {
      this._buffer[this._bufferIndex++] = channelData[i];

      if (this._bufferIndex >= this._bufferSize) {
        // Buffer lleno — enviar al main thread
        const pcm16 = this._float32ToPCM16(this._buffer);
        this.port.postMessage({
          type: 'audio_chunk',
          pcm16: pcm16
        }, [pcm16.buffer]); // Transferir el buffer (zero-copy)

        this._bufferIndex = 0;
      }
    }

    return true; // Mantener el processor activo
  }

  /**
   * Convierte Float32Array [-1,1] → Int16Array PCM 16-bit
   */
  _float32ToPCM16(float32Buffer) {
    const int16 = new Int16Array(float32Buffer.length);
    for (let i = 0; i < float32Buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Buffer[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }
}

registerProcessor('microphone-capture-processor', MicrophoneCaptureProcessor);
