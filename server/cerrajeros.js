'use strict';

const { pool } = require('./db');

// Municipios de Puerto Rico para detección automática en la ubicación
const MUNICIPIOS = [
  'Adjuntas','Aguada','Aguadilla','Aguas Buenas','Aibonito','Añasco',
  'Arecibo','Arroyo','Barceloneta','Barranquitas','Bayamón','Cabo Rojo',
  'Caguas','Camuy','Canóvanas','Carolina','Cataño','Cayey','Ceiba',
  'Ciales','Cidra','Coamo','Comerío','Corozal','Culebra','Dorado',
  'Fajardo','Florida','Guánica','Guayama','Guayanilla','Guaynabo',
  'Gurabo','Hatillo','Hormigueros','Humacao','Isabela','Jayuya',
  'Juana Díaz','Juncos','Lajas','Lares','Las Marías','Las Piedras',
  'Loíza','Luquillo','Manatí','Maricao','Maunabo','Mayagüez','Moca',
  'Morovis','Naguabo','Naranjito','Orocovis','Patillas','Peñuelas',
  'Ponce','Quebradillas','Rincón','Río Grande','Sabana Grande','Salinas',
  'San Germán','San Juan','San Lorenzo','San Sebastián','Santa Isabel',
  'Toa Alta','Toa Baja','Trujillo Alto','Utuado','Vega Alta','Vega Baja',
  'Vieques','Villalba','Yabucoa','Yauco'
];

function rowToCerrajero(row) {
  return {
    id:               row.id,
    nombre:           row.nombre,
    telefono:         row.telefono,
    zonas:            row.zonas,
    disponible:       row.disponible,
    callmebot_apikey: row.callmebot_apikey || '',
    ultimo_servicio:  row.ultimo_servicio ? row.ultimo_servicio.toISOString() : null,
  };
}

// ── Detección de municipio ────────────────────────────────────────────────────

function detectarMunicipio(ubicacion) {
  if (!ubicacion) return null;
  const lower = ubicacion.toLowerCase();
  return MUNICIPIOS.find(m => lower.includes(m.toLowerCase())) || null;
}

// ── Asignación automática ─────────────────────────────────────────────────────

async function asignarCerrajero(ubicacion) {
  const { rows } = await pool.query('SELECT * FROM cerrajeros');
  const cerrajeros = rows.map(rowToCerrajero);
  if (cerrajeros.length === 0) return null;

  const municipio = detectarMunicipio(ubicacion);
  const enZona = (c) => municipio && c.zonas.some(z => z.toLowerCase() === municipio.toLowerCase());
  const porFecha = (a, b) => {
    const tA = a.ultimo_servicio ? new Date(a.ultimo_servicio).getTime() : 0;
    const tB = b.ultimo_servicio ? new Date(b.ultimo_servicio).getTime() : 0;
    return tA - tB;
  };

  let candidatos = cerrajeros.filter(c => c.disponible && enZona(c)).sort(porFecha);
  if (candidatos.length === 0) candidatos = cerrajeros.filter(c => enZona(c)).sort(porFecha);
  if (candidatos.length === 0) candidatos = cerrajeros.filter(c => c.disponible).sort(porFecha);
  if (candidatos.length === 0) candidatos = [...cerrajeros].sort(porFecha);

  return candidatos[0] || null;
}

async function marcarUltimoServicio(id) {
  await pool.query(
    'UPDATE cerrajeros SET ultimo_servicio = NOW() WHERE id = $1',
    [id]
  );
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function listarCerrajeros() {
  const { rows } = await pool.query('SELECT * FROM cerrajeros ORDER BY id');
  return rows.map(rowToCerrajero);
}

async function getCerrajero(id) {
  const { rows } = await pool.query('SELECT * FROM cerrajeros WHERE id = $1', [id]);
  return rows[0] ? rowToCerrajero(rows[0]) : null;
}

async function toggleDisponibilidad(id) {
  const { rows } = await pool.query(
    'UPDATE cerrajeros SET disponible = NOT disponible WHERE id = $1 RETURNING *',
    [id]
  );
  return rows[0] ? rowToCerrajero(rows[0]) : null;
}

module.exports = {
  detectarMunicipio,
  asignarCerrajero,
  marcarUltimoServicio,
  listarCerrajeros,
  getCerrajero,
  toggleDisponibilidad,
};
