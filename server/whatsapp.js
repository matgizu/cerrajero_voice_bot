'use strict';

const https = require('https');

const TIPO_LABELS = {
  apertura_puerta:       'Apertura de puerta',
  cambio_cilindro:       'Cambio de cilindro',
  duplicado_llave:       'Duplicado de llave',
  apertura_caja_fuerte:  'Apertura caja fuerte',
  instalacion_cerradura: 'Instalación cerradura',
  emergencia_vehiculo:   'Emergencia vehículo',
  otro:                  'Otro'
};

/**
 * Envía WhatsApp al cerrajero asignado usando la API gratuita de CallMeBot.
 *
 * Setup previo por cada cerrajero (una sola vez):
 *   1. Enviar "I allow callmebot to send me messages" al +34 644 63 96 23 en WhatsApp
 *   2. Recibirán su apikey personal de respuesta
 *   3. Guardarla en server/data/cerrajeros.json → campo "callmebot_apikey"
 */
async function notificarCerrajero(cerrajero, servicio) {
  if (!cerrajero?.callmebot_apikey) {
    console.warn(`⚠️  Sin apikey CallMeBot para ${cerrajero?.nombre}. Notificación omitida.`);
    return { ok: false, error: 'Sin apikey' };
  }

  const emoji     = servicio.es_emergencia ? '🚨' : '🔑';
  const prioridad = servicio.es_emergencia ? '\n⚠️ *EMERGENCIA — atención inmediata*' : '';
  const tipo      = TIPO_LABELS[servicio.tipo_servicio] || servicio.tipo_servicio;
  const notas     = servicio.notas_adicionales ? `\n📝 Notas: ${servicio.notas_adicionales}` : '';

  const texto = [
    `${emoji} *NUEVO SERVICIO* — Cerrajería Express`,
    ``,
    `📋 ID: ${servicio.id}`,
    `👤 Cliente: ${servicio.nombre}`,
    `📱 Tel: ${servicio.telefono}`,
    `📍 Ubicación: ${servicio.ubicacion}`,
    `🔧 Servicio: ${tipo}${prioridad}${notas}`,
    ``,
    `⏱️ ETA estimado: ~${servicio.tiempo_estimado_minutos} min`
  ].join('\n');

  // CallMeBot espera el número en formato internacional sin + ni espacios
  const phone = cerrajero.telefono.replace(/\D/g, '');
  const url   = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(texto)}&apikey=${cerrajero.callmebot_apikey}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const ok = res.statusCode === 200;
        console.log(`📱 WhatsApp → ${cerrajero.nombre}: ${ok ? '✅ enviado' : `❌ error (${res.statusCode})`}`);
        resolve({ ok, status: res.statusCode });
      });
    }).on('error', (err) => {
      console.error(`❌ Error WhatsApp → ${cerrajero.nombre}:`, err.message);
      resolve({ ok: false, error: err.message });
    });
  });
}

module.exports = { notificarCerrajero };
