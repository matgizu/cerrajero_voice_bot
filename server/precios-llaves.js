'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  LLAVES DE VEHÍCULO — cotización desde el Excel de precios del cliente
//  ------------------------------------------------------------------------------
//  Datos: server/data/precios-llaves.json (se regenera con
//  scripts/importar-precios-llaves.js cuando el cliente mande un Excel nuevo).
//
//  Reglas del cliente (2026-09-30):
//   - PRECIO A es el que se dice al cotizar.
//   - Si el cliente se molesta con el precio, se puede bajar a B y, como último
//     recurso, a C (nunca menos). Si la fila no tiene B/C, A es precio fijo.
//   - Casi nadie sabe qué tipo de llave tiene: el agente la identifica con
//     preguntas casuales. Esta función decide la SIGUIENTE pregunta (una sola)
//     según lo que el cliente ya contestó (prende_con_boton, tiene_botones,
//     sale_como_navaja…), y se salta las que no cambian el precio.
//   - La rebaja la calcula la herramienta: cuando el cliente se queja, el
//     agente manda el último precio que dijo (precio_actual) y recibe el
//     siguiente escalón hacia abajo. Así nunca se salta B ni baja de C.
// ══════════════════════════════════════════════════════════════════════════════

const DATOS = require('./data/precios-llaves.json');

const SERVICIOS = ['todas_perdidas', 'copia', 'programar'];

/**
 * Descripción de la llave → tipos técnicos del Excel, en orden de preferencia.
 * La tabla del cliente no trae "remote"/"flip" para todas las marcas; una llave
 * con botones o de navaja también lleva chip, así que cae al precio de chip.
 */
const TIPOS_LLAVE = {
  boton_encendido:   ['smart', 'proximity', 'advanced'],
  fobik:             ['fobik', 'smart'],
  llave_con_botones: ['remote', 'flip', 'transponder'],
  llave_navaja:      ['flip', 'remote', 'transponder'],
  llave_con_chip:    ['transponder', 'remote'],
  tesla_tarjeta:     ['tesla_tarjeta'],
  tesla_telefono:    ['tesla_telefono'],
  tesla_control:     ['tesla_control'],
};

const TESLA = { tarjeta: 'tesla_tarjeta', telefono: 'tesla_telefono', control: 'tesla_control' };

const NOMBRE_TIPO = {
  smart: 'llave inteligente (prende con botón)',
  proximity: 'llave inteligente (prende con botón)',
  advanced: 'llave inteligente (prende con botón)',
  fobik: 'control que se mete en el tablero',
  remote: 'llave con los botones del control',
  flip: 'llave de navaja',
  transponder: 'llave con chip',
  tesla_tarjeta: 'tarjeta llave de Tesla',
  tesla_telefono: 'llave de teléfono de Tesla',
  tesla_conector: 'conector de Tesla',
  tesla_control: 'control de Tesla',
};

const NOMBRE_SERVICIO = {
  todas_perdidas: 'hacerte una llave nueva',
  copia: 'sacarte una copia de la llave',
  programar: 'programarte la llave',
};

// Marcas donde la llave tipo "Fobik" existe de verdad (grupo Chrysler).
const MARCAS_FOBIK = new Set(['chrysler', 'dodge', 'jeep', 'ram', 'plymouth']);

const ALIAS_MARCA = {
  mercedesbenz: 'mercedes', benz: 'mercedes', chevy: 'chevrolet', vw: 'volkswagen',
  landrover: 'landrover', rangerover: 'landrover', infinity: 'infiniti', mini: 'mini',
  alfaromeo: 'alfaromeo', mitsubichi: 'mitsubishi', huyndai: 'hyundai', hiundai: 'hyundai',
  // Pronunciación boricua / transcripción
  jonda: 'honda', yip: 'jeep', yeep: 'jeep', chevrole: 'chevrolet', chebrolet: 'chevrolet',
  jundai: 'hyundai', jiundai: 'hyundai', nisan: 'nissan', masda: 'mazda', suburu: 'subaru',
};

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Búsqueda del vehículo ────────────────────────────────────────────────────

function resolverMarca(marca) {
  const m = norm(marca);
  if (!m) return null;
  const directa = ALIAS_MARCA[m] || m;
  if (DATOS.tabla[directa] || DATOS.manuales.some(x => x.marca === directa)) return directa;
  // "Toyota Corolla" en el campo marca, o marca con errores menores
  const prefijo = Object.keys(DATOS.tabla).find(k => m.startsWith(k) || k.startsWith(m));
  if (prefijo) return prefijo;
  const parecida = Object.keys(DATOS.tabla)
    .map(k => ({ k, d: distancia(m, k) }))
    .filter(x => m.length >= 4 && x.d <= (m.length >= 7 ? 2 : 1))
    .sort((a, b) => a.d - b.d)[0];
  return parecida?.k || null;
}

