'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  VOZ DEL BOT — ajustes del agente de ElevenLabs desde el panel
//  ------------------------------------------------------------------------------
//  Lee y guarda en el agente del teléfono: velocidad, estabilidad (expresividad),
//  parecido a la voz, tono cálido (modo expresivo con [warmly]/[friendly]),
//  saludo y el diccionario de pronunciación boricua (alias tipo
//  "por favor" → "pol favol"). También genera una muestra de audio con ajustes
//  sin guardar para escucharla antes.
// ══════════════════════════════════════════════════════════════════════════════

const EL = 'https://api.elevenlabs.io/v1';
const ETIQUETAS_TONO = [
  { tag: 'warmly', description: 'Tono cálido, cercano y amable' },
  { tag: 'friendly', description: 'Tono cordial y servicial' },
];
const LIMITES = { speed: [0.7, 1.2], stability: [0, 1], similarity_boost: [0, 1] };

async function el(ruta, opciones = {}) {
  const r = await fetch(`${EL}${ruta}`, {
    ...opciones,
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '', ...(opciones.headers || {}) },
  });
  const texto = await r.text();
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${texto.slice(0, 200)}`);
  return texto;
}
const elJson = async (ruta, opciones) => JSON.parse(await el(ruta, opciones));
const agenteId = () => process.env.ELEVENLABS_AGENT_ID;

// ── Pronunciación ────────────────────────────────────────────────────────────

/** PLS (XML) → [{ palabra, suena }] sin duplicados por mayúsculas. */
function reglasDesdePls(xml) {
  const vistas = new Set();
  const out = [];
  for (const m of xml.matchAll(/<grapheme>([\s\S]*?)<\/grapheme>\s*<alias>([\s\S]*?)<\/alias>/g)) {
    const palabra = m[1].trim(), suena = m[2].trim();
    const clave = palabra.toLowerCase();
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    out.push({ palabra: clave, suena: suena.toLowerCase() });
  }
  return out;
}

const mayuscula = t => t.charAt(0).toUpperCase() + t.slice(1);

/** [{ palabra, suena }] → reglas alias de ElevenLabs (minúscula + Mayúscula inicial). */
function reglasElevenLabs(pares) {
  const reglas = [];
  for (const { palabra, suena } of pares) {
    const p = String(palabra || '').trim().toLowerCase(), s = String(suena || '').trim().toLowerCase();
    if (!p || !s || p === s) continue;
    reglas.push({ type: 'alias', string_to_replace: p, alias: s });
    if (mayuscula(p) !== p) reglas.push({ type: 'alias', string_to_replace: mayuscula(p), alias: mayuscula(s) });
  }
  return reglas;
}

/** Aplica la pronunciación al texto (para la muestra con ajustes sin guardar). */
function aplicarPronunciacion(texto, pares) {
  let t = String(texto);
  for (const { string_to_replace: de, alias: a } of reglasElevenLabs(pares)) {
    t = t.replace(new RegExp(`(?<![\\p{L}])${de.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'gu'), a);
  }
  return t;
}

// ── Leer / guardar ───────────────────────────────────────────────────────────

async function leerVoz() {
  const a = await elJson(`/convai/agents/${agenteId()}`);
  const tts = a.conversation_config?.tts || {};
  const loc = (tts.pronunciation_dictionary_locators || [])[0];
  let pronunciacion = [];
  if (loc?.pronunciation_dictionary_id) {
    try {
      const xml = await el(`/pronunciation-dictionaries/${loc.pronunciation_dictionary_id}/${loc.version_id}/download`);
      pronunciacion = reglasDesdePls(xml);
    } catch (_) {}
  }
  return {
    voz_id: tts.voice_id,
    modelo: tts.model_id,
    velocidad: tts.speed ?? 1,
    estabilidad: tts.stability ?? 0.5,
    parecido: tts.similarity_boost ?? 0.8,
    tono_calido: Boolean(tts.expressive_mode),
    saludo: a.conversation_config?.agent?.first_message || '',
    pronunciacion,
    diccionario_id: loc?.pronunciation_dictionary_id || null,
    limites: { velocidad: LIMITES.speed },
  };
}

