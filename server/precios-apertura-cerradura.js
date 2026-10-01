'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  PRECIOS DE APERTURA DE PROPIEDAD (HOGAR/NEGOCIO) POR TIPO DE CERRADURA
//  ------------------------------------------------------------------------------
//  Reglas acordadas con el cliente (2026-07-29, 2026-08-22, 2026-08-23, 2026-09-30).
//  Lo que el cliente todavía NO confirmó con un monto exacto queda con
//  precio: null — el agente nunca inventa el número, ofrece que el cerrajero
//  llama en un par de minutos a confirmarlo (mismo patrón que ya usa el
//  módulo de vehículos para casos sin definir).
// ══════════════════════════════════════════════════════════════════════════════

const TIPOS_CERRADURA = [
  'pomo_perilla',
  'reja_verja',
  'perfil_europeo_con_llave',
  'perfil_europeo_sin_llave',
  'perfil_europeo_fuera_metro',
  'deadbolt_seguridad',
  'cerradura_electronica',
  'cerradura_comercial_estandar',
  'alta_seguridad_comercial',
  'barra_panico',
  'persiana_metalica',
];

const ZONA_5_PUEBLOS = 'San Juan, Guaynabo, Bayamón, Carolina o Cataño';
const WHATSAPP_FOTO_SMART_LOCK = '787-665-0980';

const TEXTO_CONFIRMA_CERRAJERO =
  'Ese precio te lo confirmamos nosotros mismos: en un par de minutos te llama uno de nuestros cerrajeros para darte el número exacto.';

/** Hora actual en Puerto Rico (0-23), mismo criterio que el saludo del agente (ver gemini.js). */
function horaPR() {
  return Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/Puerto_Rico',
  }).format(new Date()));
}

// ── Pomo/perilla estándar ───────────────────────────────────────────────────
// Cliente 2026-07-29: $95 en horario 9am–5:59pm, zona 5 pueblos.
// Cliente 2026-08-22: $125 fuera de ese horario, cubre 6pm–12am y 7am–8:59am.
// La franja 12am–6:59am (madrugada real) no fue cubierta por el cliente.
function _pomoPerilla(hora) {
  if (hora >= 9 && hora < 18) {
    return {
      precio: 95,
      texto: `La apertura son noventa y cinco dólares, dentro de ${ZONA_5_PUEBLOS}.`,
    };
  }
  if (hora >= 18 || (hora >= 7 && hora < 9)) {
    return {
      precio: 125,
      texto: 'Fuera del horario regular la apertura son ciento veinticinco dólares.',
    };
  }
  // 12:00am–6:59am: sin tarifa confirmada todavía.
  return { precio: null, texto: TEXTO_CONFIRMA_CERRAJERO };
}

// ── Reja/verja residencial ──────────────────────────────────────────────────
// Cliente 2026-08-23: $95 antes de las 6pm, $125 después de las 6pm.
// Cliente 2026-09-30: el de antes de las 6pm es "desde $95" (deadbolt de reja).
function _rejaVerja(hora) {
  if (hora < 18) {
    return { precio: 95, texto: 'La apertura de la reja es desde noventa y cinco dólares.' };
  }
  return { precio: 125, texto: 'Después de las seis de la tarde la apertura de la reja son ciento veinticinco dólares.' };
}

// ── Perfil europeo (con/sin llave) ──────────────────────────────────────────
// Cliente 2026-07-29: $185 con llave / $250 sin llave, área metro.
// Cliente 2026-08-23: después de las 9pm, +$25. Hora exacta en que vuelve a la
// tarifa base en la mañana no está confirmada; se asume simétrica con el
// horario base del pomo/perilla (arranca 9am) hasta que el cliente lo aclare.
function _perfilEuropeo(tipoCerradura, hora) {
  const base = tipoCerradura === 'perfil_europeo_con_llave' ? 185 : 250;
  const conRecargo = hora >= 21 || hora < 9;
  const precio = conRecargo ? base + 25 : base;
  const conLlaveTexto = tipoCerradura === 'perfil_europeo_con_llave' ? 'con llave' : 'sin llave';
  return {
    precio,
    texto: conRecargo
      ? `Para perfil europeo ${conLlaveTexto}, después de las nueve de la noche, son ${precio} dólares en el área metro.`
      : `Para perfil europeo ${conLlaveTexto} son ${precio} dólares en el área metro.`,
  };
}

/**
 * Cotiza la apertura de una propiedad por tipo de cerradura.
 * @returns {{ tipo: string, precio: number|null, es_premium: boolean,
 *   confirma_cerrajero: boolean, texto: string }}
 */
function cotizarAperturaCerradura(tipoCerradura) {
  const hora = horaPR();

  switch (tipoCerradura) {
    case 'pomo_perilla': {
      const r = _pomoPerilla(hora);
      return { tipo: tipoCerradura, precio: r.precio, es_premium: false,
        confirma_cerrajero: r.precio == null, texto: r.texto };
    }
    case 'reja_verja': {
      const r = _rejaVerja(hora);
      return { tipo: tipoCerradura, precio: r.precio, es_premium: false,
        confirma_cerrajero: false, texto: r.texto };
    }
    case 'perfil_europeo_con_llave':
    case 'perfil_europeo_sin_llave': {
      const r = _perfilEuropeo(tipoCerradura, hora);
      return { tipo: tipoCerradura, precio: r.precio, es_premium: true,
        confirma_cerrajero: false, texto: r.texto };
    }
    // Cliente 2026-09-30: fuera del área metro no hay precio fijo; se valida y se llama.
    case 'perfil_europeo_fuera_metro':
      return {
        tipo: tipoCerradura, precio: null, es_premium: true, confirma_cerrajero: true,
        texto: 'Listo, déjame hacer una validación y nosotros te lo confirmamos. Te llamamos en breve.',
      };
    case 'cerradura_electronica':
      return {
        tipo: tipoCerradura, precio: null, es_premium: false, confirma_cerrajero: true,
        texto: `Para cerradura electrónica necesitamos una foto para cotizarte exacto: nos la puedes mandar por WhatsApp al ${WHATSAPP_FOTO_SMART_LOCK}, y en un par de minutos te confirmamos.`,
      };
    // Cliente 2026-09-30: sencillo o doble cilindro da igual para la apertura.
    // Abre y cierra solo con llave: el agente pregunta antes si hay otra llave
    // adentro (si no, no es una apertura real). Monto aún sin confirmar.
    case 'deadbolt_seguridad':
      return {
        tipo: tipoCerradura, precio: null, es_premium: false, confirma_cerrajero: true,
        texto: 'Sea deadbolt sencillo o doble, la apertura es igual. ' + TEXTO_CONFIRMA_CERRAJERO,
      };
    case 'cerradura_comercial_estandar':
    case 'alta_seguridad_comercial':
    case 'barra_panico':
    case 'persiana_metalica':
      return {
        tipo: tipoCerradura, precio: null, es_premium: false, confirma_cerrajero: true,
        texto: TEXTO_CONFIRMA_CERRAJERO,
      };
    default:
      return {
        tipo: tipoCerradura || null, precio: null, es_premium: false, confirma_cerrajero: true,
        texto: TEXTO_CONFIRMA_CERRAJERO,
      };
  }
}

module.exports = {
  TIPOS_CERRADURA,
  cotizarAperturaCerradura,
  horaPR,
};
