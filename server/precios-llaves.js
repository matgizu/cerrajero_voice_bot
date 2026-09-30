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
//     preguntas casuales (cómo prende el carro, si tiene botones, si la hoja
//     sale con un botoncito) y pasa la descripción, no el nombre técnico.
// ══════════════════════════════════════════════════════════════════════════════

const DATOS = require('./data/precios-llaves.json');

const SERVICIOS = ['todas_perdidas', 'copia', 'programar'];

/** Descripción que da el cliente → tipos técnicos del Excel, en orden de preferencia. */
const TIPOS_LLAVE = {
  boton_encendido:   ['smart', 'proximity', 'advanced'],
  fobik:             ['fobik', 'smart'],
  llave_con_botones: ['remote', 'flip'],
  llave_navaja:      ['flip', 'remote'],
  llave_con_chip:    ['transponder'],
  tesla_tarjeta:     ['tesla_tarjeta'],
  tesla_telefono:    ['tesla_telefono'],
  tesla_control:     ['tesla_control'],
};

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
  todas_perdidas: 'hacerle una llave nueva',
  copia: 'sacarle una copia de la llave',
  programar: 'programarle la llave',
};

// Marcas donde la llave tipo "Fobik" existe de verdad (grupo Chrysler).
const MARCAS_FOBIK = new Set(['chrysler', 'dodge', 'jeep', 'ram', 'plymouth']);

