'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data/catalogo.json');

const DEFAULTS = [
  { id: 'apertura_puerta',       emoji: '🚪', nombre: 'Apertura de puerta',       precio_base: 65,  precio_emergencia: 95,  activo: true },
  { id: 'cambio_cilindro',       emoji: '🔧', nombre: 'Cambio de cilindro',       precio_base: 80,  precio_emergencia: 120, activo: true },
  { id: 'duplicado_llave',       emoji: '🗝️', nombre: 'Duplicado de llave',       precio_base: 25,  precio_emergencia: 40,  activo: true },
  { id: 'apertura_caja_fuerte',  emoji: '🔒', nombre: 'Apertura de caja fuerte',  precio_base: 150, precio_emergencia: 220, activo: true },
  { id: 'instalacion_cerradura', emoji: '⚙️', nombre: 'Instalación de cerradura', precio_base: 90,  precio_emergencia: 135, activo: true },
  { id: 'emergencia_vehiculo',   emoji: '🚗', nombre: 'Emergencia de vehículo',   precio_base: 75,  precio_emergencia: 110, activo: true },
  { id: 'otro',                  emoji: '📋', nombre: 'Otro',                      precio_base: 60,  precio_emergencia: 90,  activo: true },
];

// ── Persistencia ──────────────────────────────────────────────────────────────

function cargarCatalogo() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    return Array.isArray(raw) && raw.length > 0 ? raw : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function guardarCatalogo(lista) {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(lista, null, 2), 'utf-8');
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function listarCatalogo() {
  return cargarCatalogo();
}

function crearServicioCatalogo({ nombre, emoji, precio_base, precio_emergencia }) {
  if (!nombre || precio_base == null) {
    return { exito: false, mensaje: 'Se requieren nombre y precio_base.' };
  }

  const lista = cargarCatalogo();

  // Generar slug único a partir del nombre
  let slug = nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Garantizar unicidad
  let id = slug;
  let n  = 2;
  while (lista.some(s => s.id === id)) id = `${slug}_${n++}`;

  const item = {
    id,
    emoji:             emoji || '🔑',
    nombre:            nombre.trim(),
    precio_base:       Number(precio_base),
    precio_emergencia: Number(precio_emergencia ?? precio_base),
    activo:            true,
  };

  lista.push(item);
  guardarCatalogo(lista);
  return { exito: true, item };
}

function actualizarServicioCatalogo(id, cambios) {
  const lista = cargarCatalogo();
  const idx   = lista.findIndex(s => s.id === id);
  if (idx === -1) return { exito: false, mensaje: 'Servicio no encontrado.' };

  const campos = ['nombre', 'emoji', 'precio_base', 'precio_emergencia', 'activo'];
  for (const campo of campos) {
    if (cambios[campo] !== undefined) lista[idx][campo] = cambios[campo];
  }
  if (cambios.precio_base !== undefined)       lista[idx].precio_base       = Number(cambios.precio_base);
  if (cambios.precio_emergencia !== undefined) lista[idx].precio_emergencia = Number(cambios.precio_emergencia);

  guardarCatalogo(lista);
  return { exito: true, item: lista[idx] };
}

function eliminarServicioCatalogo(id) {
  const lista = cargarCatalogo();
  const idx   = lista.findIndex(s => s.id === id);
  if (idx === -1) return { exito: false, mensaje: 'Servicio no encontrado.' };
  lista.splice(idx, 1);
  guardarCatalogo(lista);
  return { exito: true };
}

module.exports = {
  listarCatalogo,
  crearServicioCatalogo,
  actualizarServicioCatalogo,
  eliminarServicioCatalogo,
};
