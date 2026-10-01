# Configuración del agente de ElevenLabs (vía telefónica)

> **Fuente única del prompt:** [`prompt-telefono.txt`](prompt-telefono.txt). Ese archivo es el que tiene el agente de ElevenLabs y el que usa la versión web (`server/gemini.js` lo lee). Si cambias el prompt, edita ese archivo y súbelo al agente por API.

> Cambios 2026-10-01: el negocio se presenta como "Tu Cerrajero Puerto Rico"; trato de usted con registro profesional (sin expresiones de la calle), entiende el acento boricua sin corregir al cliente, empatía corta, pide los datos con "déjeme saber" / "¿me regala…?".

La llamada telefónica entra por Twilio y se conecta al agente de **ElevenLabs
Conversational AI** (`server/elevenlabs-bridge.js`). El "cerebro" de ese agente
se configura en el dashboard de ElevenLabs — este documento tiene todo listo
para copiar y pegar, con el mismo comportamiento que la versión web (Gemini).

> Dashboard: elevenlabs.io → **Conversational AI** → tu agente

---

## 1. Voz

- Voz clonada de Ángel Toledo: **"Ángel - Cerrajero Puerto Rico"** (`4gbXHqcXGAeTEHLn4vP2`, Instant Voice Clone).
- Modelo `eleven_v3_conversational`, modo expresivo apagado, estabilidad 0.48 (cálida, sin exagerar), similitud 0.85, velocidad 1.15.
- Audio `ulaw_8000` de entrada y salida (formato telefónico; el bridge lo pasa directo a Twilio).
- LLM `gemini-3.5-flash-lite` (el más rápido en las pruebas: ~0.5 s por turno).

## 2. First message (primer saludo)

```
Tu Cerrajero Puerto Rico, {{saludo}}, ¿en qué le puedo ayudar?
```

`{{saludo}}` lo manda el bridge según la hora de Puerto Rico (buenos días / buenas tardes / buenas noches).

## 3. System prompt

Ver [`prompt-telefono.txt`](prompt-telefono.txt) — copiar completo.

> **Nota:** si el dueño cambia precios en el panel admin, hay que actualizar
> la sección "OTROS SERVICIOS" de este prompt en ElevenLabs a mano (la versión
> web con Gemini los lee sola de la base de datos). La cotización de carros
> siempre sale del webhook, así que esa nunca se desactualiza.

## 4. Tools (webhooks)

En el agente → **Tools** → añade estas dos herramientas tipo **Webhook**
(reemplaza `TU-SERVIDOR` por el dominio público del servidor, ej. el de
Railway o el de ngrok en pruebas):

### consultar_precio
- **Método:** POST
- **URL:** `https://TU-SERVIDOR/api/tools/consultar_precio`
- **Descripción:** Consulta el precio oficial de un servicio. Para apertura de vehículo pasa la marca y el modelo. Llámala SIEMPRE antes de decir un precio.
- **Parámetros (body):**
  - `tipo_servicio` (string, requerido): `apertura_puerta` | `cambio_cilindro` | `duplicado_llave` | `apertura_caja_fuerte` | `instalacion_cerradura` | `emergencia_vehiculo` | `otro`
  - `marca` (string, opcional): marca del vehículo tal como la dijo el cliente
  - `modelo` (string, opcional): modelo si lo mencionó
  - `tipo_cerradura` (string, opcional): solo para `apertura_puerta` — `pomo_perilla` | `reja_verja` | `perfil_europeo_con_llave` | `perfil_europeo_sin_llave` | `perfil_europeo_fuera_metro` | `deadbolt_seguridad` | `cerradura_electronica` | `cerradura_comercial_estandar` | `alta_seguridad_comercial` | `barra_panico` | `persiana_metalica`
  - `es_emergencia` (boolean, opcional)

### guardar_servicio
- **Método:** POST
- **URL:** `https://TU-SERVIDOR/api/tools/guardar_servicio`
- **Descripción:** Guarda la solicitud con los datos del cliente. Llámala solo cuando tengas nombre, teléfono, ubicación y tipo de servicio. Para vehículos incluye marca y modelo; para puertas de propiedad incluye tipo_cerradura.
- **Parámetros (body):**
  - `nombre` (string, requerido)
  - `telefono` (string, requerido)
  - `ubicacion` (string, requerido): urbanización/calle, número y pueblo
  - `tipo_servicio` (string, requerido): mismos valores de arriba
  - `es_emergencia` (boolean, requerido)
  - `marca_vehiculo` (string, opcional)
  - `modelo_vehiculo` (string, opcional)
  - `tipo_cerradura` (string, opcional): el mismo que usaste en consultar_precio
  - `notas_adicionales` (string, opcional): ej. "cliente por confirmar"

El ruteo es automático: si la marca es europea/exótica (o Corvette), el
servicio se marca **premium** y se asigna directo al especialista (Mateo);
las demás van al cerrajero de la zona según el pueblo.
