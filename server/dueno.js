'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  APP DEL DUEÑO (/dueno) — link fijo y notificaciones push
//  ------------------------------------------------------------------------------
//  - Link fijo y público por ahora (pedido del cliente 2026-10-01): siempre la
//    misma app en /dueno/, sin autenticación.
//  - La página es una PWA: en Android avisa desde Chrome; en iPhone hay que
//    agregarla a la pantalla de inicio (requisito de Apple para Web Push).
//  - Las claves VAPID se generan solas la primera vez y se guardan en la BD.
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const webpush = require('web-push');
const { pool } = require('./db');

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

async function leer(clave) {
  const { rows } = await pool.query('SELECT valor FROM ajustes WHERE clave = $1', [clave]);
  return rows[0]?.valor || null;
}
async function escribir(clave, valor) {
  await pool.query(
    `INSERT INTO ajustes (clave, valor) VALUES ($1, $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [clave, JSON.stringify(valor)]
  );
}

// ── Claves VAPID (identifican a nuestro servidor ante Google/Apple/Mozilla) ──

let vapid = null;
async function claves() {
  if (vapid) return vapid;
  vapid = await leer('vapid');
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    await escribir('vapid', vapid);
  }
  // El "subject" VAPID tiene que ser https: o mailto: (en local PUBLIC_URL es http)
  const publica = process.env.PUBLIC_URL || '';
  const contacto = publica.startsWith('https:') ? publica : 'https://cerrajerovoicebot-production-ed8a.up.railway.app';
  webpush.setVapidDetails(contacto, vapid.publicKey, vapid.privateKey);
  return vapid;
}

async function clavePublica() {
  return (await claves()).publicKey;
}

// ── Celulares con avisos ─────────────────────────────────────────────────────
// Cada celular se identifica por el endpoint de su suscripción push.

async function guardarSuscripcion(suscripcion, nombre) {
  if (!suscripcion?.endpoint) throw new Error('Suscripción inválida');
  await pool.query(
    `INSERT INTO dueno_dispositivos (sesion, suscripcion, nombre) VALUES ($1, $2, $3)
     ON CONFLICT (sesion) DO UPDATE SET suscripcion = EXCLUDED.suscripcion, ultimo_uso = NOW()`,
    [sha256(suscripcion.endpoint), JSON.stringify(suscripcion), String(nombre || '').slice(0, 120)]
  );
}

async function listarDispositivos() {
  const { rows } = await pool.query(
    'SELECT id, nombre, creado_en, ultimo_uso, suscripcion IS NOT NULL AS avisos FROM dueno_dispositivos ORDER BY ultimo_uso DESC'
  );
  return rows;
}

/** Borra todos los celulares registrados (dejan de recibir avisos hasta volver a activarlos). */
async function quitarAvisos() {
  await pool.query('DELETE FROM dueno_dispositivos');
}

// ── Notificaciones ───────────────────────────────────────────────────────────

/**
 * Manda un push a todos los celulares del dueño con avisos activados.
 * @returns {number} cuántos lo recibieron
 */
async function notificar({ titulo, cuerpo, url = '/dueno', tag }) {
  await claves();
  const { rows } = await pool.query('SELECT id, suscripcion FROM dueno_dispositivos WHERE suscripcion IS NOT NULL');
  const payload = JSON.stringify({ titulo, cuerpo, url, tag });
  let enviados = 0;
  await Promise.all(rows.map(async r => {
    try {
      // urgency high: el celular lo entrega aunque esté en ahorro de batería
      await webpush.sendNotification(r.suscripcion, payload, { TTL: 300, urgency: 'high' });
      enviados++;
    } catch (err) {
      // 404/410: el navegador anuló la suscripción (desinstaló la app, quitó permisos)
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('UPDATE dueno_dispositivos SET suscripcion = NULL WHERE id = $1', [r.id]);
      } else {
        console.error('❌ Push al dueño:', err.statusCode || '', err.body || err.message);
      }
    }
  }));
  return enviados;
}

module.exports = {
  clavePublica,
  guardarSuscripcion,
  listarDispositivos,
  quitarAvisos,
  notificar,
};