const acotar = (v, [min, max]) => Math.min(max, Math.max(min, Number(v)));

async function guardarVoz(c = {}) {
  const actual = await leerVoz();
  const tts = {};
  if (c.velocidad != null) tts.speed = acotar(c.velocidad, LIMITES.speed);
  if (c.estabilidad != null) tts.stability = acotar(c.estabilidad, LIMITES.stability);
  if (c.parecido != null) tts.similarity_boost = acotar(c.parecido, LIMITES.similarity_boost);
  if (c.tono_calido != null) {
    tts.expressive_mode = Boolean(c.tono_calido);
    if (tts.expressive_mode) tts.suggested_audio_tags = ETIQUETAS_TONO;
  }

  if (Array.isArray(c.pronunciacion)) {
    const rules = reglasElevenLabs(c.pronunciacion);
    let dic;
    if (actual.diccionario_id) {
      dic = await elJson(`/pronunciation-dictionaries/${actual.diccionario_id}/set-rules`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules }),
      });
    } else if (rules.length) {
      dic = await elJson('/pronunciation-dictionaries/add-from-rules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Boricua - Tu Cerrajero PR', rules }),
      });
    }
    if (dic) tts.pronunciation_dictionary_locators = rules.length
      ? [{ pronunciation_dictionary_id: dic.id, version_id: dic.version_id }]
      : [];
  }

  const agent = {};
  if (typeof c.saludo === 'string' && c.saludo.trim()) {
    let saludo = c.saludo.trim().slice(0, 300);
    // Con el tono cálido, el saludo arranca con [warmly]; sin él, se quita.
    const calido = c.tono_calido ?? actual.tono_calido;
    saludo = saludo.replace(/^\[[a-z ]+\]\s*/i, '');
    if (calido) saludo = `[warmly] ${saludo}`;
    agent.first_message = saludo;
  }

  await el(`/convai/agents/${agenteId()}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_config: { tts, ...(Object.keys(agent).length ? { agent } : {}) } }),
  });
  return leerVoz();
}

// ── Muestra de audio ─────────────────────────────────────────────────────────

/** MP3 con los ajustes indicados (sin guardar nada en el agente). */
async function probarVoz({ texto, velocidad, estabilidad, parecido, tono_calido, pronunciacion }) {
  const actual = await leerVoz();
  let t = String(texto || '').trim().slice(0, 500) || 'Tu Cerrajero Puerto Rico, buenas tardes, ¿en qué le puedo ayudar?';
  t = t.replace(/\{\{\s*saludo\s*\}\}/gi, 'buenas tardes');
  const calido = tono_calido ?? actual.tono_calido;
  if (!calido) t = t.replace(/\[[a-z ]+\]\s*/gi, '');
  else if (!/^\[[a-z ]+\]/i.test(t)) t = `[warmly] ${t}`;
  t = aplicarPronunciacion(t, Array.isArray(pronunciacion) ? pronunciacion : actual.pronunciacion);

  const r = await fetch(`${EL}/text-to-speech/${actual.voz_id}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: t,
      // Las etiquetas de tono las entiende eleven_v3; sin tono cálido, el mismo modelo del agente
      model_id: calido ? 'eleven_v3' : (actual.modelo || 'eleven_v3_conversational'),
      language_code: 'es',
      voice_settings: {
        speed: acotar(velocidad ?? actual.velocidad, LIMITES.speed),
        stability: acotar(estabilidad ?? actual.estabilidad, LIMITES.stability),
        similarity_boost: acotar(parecido ?? actual.parecido, LIMITES.similarity_boost),
      },
    }),
  });
  if (!r.ok) throw new Error(`No se pudo generar la muestra (${r.status}): ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { leerVoz, guardarVoz, probarVoz };
