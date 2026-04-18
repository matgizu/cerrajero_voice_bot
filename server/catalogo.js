'use strict';

const { pool } = require('./db');

function rowToItem(row) {
  return {
    id:                row.id,
    emoji:             row.emoji,
    nombre:            row.nombre,
    precio_base:       Number(row.precio_base),
    precio_emergencia: Number(row.precio_emergencia),
    activo:            row.activo,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function listarCatalogo() {
  const { rows } = await pool.query('SELECT * FROM catalogo ORDER BY nombre');
  return rows.map(rowToItem);
}

async function crearServicioCatalogo({ nombre, emoji, precio_base, precio_emergencia }) {
  if (!nombre || precio_base == null) {
    return { exito: false, mensaje: 'Se requieren nombre y precio_base.' };
  }

  // Generar slug único a partir del nombre
  let slug = nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  // Garantizar unicidad
  const { rows: existing } = await pool.query(
    "SELECT id FROM catalogo WHERE id LIKE $1 || '%'",
    [slug]
  );
  let id = slug;
  if (existing.length > 0) id = `${slug}_${existing.length + 1}`;

  const precioEmergencia = precio_emergencia != null ? Number(precio_emergencia) : Number(precio_base);

  const { rows } = await pool.query(
    `INSERT INTO catalogo (id, emoji, nombre, precio_base, precio_emergencia)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, emoji || '🔑', nombre.trim(), Number(precio_base), precioEmergencia]
  );

  return { exito: true, item: rowToItem(rows[0]) };
}

async function actualizarServicioCatalogo(id, cambios) {
  const { rows: found } = await pool.query('SELECT * FROM catalogo WHERE id = $1', [id]);
  if (found.length === 0) return { exito: false, mensaje: 'Servicio no encontrado.' };

  const sets   = [];
  const params = [];
  let   idx    = 1;

  const campos = {
    nombre:            v => v,
    emoji:             v => v,
    precio_base:       v => Number(v),
    precio_emergencia: v => Number(v),
    activo:            v => Boolean(v),
  };

  for (const [campo, transform] of Object.entries(campos)) {
    if (cambios[campo] !== undefined) {
      sets.push(`${campo} = $${idx++}`);
      params.push(transform(cambios[campo]));
    }
  }

  if (sets.length === 0) return { exito: false, mensaje: 'Sin campos para actualizar.' };

  params.push(id);
  const { rows } = await pool.query(
    `UPDATE catalogo SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );

  return { exito: true, item: rowToItem(rows[0]) };
}

async function eliminarServicioCatalogo(id) {
  const { rowCount } = await pool.query('DELETE FROM catalogo WHERE id = $1', [id]);
  if (rowCount === 0) return { exito: false, mensaje: 'Servicio no encontrado.' };
  return { exito: true };
}

module.exports = {
  listarCatalogo,
  crearServicioCatalogo,
  actualizarServicioCatalogo,
  eliminarServicioCatalogo,
};
