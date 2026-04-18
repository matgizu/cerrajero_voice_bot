'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'data/cerrajeros.json');

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

// ── Persistencia ──────────────────────────────────────────────────────────────

function cargarCerrajeros() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function guardarCerrajeros(lista) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(lista, null, 2), 'utf-8');
}

// ── Detección de municipio ────────────────────────────────────────────────────

function detectarMunicipio(ubicacion) {
  if (!ubicacion) return null;
  const lower = ubicacion.toLowerCase();
  return MUNICIPIOS.find(m => lower.includes(m.toLowerCase())) || null;
}

// ── Asignación automática ─────────────────────────────────────────────────────
// Prioridad: disponible en zona → cualquiera en zona → cualquier disponible → cualquiera
// Desempate: el que hace más tiempo no recibe un servicio

function asignarCerrajero(ubicacion) {
  const cerrajeros = cargarCerrajeros();
  if (cerrajeros.length === 0) return null;

  const municipio = detectarMunicipio(ubicacion);

  const enZona = (c) =>
    municipio && c.zonas.some(z => z.toLowerCase() === municipio.toLowerCase());

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

function marcarUltimoServicio(id) {
  const lista = cargarCerrajeros();
  const idx   = lista.findIndex(c => c.id === id);
  if (idx !== -1) {
    lista[idx].ultimo_servicio = new Date().toISOString();
    guardarCerrajeros(lista);
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function listarCerrajeros() {
  return cargarCerrajeros();
}

function getCerrajero(id) {
  return cargarCerrajeros().find(c => c.id === id) || null;
}

function toggleDisponibilidad(id) {
  const lista = cargarCerrajeros();
  const idx   = lista.findIndex(c => c.id === id);
  if (idx === -1) return null;
  lista[idx].disponible = !lista[idx].disponible;
  guardarCerrajeros(lista);
  return lista[idx];
}

module.exports = {
  detectarMunicipio,
  asignarCerrajero,
  marcarUltimoServicio,
  listarCerrajeros,
  getCerrajero,
  toggleDisponibilidad
};
