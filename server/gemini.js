/**
 * gemini.js — Configuración de conexión con Gemini Multimodal Live API
 *
 * Define el system prompt (español puertorriqueño + manejo de objeciones),
 * herramientas (function calling) y parámetros de audio del agente.
 *
 * Los precios del catálogo de hogar se inyectan desde la base de datos al
 * armar cada sesión, así el dueño los edita en el panel admin sin tocar código.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

// ── Configuraciones básicas ──────────────────────────────────────────────────
const GEMINI_WS_ENDPOINT = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
const VOICE = process.env.AGENT_VOICE || 'Zephyr';

// ── System Instruction del Agente ───────────────────────────────────────────

// Mismo prompt que el agente telefónico de ElevenLabs (docs/prompt-telefono.txt),
// así web y teléfono no se desincronizan. En la web el agente habla primero,
// por eso se le agrega el paso del saludo.
const PROMPT_BASE = fs.readFileSync(path.join(__dirname, '../docs/prompt-telefono.txt'), 'utf8')
  .replace(
    'FLUJO DE LA LLAMADA (ya saludaste con el primer mensaje; sigue natural)',
    'FLUJO DE LA LLAMADA\n0. SALUDO INICIAL: tú hablas primero, apenas conecte la llamada, exactamente así: "¡Tu Cerrajero Puerto Rico, {{SALUDO}}! ¿En qué le puedo ayudar?" — y nada más; espera a que el cliente responda.'
  );

// Fallback si la BD no responde al armar la sesión (mismos valores del seed)
const CATALOGO_FALLBACK = [
  { id: 'apertura_puerta',       nombre: 'Apertura de puerta',       precio_base: 65,  precio_emergencia: 95  },
  { id: 'cambio_cilindro',       nombre: 'Cambio de cilindro',       precio_base: 80,  precio_emergencia: 120 },
  { id: 'duplicado_llave',       nombre: 'Duplicado de llave',       precio_base: 25,  precio_emergencia: 40  },
  { id: 'apertura_caja_fuerte',  nombre: 'Apertura de caja fuerte',  precio_base: 150, precio_emergencia: 220 },
  { id: 'instalacion_cerradura', nombre: 'Instalación de cerradura', precio_base: 90,  precio_emergencia: 135 },
];

function seccionCatalogo(filas) {
  // apertura_puerta NO va aquí: tiene su propia cotización granular por tipo
  // de cerradura (ver PRECIOS DE APERTURA DE PUERTA + tipo_cerradura arriba).
  const lineas = filas
    .filter(f => f.id !== 'emergencia_vehiculo' && f.id !== 'otro' && f.id !== 'apertura_puerta' && f.activo !== false)
    .map(f => `- ${f.nombre}: $${Number(f.precio_base)} (emergencia $${Number(f.precio_emergencia)})`);
  return `
PRECIOS ACTUALES DEL CATÁLOGO (hogar/negocio, desde el panel admin — confirma con consultar_precio antes de decirlos)
${lineas.join('\n')}
- Cualquier otro servicio: "El técnico te cotiza en el sitio, sin compromiso."
`;
}

/** Saludo según la hora de Puerto Rico (AST): buenos días / buenas tardes / buenas noches. */
function saludoPR() {
  const hora = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: 'America/Puerto_Rico',
  }).format(new Date()));
  if (hora >= 5 && hora < 12) return 'buenos días';
  if (hora >= 12 && hora < 19) return 'buenas tardes';
  return 'buenas noches';
}

async function buildSystemInstruction() {
  let filas = CATALOGO_FALLBACK;
  try {
    // Require diferido para no crear ciclo al arrancar (catalogo → db)
    const { listarCatalogo } = require('./catalogo');
    const desdeDB = await listarCatalogo();
    if (Array.isArray(desdeDB) && desdeDB.length > 0) filas = desdeDB;
  } catch (err) {
    console.warn('⚠️  No pude leer el catálogo de la BD para el prompt, uso fallback:', err.message);
  }
  return (PROMPT_BASE.replaceAll('{{SALUDO}}', saludoPR()) + seccionCatalogo(filas)).trim();
}

