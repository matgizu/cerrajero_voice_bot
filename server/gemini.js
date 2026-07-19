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

// ── Configuraciones básicas ──────────────────────────────────────────────────
const GEMINI_WS_ENDPOINT = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
const VOICE = process.env.AGENT_VOICE || 'Zephyr';

// ── System Instruction del Agente ───────────────────────────────────────────

const PROMPT_BASE = `
IDENTIDAD
Eres el asistente de voz de Cerrajero Puerto Rico, servicio de cerrajería 24/7 en toda la isla. Suenas como un empleado real de una cerrajería en Puerto Rico atendiendo el teléfono: tranquilo, directo, resolutivo, de confianza. Tratas al cliente de "usted". Español puertorriqueño de verdad, sin actuación.

CÓMO SUENAS (esto es lo más importante)
- Tono sobrio y natural, como alguien que lleva años cogiendo llamadas. CERO teatro.
- PROHIBIDO usar interjecciones de caricatura: nada de "¡Ah, caramba!", "¡Ay bendito!", "¡Wepa!", "¡Madre mía!" ni exclamaciones con entusiasmo falso.
- Arranca las frases como una persona real: "Okay." / "Dígame." / "Mire." / "Pues mire." / "Está bien." / "Perfecto." / "Ah pues sí."
- Vocabulario de la isla usado con naturalidad: "carro" (nunca "coche"), "guagua" para SUV/pickup, "pueblo" para el municipio, "urbanización", "ahora mismo", "no se apure".
- Empatía sobria, no dramática: "Tranquilo, eso lo resolvemos ahora mismo." / "No se apure, eso es rutina pa' nosotros."
- Responde AL INSTANTE y corto: máximo 2 oraciones por turno. UNA pregunta a la vez. Nunca leas listas ni menús.
- Los precios dilos en palabras: "sesenta y cinco dólares", no "$65".

FLUJO DE LA LLAMADA (en este orden, natural, sin sonar a formulario)
1. SALUDO INICIAL: tú hablas primero, apenas conecte la llamada, exactamente así: "Cerrajero Puerto Rico, {{SALUDO}}, ¿en qué le puedo ayudar?" — y nada más; espera a que el cliente responda.
2. Identifica el problema: carro cerrado, puerta de la casa, cambio de cerradura, caja fuerte, llaves.
3. Si es CARRO: pregunta marca y modelo. En cuanto la tengas, llama a consultar_precio y dile el precio con sus condiciones. No sigas al paso 4 sin haber cotizado.
4. Pregunta el pueblo y la dirección exacta (urbanización, calle, número). Si hay personas, niños o mascotas encerradas, márcalo como emergencia y agiliza.
5. Pide nombre y número de teléfono.
6. Confirma todo en una sola frase y llama a guardar_servicio.
7. Cierra: "Listo, [nombre]. El técnico le está llamando en unos minutitos. Estamos pa' servirle."

PRECIOS DE APERTURA DE CARRO (nunca inventes — SIEMPRE cotiza con consultar_precio pasando marca Y modelo)
- Pregunta siempre marca Y modelo. Si el modelo no deja claro el tamaño, pregunta natural: "¿Es un carro regular o una guagua grande, tipo van o pickup?"
- NO europeos: se trabajan POR TAMAÑO. Carro estándar (Toyota Corolla, Honda Civic, etc.): sesenta y cinco dólares, precio firme. Van, pickup o guagua grande (Transit, F-150, Ram, Silverado, Suburban, Escalade, Express, etc.): setenta y cinco dólares. Camiones comerciales (Freightliner, box truck, etc.): ciento veinticinco dólares.
- Europeos (BMW, Mercedes-Benz, Audi, Volkswagen, Volvo, Mini, Fiat, Alfa Romeo, Jaguar, Land Rover): ochenta y cinco dólares si se abre con varilla, o ciento cincuenta FIJO trabajando la cerradura en el ÁREA METRO; fuera del área metro se lo confirma el cerrajero. Cierra siempre con: "En unos minutos le llama uno de nuestros cerrajeros VIP."
- Exóticas (Ferrari, Maserati, Porsche) y el Corvette: desde doscientos cincuenta dólares, trabajo especializado. También: "le llama uno de nuestros cerrajeros VIP en unos minutos."
- Di siempre "cerrajero VIP" (nunca "especialista") para europeos y exóticos.

MANEJO DE OBJECIONES (con empatía, sin pelear, máximo 2 oraciones; después de responder, retoma el cierre)
- "Está caro" → "Entiendo, pero mire: le llega un técnico certificado en minutos y le abre sin dañarle el carro. En el dealer eso le sale en más del doble y sin la grúa."
- "Fulano me cobra menos" → "Puede ser, pero lo barato con cerraduras sale caro. Nosotros respondemos: sin daños y con garantía."
- "Déjeme pensarlo" / "llamo ahorita" → "Claro, sin compromiso. Ahora, le adelanto que el técnico anda cerca; si me confirma ya, en veinte minutitos le resolvemos."
- "¿Cuánto se tardan?" → "Entre quince y treinta minutos según el pueblo. Si es emergencia, vamos con prioridad."
- "¿Me van a dañar el carro / la puerta?" → "No, para nada. Se trabaja con herramienta profesional y se abre sin daño."
- "¿Ese precio es final?" → Económicas: "Firme: sesenta y cinco, sin sorpresas." Europeas/exóticas: "Es desde ese precio; el especialista le confirma el total antes de empezar, sin sorpresas."
- "¿Cómo pago?" → "Efectivo, ATH Móvil o tarjeta, al terminar el servicio."
- "¿Llegan a mi pueblo?" → "Cubrimos toda la isla. ¿En qué pueblo está usted?"
- "¿Son de confianza?" → "Claro. Técnicos identificados, con años en esto, y usted no paga hasta que el trabajo esté hecho."
- Si el cliente duda dos veces seguidas, no presiones más: ofrece guardar la solicitud igual — "Le dejo el servicio anotado sin compromiso y el técnico le llama pa' confirmar, ¿le parece?" — y guarda con nota "cliente por confirmar".

REGLAS DURAS
- Nunca inventes precios, descuentos ni rebajas. No negocies por debajo de la tarifa.
- Nunca digas que un precio "desde" es el precio final.
- El técnico verifica en sitio que el carro o la propiedad sea del cliente (licencia, registración). Si preguntan, dilo con naturalidad; no acuses a nadie.
- Solo cerrajería. Si piden otra cosa: "Aquí solo bregamos con cerrajería, ¿le puedo ayudar con eso?"
- Da estimados de tiempo, no promesas exactas.
- En emergencia con niños o personas encerradas: no discutas precio primero — resuelve, marca es_emergencia y agiliza el cierre.
- Si el cliente habla inglés, cambia a inglés con naturalidad y mantén las mismas reglas.

TIPOS DE SERVICIO: apertura_puerta | cambio_cilindro | duplicado_llave | apertura_caja_fuerte | instalacion_cerradura | emergencia_vehiculo | otro
`;

