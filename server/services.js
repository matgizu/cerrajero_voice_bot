'use strict';

const { pool } = require('./db');
const { asignarCerrajero, asignarEspecialista, marcarUltimoServicio, getCerrajero } = require('./cerrajeros');
const { cotizarApertura, esPremium } = require('./precios-apertura-marca');
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
    marca_vehiculo:          row.marca_vehiculo  || '',
    modelo_vehiculo:         row.modelo_vehiculo || '',
    es_premium:              row.es_premium === true,
    precio_cotizado:         row.precio_cotizado || '',
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
  const {
    nombre, telefono, ubicacion, tipo_servicio, es_emergencia, notas_adicionales,
    marca_vehiculo, modelo_vehiculo,
  } = datos;

  if (!nombre || !telefono || !ubicacion || !tipo_servicio) {
    return { exito: false, mensaje: 'Datos incompletos: se requieren nombre, teléfono, ubicación y tipo de servicio.' };
  }

  const id             = `SRV-${Date.now().toString(36).toUpperCase()}`;
  const esEmergencia   = Boolean(es_emergencia);
  const tiempoEstimado = esEmergencia ? 15 : 30;

  // Lead premium: apertura de vehículo europeo/exótico/Corvette → va directo
  // al especialista (Mateo). Si no hay especialista, cae al ruteo por zona.
  const esVehiculo   = tipo_servicio === 'emergencia_vehiculo';
  const premium      = esVehiculo && marca_vehiculo && esPremium(marca_vehiculo, modelo_vehiculo || '');
  const cotizacion   = esVehiculo && marca_vehiculo
    ? cotizarApertura(marca_vehiculo, modelo_vehiculo || '')
    : null;
  const precioTexto  = cotizacion
    ? (cotizacion.precio_desde
        ? (cotizacion.precio_varilla
            ? `$${cotizacion.precio_varilla} varilla · $${cotizacion.precio_desde} cerradura (metro)`
            : `desde $${cotizacion.precio_desde}`)
        : (cotizacion.precio_min != null
            ? `$${cotizacion.precio_min}`
            : `por confirmar (${cotizacion.tamano || 'vehículo grande'})`))
    : '';

  const cerrajero = premium
    ? (await asignarEspecialista()) || (await asignarCerrajero(ubicacion))
    : await asignarCerrajero(ubicacion);

  const { rows } = await pool.query(
    `INSERT INTO servicios
       (id, nombre, telefono, ubicacion, tipo_servicio, es_emergencia,
        notas_adicionales, marca_vehiculo, modelo_vehiculo, es_premium, precio_cotizado,
        estado, cerrajero_id, cerrajero_nombre, tiempo_estimado_minutos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pendiente',$12,$13,$14)
     RETURNING *`,
    [
      id,
      nombre.trim(),
      telefono.trim(),
      ubicacion.trim(),
      tipo_servicio,
      esEmergencia,
      notas_adicionales || '',
      (marca_vehiculo  || '').trim(),
      (modelo_vehiculo || '').trim(),
      premium,
      precioTexto,
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

  const emoji = premium ? '⭐' : esEmergencia ? '🚨' : '🔑';
  console.log(`\n${emoji} NUEVO SERVICIO [${id}]${premium ? ' — LEAD PREMIUM' : ''}`);
  console.log(`   Cliente:   ${servicio.nombre} | ${servicio.telefono}`);
  console.log(`   Ubicación: ${servicio.ubicacion}`);
  console.log(`   Tipo:      ${servicio.tipo_servicio}${marca_vehiculo ? ` (${marca_vehiculo} ${modelo_vehiculo || ''})`.trimEnd() : ''}`);
  if (precioTexto) console.log(`   Cotizado:  ${precioTexto}`);
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

// ── Consultar precio (herramienta del agente de voz) ─────────────────────────

/**
 * Cotiza un servicio para que el agente lo diga por voz.
 *  - Vehículo (emergencia_vehiculo): por marca/modelo con las 3 categorías.
 *  - Resto de servicios: precios del catálogo en la base de datos (editables
 *    desde el panel admin, sin tocar código).
 */
async function consultarPrecio({ tipo_servicio, marca, modelo, es_emergencia } = {}) {
  if (tipo_servicio === 'emergencia_vehiculo' || marca) {
    const q = cotizarApertura(marca || '', modelo || '');
    return {
      exito: true,
      tipo_servicio: 'emergencia_vehiculo',
      categoria: q.categoria,
      tamano: q.tamano,
      es_premium: q.es_premium,
      precio_varilla: q.precio_varilla,
      precio_desde: q.precio_desde,
      precio: q.precio_varilla == null && q.precio_desde == null ? q.precio_min : null,
      marca: q.marca,
      respuesta_sugerida: q.texto,
    };
  }

  const { rows } = await pool.query(
    'SELECT * FROM catalogo WHERE id = $1 AND activo = true',
    [tipo_servicio]
  );
  if (rows.length === 0) {
    return { exito: false, mensaje: `No tengo precio para '${tipo_servicio}'. Ofrece que el técnico cotiza en sitio.` };
  }

  const item   = rows[0];
  const emer   = Boolean(es_emergencia);
  const precio = Number(emer ? item.precio_emergencia : item.precio_base);
  return {
    exito: true,
    tipo_servicio,
    es_premium: false,
    precio,
    es_emergencia: emer,
    precio_base: Number(item.precio_base),
    precio_emergencia: Number(item.precio_emergencia),
    respuesta_sugerida: emer
      ? `En emergencia, ${item.nombre.toLowerCase()} son $${precio} y vamos con prioridad.`
      : `${item.nombre} son $${precio}.`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function manejarFunctionCall(nombre, args) {
  switch (nombre) {
    case 'guardar_servicio': return guardarServicio(args);
    case 'consultar_precio': return consultarPrecio(args);
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
  consultarPrecio,
  actualizarEstado,
  reasignarCerrajero,
};
