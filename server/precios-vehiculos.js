'use strict';

const path = require('path');
const fs   = require('fs');
const { pool } = require('./db');

const VEHICLES_PATH = path.join(__dirname, '../vehicles.json');

let _vehiclesCache = null;
function getVehicles() {
  if (!_vehiclesCache) {
    _vehiclesCache = JSON.parse(fs.readFileSync(VEHICLES_PATH, 'utf-8'));
  }
  return _vehiclesCache;
}

// ── API de catálogo de vehículos ──────────────────────────────────────────────

function getYears() {
  return Object.keys(getVehicles()).sort((a, b) => Number(b) - Number(a));
}

function getMakes(year) {
  const v = getVehicles();
  const yearData = v[year];
  if (!yearData) return [];
  return Object.keys(yearData).sort();
}

function getModels(year, make) {
  const v = getVehicles();
  return (v[year]?.[make] || []).sort();
}

// ── CRUD precios_vehiculos ────────────────────────────────────────────────────

async function listarPreciosVehiculos() {
  const { rows } = await pool.query(
    `SELECT id, anio, marca, modelo, precio_apertura, precio_copia_llave, precio_llave_perdida
     FROM precios_vehiculos
     ORDER BY anio DESC, marca, modelo`
  );
  return rows;
}

async function upsertPrecioVehiculo({ anio, marca, modelo, precio_apertura, precio_copia_llave, precio_llave_perdida }) {
  if (!anio || !marca || !modelo) {
    return { exito: false, mensaje: 'Año, marca y modelo son obligatorios' };
  }
  const apertura = parseFloat(precio_apertura)     || 0;
  const copia    = parseFloat(precio_copia_llave)  || 0;
  const perdida  = parseFloat(precio_llave_perdida) || 0;

  const { rows } = await pool.query(
    `INSERT INTO precios_vehiculos (anio, marca, modelo, precio_apertura, precio_copia_llave, precio_llave_perdida)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (anio, marca, modelo) DO UPDATE
       SET precio_apertura     = EXCLUDED.precio_apertura,
           precio_copia_llave   = EXCLUDED.precio_copia_llave,
           precio_llave_perdida = EXCLUDED.precio_llave_perdida
     RETURNING *`,
    [anio, marca, modelo, apertura, copia, perdida]
  );
  return { exito: true, item: rows[0] };
}

async function eliminarPrecioVehiculo(id) {
  const { rowCount } = await pool.query(
    'DELETE FROM precios_vehiculos WHERE id = $1', [id]
  );
  if (rowCount === 0) return { exito: false, mensaje: 'No encontrado' };
  return { exito: true };
}

module.exports = {
  getYears,
  getMakes,
  getModels,
  listarPreciosVehiculos,
  upsertPrecioVehiculo,
  eliminarPrecioVehiculo,
};
