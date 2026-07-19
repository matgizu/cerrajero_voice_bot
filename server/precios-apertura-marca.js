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
// Europeos: $85 varilla · $150 FIJO por cerradura SOLO área metro (fuera: confirma VIP).
// No europeos: por tamaño (cliente 2026-07-18) — estándar $65 · grande
// (van/pickup/SUV grande: F-150, Ram, Suburban, Escalade, Express, Silverado,
// Transit...) $75 · camiones comerciales $125.
const PRECIOS = {
  economica: { precio_apertura: 65 },
  grande:    { precio_apertura: 75 },
  camion:    { precio_apertura: 125 },
  europea:   { precio_varilla: 85, precio_cerradura_metro: 150 },
  exotica:   { precio_desde: 250 },
  corvette:  { precio_desde: 250 },
};

const _sinAcentos = (s) =>
  String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// ── Clasificación por tamaño (vehículos NO europeos) ──────────────────────────

const MODELOS_GRANDES = {
  // Camiones comerciales primero: tienen prioridad sobre van/pickup
  camion: [
    'camion', 'freightliner', 'kenworth', 'peterbilt', 'mack', 'hino',
    'isuzu npr', 'npr', 'box truck', 'diez ruedas', '18 wheeler',
  ],
  van: [
    'transit', 'sprinter', 'promaster', 'pro master', 'express', 'savana',
    'nv200', 'nv350', 'nv1500', 'nv2500', 'nv3500', 'e-150', 'e150', 'e-250',
    'e250', 'e-350', 'e350', 'metris', 'van',
  ],
  pickup: [
    'f-150', 'f150', 'f-250', 'f250', 'f-350', 'f350', 'f-450', 'f450',
    'silverado', 'sierra', 'ram', 'tundra', 'tacoma', 'frontier', 'ranger',
    'colorado', 'ridgeline', 'titan', 'gladiator', 'pickup', 'pick up', 'pick-up',
  ],
  suv_grande: [
    'suburban', 'tahoe', 'yukon', 'expedition', 'escalade', 'navigator',
    'sequoia', 'armada', 'land cruiser',
  ],
};

/**
 * Clasifica el tamaño por el modelo dicho por el cliente.
 * @returns {'van'|'pickup'|'suv_grande'|'estandar'}
 */
