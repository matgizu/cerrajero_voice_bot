'use strict';

const { pool } = require('./db');

// ══════════════════════════════════════════════════════════════════════════════
//  CLASIFICACIÓN DE MARCAS POR CATEGORÍA DE PRECIO
//  ------------------------------------------------------------------------------
//  El precio de apertura de vehículo depende ÚNICAMENTE de la marca (más un caso
//  especial por modelo: Corvette). No depende del tipo de llave ni del año.
//
//    • económica  → $65 fijo en toda la isla
//    • europea    → con varilla $85 · por cerradura desde $150 (depende del área)
//    • exótica    → desde $250 (depende del área)
//
//  Europea y exótica son servicios especializados que hace el dueño (Mateo);
//  el precio "desde" varía por zona geográfica y lo confirma el especialista.
// ══════════════════════════════════════════════════════════════════════════════

const MARCAS_EXOTICA = new Set([
  'Ferrari', 'Maserati', 'Porsche',
]);

const MARCAS_EUROPEA = new Set([
  'Alfa Romeo', 'Audi', 'BMW', 'Fiat', 'Jaguar', 'Land Rover',
  'Mercedes-Benz', 'Mini', 'Volkswagen', 'Volvo',
]);

const MARCAS_ECONOMICA = [
  'Acura', 'Buick', 'Cadillac', 'Chevrolet', 'Chrysler', 'Dodge', 'Ford',
  'Genesis', 'GMC', 'Honda', 'Hyundai', 'Infiniti', 'Jeep', 'Kia', 'Lexus',
  'Lincoln', 'Mazda', 'Mercury', 'Mitsubishi', 'Nissan', 'Oldsmobile',
  'Pontiac', 'Ram', 'Saab', 'Saturn', 'Scion', 'Smart', 'Subaru', 'Suzuki',
  'Tesla', 'Toyota',
];

// Precios de referencia por categoría (fuente única de verdad para la cotización).
const PRECIOS = {
  economica: { precio_apertura: 65 },
  europea:   { precio_varilla: 85, precio_desde: 150 },
  exotica:   { precio_desde: 250 },
  corvette:  { precio_desde: 250 },
};

const _sinAcentos = (s) =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ── Normalización y clasificación ─────────────────────────────────────────────

/**
 * Devuelve el nombre canónico de la marca (tal como está en las listas) a partir
 * de un texto libre del cliente. Tolera mayúsculas/acentos/variantes comunes.
 */
function normalizarMarca(marca) {
  if (!marca) return null;
  const limpio = _sinAcentos(marca);

  const ALIAS = {
    'mercedes': 'Mercedes-Benz', 'mercedes benz': 'Mercedes-Benz', 'benz': 'Mercedes-Benz',
    'vw': 'Volkswagen',
    'landrover': 'Land Rover', 'range rover': 'Land Rover',
    'alfa': 'Alfa Romeo',
    'chevy': 'Chevrolet',
  };
  if (ALIAS[limpio]) return ALIAS[limpio];

  const todas = [...MARCAS_EXOTICA, ...MARCAS_EUROPEA, ...MARCAS_ECONOMICA];
  return todas.find(m => _sinAcentos(m) === limpio) || null;
}

/**
 * Categoría de precio de una marca: 'exotica' | 'europea' | 'economica'.
 * Si la marca no se reconoce, se asume 'economica' ($65) como piso seguro.
 */
function categoriaDeMarca(marca) {
  const canon = normalizarMarca(marca);
  if (canon && MARCAS_EXOTICA.has(canon)) return 'exotica';
  if (canon && MARCAS_EUROPEA.has(canon)) return 'europea';
  return 'economica';
}

// ── Cotización de apertura de vehículo (usada por el bot y el ruteo) ───────────

/**
 * Cotiza la apertura de un vehículo por marca (y modelo, para el caso Corvette).
 * Devuelve un objeto con el texto listo para que el agente lo diga por voz.
 *
 * @returns {{
 *   categoria: string, es_premium: boolean, precio_min: number,
 *   precio_varilla: number|null, precio_desde: number|null,
 *   marca: string|null, texto: string
 * }}
 */
