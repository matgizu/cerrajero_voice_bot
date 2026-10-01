'use strict';

const https = require('https');

const TIPO_LABELS = {
  apertura_puerta:       'Apertura de puerta',
  cambio_cilindro:       'Cambio de cilindro',
  duplicado_llave:       'Duplicado de llave',
  apertura_caja_fuerte:  'Apertura caja fuerte',
  instalacion_cerradura: 'Instalación cerradura',
  emergencia_vehiculo:   'Emergencia vehículo',
  llave_vehiculo:        'Llave de vehículo',
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
  const vehiculo  = [servicio.marca_vehiculo, servicio.modelo_vehiculo, servicio.anio_vehiculo].filter(Boolean).join(' ');
  const detalle   = [
    vehiculo ? `\n🚗 Vehículo: ${vehiculo}` : '',
    servicio.tipo_llave ? `\n🔑 Llave: ${servicio.tipo_llave}` : '',
    servicio.precio_cotizado ? `\n💵 Precio: ${servicio.precio_cotizado}` : '',
  ].join('');

  const texto = [
    `${emoji} *NUEVO SERVICIO* — Tu Cerrajero Puerto Rico`,
    ``,
    `📋 ID: ${servicio.id}`,
    `👤 Cliente: ${servicio.nombre}`,
    `📱 Tel: ${servicio.telefono}`,
    `📍 Ubicación: ${servicio.ubicacion}`,
    `🔧 Servicio: ${tipo}${prioridad}${detalle}${notas}`,
    ``,
    `⏱️ ETA estimado: ~${servicio.tiempo_estimado_minutos} min`
  ].join('\n');

  const r = await enviarWhatsApp(cerrajero.telefono, cerrajero.callmebot_apikey, texto);
  console.log(`📱 WhatsApp → ${cerrajero.nombre}: ${r.ok ? '✅ enviado' : `❌ error (${r.status || r.error})`}`);
  return r;
}

/**
 * Envía un WhatsApp con CallMeBot (gratis, solo envío). El destinatario debe
 * haber activado CallMeBot una vez y darnos su apikey personal.
 */
function enviarWhatsApp(telefono, apikey, texto) {
  // CallMeBot espera el número en formato internacional sin + ni espacios
  const phone = String(telefono || '').replace(/\D/g, '');
  if (!phone || !apikey) return Promise.resolve({ ok: false, error: 'Falta número o apikey' });
  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(texto)}&apikey=${encodeURIComponent(apikey)}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: body.slice(0, 300) }));
    }).on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

module.exports = { notificarCerrajero, enviarWhatsApp };
