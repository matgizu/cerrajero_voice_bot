'use strict';

const fs   = require('fs');
const path = require('path');

const { asignarCerrajero, marcarUltimoServicio, getCerrajero } = require('./cerrajeros');
const { notificarCerrajero } = require('./whatsapp');
const emitter = require('./events');

const DATA_PATH = path.join(__dirname, 'data/servicios.json');

const ESTADOS_VALIDOS = ['pendiente', 'en_camino', 'completado', 'cancelado'];

// ── Persistencia ──────────────────────────────────────────────────────────────

function cargarServicios() {
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function guardarServicios(lista) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(lista, null, 2), 'utf-8');
}

// ── Guardar nuevo servicio ────────────────────────────────────────────────────

function guardarServicio(datos) {
  const { nombre, telefono, ubicacion, tipo_servicio, es_emergencia, notas_adicionales } = datos;

  if (!nombre || !telefono || !ubicacion || !tipo_servicio) {
    return { exito: false, mensaje: 'Datos incompletos: se requieren nombre, teléfono, ubicación y tipo de servicio.' };
  }

  const id        = `SRV-${Date.now().toString(36).toUpperCase()}`;
  const timestamp = new Date().toISOString();

  // Auto-asignar cerrajero por zona + disponibilidad
  const cerrajero = asignarCerrajero(ubicacion);

  const servicio = {
    id,
    nombre:             nombre.trim(),
    telefono:           telefono.trim(),
    ubicacion:          ubicacion.trim(),
    tipo_servicio,
    es_emergencia:      Boolean(es_emergencia),
    notas_adicionales:  notas_adicionales || '',
    estado:             'pendiente',
    cerrajero_id:       cerrajero?.id    || null,
    cerrajero_nombre:   cerrajero?.nombre || null,
    creado_en:          timestamp,
    actualizado_en:     timestamp,
    tiempo_estimado_minutos: es_emergencia ? 15 : 30
  };

  const lista = cargarServicios();
  lista.unshift(servicio); // más recientes primero
  guardarServicios(lista);

  // Actualizar turno del cerrajero y notificar por WhatsApp (fire & forget)
  if (cerrajero) {
    marcarUltimoServicio(cerrajero.id);
    notificarCerrajero(cerrajero, servicio).catch(err =>
      console.error('Error WhatsApp:', err.message)
    );
  }

  // Emitir evento para broadcast SSE al panel admin
  emitter.emit('servicio_nuevo', servicio);

  const emoji = es_emergencia ? '🚨' : '🔑';
  console.log(`\n${emoji} NUEVO SERVICIO [${id}]`);
  console.log(`   Cliente:  ${servicio.nombre} | ${servicio.telefono}`);
  console.log(`   Ubicación: ${servicio.ubicacion}`);
  console.log(`   Tipo:      ${servicio.tipo_servicio}`);
  console.log(`   Asignado:  ${cerrajero?.nombre || 'Sin asignar (nadie disponible)'}\n`);

  return {
    exito:                   true,
    id,
    mensaje:                 `Servicio registrado. ${cerrajero ? `Cerrajero ${cerrajero.nombre} notificado.` : 'Sin cerrajero disponible.'}`,
    tiempo_estimado_minutos: servicio.tiempo_estimado_minutos,
    cerrajero_asignado:      cerrajero?.nombre || null,
    datos_confirmados:       servicio
  };
}

// ── Actualizar estado ─────────────────────────────────────────────────────────

function actualizarEstado(id, estado) {
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return { exito: false, mensaje: `Estado inválido. Válidos: ${ESTADOS_VALIDOS.join(', ')}` };
  }

  const lista = cargarServicios();
  const idx   = lista.findIndex(s => s.id === id);
  if (idx === -1) return { exito: false, mensaje: 'Servicio no encontrado' };

  lista[idx].estado        = estado;
  lista[idx].actualizado_en = new Date().toISOString();
  guardarServicios(lista);

  emitter.emit('servicio_actualizado', lista[idx]);

  return { exito: true, servicio: lista[idx] };
}

// ── Reasignar cerrajero ───────────────────────────────────────────────────────

function reasignarCerrajero(servicioId, cerrajeroId) {
  const lista  = cargarServicios();
  const idx    = lista.findIndex(s => s.id === servicioId);
  if (idx === -1) return { exito: false, mensaje: 'Servicio no encontrado' };

  const cerrajero = getCerrajero(cerrajeroId);
  if (!cerrajero) return { exito: false, mensaje: 'Cerrajero no encontrado' };

  lista[idx].cerrajero_id     = cerrajero.id;
  lista[idx].cerrajero_nombre = cerrajero.nombre;
  lista[idx].actualizado_en   = new Date().toISOString();
  guardarServicios(lista);

  // Notificar al nuevo cerrajero
  notificarCerrajero(cerrajero, lista[idx]).catch(err =>
    console.error('Error WhatsApp reasignación:', err.message)
  );

  emitter.emit('servicio_actualizado', lista[idx]);

  return { exito: true, servicio: lista[idx] };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function manejarFunctionCall(nombre, args) {
  switch (nombre) {
    case 'guardar_servicio': return guardarServicio(args);
    default: return { exito: false, mensaje: `Función '${nombre}' no reconocida.` };
  }
}

function listarServicios() {
  return cargarServicios();
}

module.exports = {
  manejarFunctionCall,
  listarServicios,
  guardarServicio,
  actualizarEstado,
  reasignarCerrajero
};
