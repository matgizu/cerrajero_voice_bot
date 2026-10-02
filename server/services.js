'use strict';

const { pool } = require('./db');
const { asignarCerrajero, asignarEspecialista, marcarUltimoServicio, getCerrajero } = require('./cerrajeros');
const { cotizarApertura, esPremium } = require('./precios-apertura-marca');
const { cotizarAperturaCerradura } = require('./precios-apertura-cerradura');
const { cotizarLlave, ANIO_MAXIMO_SIN_COTIZAR } = require('./precios-llaves');
const { notificarCerrajero } = require('./whatsapp');
const emitter = require('./events');

const ESTADOS_VALIDOS = ['pendiente', 'en_camino', 'completado', 'cancelado'];

/**
 * Normaliza el teléfono del cliente. Puerto Rico/EE.UU.: 10 dígitos (o 11 con
 * el 1 delante). Internacional: con "+" y 11–15 dígitos. Si no cuadra devuelve
 * null para que el agente lo vuelva a pedir (en la prueba guardó "527555555").
 */
function normalizarTelefono(telefono) {
  const txt = String(telefono || '').trim();
  const d = txt.replace(/\D/g, '');
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith('1')) return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  if (txt.startsWith('+') && d.length >= 11 && d.length <= 15) return `+${d}`;
  return null;
}

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
    tipo_cerradura:          row.tipo_cerradura  || '',
    anio_vehiculo:           row.anio_vehiculo   || '',
    tipo_llave:              row.tipo_llave      || '',
    conversation_id:         row.conversation_id || '',
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
    marca_vehiculo, modelo_vehiculo, tipo_cerradura,
    anio_vehiculo, tipo_llave, precio_acordado, conversation_id,
  } = datos;

  if (!nombre || !telefono || !ubicacion || !tipo_servicio) {
    return { exito: false, mensaje: 'Datos incompletos: se requieren nombre, teléfono, ubicación y tipo de servicio.' };
  }

  const telefonoOk = normalizarTelefono(telefono);
  if (!telefonoOk) {
    const n = String(telefono).replace(/\D/g, '').length;
    return {
      exito: false,
      mensaje: `El teléfono "${telefono}" tiene ${n} dígitos y debe tener 10 (ej. 787-555-1234). NO se guardó el servicio. Pídele al cliente con amabilidad que te lo repita completo ("Perdone, creo que se me escapó un número, ¿me repite el teléfono completo, por favor?"), repíteselo para confirmar y vuelve a llamar a guardar_servicio.`,
    };
  }

  const id             = `SRV-${Date.now().toString(36).toUpperCase()}`;
  const esEmergencia   = Boolean(es_emergencia);
  const tiempoEstimado = esEmergencia ? 15 : 30;

  // Lead premium: apertura de vehículo europeo/exótico/Corvette, o cerradura
  // europea de propiedad → van directo al especialista (Mateo). Si no hay
  // especialista disponible, cae al ruteo normal por zona.
  const esVehiculo    = tipo_servicio === 'emergencia_vehiculo';
  const esPuertaHogar = tipo_servicio === 'apertura_puerta' && tipo_cerradura;
  const premiumVehiculo  = esVehiculo && marca_vehiculo && esPremium(marca_vehiculo, modelo_vehiculo || '');
  const cotizacionCerradura = esPuertaHogar ? cotizarAperturaCerradura(tipo_cerradura) : null;
  const premium       = premiumVehiculo || Boolean(cotizacionCerradura?.es_premium);
  const cotizacion    = esVehiculo && marca_vehiculo
    ? cotizarApertura(marca_vehiculo, modelo_vehiculo || '')
    : null;
  // Llave de vehículo: el precio lo negocia el agente (A → B → C), así que se
  // guarda el que el cliente aceptó para que el cerrajero lo sepa.
  const precioLlave = tipo_servicio === 'llave_vehiculo' && precio_acordado
    ? `$${String(precio_acordado).replace(/[^\d.]/g, '')}`
    : '';
  const precioTexto   = precioLlave || (cotizacion
    ? (cotizacion.precio_desde
        ? (cotizacion.precio_varilla
            ? `$${cotizacion.precio_varilla} varilla · $${cotizacion.precio_desde} cerradura (metro)`
            : `desde $${cotizacion.precio_desde}`)
        : (cotizacion.precio_min != null
            ? `$${cotizacion.precio_min}`
            : `por confirmar (${cotizacion.tamano || 'vehículo grande'})`))
    : cotizacionCerradura
      ? (cotizacionCerradura.precio != null ? `$${cotizacionCerradura.precio}` : 'por confirmar (cerrajero llama)')
      : '');

  const cerrajero = premium
    ? (await asignarEspecialista()) || (await asignarCerrajero(ubicacion))
    : await asignarCerrajero(ubicacion);

  const { rows } = await pool.query(
    `INSERT INTO servicios
       (id, nombre, telefono, ubicacion, tipo_servicio, es_emergencia,
        notas_adicionales, marca_vehiculo, modelo_vehiculo, tipo_cerradura, es_premium, precio_cotizado,
        estado, cerrajero_id, cerrajero_nombre, tiempo_estimado_minutos, anio_vehiculo, tipo_llave,
        conversation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pendiente',$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      id,
      nombre.trim(),
      telefonoOk,
      ubicacion.trim(),
      tipo_servicio,
      esEmergencia,
      notas_adicionales || '',
      (marca_vehiculo  || '').trim(),
      (modelo_vehiculo || '').trim(),
      (tipo_cerradura  || '').trim(),
      premium,
      precioTexto,
      cerrajero?.id    || null,
      cerrajero?.nombre || null,
      tiempoEstimado,
      String(anio_vehiculo || '').trim(),
      String(tipo_llave || '').trim(),
      // Lo inyecta ElevenLabs (system__conversation_id): liga el servicio a la llamada
      String(conversation_id || '').trim(),
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
  console.log(`   Tipo:      ${servicio.tipo_servicio}${marca_vehiculo ? ` (${marca_vehiculo} ${modelo_vehiculo || ''})`.trimEnd() : ''}${tipo_cerradura ? ` (${tipo_cerradura})` : ''}`);
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
 *  - Apertura de puerta de propiedad (apertura_puerta + tipo_cerradura): por
 *    tipo de cerradura, precios acordados con el cliente (ver
 *    precios-apertura-cerradura.js). Si no hay precio confirmado para ese
 *    tipo, ofrece que el cerrajero confirma en un par de minutos.
 *  - Resto de servicios: precios del catálogo en la base de datos (editables
 *    desde el panel admin, sin tocar código).
 */
/** Año de carro dicho por el cliente → número (acepta "98", "del 2016"…). */
function anioCarro(anio) {
  const n = parseInt(String(anio || '').replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) return null;
  return n < 100 ? (n < 50 ? 2000 + n : 1900 + n) : n;
}

// Carros de ANIO_MAXIMO_SIN_COTIZAR (2001) o antes no se cotizan por teléfono:
// el técnico (o el dueño, si la consulta está activa) da el precio específico.

async function consultarPrecio({ tipo_servicio, marca, modelo, anio, tipo_cerradura, es_emergencia } = {}) {
  if (tipo_servicio === 'emergencia_vehiculo' || marca) {
    const anioN = anioCarro(anio);
    if (anioN && anioN <= ANIO_MAXIMO_SIN_COTIZAR) {
      return {
        exito: true, tipo_servicio: 'emergencia_vehiculo', sin_precio: true, precio: null,
        contexto: `Apertura de carro: ${[marca, modelo, anioN].filter(Boolean).join(' ')} (carro de ${ANIO_MAXIMO_SIN_COTIZAR} o antes)`,
        respuesta_sugerida: '',
      };
    }
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

  if (tipo_servicio === 'apertura_puerta' && tipo_cerradura) {
    const q = cotizarAperturaCerradura(tipo_cerradura);
    return {
      exito: true,
      tipo_servicio: 'apertura_puerta',
      tipo_cerradura: q.tipo,
      es_premium: q.es_premium,
      confirma_cerrajero: q.confirma_cerrajero,
      // Cerradura electrónica: se cotiza con foto por WhatsApp, no es "sin precio".
      sin_precio: q.confirma_cerrajero && q.tipo !== 'cerradura_electronica',
      contexto: `Apertura de puerta de casa o negocio, cerradura tipo ${String(q.tipo || tipo_cerradura).replace(/_/g, ' ')}`,
      precio: q.precio,
      respuesta_sugerida: q.texto,
    };
  }

  const { rows } = await pool.query(
    'SELECT * FROM catalogo WHERE id = $1 AND activo = true',
    [tipo_servicio]
  );
  if (rows.length === 0) {
    return {
      exito: false, sin_precio: true, contexto: `Servicio: ${String(tipo_servicio || 'otro').replace(/_/g, ' ')}`,
      mensaje: `No tengo precio para '${tipo_servicio}'.`,
    };
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
    case 'cotizar_llave':    return cotizarLlave(args);
    // Versión web (Gemini): misma consulta al dueño que el teléfono
    case 'consultar_dueno': {
      const consultas = require('./consultas');
      const r = await consultas.crearConsulta(args, (process.env.PUBLIC_URL || '').replace(/\/$/, ''));
      return r.activa
        ? { consulta_id: r.consulta.id, mensaje: 'Consulta enviada. Dile al cliente que espere un momento en la línea y llama a esperar_respuesta_dueno con este consulta_id.' }
        : { mensaje: 'La consulta al dueño está apagada: dile al cliente que en breve lo llamamos para confirmarle el costo.' };
    }
    case 'esperar_respuesta_dueno': return require('./consultas').esperarRespuesta(args.consulta_id);
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
