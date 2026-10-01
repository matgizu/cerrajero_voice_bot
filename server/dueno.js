'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  APP DEL DUEÑO (/dueno) — acceso por enlace y notificaciones push
//  ------------------------------------------------------------------------------
//  - Desde el panel se genera un enlace de acceso secreto. El dueño lo abre una
//    vez en su celular y queda con una cookie de sesión (no escribe contraseña).
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

// ── Enlace de acceso y sesiones ──────────────────────────────────────────────

/** Genera un enlace nuevo (el anterior deja de servir; los celulares ya conectados siguen). */
async function generarEnlace(baseUrl) {
  const token = crypto.randomBytes(24).toString('base64url');
  await escribir('dueno_acceso', { hash: sha256(token), creado: new Date().toISOString() });
  return `${baseUrl}/dueno/acceso/${token}`;
}

/** Valida el token del enlace y crea una sesión para ese celular. */
async function canjearEnlace(token, nombre) {
  const acceso = await leer('dueno_acceso');
  if (!acceso?.hash) return null;
  const a = Buffer.from(acceso.hash), b = Buffer.from(sha256(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const sesion = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    'INSERT INTO dueno_dispositivos (sesion, nombre) VALUES ($1, $2)',
    [sha256(sesion), String(nombre || '').slice(0, 120)]
  );
  return sesion;
}

/** Sesión del dueño desde la cookie (se guarda solo el hash en la BD). */
async function sesionValida(sesion) {
  if (!sesion) return null;
  const { rows } = await pool.query(
    'UPDATE dueno_dispositivos SET ultimo_uso = NOW() WHERE sesion = $1 RETURNING id, suscripcion IS NOT NULL AS avisos',
    [sha256(sesion)]
  );
  return rows[0] || null;
}

async function guardarSuscripcion(sesion, suscripcion) {
  if (!suscripcion?.endpoint) throw new Error('Suscripción inválida');
  await pool.query('UPDATE dueno_dispositivos SET suscripcion = $2 WHERE sesion = $1', [sha256(sesion), JSON.stringify(suscripcion)]);
}

async function listarDispositivos() {
  const { rows } = await pool.query(
    'SELECT id, nombre, creado_en, ultimo_uso, suscripcion IS NOT NULL AS avisos FROM dueno_dispositivos ORDER BY ultimo_uso DESC'
  );
  return rows;
}

async function desconectarTodos() {
  await pool.query('DELETE FROM dueno_dispositivos');
  await escribir('dueno_acceso', {});
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
  generarEnlace,
  canjearEnlace,
  sesionValida,
  guardarSuscripcion,
  listarDispositivos,
  desconectarTodos,
  notificar,
};
