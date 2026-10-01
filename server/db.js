'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('❌ DATABASE_URL no está definida. Agrega el plugin PostgreSQL en Railway o configura .env');
}

// SSL solo para BD remota (Railway); el Postgres local no lo soporta
const esLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: esLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

// ── Seed data ─────────────────────────────────────────────────────────────────

const CERRAJEROS_SEED = [
  { id: 'CRR-001', nombre: 'Carlos Rodríguez', telefono: '+17871110001', zonas: ['Bayamón','Guaynabo','Toa Baja','Toa Alta'],        disponible: true, callmebot_apikey: '', es_especialista: false },
  { id: 'CRR-002', nombre: 'Miguel Torres',    telefono: '+17872220002', zonas: ['San Juan','Carolina','Canóvanas','Loíza'],          disponible: true, callmebot_apikey: '', es_especialista: false },
  { id: 'CRR-003', nombre: 'Juan Pérez',       telefono: '+17873330003', zonas: ['Caguas','Trujillo Alto','Gurabo','San Lorenzo'],    disponible: true, callmebot_apikey: '', es_especialista: false },
  { id: 'CRR-004', nombre: 'Roberto Martínez', telefono: '+17874440004', zonas: ['Ponce','Juana Díaz','Peñuelas','Guayanilla'],      disponible: true, callmebot_apikey: '', es_especialista: false },
  { id: 'CRR-005', nombre: 'Luis García',      telefono: '+17875550005', zonas: ['Arecibo','Manatí','Barceloneta','Dorado','Vega Alta','Vega Baja'], disponible: true, callmebot_apikey: '', es_especialista: false },
  // Especialista en apertura de vehículos europeos/exóticos (cubre toda la isla).
  // Los leads premium se le asignan directo a él.
  { id: 'CRR-006', nombre: 'Mateo Giraldo',    telefono: '+17876660006', zonas: [],                                                  disponible: true, callmebot_apikey: '', es_especialista: true },
];