function clasificarTamano(modelo) {
  const limpio = _sinAcentos(modelo || '');
  if (!limpio) return 'estandar';
  for (const [tipo, keywords] of Object.entries(MODELOS_GRANDES)) {
    for (const kw of keywords) {
      if (new RegExp(`(^|[^a-z0-9])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(limpio)) {
        return tipo;
      }
    }
  }
  return 'estandar';
}

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

const NOMBRE_TAMANO = { van: 'van', pickup: 'pickup', suv_grande: 'guagua grande', camion: 'camión' };

/**
 * Cotiza la apertura de un vehículo por marca, modelo y tamaño.
 * Devuelve un objeto con el texto listo para que el agente lo diga por voz.
 *
 * Reglas (cliente, 2026-07-19):
 *  - Europeos: $85 con varilla · $150 FIJO por cerradura SOLO área metro
 *    (fuera del área metro lo confirma el cerrajero VIP). Cierre: "le llama
 *    uno de nuestros cerrajeros VIP en unos minutos".
 *  - No europeos: por tamaño. Estándar $65 firme; van/pickup/SUV grande según
 *    tarifa de grandes (aún sin definir → el cerrajero confirma al llamar).
 *  - Exóticas y Corvette: desde $250 (VIP).
 *
 * @returns {{
 *   categoria: string, tamano: string, es_premium: boolean, precio_min: number|null,
 *   precio_varilla: number|null, precio_desde: number|null,
 *   marca: string|null, texto: string
 * }}
 */
/** Busca una marca conocida como palabra dentro de un texto libre ("Ford Transit" → Ford). */
function buscarMarcaEnTexto(texto) {
  const limpio = _sinAcentos(texto);
  const ALIAS_TEXTO = [
    [/\bmercedes\b|\bbenz\b/, 'Mercedes-Benz'], [/\bvw\b/, 'Volkswagen'],
    [/\brange rover\b|\blandrover\b/, 'Land Rover'], [/\bchevy\b/, 'Chevrolet'],
  ];
  for (const [re, m] of ALIAS_TEXTO) if (re.test(limpio)) return m;
  const todas = [...MARCAS_EXOTICA, ...MARCAS_EUROPEA, ...MARCAS_ECONOMICA];
  return todas.find(m => new RegExp(`(^|[^a-z0-9])${_sinAcentos(m).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(limpio)) || null;
}

function cotizarApertura(marca, modelo = '') {
  // El agente a veces manda todo junto ("Ford Transit" en marca): clasificamos
  // marca y tamaño sobre el texto completo para no fallar en esos casos.
  const textoCompleto = `${marca || ''} ${modelo || ''}`.trim();
  const canon      = normalizarMarca(marca) || buscarMarcaEnTexto(textoCompleto);
  const nombre     = canon || 'vehículo';
  // Ram solo fabrica pickups/vans: la marca sola ya define el tamaño
  const tamano     = clasificarTamano(textoCompleto) !== 'estandar'
    ? clasificarTamano(textoCompleto)
    : (canon === 'Ram' ? 'pickup' : 'estandar');
  const esCorvette = canon === 'Chevrolet' && /corvette/.test(_sinAcentos(textoCompleto));

  if (esCorvette) {
    return {
      categoria: 'especial', tamano, es_premium: true,
      precio_min: PRECIOS.corvette.precio_desde, precio_varilla: null,
      precio_desde: PRECIOS.corvette.precio_desde, marca: 'Chevrolet Corvette',
      texto: `La apertura de un Corvette arranca desde $${PRECIOS.corvette.precio_desde}; es un trabajo especializado. ` +
             `En unos minutos le llama uno de nuestros cerrajeros VIP para confirmarle.`,
    };
  }

  // Categoría a partir de la marca canónica ya detectada (no del campo crudo,
  // que puede venir con el modelo pegado: "BMW X5")
  const categoria = canon && MARCAS_EXOTICA.has(canon) ? 'exotica'
    : canon && MARCAS_EUROPEA.has(canon) ? 'europea'
    : 'economica';

  if (categoria === 'exotica') {
    const { precio_desde } = PRECIOS.exotica;
    return {
      categoria, tamano, es_premium: true, precio_min: precio_desde,
      precio_varilla: null, precio_desde, marca: canon,
      texto: `La apertura de su ${nombre} arranca desde $${precio_desde}; es un trabajo muy especializado. ` +
             `En unos minutos le llama uno de nuestros cerrajeros VIP para confirmarle.`,
    };
  }

  if (categoria === 'europea') {
    const { precio_varilla, precio_cerradura_metro } = PRECIOS.europea;
    return {
      categoria, tamano, es_premium: true, precio_min: precio_varilla,
      precio_varilla, precio_desde: precio_cerradura_metro, marca: canon,
      texto: `Para su ${nombre}: $${precio_varilla} si se abre con varilla, o $${precio_cerradura_metro} fijo trabajando la cerradura en el área metro ` +
             `(fuera del área metro se lo confirma el cerrajero). En unos minutos le llama uno de nuestros cerrajeros VIP.`,
    };
  }

  // No europeo: por tamaño
  if (tamano !== 'estandar') {
    const esCamion = tamano === 'camion';
    const precio   = esCamion ? PRECIOS.camion.precio_apertura : PRECIOS.grande.precio_apertura;
    const tipoTexto = NOMBRE_TAMANO[tamano] || 'vehículo grande';
    if (precio == null) {
      return {
        categoria: esCamion ? 'camion' : 'grande', tamano, es_premium: false, precio_min: null,
        precio_varilla: null, precio_desde: null, marca: canon,
        texto: `Para una ${tipoTexto} como la suya el precio se lo confirma nuestro cerrajero al llamarle en unos minutos. ` +
               `Déjeme tomarle los datos para coordinarle.`,
      };
    }
    return {
      categoria: esCamion ? 'camion' : 'grande', tamano, es_premium: false, precio_min: precio,
      precio_varilla: null, precio_desde: null, marca: canon,
      texto: esCamion
        ? `La apertura de un camión son $${precio}.`
        : `Para una ${tipoTexto} como la suya la apertura son $${precio}.`,
    };
  }

  const { precio_apertura } = PRECIOS.economica;
  return {
    categoria: 'economica', tamano, es_premium: false, precio_min: precio_apertura,
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
  clasificarTamano,
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