function resolverModelo(marcaKey, modelo) {
  const modelos = DATOS.tabla[marcaKey] || {};
  const m = norm(modelo).replace(new RegExp(`^${marcaKey}`), '');
  if (!m) return null;
  if (modelos[m]) return m;
  // "F150" ↔ "f150", "Grand Cherokee Laredo" → "grandcherokee", "CRV" → "crv"
  const candidatos = Object.keys(modelos)
    .filter(k => m.startsWith(k) || k.startsWith(m))
    .sort((a, b) => b.length - a.length);
  if (candidatos[0]) return candidatos[0];
  // Acento boricua / transcripción: "Telcel" → tercel, "Corola" → corolla.
  // Se acepta el modelo más parecido si está a 1–2 letras de distancia.
  const parecido = Object.keys(modelos)
    .map(k => ({ k, d: distancia(m, k) }))
    .filter(x => m.length >= 4 && x.d <= (m.length >= 6 ? 2 : 1))
    .sort((a, b) => a.d - b.d)[0];
  return parecido?.k || m; // m igual sirve para las filas manuales
}

/** Distancia de edición (Levenshtein), con L↔R contando como media letra. */
function distancia(a, b) {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = fila[j];
      const lr = (a[i - 1] === 'l' && b[j - 1] === 'r') || (a[i - 1] === 'r' && b[j - 1] === 'l');
      const costo = a[i - 1] === b[j - 1] ? 0 : lr ? 0.5 : 1;
      fila[j] = Math.min(fila[j] + 1, fila[j - 1] + 1, prev + costo);
      prev = tmp;
    }
  }
  return fila[b.length];
}

function parseAnio(anio) {
  const n = parseInt(String(anio || '').replace(/\D/g, ''), 10);
  if (Number.isNaN(n)) return null;
  if (n < 100) return n < 50 ? 2000 + n : 1900 + n;
  return n;
}

// ── Opciones de precio para un tipo concreto ────────────────────────────────

function opcionesManuales(marcaKey, modeloKey, anio, tipo, servicio) {
  return DATOS.manuales.filter(x =>
    x.marca === marcaKey &&
    (x.modelos == null || x.modelos.some(md => modeloKey && (md === modeloKey || modeloKey.startsWith(md)))) &&
    anio >= x.desde && anio <= x.hasta &&
    x.tipo === tipo && x.servicio === servicio
  ).map(x => ({ etiqueta: x.etiqueta, a: x.a, b: x.b, c: x.c, nota: x.nota }));
}

function opcionTabla(marcaKey, modeloKey, anio, tipo, servicio) {
  const precios = DATOS.tabla[marcaKey]?.[modeloKey]?.[String(anio)]?.[tipo];
  const a = precios?.[SERVICIOS.indexOf(servicio)];
  return a == null ? null : { etiqueta: '', a, b: null, c: null, nota: '' };
}

/** Tipos técnicos que el Excel tiene para ese vehículo (tabla + manuales). */
function tiposDelVehiculo(marcaKey, modeloKey, anio) {
  const tipos = new Set(Object.keys(DATOS.tabla[marcaKey]?.[modeloKey]?.[String(anio)] || {}));
  for (const x of DATOS.manuales) {
    if (x.marca === marcaKey && anio >= x.desde && anio <= x.hasta &&
        (x.modelos == null || x.modelos.some(md => modeloKey && modeloKey.startsWith(md)))) tipos.add(x.tipo);
  }
  return tipos;
}

// ── Identificación de la llave, una pregunta a la vez ───────────────────────

const esSi = v => v === true || /^(true|si|sí|yes|1)$/i.test(String(v ?? '').trim());
const esNo = v => v === false || /^(false|no|0)$/i.test(String(v ?? '').trim());
const sinDato = v => !esSi(v) && !esNo(v);

/** Primera opción de precio que exista para una descripción de llave. */
function resolverOpciones(ctx, descripcion) {
  for (const tipo of TIPOS_LLAVE[descripcion]) {
    if (!ctx.tipos.has(tipo)) continue;
    const manuales = opcionesManuales(ctx.marcaKey, ctx.modeloKey, ctx.anio, tipo, ctx.servicio);
    const opciones = manuales.length ? manuales : [opcionTabla(ctx.marcaKey, ctx.modeloKey, ctx.anio, tipo, ctx.servicio)].filter(Boolean);
    if (opciones.length) return { tipo, opciones };
  }
  return null;
}

const mismaCotizacion = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/**
 * Devuelve { descripcion } si ya se sabe qué llave es, o { pregunta } con la
 * siguiente pregunta casual. Se salta preguntas cuya respuesta no cambia el precio.
 */