const CATALOGO_SEED = [
  { id: 'apertura_puerta',       emoji: '🚪', nombre: 'Apertura de puerta',       precio_base: 65,  precio_emergencia: 95,  precio_copia_llave: 0, precio_llave_perdida: 0 },
  { id: 'cambio_cilindro',       emoji: '🔧', nombre: 'Cambio de cilindro',        precio_base: 80,  precio_emergencia: 120, precio_copia_llave: 0, precio_llave_perdida: 0 },
  { id: 'duplicado_llave',       emoji: '🗝️', nombre: 'Duplicado de llave',        precio_base: 25,  precio_emergencia: 40,  precio_copia_llave: 0, precio_llave_perdida: 0 },
  { id: 'apertura_caja_fuerte',  emoji: '🔒', nombre: 'Apertura de caja fuerte',   precio_base: 150, precio_emergencia: 220, precio_copia_llave: 0, precio_llave_perdida: 0 },
  { id: 'instalacion_cerradura', emoji: '⚙️', nombre: 'Instalación de cerradura',  precio_base: 90,  precio_emergencia: 135, precio_copia_llave: 0, precio_llave_perdida: 0 },
  { id: 'emergencia_vehiculo',   emoji: '🚗', nombre: 'Emergencia de vehículo',    precio_base: 75,  precio_emergencia: 110, precio_copia_llave: 0, precio_llave_perdida: 0 },
  { id: 'otro',                  emoji: '📋', nombre: 'Otro',                       precio_base: 60,  precio_emergencia: 90,  precio_copia_llave: 0, precio_llave_perdida: 0 },
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
      es_especialista  BOOLEAN NOT NULL DEFAULT false,
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
      id                   TEXT PRIMARY KEY,
      emoji                TEXT             DEFAULT '🔑',
      nombre               TEXT    NOT NULL,
      precio_base          NUMERIC(10,2) NOT NULL,
      precio_emergencia    NUMERIC(10,2) NOT NULL,
      precio_copia_llave   NUMERIC(10,2) NOT NULL DEFAULT 0,
      precio_llave_perdida NUMERIC(10,2) NOT NULL DEFAULT 0,
      activo               BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS precios_vehiculos (
      id                   SERIAL PRIMARY KEY,
      anio                 TEXT          NOT NULL,
      marca                TEXT          NOT NULL,
      modelo               TEXT          NOT NULL,
      precio_apertura      NUMERIC(10,2) NOT NULL DEFAULT 0,
      precio_copia_llave   NUMERIC(10,2) NOT NULL DEFAULT 0,
      precio_llave_perdida NUMERIC(10,2) NOT NULL DEFAULT 0,
      UNIQUE (anio, marca, modelo)
    );

    -- Centro de mando: una fila por llamada telefónica atendida por el agente.
    -- id = CallSid de Twilio (o el conversation_id si se importó de ElevenLabs).
    CREATE TABLE IF NOT EXISTS llamadas (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT UNIQUE,
      numero          TEXT        NOT NULL DEFAULT '',
      direccion       TEXT        NOT NULL DEFAULT '',
      inicio          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fin             TIMESTAMPTZ,
      duracion_seg    INTEGER,
      transcript      JSONB       NOT NULL DEFAULT '[]',
      servicio_id     TEXT,
      resumen         TEXT        NOT NULL DEFAULT '',
      costo_usd       NUMERIC(10,4),
      creditos        INTEGER,
      tokens_llm      INTEGER,
      tts_seg         NUMERIC(10,1),
      asr_seg         NUMERIC(10,1),
      fin_motivo      TEXT        NOT NULL DEFAULT '',
      metricas_ok     BOOLEAN     NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS llamadas_inicio_idx ON llamadas (inicio DESC);

    -- Ajustes editables desde el panel (clave → valor JSON)
    CREATE TABLE IF NOT EXISTS ajustes (
      clave TEXT PRIMARY KEY,
      valor JSONB NOT NULL
    );

    -- Consultas de precio al dueño por WhatsApp mientras el cliente espera en línea
    CREATE TABLE IF NOT EXISTS consultas (
      id              TEXT PRIMARY KEY,
      token           TEXT        NOT NULL UNIQUE,
      conversation_id TEXT        NOT NULL DEFAULT '',
      numero_cliente  TEXT        NOT NULL DEFAULT '',
      resumen         TEXT        NOT NULL DEFAULT '',
      pregunta        TEXT        NOT NULL DEFAULT '',
      estado          TEXT        NOT NULL DEFAULT 'pendiente',
      respuesta       TEXT        NOT NULL DEFAULT '',
      respondida_por  TEXT        NOT NULL DEFAULT '',
      whatsapp_ok     BOOLEAN     NOT NULL DEFAULT false,
      creada_en       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      respondida_en   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS consultas_creada_idx ON consultas (creada_en DESC);

    CREATE TABLE IF NOT EXISTS precios_apertura_marca (
      id               SERIAL PRIMARY KEY,
      marca            TEXT          NOT NULL UNIQUE,
      precio_apertura  NUMERIC(10,2) NOT NULL DEFAULT 0,
      notas            TEXT          NOT NULL DEFAULT ''
    );
  `);

  // Migraciones para tablas ya existentes (añade columnas si no existen)
  await pool.query(`
    ALTER TABLE catalogo ADD COLUMN IF NOT EXISTS precio_copia_llave   NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE catalogo ADD COLUMN IF NOT EXISTS precio_llave_perdida NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE precios_vehiculos ADD COLUMN IF NOT EXISTS precio_apertura NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE cerrajeros ADD COLUMN IF NOT EXISTS es_especialista BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS marca_vehiculo  TEXT DEFAULT '';
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS modelo_vehiculo TEXT DEFAULT '';
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS es_premium      BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS precio_cotizado TEXT DEFAULT '';
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS tipo_cerradura  TEXT DEFAULT '';
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS conversation_id TEXT DEFAULT '';
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS anio_vehiculo   TEXT DEFAULT '';
    ALTER TABLE servicios ADD COLUMN IF NOT EXISTS tipo_llave      TEXT DEFAULT '';
  `);

  // Seed cerrajeros si la tabla está vacía
  const { rows: [{ count: cCount }] } = await pool.query('SELECT COUNT(*) FROM cerrajeros');
  if (cCount === '0') {
    for (const c of CERRAJEROS_SEED) {
      await pool.query(
        `INSERT INTO cerrajeros (id, nombre, telefono, zonas, disponible, callmebot_apikey, es_especialista)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [c.id, c.nombre, c.telefono, JSON.stringify(c.zonas), c.disponible, c.callmebot_apikey, c.es_especialista === true]
      );
    }
    console.log('  ✅ Cerrajeros iniciales insertados');
  }

  // Seed catálogo si la tabla está vacía
  const { rows: [{ count: catCount }] } = await pool.query('SELECT COUNT(*) FROM catalogo');
  if (catCount === '0') {
    for (const s of CATALOGO_SEED) {
      await pool.query(
        `INSERT INTO catalogo (id, emoji, nombre, precio_base, precio_emergencia, precio_copia_llave, precio_llave_perdida)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [s.id, s.emoji, s.nombre, s.precio_base, s.precio_emergencia, s.precio_copia_llave, s.precio_llave_perdida]
      );
    }
    console.log('  ✅ Catálogo inicial insertado');
  }

  // Seed de precios de apertura por marca (require diferido: ese módulo importa este)
  const { seedPreciosAperturaMarca } = require('./precios-apertura-marca');
  await seedPreciosAperturaMarca();

  // Garantizar que el especialista exista aunque la tabla ya tuviera datos
  // (bases desplegadas antes de CRR-006). Idempotente: no pisa ediciones.
  const especialista = CERRAJEROS_SEED.find(c => c.es_especialista);
  if (especialista) {
    await pool.query(
      `INSERT INTO cerrajeros (id, nombre, telefono, zonas, disponible, callmebot_apikey, es_especialista)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [especialista.id, especialista.nombre, especialista.telefono, JSON.stringify(especialista.zonas),
       especialista.disponible, especialista.callmebot_apikey, true]
    );
    await pool.query(
      `UPDATE cerrajeros SET es_especialista = true WHERE id = $1`,
      [especialista.id]
    );
  }

  console.log('  ✅ Base de datos lista\n');
}

module.exports = { pool, initDB };
