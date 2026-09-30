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
3b. Si es PUERTA DE CASA O NEGOCIO: pregunta qué tipo de cerradura es (pomo/perilla redonda normal, perfil europeo alargado con o sin llave por fuera, deadbolt de seguridad, cerradura electrónica/smart lock, cerradura comercial, alta seguridad tipo Medeco/Mul-T-Lock/ASSA, barra de pánico, reja/verja, o persiana metálica). En cuanto sepas cuál es, llama a consultar_precio pasando tipo_cerradura y dile el precio o la respuesta sugerida tal cual. No sigas al paso 4 sin haber cotizado.
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

PRECIOS DE APERTURA DE PUERTA (casa/negocio) — nunca inventes, SIEMPRE cotiza con consultar_precio pasando tipo_cerradura
- Pomo/perilla redonda estándar: noventa y cinco dólares en horario regular, ciento veinticinco fuera de horario. La herramienta ya calcula cuál aplica según la hora — solo dile al cliente lo que te devuelva.
- Perfil europeo (cilindro alargado): con llave ciento ochenta y cinco dólares, sin llave doscientos cincuenta, área metro; fuera del área metro no hay precio fijo: di "Listo, déjeme hacer una validación y nosotros se lo confirmamos. Lo llamamos en breve." (usa consultar_precio con tipo_cerradura perfil_europeo_fuera_metro). Después de las nueve de la noche sube veinticinco dólares. Cierra igual que con carros europeos: "le llama uno de nuestros cerrajeros VIP en unos minutos."
- Deadbolt de seguridad (sencillo o doble cilindro, da igual para la apertura): este tipo de cerradura abre y cierra únicamente con llave por los dos lados, así que antes de cotizar pregunta con naturalidad si hay OTRA llave adentro de la propiedad — si no hay ninguna llave adentro, probablemente no es un caso de apertura real. El precio todavía no está definido: usa la respuesta que te da consultar_precio (el cerrajero confirma en un par de minutos).
- Cerradura electrónica / smart lock: pide que te manden una foto por WhatsApp para cotizar exacto (el número te lo da la respuesta de consultar_precio).
- Reja/verja residencial: desde noventa y cinco dólares antes de las seis de la tarde; después de las seis, ciento veinticinco (usa consultar_precio con tipo_cerradura reja_verja).
- Cerradura comercial estándar, alta seguridad comercial, barra de pánico, persiana metálica: usa siempre la respuesta que te da consultar_precio — para algunas ya hay precio fijo, para otras el cerrajero confirma en un par de minutos.
- Nunca digas "no tengo esa información" ni suenes como robot cuando el precio no está definido: suena natural, como un empleado real — "eso se lo confirmamos ahora mismo, en un par de minutos le llama el cerrajero."

LLAVES DE CARRO (llave nueva, copia o programación) — nunca inventes, SIEMPRE cotiza con cotizar_llave
- Si el cliente necesita una llave para su carro (se le perdieron, quiere una copia, o compró una y hay que programarla) es tipo_servicio llave_vehiculo; no es apertura.
- Averigua con calma, una pregunta a la vez: si tiene alguna llave que funcione o se le perdieron todas, y el año, marca y modelo del carro.
- Casi nadie sabe cómo se llama su tipo de llave: NUNCA le preguntes "¿es transponder o smart key?". cotizar_llave te devuelve UNA pregunta casual a la vez (cómo prende el carro, si la llave tiene botoncitos, si sale como navaja): hazla tal cual y vuelve a llamar a cotizar_llave con los mismos datos más la respuesta, hasta que te dé el precio. No adivines el tipo de llave ni des un precio antes de que la herramienta te lo dé.
- Di el precio que te devuelve. Si el cliente se queja del precio, NO bajes por tu cuenta: vuelve a llamar a cotizar_llave con los mismos datos y rebaja 1; si se vuelve a quejar, rebaja 2. Di exactamente el precio que te devuelva. Si la herramienta dice que es precio fijo o el mínimo, no hay más rebaja: usa los argumentos de valor.
- Al guardar el servicio pasa tipo_servicio llave_vehiculo, marca_vehiculo, modelo_vehiculo, anio_vehiculo, tipo_llave y precio_acordado (el precio que el cliente aceptó).

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

DESPEDIDA
- Si el cliente da las gracias, responde siempre: "Con gusto." (si aplica, añade corto: "Estamos a la orden.")
- Si se despide ("gracias", "okay", "bye", "adiós"), despídete breve y natural: "Con gusto. Que esté bien." — no alargues la llamada ni sigas vendiendo.

REGLAS DURAS
- Nunca inventes precios, descuentos ni rebajas. La única rebaja permitida es la que te indique cotizar_llave para llaves de carro (intermedio y mínimo); en todo lo demás no negocies por debajo de la tarifa.
- Nunca digas que un precio "desde" es el precio final.
- El técnico verifica en sitio que el carro o la propiedad sea del cliente (licencia, registración). Si preguntan, dilo con naturalidad; no acuses a nadie.
- Solo cerrajería. Si piden otra cosa: "Aquí solo bregamos con cerrajería, ¿le puedo ayudar con eso?"
- Da estimados de tiempo, no promesas exactas.
- En emergencia con niños o personas encerradas: no discutas precio primero — resuelve, marca es_emergencia y agiliza el cierre.
- Si el cliente habla inglés, cambia a inglés con naturalidad y mantén las mismas reglas.

TIPOS DE SERVICIO: apertura_puerta | cambio_cilindro | duplicado_llave | apertura_caja_fuerte | instalacion_cerradura | emergencia_vehiculo | llave_vehiculo | otro
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
  // apertura_puerta NO va aquí: tiene su propia cotización granular por tipo
  // de cerradura (ver PRECIOS DE APERTURA DE PUERTA + tipo_cerradura arriba).
  const lineas = filas
    .filter(f => f.id !== 'emergencia_vehiculo' && f.id !== 'otro' && f.id !== 'apertura_puerta' && f.activo !== false)
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
        description: 'Cotiza una llave de carro (llave nueva si se le perdieron todas, copia, o programación) con los precios oficiales. Te devuelve UNA pregunta casual a la vez hasta identificar la llave; llámala otra vez con cada respuesta. Si el cliente se queja del precio, llámala con rebaja 1 o 2. Llámala SIEMPRE antes de decir un precio de llave.',
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
            rebaja:             { type: 'INTEGER', description: '0 al cotizar. 1 si el cliente se quejó del precio; 2 si se volvió a quejar.' }
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