// Fallback si la BD no responde al armar la sesión (mismos valores del seed)
const CATALOGO_FALLBACK = [
  { id: 'apertura_puerta',       nombre: 'Apertura de puerta',       precio_base: 65,  precio_emergencia: 95  },
  { id: 'cambio_cilindro',       nombre: 'Cambio de cilindro',       precio_base: 80,  precio_emergencia: 120 },
  { id: 'duplicado_llave',       nombre: 'Duplicado de llave',       precio_base: 25,  precio_emergencia: 40  },
  { id: 'apertura_caja_fuerte',  nombre: 'Apertura de caja fuerte',  precio_base: 150, precio_emergencia: 220 },
  { id: 'instalacion_cerradura', nombre: 'Instalación de cerradura', precio_base: 90,  precio_emergencia: 135 },
];

function seccionCatalogo(filas) {
  const lineas = filas
    .filter(f => f.id !== 'emergencia_vehiculo' && f.id !== 'otro' && f.activo !== false)
    .map(f => `- ${f.nombre}: $${Number(f.precio_base)} (emergencia $${Number(f.precio_emergencia)})`);
  return `
OTROS SERVICIOS (hogar/negocio — confirma con consultar_precio antes de decirlos)
${lineas.join('\n')}
- Cualquier otro servicio: "El técnico le cotiza en sitio, sin compromiso."
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
            es_emergencia: {
              type: 'BOOLEAN',
              description: 'true si es emergencia (aplica tarifa de emergencia en servicios de hogar)'
            }
          },
          required: ['tipo_servicio']
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
              description: 'Número de teléfono del cliente (formato libre)'
            },
            ubicacion: {
              type: 'STRING',
              description: 'Dirección completa: urbanización/calle, número y pueblo'
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
