'use strict';

const { pool } = require('./db');
const { asignarCerrajero, marcarUltimoServicio, getCerrajero } = require('./cerrajeros');
const { notificarCerrajero } = require('./whatsapp');
const emitter = require('./events');

const ESTADOS_VALIDOS = ['pendiente', 'en_camino', 'completado', 'cancelado'];

function rowToServicio(row) {
  return {
    id:                      row.id,
    nombre:                  row.nombre,
    telefono:                row.telefono,
    ubicacion:               row.ubicacion,
    tipo_servicio:           row.tipo_servicio,
    es_emergencia:           row.es_emergencia,
    notas_adicionales:       row.notas_adicionales || '',
    estado:                  row.estado,
    cerrajero_id:            row.cerrajero_id,
    cerrajero_nombre:        row.cerrajero_nombre,
    creado_en:               row.creado_en instanceof Date ? row.creado_en.toISOString() : row.creado_en,
    actualizado_en:          row.actualizado_en instanceof Date ? row.actualizado_en.toISOString() : row.actualizado_en,
    tiempo_estimado_minutos: row.tiempo_estimado_minutos,
  };
}

// ── Guardar nuevo servicio ────────────────────────────────────────────────────

async function guardarServicio(datos) {
  const { nombre, telefono, ubicacion, tipo_servicio, es_emergencia, notas_adicionales } = datos;

  if (!nombre || !telefono || !ubicacion || !tipo_servicio) {
    return { exito: false, mensaje: 'Datos incompletos: se requieren nombre, teléfono, ubicación y tipo de servicio.' };
  }

  const id                     = `SRV-${Date.now().toString(36).toUpperCase()}`;
  const esEmergencia           = Boolean(es_emergencia);
  const tiempoEstimado         = esEmergencia ? 15 : 30;
  const cerrajero              = await asignarCerrajero(ubicacion);

  const { rows } = await pool.query(
    `INSERT INTO servicios
       (id, nombre, telefono, ubicacion, tipo_servicio, es_emergencia,
        notas_adicionales, estado, cerrajero_id, cerrajero_nombre, tiempo_estimado_minutos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pendiente',$8,$9,$10)
     RETURNING *`,
    [
      id,
      nombre.trim(),
      telefono.trim(),
      ubicacion.trim(),
      tipo_servicio,
      esEmergencia,
      notas_adicionales || '',
      cerrajero?.id    || null,
      cerrajero?.nombre || null,
      tiempoEstimado,
    ]
  );

  const servicio = rowToServicio(rows[0]);

  if (cerrajero) {
    await marcarUltimoServicio(cerrajero.id);
    notificarCerrajero(cerrajero, servicio).catch(err =>
      console.error('Error WhatsApp:', err.message)
    );
  }

  emitter.emit('servicio_nuevo', servicio);

  const emoji = esEmergencia ? '🚨' : '🔑';
  console.log(`\n${emoji} NUEVO SERVICIO [${id}]`);
  console.log(`   Cliente:   ${servicio.nombre} | ${servicio.telefono}`);
  console.log(`   Ubicación: ${servicio.ubicacion}`);
  console.log(`   Tipo:      ${servicio.tipo_servicio}`);
  console.log(`   Asignado:  ${cerrajero?.nombre || 'Sin asignar (nadie disponible)'}\n`);

  return {
    exito:                   true,
    id,
    mensaje:                 `Servicio registrado. ${cerrajero ? `Cerrajero ${cerrajero.nombre} notificado.` : 'Sin cerrajero disponible.'}`,
    tiempo_estimado_minutos: tiempoEstimado,
    cerrajero_asignado:      cerrajero?.nombre || null,
    datos_confirmados:       servicio,
  };
}

// ── Actualizar estado ─────────────────────────────────────────────────────────

async function actualizarEstado(id, estado) {
  if (!ESTADOS_VALIDOS.includes(estado)) {
    return { exito: false, mensaje: `Estado inválido. Válidos: ${ESTADOS_VALIDOS.join(', ')}` };
  }

  const { rows } = await pool.query(
    `UPDATE servicios SET estado = $1, actualizado_en = NOW()
     WHERE id = $2 RETURNING *`,
    [estado, id]
  );

  if (rows.length === 0) return { exito: false, mensaje: 'Servicio no encontrado' };

  const servicio = rowToServicio(rows[0]);
  emitter.emit('servicio_actualizado', servicio);
  return { exito: true, servicio };
}

// ── Reasignar cerrajero ───────────────────────────────────────────────────────

async function reasignarCerrajero(servicioId, cerrajeroId) {
  const { rows: srvRows } = await pool.query('SELECT * FROM servicios WHERE id = $1', [servicioId]);
  if (srvRows.length === 0) return { exito: false, mensaje: 'Servicio no encontrado' };

  const cerrajero = await getCerrajero(cerrajeroId);
  if (!cerrajero) return { exito: false, mensaje: 'Cerrajero no encontrado' };

  const { rows } = await pool.query(
    `UPDATE servicios SET cerrajero_id = $1, cerrajero_nombre = $2, actualizado_en = NOW()
     WHERE id = $3 RETURNING *`,
    [cerrajero.id, cerrajero.nombre, servicioId]
  );

  const servicio = rowToServicio(rows[0]);
  notificarCerrajero(cerrajero, servicio).catch(err =>
    console.error('Error WhatsApp reasignación:', err.message)
  );
  emitter.emit('servicio_actualizado', servicio);
  return { exito: true, servicio };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function manejarFunctionCall(nombre, args) {
  switch (nombre) {
    case 'guardar_servicio': return guardarServicio(args);
    default: return { exito: false, mensaje: `Función '${nombre}' no reconocida.` };
  }
}

async function listarServicios() {
  const { rows } = await pool.query('SELECT * FROM servicios ORDER BY creado_en DESC');
  return rows.map(rowToServicio);
}

module.exports = {
  manejarFunctionCall,
  listarServicios,
  guardarServicio,
  actualizarEstado,
  reasignarCerrajero,
};