function cotizarApertura(marca, modelo = '') {
  const canon      = normalizarMarca(marca);
  const nombre     = canon || 'vehículo';
  const esCorvette = canon === 'Chevrolet' && /corvette/.test(_sinAcentos(modelo));

  if (esCorvette) {
    return {
      categoria: 'especial', es_premium: true,
      precio_min: PRECIOS.corvette.precio_desde, precio_varilla: null,
      precio_desde: PRECIOS.corvette.precio_desde, marca: 'Chevrolet Corvette',
      texto: `La apertura de un Corvette arranca desde $${PRECIOS.corvette.precio_desde}. ` +
             `Es un trabajo especializado; un especialista lo confirma según su zona.`,
    };
  }

  const categoria = categoriaDeMarca(marca);

  if (categoria === 'exotica') {
    const { precio_desde } = PRECIOS.exotica;
    return {
      categoria, es_premium: true, precio_min: precio_desde,
      precio_varilla: null, precio_desde, marca: canon,
      texto: `La apertura de su ${nombre} arranca desde $${precio_desde}. ` +
             `Es un trabajo muy especializado; un especialista lo confirma según su zona.`,
    };
  }

  if (categoria === 'europea') {
    const { precio_varilla, precio_desde } = PRECIOS.europea;
    return {
      categoria, es_premium: true, precio_min: precio_varilla,
      precio_varilla, precio_desde, marca: canon,
      texto: `Para su ${nombre}: $${precio_varilla} si se puede abrir con varilla, ` +
             `y desde $${precio_desde} si hay que trabajar la cerradura. ` +
             `Es un servicio especializado y el precio final depende de su zona; un especialista lo confirma.`,
    };
  }

  const { precio_apertura } = PRECIOS.economica;
  return {
    categoria: 'economica', es_premium: false, precio_min: precio_apertura,
    precio_varilla: null, precio_desde: null, marca: canon,
    texto: `La apertura de su ${nombre} son $${precio_apertura}.`,
  };
}

/** true si la apertura de esa marca es un servicio especializado (europea/exótica/Corvette). */
function esPremium(marca, modelo = '') {
  return cotizarApertura(marca, modelo).es_premium;
}

// ── CRUD precios_apertura_marca (panel admin) ─────────────────────────────────

async function listarPreciosAperturaMarca() {
  const { rows } = await pool.query(
    `SELECT id, marca, precio_apertura, notas
     FROM precios_apertura_marca
     ORDER BY marca`
  );
  return rows;
}

async function upsertPrecioAperturaMarca({ marca, precio_apertura, notas = '' }) {
  if (!marca) return { exito: false, mensaje: 'Marca es obligatoria' };
  const precio = parseFloat(precio_apertura) || 0;
  const { rows } = await pool.query(
    `INSERT INTO precios_apertura_marca (marca, precio_apertura, notas)
     VALUES ($1, $2, $3)
     ON CONFLICT (marca) DO UPDATE
       SET precio_apertura = EXCLUDED.precio_apertura,
           notas           = EXCLUDED.notas
     RETURNING *`,
    [marca, precio, notas]
  );
  return { exito: true, item: rows[0] };
}

async function eliminarPrecioAperturaMarca(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM precios_apertura_marca WHERE id = $1', [id]
  );
  return rowCount > 0
    ? { exito: true }
    : { exito: false, mensaje: 'No encontrado' };
}

// ── Datos para el seed de la tabla (reflejo editable en el panel) ──────────────

function _filaSeed(marca) {
  const categoria = categoriaDeMarca(marca);
  if (categoria === 'exotica') {
    return { precio_apertura: PRECIOS.exotica.precio_desde,
             notas: 'Exótica · Desde $250 (servicio especializado, depende del área)' };
  }
  if (categoria === 'europea') {
    return { precio_apertura: PRECIOS.europea.precio_varilla,
             notas: 'Europea · Con varilla $85 · Por cerradura desde $150 (depende del área)' };
  }
  const nota = marca === 'Chevrolet' ? 'Corvette: desde $250' : '';
  return { precio_apertura: PRECIOS.economica.precio_apertura, notas: nota };
}

async function seedPreciosAperturaMarca() {
  const { rows: [{ count }] } = await pool.query(
    'SELECT COUNT(*) FROM precios_apertura_marca'
  );
  if (count !== '0') return;

  const todas = [...MARCAS_EXOTICA, ...MARCAS_EUROPEA, ...MARCAS_ECONOMICA].sort();
  for (const marca of todas) {
    const { precio_apertura, notas } = _filaSeed(marca);
    await pool.query(
      `INSERT INTO precios_apertura_marca (marca, precio_apertura, notas)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [marca, precio_apertura, notas]
    );
  }
  console.log('  ✅ Precios de apertura por marca insertados');
}

module.exports = {
  // clasificación / cotización
  normalizarMarca,
  categoriaDeMarca,
  cotizarApertura,
  esPremium,
  MARCAS_EXOTICA,
  MARCAS_EUROPEA,
  MARCAS_ECONOMICA,
  // CRUD + seed
  listarPreciosAperturaMarca,
  upsertPrecioAperturaMarca,
  eliminarPrecioAperturaMarca,
  seedPreciosAperturaMarca,
};