function identificarLlave(ctx, p) {
  const era = ctx.servicio === 'todas_perdidas' ? 'era' : 'es';

  if (ctx.marcaKey === 'tesla') {
    const t = TESLA[String(p.llave_tesla || '').toLowerCase()];
    if (t) return { descripcion: t };
    return { pregunta: '¿Usted abre el Tesla con la tarjeta, con el teléfono o con el controlito?', parametro: 'llave_tesla (tarjeta | telefono | control)' };
  }

  if (sinDato(p.prende_con_boton)) {
    return { pregunta: '¿Ese carro prende con un botón, o metiendo la llave y dándole vuelta?', parametro: 'prende_con_boton (true si prende con botón, false si con llave)' };
  }
  if (esSi(p.prende_con_boton)) return { descripcion: 'boton_encendido' };

  if (MARCAS_FOBIK.has(ctx.marcaKey) && ctx.tipos.has('fobik')) {
    if (sinDato(p.control_en_tablero)) {
      return { pregunta: `¿La llave ${era} un control completo que se mete en el tablero, sin parte de metal?`, parametro: 'control_en_tablero (true/false)' };
    }
    if (esSi(p.control_en_tablero)) return { descripcion: 'fobik' };
  }

  if (sinDato(p.tiene_botones)) {
    const conChip = resolverOpciones(ctx, 'llave_con_chip');
    const conBotones = resolverOpciones(ctx, 'llave_con_botones');
    const conNavaja = resolverOpciones(ctx, 'llave_navaja');
    if (conChip && mismaCotizacion(conChip, conBotones) && mismaCotizacion(conChip, conNavaja)) {
      return { descripcion: 'llave_con_chip' };  // da igual: mismo precio
    }
    return { pregunta: `¿La llave ${era} de metal con la cabecita negra nada más, o tiene los botoncitos para abrir y cerrar las puertas?`, parametro: 'tiene_botones (true/false)' };
  }
  if (esNo(p.tiene_botones)) return { descripcion: 'llave_con_chip' };

  if (sinDato(p.sale_como_navaja)) {
    if (mismaCotizacion(resolverOpciones(ctx, 'llave_con_botones'), resolverOpciones(ctx, 'llave_navaja'))) {
      return { descripcion: 'llave_con_botones' };  // da igual: mismo precio
    }
    return { pregunta: '¿Y la parte de metal sale sola cuando le aprieta un botoncito, como una navaja?', parametro: 'sale_como_navaja (true/false)' };
  }
  return { descripcion: esSi(p.sale_como_navaja) ? 'llave_navaja' : 'llave_con_botones' };
}

// ── Negociación A → B → C ────────────────────────────────────────────────────

/** Escalones de precio sin repetir: [A], [A,B] o [A,B,C]. */
function escalones(op) {
  return [op.a, op.b, op.c].filter((v, i, arr) => v != null && arr.indexOf(v) === i);
}

