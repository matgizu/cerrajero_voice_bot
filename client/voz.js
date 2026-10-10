'use strict';

// ══════════════════════════════════════════════════════════════════════════════
//  Voz del bot — ajustes del agente de ElevenLabs, muestra de audio y
//  pronunciación boricua. Nada se aplica al bot hasta tocar "Guardar en el bot".
// ══════════════════════════════════════════════════════════════════════════════

(() => {
  const $ = id => document.getElementById(id);
  const FRASES = {
    saludo: null, // se toma del campo "Saludo"
    precio: 'Perfecto. La apertura de su carro le sale en noventa y cinco dólares... Déjeme saber si continuamos con el servicio.',
    espera: 'Gracias por su paciencia en la línea. Deme otro momentito, por favor, que ya casi termino.',
    datos: 'Perfecto, gracias. ¿Me deja saber en qué pueblo está, por favor?',
    despedida: 'Con mucho gusto. El técnico le llama en unos minutos. Que tenga buenas tardes.',
  };

  let original = null;   // lo que tiene el bot ahora
  let audioUrl = null;

  // Expresividad (lo que se muestra) = 1 − estabilidad (lo que usa ElevenLabs)
  const leerFormulario = () => ({
    velocidad: Number($('voz-velocidad').value),
    estabilidad: Math.round((1 - Number($('voz-expresividad').value) / 100) * 100) / 100,
    parecido: Number($('voz-parecido').value) / 100,
    tono_calido: $('voz-calido').checked,
    saludo: $('voz-saludo').value.trim(),
    pronunciacion: [...document.querySelectorAll('.voz-pron-fila')]
      .map(f => ({ palabra: f.querySelector('.p-de').value.trim(), suena: f.querySelector('.p-a').value.trim() }))
      .filter(p => p.palabra && p.suena),
  });

  function pintarValores() {
    $('voz-velocidad-val').textContent = Number($('voz-velocidad').value).toFixed(2).replace('.', ',');
    $('voz-expresividad-val').textContent = `${$('voz-expresividad').value}%`;
    $('voz-parecido-val').textContent = `${$('voz-parecido').value}%`;
    marcarCambios();
  }

  function filaPron(p = { palabra: '', suena: '' }) {
    const div = document.createElement('div');
    div.className = 'voz-pron-fila';
    div.innerHTML = `<input class="voz-input p-de" placeholder="se escribe (ej. por favor)">
      <span>→</span>
      <input class="voz-input p-a" placeholder="suena (ej. pol favol)">
      <button title="Quitar">✕</button>`;
    div.querySelector('.p-de').value = p.palabra;
    div.querySelector('.p-a').value = p.suena;
    div.querySelector('button').onclick = () => { div.remove(); marcarCambios(); };
    div.querySelectorAll('input').forEach(i => i.addEventListener('input', marcarCambios));
    return div;
  }

  function llenar(v) {
    $('voz-velocidad').value = v.velocidad;
    $('voz-expresividad').value = Math.round((1 - v.estabilidad) * 100);
    $('voz-parecido').value = Math.round(v.parecido * 100);
    $('voz-calido').checked = v.tono_calido;
    $('voz-saludo').value = (v.saludo || '').replace(/^\[[a-z ]+\]\s*/i, '');
    const cont = $('voz-pronunciacion');
    cont.innerHTML = '';
    v.pronunciacion.forEach(p => cont.appendChild(filaPron(p)));
    pintarValores();
  }

  const normal = v => JSON.stringify({ ...v, saludo: (v.saludo || '').replace(/^\[[a-z ]+\]\s*/i, '') });
  function marcarCambios() {
    if (!original) return;
    const hay = normal(leerFormulario()) !== normal({
      velocidad: original.velocidad, estabilidad: original.estabilidad, parecido: original.parecido,
      tono_calido: original.tono_calido, saludo: original.saludo, pronunciacion: original.pronunciacion,
    });
    $('voz-cambios').textContent = hay ? '● Hay cambios sin guardar (el bot sigue con los anteriores)' : 'Sin cambios: el bot usa estos ajustes';
    $('voz-cambios').classList.toggle('con-cambios', hay);
  }

  async function cargar() {
    try {
      const r = await fetch('/api/centro/voz');
      if (!r.ok) throw new Error();
      original = await r.json();
      llenar(original);
      if (!$('voz-texto-prueba').value) $('voz-texto-prueba').value = FRASES.precio;
      $('voz-estado-carga').textContent = 'Ajustes actuales del bot';
    } catch (_) {
      $('voz-estado-carga').textContent = 'No pude leer los ajustes del bot';
    }
  }

  async function escuchar() {
    const b = $('voz-escuchar');
    b.disabled = true;
    b.textContent = '⏳ Generando…';
    try {
      const r = await fetch('/api/centro/voz/probar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...leerFormulario(), texto: $('voz-texto-prueba').value }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo generar');
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(await r.blob());
      $('voz-audio').src = audioUrl;
      $('voz-audio').play().catch(() => {});
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, 'error');
    }
    b.disabled = false;
    b.textContent = '▶ Escuchar';
  }

  async function guardar() {
    if (!confirm('¿Aplicar estos ajustes al bot del teléfono? Las próximas llamadas ya van a sonar así.')) return;
    const b = $('voz-guardar');
    b.disabled = true;
    b.textContent = 'Guardando…';
    try {
      const r = await fetch('/api/centro/voz', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leerFormulario()),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo guardar');
      original = await r.json();
      llenar(original);
      if (typeof showToast === 'function') showToast('✅ Voz del bot actualizada', 'info');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, 'error');
    }
    b.disabled = false;
    b.textContent = '💾 Guardar en el bot';
  }

  ['voz-velocidad', 'voz-expresividad', 'voz-parecido'].forEach(id => $(id).addEventListener('input', pintarValores));
  ['voz-calido', 'voz-saludo'].forEach(id => $(id).addEventListener('input', marcarCambios));
  $('voz-calido').addEventListener('change', marcarCambios);
  document.querySelectorAll('[data-frase]').forEach(b => b.addEventListener('click', () => {
    const f = b.dataset.frase;
    $('voz-texto-prueba').value = f === 'saludo' ? $('voz-saludo').value : FRASES[f];
  }));
  $('voz-escuchar').addEventListener('click', escuchar);
  $('voz-guardar').addEventListener('click', guardar);
  $('voz-descartar').addEventListener('click', () => original && llenar(original));
  $('voz-pron-agregar').addEventListener('click', () => {
    const fila = filaPron();
    $('voz-pronunciacion').appendChild(fila);
    fila.querySelector('.p-de').focus();
    marcarCambios();
  });

  // ── Cómo escucha (paciencia, pausa, cerebro) y prompt ──────────────────────
  const aviso = (msg, tipo = 'info') => typeof showToast === 'function' && showToast(msg, tipo);

  function pintarAgente(a) {
    $('agente-paciencia').value = a.paciencia || 'normal';
    if (a.pausa_seg != null) $('agente-pausa').value = Math.round(a.pausa_seg);
    $('agente-pausa-val').textContent = `${$('agente-pausa').value} s`;
    $('agente-cerebro').value = a.modelo_cerebro || '';
    const p = $('agente-prompt-estado');
    p.textContent = a.prompt.igual_al_repo ? '✓ El bot usa las del repo' : `≠ Distintas al repo (bot ${a.prompt.caracteres_agente} / repo ${a.prompt.caracteres_repo} caracteres)`;
    p.className = a.prompt.igual_al_repo ? 'ok' : 'distinto';
    $('agente-estado').textContent = 'Ajustes actuales del bot';
  }

  async function cargarAgente() {
    try {
      const r = await fetch('/api/centro/agente');
      if (!r.ok) throw new Error();
      pintarAgente(await r.json());
    } catch (_) {
      $('agente-estado').textContent = 'No pude leer los ajustes del bot';
    }
  }

  async function guardarAgente() {
    if (!confirm('¿Aplicar la forma de escuchar al bot del teléfono?')) return;
    const b = $('agente-guardar');
    b.disabled = true;
    try {
      const r = await fetch('/api/centro/agente', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paciencia: $('agente-paciencia').value, pausa_seg: Number($('agente-pausa').value), modelo_cerebro: $('agente-cerebro').value.trim() }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo guardar');
      pintarAgente(await r.json());
      aviso('✅ Escucha del bot actualizada');
    } catch (err) {
      aviso(err.message, 'error');
    }
    b.disabled = false;
  }

  async function subirPrompt() {
    if (!confirm('¿Subir las instrucciones del repo al bot del teléfono? Las próximas llamadas ya las usan.')) return;
    const b = $('agente-subir-prompt');
    b.disabled = true;
    try {
      const r = await fetch('/api/centro/agente/prompt', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo subir');
      pintarAgente(await r.json());
      aviso('✅ Instrucciones subidas al bot');
    } catch (err) {
      aviso(err.message, 'error');
    }
    b.disabled = false;
  }

  $('agente-pausa').addEventListener('input', () => { $('agente-pausa-val').textContent = `${$('agente-pausa').value} s`; });
  $('agente-guardar').addEventListener('click', guardarAgente);
  $('agente-subir-prompt').addEventListener('click', subirPrompt);

  // Se carga la primera vez que se abre la pestaña
  let cargado = false;
  document.querySelector('[data-tab="voz"]').addEventListener('click', () => { if (!cargado) { cargado = true; cargar(); cargarAgente(); } });
})();
