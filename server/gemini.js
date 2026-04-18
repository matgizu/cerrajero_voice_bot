/**
 * gemini.js — Configuración de conexión con Gemini Multimodal Live API
 * 
 * Define el system prompt, herramientas (function calling) y
 * parámetros de audio para el agente de cerrajería.
 */

'use strict';

require('dotenv').config();

// ── Configuraciones básicas ──────────────────────────────────────────────────
const GEMINI_WS_ENDPOINT = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-live-preview';
const VOICE = process.env.AGENT_VOICE || 'Zephyr';

// ── System Instruction del Agente ───────────────────────────────────────────
const SYSTEM_INSTRUCTION = `
Eres el asistente de voz de Cerrajería Express 24/7. Habla español con fluidez y naturalidad. Sé directo, breve y cálido — sin rodeos.

FLUJO (sigue este orden exacto, una pregunta a la vez):
1. Saluda en una sola frase e identifícate. Pregunta de inmediato: "¿Me puede dar su nombre y número de teléfono?"
2. Con esos datos, pregunta: "¿Cuál es el problema? (puerta trabada, llaves perdidas, cambio de cerradura, caja fuerte, vehículo u otro)"
3. Pregunta la dirección exacta: calle, número, piso y ciudad.
4. Pregunta solo si aplica: "¿Hay personas, niños o mascotas encerradas?" — si sí, marca emergencia.
5. Confirma los datos en voz alta y llama a guardar_servicio.
6. Cierra con: "Listo, [nombre]. Un técnico le contactará en minutos."

REGLAS:
- Máximo 2 oraciones por respuesta. Sin explicaciones largas.
- Nunca menciones precios. Si preguntan: "El técnico le dará el precio en sitio."
- Si la consulta no es de cerrajería, di: "Solo atiendo servicios de cerrajería, ¿en qué le ayudo?"
- En emergencia: comunica urgencia brevemente y agiliza el cierre.

TIPOS DE SERVICIO: apertura_puerta | cambio_cilindro | duplicado_llave | apertura_caja_fuerte | instalacion_cerradura | emergencia_vehiculo | otro
`;

// ── Definición de herramientas (Function Calling) ───────────────────────────
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'guardar_servicio',
        description: 'Guarda la solicitud de servicio de cerrajería con los datos del cliente recabados durante la llamada. Llama esta función solo cuando tengas nombre, teléfono, ubicación y tipo de servicio.',
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
              description: 'Dirección completa donde se requiere el servicio: calle, número, piso/depto, ciudad'
            },
            tipo_servicio: {
              type: 'STRING',
              description: 'Tipo de servicio requerido. Valores posibles: apertura_puerta, cambio_cilindro, duplicado_llave, apertura_caja_fuerte, instalacion_cerradura, emergencia_vehiculo, otro',
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
              description: 'true si hay niños, mascotas, personas mayores encerradas o situación de peligro inmediato'
            },
            notas_adicionales: {
              type: 'STRING',
              description: 'Información adicional relevante que el cliente haya mencionado (opcional)'
            }
          },
          required: ['nombre', 'telefono', 'ubicacion', 'tipo_servicio', 'es_emergencia']
        }
      }
    ]
  }
];

// ── Configuración de sesión (v1beta confirmado) ───────────────────────────────
function buildSetupMessage() {
  // v1beta: clave raiz 'setup', configuración de audio dentro de generationConfig
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
      },
      systemInstruction: {
        parts: [
          {
            text: SYSTEM_INSTRUCTION.trim()
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
  buildGeminiUrl,
  MODEL,
  VOICE
};