// ── Definición de herramientas (Function Calling) ───────────────────────────
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'consultar_precio',
        description: 'Consulta el precio oficial de un servicio para decírselo al cliente. Para apertura de vehículo pasa la marca (y modelo si lo mencionó). Llámala SIEMPRE antes de decir un precio; nunca cotices de memoria.',
        parameters: {
          type: 'OBJECT',
          properties: {
            tipo_servicio: {
              type: 'STRING',
              description: 'Tipo de servicio a cotizar',
              enum: [
                'apertura_puerta',
                'cambio_cilindro',
                'duplicado_llave',
                'apertura_caja_fuerte',
                'instalacion_cerradura',
                'emergencia_vehiculo',
                'otro'
              ]
            },
            marca: {
              type: 'STRING',
              description: 'Marca del vehículo tal como la dijo el cliente (ej. "Toyota", "BMW", "mercedes"). Solo para emergencia_vehiculo.'
            },
            modelo: {
              type: 'STRING',
              description: 'Modelo del vehículo si lo mencionó (ej. "Corolla", "Corvette"). Opcional.'
            },
            tipo_cerradura: {
              type: 'STRING',
              description: 'Tipo de cerradura de la propiedad. Solo para tipo_servicio=apertura_puerta; pásalo SIEMPRE que sea una puerta de casa o negocio.',
              enum: [
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
                'persiana_metalica'
              ]
            },
            es_emergencia: {
              type: 'BOOLEAN',
              description: 'true si es emergencia (aplica tarifa de emergencia en servicios de hogar)'
            }
          },
          required: ['tipo_servicio']
        }
      },
      {
        name: 'cotizar_llave',
        description: 'Cotiza una llave de carro (llave nueva si se le perdieron todas, copia, o programación) con los precios oficiales. Te devuelve UNA pregunta casual a la vez hasta identificar la llave; llámala otra vez con cada respuesta. Si el cliente se queja del precio, llámala con precio_actual = el último precio que dijiste. Llámala SIEMPRE antes de decir un precio de llave.',
        parameters: {
          type: 'OBJECT',
          properties: {
            servicio: {
              type: 'STRING',
              description: 'todas_perdidas = no tiene ninguna llave que funcione; copia = tiene una y quiere otra; programar = ya tiene la llave nueva y solo hay que programarla',
              enum: ['todas_perdidas', 'copia', 'programar']
            },
            marca:  { type: 'STRING', description: 'Marca del carro (ej. Toyota, Ford, Mercedes)' },
            modelo: { type: 'STRING', description: 'Modelo del carro (ej. Corolla, F-150)' },
            anio:   { type: 'STRING', description: 'Año del carro (ej. 2016)' },
            prende_con_boton:   { type: 'BOOLEAN', description: 'Respuesta a "¿prende con un botón o metiendo la llave?": true = botón, false = llave. Solo si la herramienta te lo preguntó.' },
            control_en_tablero: { type: 'BOOLEAN', description: 'Respuesta a "¿es un control completo que se mete en el tablero?". Solo si la herramienta te lo preguntó.' },
            tiene_botones:      { type: 'BOOLEAN', description: 'Respuesta a "¿la llave tiene botoncitos para abrir y cerrar?". Solo si la herramienta te lo preguntó.' },
            sale_como_navaja:   { type: 'BOOLEAN', description: 'Respuesta a "¿la parte de metal sale sola con un botoncito, como navaja?". Solo si la herramienta te lo preguntó.' },
            llave_tesla:        { type: 'STRING', description: 'Solo Tesla: cómo abre el carro.', enum: ['tarjeta', 'telefono', 'control'] },
            precio_actual:      { type: 'NUMBER', description: 'Solo si el cliente se quejó del precio: el último precio en dólares que le dijiste. La herramienta te devuelve el siguiente precio más bajo.' }
          },
          required: []
        }
      },
      {
        name: 'guardar_servicio',
        description: 'Guarda la solicitud de servicio con los datos del cliente. Llámala solo cuando tengas nombre, teléfono, ubicación y tipo de servicio. Para vehículos incluye marca y modelo.',
        parameters: {
          type: 'OBJECT',
          properties: {
            nombre: {
              type: 'STRING',
              description: 'Nombre completo del cliente'
            },
            telefono: {
              type: 'STRING',
              description: 'Teléfono del cliente con sus 10 dígitos (ej. 787-555-1234), ya confirmado con el cliente'
            },
            ubicacion: {
              type: 'STRING',
              description: 'Dirección completa con los números en dígitos (ej. 6584 Calle Collins, Urb. Santa Juanita, Bayamón), nunca en palabras'
            },
            tipo_servicio: {
              type: 'STRING',
              description: 'Tipo de servicio requerido',
              enum: [
                'apertura_puerta',
                'cambio_cilindro',
                'duplicado_llave',
                'apertura_caja_fuerte',
                'instalacion_cerradura',
                'emergencia_vehiculo',
                'llave_vehiculo',
                'otro'
              ]
            },
            es_emergencia: {
              type: 'BOOLEAN',
              description: 'true si hay niños, mascotas o personas encerradas, o peligro inmediato'
            },
            marca_vehiculo: {
              type: 'STRING',
              description: 'Marca del vehículo (solo para emergencia_vehiculo)'
            },
            modelo_vehiculo: {
              type: 'STRING',
              description: 'Modelo del vehículo si lo dio (opcional)'
            },
            tipo_cerradura: {
              type: 'STRING',
              description: 'Tipo de cerradura de la propiedad (solo para apertura_puerta), el mismo que usaste en consultar_precio.',
              enum: [
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
                'persiana_metalica'
              ]
            },
            anio_vehiculo: {
              type: 'STRING',
              description: 'Año del vehículo (solo para llave_vehiculo)'
            },
            tipo_llave: {
              type: 'STRING',
              description: 'Tipo de llave que usaste en cotizar_llave (solo para llave_vehiculo)'
            },
            precio_acordado: {
              type: 'NUMBER',
              description: 'Precio en dólares que el cliente aceptó (solo para llave_vehiculo)'
            },
            notas_adicionales: {
              type: 'STRING',
              description: 'Información adicional relevante, ej. "cliente por confirmar" si quedó dudoso (opcional)'
            }
          },
          required: ['nombre', 'telefono', 'ubicacion', 'tipo_servicio', 'es_emergencia']
        }
      }
    ]
  }
];

// ── Configuración de sesión (v1beta confirmado) ───────────────────────────────
async function buildSetupMessage() {
  const systemInstruction = await buildSystemInstruction();
  return {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: VOICE
            }
          }
        },
        // Sin "pensamiento" previo: responde de una (clave para la latencia)
        thinkingConfig: {
          thinkingBudget: 0
        },
      },
      // VAD más agresivo: detecta el fin del habla a los ~400ms de silencio
      // en vez del default (mucho más lento). Baja la latencia percibida.
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
          endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
          prefixPaddingMs: 100,
          silenceDurationMs: 400
        }
      },
      // Transcripciones en vivo para la UI
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [
          {
            text: systemInstruction
          }
        ]
      },
      tools: TOOLS
    }
  };
}

// ── URL de conexión ──────────────────────────────────────────────────────────
function buildGeminiUrl() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'TU_API_KEY_AQUI') {
    throw new Error('❌ GEMINI_API_KEY no configurada. Copia .env.example → .env y agrega tu API key.');
  }
  return `${GEMINI_WS_ENDPOINT}?key=${apiKey}`;
}

module.exports = {
  buildSetupMessage,
  buildSystemInstruction,
  buildGeminiUrl,
  saludoPR,
  MODEL,
  VOICE
};