const ALIAS_MARCA = {
  mercedesbenz: 'mercedes', benz: 'mercedes', chevy: 'chevrolet', vw: 'volkswagen',
  landrover: 'landrover', rangerover: 'landrover', infinity: 'infiniti', mini: 'mini',
  alfaromeo: 'alfaromeo', mitsubichi: 'mitsubishi', huyndai: 'hyundai', hiundai: 'hyundai',
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
  return Object.keys(DATOS.tabla).find(k => m.startsWith(k) || k.startsWith(m)) || null;
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
  return candidatos[0] || m; // m igual sirve para las filas manuales
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

// ── Textos para el agente ────────────────────────────────────────────────────

function preguntasTipoLlave(marcaKey, servicio) {
  const tiempo = servicio === 'todas_perdidas' ? 'era' : 'es';
  if (marcaKey === 'tesla') {
    return 'Pregunta casual: "¿Usted abre el Tesla con la tarjeta, con el teléfono o con el controlito?" → tesla_tarjeta / tesla_telefono / tesla_control.';
  }
  const pasos = [
    `1) "¿Ese carro prende con un botón, o metiendo la llave y dándole vuelta?" → si prende con botón: boton_encendido.`,
  ];
  if (MARCAS_FOBIK.has(marcaKey)) {
    pasos.push(`2) Si prende dándole vuelta: "¿La llave ${tiempo} un control completo que se mete en el tablero, sin parte de metal?" → si sí: fobik.`);
  }
  const n = pasos.length + 1;
  pasos.push(`${n}) "¿La llave ${tiempo} de metal con la cabecita negra nada más, o tiene los botoncitos para abrir y cerrar las puertas?" → sin botones: llave_con_chip.`);
  pasos.push(`${n + 1}) Si tiene botones: "¿Y la parte de metal sale sola cuando le aprieta un botoncito, como una navaja?" → si sí: llave_navaja; si no: llave_con_botones.`);
  return 'Identifica la llave con preguntas casuales, UNA a la vez, y vuelve a llamar a cotizar_llave con tipo_llave:\n' + pasos.join('\n');
}

function instruccionNegociacion(op) {
  if (op.b == null && op.c == null) {
    return `Precio fijo: $${op.a}. No tiene rebaja; si el cliente objeta, usa argumentos de valor (técnico certificado, más barato que el dealer, garantía).`;
  }
  const minimo = op.c ?? op.b;
  let t = `Di $${op.a}. Si el cliente se molesta o dice que está caro, puedes bajar a $${op.b}`;
  if (op.c != null) t += `; si todavía no acepta, tu último precio es $${op.c}`;
  t += `. Nunca menos de $${minimo}. Baja de uno en uno y solo si el cliente se queja del precio.`;
  if (op.nota) t += ` Ojo: ${op.nota}.`;
  return t;
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Cotiza una llave de vehículo.
 * @param {{marca, modelo, anio, tipo_llave, servicio}} p
 * @returns {{ exito, necesita?, precio?, precio_intermedio?, precio_minimo?, texto, instrucciones }}
 */
function cotizarLlave({ marca, modelo, anio, tipo_llave, servicio } = {}) {
  const confirma = texto => ({
    exito: true, confirma_cerrajero: true, precio: null, texto,
    instrucciones: 'No inventes un precio. Toma los datos y guarda el servicio; el cerrajero llama a confirmar.',
  });

  if (!servicio || !SERVICIOS.includes(servicio)) {
    return {
      exito: true, necesita: 'servicio',
      texto: '¿Tiene alguna llave de ese carro que todavía funcione, o se le perdieron todas?',
      instrucciones: 'Si no tiene ninguna llave: todas_perdidas. Si tiene una y quiere otra: copia. Si ya compró la llave y solo hay que programarla: programar.',
    };
  }

  const marcaKey = resolverMarca(marca);
  const anioN = parseAnio(anio);
  if (marca && modelo && anioN && !marcaKey) {
    return confirma(`Para ese ${marca} la llave se la cotiza el cerrajero directamente; en un par de minutos le llama.`);
  }
  if (!marcaKey || !modelo || !anioN) {
    return {
      exito: true, necesita: 'vehiculo',
      texto: '¿De qué año, marca y modelo es el carro?',
      instrucciones: 'Necesito año, marca y modelo para cotizar la llave.',
    };
  }
  const modeloKey = resolverModelo(marcaKey, modelo);
  const tipos = tiposDelVehiculo(marcaKey, modeloKey, anioN);
  const nombreVehiculo = `${DATOS.nombres[marcaKey] || marca} ${DATOS.nombres[`${marcaKey}|${modeloKey}`] || modelo} ${anioN}`;

  if (tipos.size === 0) {
    return confirma(`Para el ${nombreVehiculo} la llave se la cotiza el cerrajero directamente; en un par de minutos le llama.`);
  }

  if (!tipo_llave || !TIPOS_LLAVE[tipo_llave]) {
    return {
      exito: true, necesita: 'tipo_llave', vehiculo: nombreVehiculo,
      texto: '',
      instrucciones: preguntasTipoLlave(marcaKey, servicio),
    };
  }

  for (const tipo of TIPOS_LLAVE[tipo_llave]) {
    if (!tipos.has(tipo)) continue;
    const manuales = opcionesManuales(marcaKey, modeloKey, anioN, tipo, servicio);
    const opciones = manuales.length ? manuales : [opcionTabla(marcaKey, modeloKey, anioN, tipo, servicio)].filter(Boolean);
    if (!opciones.length) continue;

    const [principal, ...otras] = opciones;
    const que = `${NOMBRE_SERVICIO[servicio]}, ${NOMBRE_TIPO[tipo]}${principal.etiqueta ? ` ${principal.etiqueta}` : ''},`;
    let instrucciones = instruccionNegociacion(principal);
    for (const o of otras) {
      instrucciones += ` Otra opción para este carro — ${o.etiqueta || 'alternativa'}: $${o.a}` +
        (o.b != null ? ` (puedes bajar a $${o.b}${o.c != null ? `, mínimo $${o.c}` : ''})` : ' (fijo)') +
        (o.a < principal.a
          ? '. Ofrécela si el cliente busca algo más económico.'
          : '. Si la llave del cliente es de ese tipo, cotiza esta en vez de la primera.');
    }
    if (principal.nota && /confirma/.test(principal.nota)) {
      instrucciones += ' Aclara que el cerrajero le confirma el precio final antes de empezar.';
    }
    return {
      exito: true,
      vehiculo: nombreVehiculo,
      tipo_llave: tipo,
      servicio,
      precio: principal.a,
      precio_intermedio: principal.b,
      precio_minimo: principal.c ?? principal.b ?? principal.a,
      negociable: principal.b != null,
      texto: `Para su ${nombreVehiculo}, ${que} le sale en ${principal.a} dólares.`,
      instrucciones,
    };
  }

  return confirma(`Para ese tipo de llave del ${nombreVehiculo} el precio se lo confirma el cerrajero; en un par de minutos le llama.`);
}

module.exports = { cotizarLlave, TIPOS_LLAVE, SERVICIOS };