/** Sin precio_actual → A. Con precio_actual → el siguiente escalón por debajo (o el mínimo). */
function siguientePrecio(op, precioActual) {
  const e = escalones(op);
  const actual = Number(String(precioActual ?? '').replace(/[^\d.]/g, ''));
  let nivel = 0;
  if (actual > 0) {
    const debajo = e.findIndex(v => v < actual);
    nivel = debajo === -1 ? e.length - 1 : debajo;
  }
  return { precio: e[nivel], nivel, ultimo: nivel === e.length - 1, fijo: e.length === 1 };
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Cotiza una llave de vehículo, paso a paso.
 * @param {{servicio, marca, modelo, anio, prende_con_boton, control_en_tablero,
 *          tiene_botones, sale_como_navaja, llave_tesla, precio_actual, tipo_llave}} p
 */
function cotizarLlave(p = {}) {
  const { marca, modelo, anio, servicio } = p;
  const confirma = texto => ({
    exito: true, confirma_cerrajero: true, precio: null, texto,
    instrucciones: 'No inventes un precio. Toma los datos y guarda el servicio; el cerrajero llama a confirmar.',
  });
  const pregunta = (texto, parametro) => ({
    exito: true, necesita: parametro, texto,
    instrucciones: `Haz SOLO esta pregunta, tal cual y sin cotizar todavía. Con la respuesta vuelve a llamar a cotizar_llave con los mismos datos más ${parametro}.`,
  });

  if (!servicio || !SERVICIOS.includes(servicio)) {
    return pregunta('¿Tienes alguna llave de ese carro que todavía funcione, o se te perdieron todas?',
      'servicio (todas_perdidas si no tiene ninguna; copia si tiene una y quiere otra; programar si ya compró la llave nueva)');
  }

  const marcaKey = resolverMarca(marca);
  const anioN = parseAnio(anio);
  if (marca && !marcaKey) {
    // Puede ser una marca que no está en el Excel (Lamborghini) o algo mal
    // escuchado por el acento / la línea ("Carreto"). El agente decide.
    return {
      exito: true, necesita: 'marca', precio: null, texto: '',
      instrucciones: `No reconozco la marca "${marca}". Si no suena a una marca de carro real, seguro no se escuchó bien: pide con amabilidad que te la repita ("Perdona, no te escuché bien, ¿me repites la marca del carro, por favor?") y vuelve a llamar a cotizar_llave. Nunca corrijas al cliente. Si el cliente confirma que es una marca real que no está en la lista, dile: "Para ese carro la llave te la cotiza el cerrajero directamente; en un par de minutos te llama."`,
    };
  }
  if (!marcaKey || !modelo || !anioN) {
    return pregunta('Déjame saber de qué año, marca y modelo es el carro.', 'anio, marca y modelo');
  }
  const anioMax = new Date().getFullYear() + 1;
  if (anioN < 1950 || anioN > anioMax) {
    return pregunta('Perdona, no te escuché bien el año. Déjame saber de qué año es el carro.', 'anio');
  }
  const modeloKey = resolverModelo(marcaKey, modelo);
  const ctx = { marcaKey, modeloKey, anio: anioN, servicio, tipos: tiposDelVehiculo(marcaKey, modeloKey, anioN) };
  const nombreVehiculo = `${DATOS.nombres[marcaKey] || marca} ${DATOS.nombres[`${marcaKey}|${modeloKey}`] || modelo} ${anioN}`;

  if (ctx.tipos.size === 0) {
    return confirma(`Para el ${nombreVehiculo} la llave te la cotiza el cerrajero directamente; en un par de minutos te llama.`);
  }

  // Compatibilidad: si el agente ya manda la descripción final, se respeta.
  const id = TIPOS_LLAVE[p.tipo_llave] ? { descripcion: p.tipo_llave } : identificarLlave(ctx, p);
  if (id.pregunta) return { ...pregunta(id.pregunta, id.parametro), vehiculo: nombreVehiculo };

  const r = resolverOpciones(ctx, id.descripcion);
  if (!r) {
    return confirma(`Para ese tipo de llave del ${nombreVehiculo} el precio te lo confirma el cerrajero; en un par de minutos te llama.`);
  }

  const [principal, ...otras] = r.opciones;
  const neg = siguientePrecio(principal, p.precio_actual);
  const que = `${NOMBRE_SERVICIO[servicio]}, ${NOMBRE_TIPO[r.tipo]}${principal.etiqueta ? ` ${principal.etiqueta}` : ''},`;

  let texto, instrucciones;
  if (neg.nivel === 0) {
    texto = `Para tu ${nombreVehiculo}, ${que} te sale en ${neg.precio} dólares.`;
    instrucciones = neg.fijo
      ? 'Precio fijo, no tiene rebaja. Si el cliente dice que está caro, usa argumentos de valor (técnico certificado, se hace en sitio, más barato que el dealer y sin grúa).'
      : `Si el cliente se queja del precio, NO bajes por tu cuenta: vuelve a llamar a cotizar_llave con los mismos datos y precio_actual ${neg.precio}.`;
  } else if (neg.ultimo) {
    texto = `Mira, lo más que te lo puedo dejar es en ${neg.precio} dólares.`;
    instrucciones = `Este es el precio mínimo ($${neg.precio}). No bajes más aunque insista; si no acepta, ofrece dejar el servicio anotado sin compromiso.`;
  } else {
    texto = `Mira, te lo puedo dejar en ${neg.precio} dólares.`;
    instrucciones = `Si el cliente todavía se queja del precio, vuelve a llamar a cotizar_llave con los mismos datos y precio_actual ${neg.precio}.`;
  }
  if (neg.nivel === 0 && principal.nota && /confirma/.test(principal.nota)) {
    instrucciones += ' Aclara que el cerrajero le confirma el precio final antes de empezar.';
  }
  for (const o of otras) {
    instrucciones += ` Hay otra opción para este carro — ${o.etiqueta || 'alternativa'}: ${o.a} dólares` +
      (o.a < principal.a ? '; ofrécela si el cliente busca algo más económico.' : '; menciónala solo si la llave del cliente es de ese tipo.');
  }

  return {
    exito: true,
    vehiculo: nombreVehiculo,
    tipo_llave: id.descripcion,
    servicio,
    precio: neg.precio,
    escalon: neg.nivel,
    precio_minimo: escalones(principal).at(-1),
    texto,
    instrucciones: instrucciones + ` Al guardar el servicio usa tipo_llave ${id.descripcion} y precio_acordado ${neg.precio} si el cliente acepta.`,
  };
}

module.exports = { cotizarLlave, TIPOS_LLAVE, SERVICIOS };
