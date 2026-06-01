'use strict';

const { pool } = require('./db');

const MARCAS_EUROPEAS = new Set([
  'Alfa Romeo', 'Audi', 'BMW', 'Ferrari', 'Fiat', 'Jaguar',
  'Land Rover', 'Maserati', 'Mercedes-Benz', 'Mini', 'Porsche',
  'Volkswagen', 'Volvo',
]);

const TODAS_LAS_MARCAS = [
  'Acura', 'Alfa Romeo', 'Audi', 'BMW', 'Buick', 'Cadillac', 'Chevrolet',
  'Chrysler', 'Dodge', 'Ferrari', 'Fiat', 'Ford', 'Genesis', 'GMC',
  'Honda', 'Hyundai', 'Infiniti', 'Jaguar', 'Jeep', 'Kia', 'Land Rover',
  'Lexus', 'Lincoln', 'Maserati', 'Mazda', 'Mercedes-Benz', 'Mercury',
  'Mini', 'Mitsubishi', 'Nissan', 'Oldsmobile', 'Pontiac', 'Porsche',
  'Ram', 'Saab', 'Saturn', 'Scion', 'Smart', 'Subaru', 'Suzuki',
  'Tesla', 'Toyota', 'Volkswagen', 'Volvo',
];

function precioYNotasPorMarca(marca) {
  if (MARCAS_EUROPEAS.has(marca)) {
    return {
      precio_apertura: 85,
      notas: 'Con barrilla $85 · Sin barrilla desde $150',
    };
  }
  const nota = marca === 'Chevrolet'
    ? 'Corvette: $250 mínimo'
    : '';
  return { precio_apertura: 65, notas: nota };
}

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

async function seedPreciosAperturaMarca() {
  const { rows: [{ count }] } = await pool.query(
    'SELECT COUNT(*) FROM precios_apertura_marca'
  );
  if (count !== '0') return;

  for (const marca of TODAS_LAS_MARCAS) {
    const { precio_apertura, notas } = precioYNotasPorMarca(marca);
    await pool.query(
      `INSERT INTO precios_apertura_marca (marca, precio_apertura, notas)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [marca, precio_apertura, notas]
    );
  }
  console.log('  ✅ Precios de apertura por marca insertados');
}

module.exports = {
  listarPreciosAperturaMarca,
  upsertPrecioAperturaMarca,
  eliminarPrecioAperturaMarca,
  seedPreciosAperturaMarca,
};
