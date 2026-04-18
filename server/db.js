'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('❌ DATABASE_URL no está definida. Agrega el plugin PostgreSQL en Railway o configura .env');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

// ── Seed data ─────────────────────────────────────────────────────────────────

const CERRAJEROS_SEED = [
  { id: 'CRR-001', nombre: 'Carlos Rodríguez', telefono: '+17871110001', zonas: ['Bayamón','Guaynabo','Toa Baja','Toa Alta'],        disponible: true, callmebot_apikey: '' },
  { id: 'CRR-002', nombre: 'Miguel Torres',    telefono: '+17872220002', zonas: ['San Juan','Carolina','Canóvanas','Loíza'],          disponible: true, callmebot_apikey: '' },
  { id: 'CRR-003', nombre: 'Juan Pérez',       telefono: '+17873330003', zonas: ['Caguas','Trujillo Alto','Gurabo','San Lorenzo'],    disponible: true, callmebot_apikey: '' },
  { id: 'CRR-004', nombre: 'Roberto Martínez', telefono: '+17874440004', zonas: ['Ponce','Juana Díaz','Peñuelas','Guayanilla'],      disponible: true, callmebot_apikey: '' },
  { id: 'CRR-005', nombre: 'Luis García',      telefono: '+17875550005', zonas: ['Arecibo','Manatí','Barceloneta','Dorado','Vega Alta','Vega Baja'], disponible: true, callmebot_apikey: '' },
];

const CATALOGO_SEED = [
  { id: 'apertura_puerta',       emoji: '🚪', nombre: 'Apertura de puerta',       precio_base: 65,  precio_emergencia: 95  },
  { id: 'cambio_cilindro',       emoji: '🔧', nombre: 'Cambio de cilindro',        precio_base: 80,  precio_emergencia: 120 },
  { id: 'duplicado_llave',       emoji: '🗝️', nombre: 'Duplicado de llave',        precio_base: 25,  precio_emergencia: 40  },
  { id: 'apertura_caja_fuerte',  emoji: '🔒', nombre: 'Apertura de caja fuerte',   precio_base: 150, precio_emergencia: 220 },
  { id: 'instalacion_cerradura', emoji: '⚙️', nombre: 'Instalación de cerradura',  precio_base: 90,  precio_emergencia: 135 },
  { id: 'emergencia_vehiculo',   emoji: '🚗', nombre: 'Emergencia de vehículo',    precio_base: 75,  precio_emergencia: 110 },
  { id: 'otro',                  emoji: '📋', nombre: 'Otro',                       precio_base: 60,  precio_emergencia: 90  },
];

// ── Inicialización de tablas ───────────────────────────────────────────────────

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cerrajeros (
      id               TEXT PRIMARY KEY,
      nombre           TEXT    NOT NULL,
      telefono         TEXT    NOT NULL,
      zonas            JSONB   NOT NULL DEFAULT '[]',
      disponible       BOOLEAN NOT NULL DEFAULT true,
      callmebot_apikey TEXT             DEFAULT '',
      ultimo_servicio  TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS servicios (
      id                       TEXT PRIMARY KEY,
      nombre                   TEXT    NOT NULL,
      telefono                 TEXT    NOT NULL,
      ubicacion                TEXT    NOT NULL,
      tipo_servicio            TEXT    NOT NULL,
      es_emergencia            BOOLEAN NOT NULL DEFAULT false,
      notas_adicionales        TEXT             DEFAULT '',
      estado                   TEXT    NOT NULL DEFAULT 'pendiente',
      cerrajero_id             TEXT,
      cerrajero_nombre         TEXT,
      creado_en                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizado_en           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tiempo_estimado_minutos  INTEGER     NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS catalogo (
      id                TEXT PRIMARY KEY,
      emoji             TEXT             DEFAULT '🔑',
      nombre            TEXT    NOT NULL,
      precio_base       NUMERIC(10,2) NOT NULL,
      precio_emergencia NUMERIC(10,2) NOT NULL,
      activo            BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Seed cerrajeros si la tabla está vacía
  const { rows: [{ count: cCount }] } = await pool.query('SELECT COUNT(*) FROM cerrajeros');
  if (cCount === '0') {
    for (const c of CERRAJEROS_SEED) {
      await pool.query(
        `INSERT INTO cerrajeros (id, nombre, telefono, zonas, disponible, callmebot_apikey)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [c.id, c.nombre, c.telefono, JSON.stringify(c.zonas), c.disponible, c.callmebot_apikey]
      );
    }
    console.log('  ✅ Cerrajeros iniciales insertados');
  }

  // Seed catálogo si la tabla está vacía
  const { rows: [{ count: catCount }] } = await pool.query('SELECT COUNT(*) FROM catalogo');
  if (catCount === '0') {
    for (const s of CATALOGO_SEED) {
      await pool.query(
        `INSERT INTO catalogo (id, emoji, nombre, precio_base, precio_emergencia)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [s.id, s.emoji, s.nombre, s.precio_base, s.precio_emergencia]
      );
    }
    console.log('  ✅ Catálogo inicial insertado');
  }

  console.log('  ✅ Base de datos lista\n');
}

module.exports = { pool, initDB };
