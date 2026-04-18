'use strict';

// ── Estado global ─────────────────────────────────────────────────────────────
let servicios   = [];
let cerrajeros  = [];
let filtroEstado = '';
let filtroSearch = '';
let modalServicioId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

const TIPO_LABELS = {
  apertura_puerta:       '🚪 Apertura de puerta',
  cambio_cilindro:       '🔧 Cambio de cilindro',
  duplicado_llave:       '🗝️ Duplicado de llave',
  apertura_caja_fuerte:  '🔒 Caja fuerte',
  instalacion_cerradura: '⚙️ Instalación cerradura',
  emergencia_vehiculo:   '🚗 Emergencia vehículo',
  otro:                  '📋 Otro'
};

function tiempoRelativo(isoStr) {
  if (!isoStr) return '—';
  const diff = Math.floor((Date.now() - new Date(isoStr)) / 1000);
  if (diff < 60)   return 'hace un momento';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400)return `hace ${Math.floor(diff / 3600)} h`;
  return new Date(isoStr).toLocaleDateString('es-PR', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
}

function formatFecha(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleString('es-PR', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent  = msg;
  toast.className    = `toast ${type}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ── Reloj ─────────────────────────────────────────────────────────────────────
function actualizarReloj() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('es-PR');
}
setInterval(actualizarReloj, 1000);
actualizarReloj();

// ── Estadísticas ──────────────────────────────────────────────────────────────
function actualizarStats() {
  const hoy = new Date().toDateString();
  document.getElementById('stat-total').textContent =
    servicios.length;
  document.getElementById('stat-pendientes').textContent =
    servicios.filter(s => s.estado === 'pendiente').length;
  document.getElementById('stat-en-camino').textContent =
    servicios.filter(s => s.estado === 'en_camino').length;
  document.getElementById('stat-emergencias').textContent =
    servicios.filter(s => s.es_emergencia && s.estado !== 'completado' && s.estado !== 'cancelado').length;
  document.getElementById('stat-completados').textContent =
    servicios.filter(s => s.estado === 'completado' && new Date(s.actualizado_en || s.creado_en).toDateString() === hoy).length;
}

// ── Render servicios ──────────────────────────────────────────────────────────
function renderServicios() {
  const grid  = document.getElementById('servicios-grid');
  const empty = document.getElementById('empty-servicios');

  let lista = servicios;

  if (filtroEstado) lista = lista.filter(s => s.estado === filtroEstado);
  if (filtroSearch) {
    const q = filtroSearch.toLowerCase();
    lista = lista.filter(s =>
      s.nombre.toLowerCase().includes(q) ||
      s.telefono.includes(q) ||
      s.ubicacion.toLowerCase().includes(q)
    );
  }

  // Emergencias primero, luego por fecha desc
  lista = [...lista].sort((a, b) => {
    if (a.es_emergencia !== b.es_emergencia) return a.es_emergencia ? -1 : 1;
    return new Date(b.creado_en) - new Date(a.creado_en);
  });

  // Limpiar cards existentes (dejar el empty-state placeholder)
  [...grid.querySelectorAll('.servicio-card')].forEach(el => el.remove());

  if (lista.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  lista.forEach(s => {
    const card = document.createElement('div');
    card.className = `servicio-card${s.es_emergencia ? ' emergencia' : ''}`;
    card.dataset.id = s.id;

    card.innerHTML = `
      <div class="card-header">
        <span class="card-id">${s.id}</span>
        <div class="card-badges">
          ${s.es_emergencia ? '<span class="emergencia-badge">🚨 Emergencia</span>' : ''}
          <span class="estado-badge estado-${s.estado}">${estadoLabel(s.estado)}</span>
        </div>
      </div>
      <div>
        <div class="card-name">${s.nombre}</div>
        <div class="card-phone">📱 ${s.telefono}</div>
      </div>
      <div class="card-meta">
        <div class="card-row"><span>${TIPO_LABELS[s.tipo_servicio] || s.tipo_servicio}</span></div>
        <div class="card-row"><span>📍</span><span>${s.ubicacion}</span></div>
        <div class="card-row"><span>👷</span><span>${s.cerrajero_nombre || 'Sin asignar'}</span></div>
      </div>
      <div class="card-footer">
        <span class="card-time">${tiempoRelativo(s.creado_en)}</span>
        <select class="estado-select" data-id="${s.id}">
          <option value="pendiente"  ${s.estado === 'pendiente'  ? 'selected' : ''}>Pendiente</option>
          <option value="en_camino"  ${s.estado === 'en_camino'  ? 'selected' : ''}>En camino</option>
          <option value="completado" ${s.estado === 'completado' ? 'selected' : ''}>Completado</option>
          <option value="cancelado"  ${s.estado === 'cancelado'  ? 'selected' : ''}>Cancelado</option>
        </select>
      </div>
    `;

    // Click en la tarjeta → modal detalle
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('estado-select')) return;
      abrirModal(s.id);
    });

    // Cambio de estado inline
    card.querySelector('.estado-select').addEventListener('change', async (e) => {
      e.stopPropagation();
      await cambiarEstado(s.id, e.target.value);
    });

    grid.appendChild(card);
  });
}

function estadoLabel(estado) {
  const labels = { pendiente: 'Pendiente', en_camino: 'En camino', completado: 'Completado', cancelado: 'Cancelado' };
  return labels[estado] || estado;
}

// ── Render cerrajeros ─────────────────────────────────────────────────────────
function renderCerrajeros() {
  const grid = document.getElementById('cerrajeros-grid');
  grid.innerHTML = '';

  cerrajeros.forEach(c => {
    const activos = servicios.filter(s =>
      s.cerrajero_id === c.id && !['completado','cancelado'].includes(s.estado)
    ).length;

    const card = document.createElement('div');
    card.className = `cerrajero-card ${c.disponible ? 'disponible' : 'ocupado'}`;
    card.innerHTML = `
      <div class="cerr-header">
        <span class="cerr-name">${c.nombre}</span>
        <div class="disponibilidad-toggle ${c.disponible ? 'on' : ''}" data-id="${c.id}" title="${c.disponible ? 'Marcar ocupado' : 'Marcar disponible'}"></div>
      </div>
      <div class="cerr-info">
        <div class="cerr-row"><span>📱</span><span>${c.telefono}</span></div>
        <div class="cerr-row"><span>📍</span><span>${c.zonas.join(', ')}</span></div>
        <div class="cerr-row"><span>📋</span><span>${activos} servicio${activos !== 1 ? 's' : ''} activo${activos !== 1 ? 's' : ''}</span></div>
      </div>
      <div class="cerr-status ${c.disponible ? 'disponible' : 'ocupado'}">
        ${c.disponible ? '🟢 Disponible' : '🔴 No disponible'}
      </div>
    `;

    card.querySelector('.disponibilidad-toggle').addEventListener('click', async () => {
      await toggleCerrajero(c.id);
    });

    grid.appendChild(card);
  });
}

// ── Modal detalle ─────────────────────────────────────────────────────────────
function abrirModal(id) {
  const s = servicios.find(sv => sv.id === id);
  if (!s) return;
  modalServicioId = id;

  const cerrajeroOpts = cerrajeros.map(c =>
    `<option value="${c.id}" ${s.cerrajero_id === c.id ? 'selected' : ''}>${c.nombre} — ${c.zonas.join(', ')}</option>`
  ).join('');

  document.getElementById('modal-body').innerHTML = `
    <h2>${s.es_emergencia ? '🚨 ' : '🔑 '}${s.nombre}</h2>

    <p class="modal-section-title">Datos del cliente</p>
    <div class="modal-field"><label>Teléfono</label><p>${s.telefono}</p></div>
    <div class="modal-field"><label>Ubicación</label><p>${s.ubicacion}</p></div>
    <div class="modal-field"><label>Servicio</label><p>${TIPO_LABELS[s.tipo_servicio] || s.tipo_servicio}</p></div>
    ${s.notas_adicionales ? `<div class="modal-field"><label>Notas</label><p>${s.notas_adicionales}</p></div>` : ''}

    <p class="modal-section-title">Asignación y estado</p>
    <div class="modal-field">
      <label>Cerrajero asignado</label>
      <select class="modal-select" id="modal-cerrajero-select">
        <option value="">— Sin asignar —</option>
        ${cerrajeroOpts}
      </select>
    </div>
    <div class="modal-field">
      <label>Estado</label>
      <select class="modal-select" id="modal-estado-select">
        <option value="pendiente"  ${s.estado === 'pendiente'  ? 'selected' : ''}>Pendiente</option>
        <option value="en_camino"  ${s.estado === 'en_camino'  ? 'selected' : ''}>En camino</option>
        <option value="completado" ${s.estado === 'completado' ? 'selected' : ''}>Completado</option>
        <option value="cancelado"  ${s.estado === 'cancelado'  ? 'selected' : ''}>Cancelado</option>
      </select>
    </div>

    <p class="modal-section-title">Tiempos</p>
    <div class="modal-field"><label>Registrado</label><p>${formatFecha(s.creado_en)}</p></div>
    <div class="modal-field"><label>Última actualización</label><p>${formatFecha(s.actualizado_en)}</p></div>
    <div class="modal-field"><label>ETA estimado</label><p>${s.tiempo_estimado_minutos} minutos</p></div>

    <div class="modal-actions">
      <button class="btn btn-primary" id="modal-save-btn">Guardar cambios</button>
      <button class="btn btn-ghost" id="modal-cancel-btn">Cerrar</button>
    </div>
  `;

  document.getElementById('modal-overlay').classList.remove('hidden');

  document.getElementById('modal-save-btn').addEventListener('click', async () => {
    const nuevoEstado     = document.getElementById('modal-estado-select').value;
    const nuevoCerrajero  = document.getElementById('modal-cerrajero-select').value;

    if (nuevoEstado !== s.estado) await cambiarEstado(id, nuevoEstado);
    if (nuevoCerrajero && nuevoCerrajero !== s.cerrajero_id) await reasignar(id, nuevoCerrajero);

    cerrarModal();
  });

  document.getElementById('modal-cancel-btn').addEventListener('click', cerrarModal);
}

function cerrarModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  modalServicioId = null;
}

document.getElementById('modal-close').addEventListener('click', cerrarModal);
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) cerrarModal();
});

// ── API calls ─────────────────────────────────────────────────────────────────
async function cambiarEstado(id, estado) {
  try {
    const res = await fetch(`/api/servicios/${id}/estado`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estado })
    });
    const data = await res.json();
    if (data.exito) {
      actualizarServicio(data.servicio);
      showToast(`Estado actualizado: ${estadoLabel(estado)}`, 'success');
    } else {
      showToast(data.mensaje || 'Error al actualizar', 'error');
    }
  } catch (err) {
    showToast('Error de conexión', 'error');
  }
}

async function reasignar(servicioId, cerrajeroId) {
  try {
    const res = await fetch(`/api/servicios/${servicioId}/asignar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cerrajero_id: cerrajeroId })
    });
    const data = await res.json();
    if (data.exito) {
      actualizarServicio(data.servicio);
      showToast('Cerrajero reasignado y notificado por WhatsApp', 'success');
    } else {
      showToast(data.mensaje || 'Error al reasignar', 'error');
    }
  } catch (err) {
    showToast('Error de conexión', 'error');
  }
}

async function toggleCerrajero(id) {
  try {
    const res  = await fetch(`/api/cerrajeros/${id}/disponibilidad`, { method: 'PATCH' });
    const data = await res.json();
    actualizarCerrajero(data);
    showToast(`${data.nombre}: ${data.disponible ? 'Disponible' : 'No disponible'}`, 'info');
  } catch (err) {
    showToast('Error de conexión', 'error');
  }
}

// ── Actualizar estado local ───────────────────────────────────────────────────
function actualizarServicio(servicio) {
  const idx = servicios.findIndex(s => s.id === servicio.id);
  if (idx !== -1) servicios[idx] = servicio;
  else servicios.unshift(servicio);
  actualizarStats();
  renderServicios();
}

function actualizarCerrajero(cerrajero) {
  const idx = cerrajeros.findIndex(c => c.id === cerrajero.id);
  if (idx !== -1) cerrajeros[idx] = cerrajero;
  renderCerrajeros();
}

// ── SSE — tiempo real ─────────────────────────────────────────────────────────
function conectarSSE() {
  const badge = document.getElementById('sse-badge');
  const es    = new EventSource('/api/eventos');

  es.addEventListener('conectado', () => {
    badge.textContent  = '● En vivo';
    badge.className    = 'badge badge-on';
  });

  es.addEventListener('servicio_nuevo', (e) => {
    const s = JSON.parse(e.data);
    servicios.unshift(s);
    actualizarStats();
    renderServicios();
    showToast(`🔑 Nuevo servicio: ${s.nombre}`, 'info');
    // Sonido sutil de notificación
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = s.es_emergencia ? 880 : 660;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch (_) {}
  });

  es.addEventListener('servicio_actualizado', (e) => {
    actualizarServicio(JSON.parse(e.data));
  });

  es.addEventListener('cerrajero_actualizado', (e) => {
    actualizarCerrajero(JSON.parse(e.data));
  });

  es.onerror = () => {
    badge.textContent = '● Sin conexión';
    badge.className   = 'badge badge-off';
    setTimeout(conectarSSE, 3000); // reconectar
  };
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ── Filtros ───────────────────────────────────────────────────────────────────
document.getElementById('search').addEventListener('input', (e) => {
  filtroSearch = e.target.value.trim();
  renderServicios();
});

document.getElementById('filter-estado').addEventListener('change', (e) => {
  filtroEstado = e.target.value;
  renderServicios();
});

// ── Carga inicial ─────────────────────────────────────────────────────────────
async function cargarDatos() {
  try {
    const [resS, resC] = await Promise.all([
      fetch('/api/servicios'),
      fetch('/api/cerrajeros')
    ]);
    const dataS = await resS.json();
    const dataC = await resC.json();
    servicios  = dataS.servicios || [];
    cerrajeros = dataC || [];
    actualizarStats();
    renderServicios();
    renderCerrajeros();
  } catch (err) {
    showToast('Error cargando datos', 'error');
  }
}

// ── Catálogo de servicios ─────────────────────────────────────────────────────
let catalogo = [];
let catalogoEditandoId = null;

async function cargarCatalogo() {
  try {
    const res  = await fetch('/api/catalogo');
    catalogo   = await res.json();
    renderCatalogo();
  } catch {
    showToast('Error cargando catálogo', 'error');
  }
}

function renderCatalogo() {
  const tbody = document.getElementById('catalogo-tbody');
  tbody.innerHTML = '';

  if (catalogo.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="catalogo-empty">No hay servicios en el catálogo.</td></tr>';
    return;
  }

  catalogo.forEach(item => {
    const tr = document.createElement('tr');
    tr.className = item.activo ? '' : 'catalogo-row-inactivo';
    tr.innerHTML = `
      <td class="catalogo-nombre">
        <span class="catalogo-emoji">${item.emoji}</span>
        <span>${item.nombre}</span>
      </td>
      <td class="catalogo-precio">$${Number(item.precio_base).toFixed(2)}</td>
      <td class="catalogo-precio emergencia">$${Number(item.precio_emergencia).toFixed(2)}</td>
      <td>
        <span class="catalogo-badge ${item.activo ? 'activo' : 'inactivo'}">
          ${item.activo ? 'Activo' : 'Inactivo'}
        </span>
      </td>
      <td class="catalogo-actions">
        <button class="btn-icon" title="Editar" data-accion="editar" data-id="${item.id}">✏️</button>
        <button class="btn-icon" title="${item.activo ? 'Desactivar' : 'Activar'}" data-accion="toggle" data-id="${item.id}">
          ${item.activo ? '🔕' : '🔔'}
        </button>
        <button class="btn-icon danger" title="Eliminar" data-accion="eliminar" data-id="${item.id}">🗑️</button>
      </td>
    `;

    tr.querySelectorAll('[data-accion]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const { accion, id } = btn.dataset;
        if (accion === 'editar')   iniciarEdicionCatalogo(id);
        if (accion === 'toggle')   toggleActivoCatalogo(id);
        if (accion === 'eliminar') eliminarCatalogo(id);
      });
    });

    tbody.appendChild(tr);
  });
}

function iniciarEdicionCatalogo(id) {
  const item = catalogo.find(s => s.id === id);
  if (!item) return;
  catalogoEditandoId = id;

  document.getElementById('cat-emoji').value              = item.emoji;
  document.getElementById('cat-nombre').value             = item.nombre;
  document.getElementById('cat-precio-base').value        = item.precio_base;
  document.getElementById('cat-precio-emergencia').value  = item.precio_emergencia;

  document.getElementById('catalogo-form-title').textContent = 'Editar servicio';
  document.getElementById('cat-cancel-btn').style.display    = '';
  document.getElementById('catalogo-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelarEdicionCatalogo() {
  catalogoEditandoId = null;
  document.getElementById('cat-emoji').value             = '';
  document.getElementById('cat-nombre').value            = '';
  document.getElementById('cat-precio-base').value       = '';
  document.getElementById('cat-precio-emergencia').value = '';
  document.getElementById('catalogo-form-title').textContent = 'Agregar servicio';
  document.getElementById('cat-cancel-btn').style.display   = 'none';
}

async function guardarCatalogo() {
  const emoji            = document.getElementById('cat-emoji').value.trim() || '🔑';
  const nombre           = document.getElementById('cat-nombre').value.trim();
  const precio_base      = parseFloat(document.getElementById('cat-precio-base').value);
  const precio_emergencia = parseFloat(document.getElementById('cat-precio-emergencia').value);

  if (!nombre || isNaN(precio_base)) {
    showToast('Completa nombre y precio base', 'error');
    return;
  }

  try {
    let res, data;
    if (catalogoEditandoId) {
      res  = await fetch(`/api/catalogo/${catalogoEditandoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji, nombre, precio_base, precio_emergencia: isNaN(precio_emergencia) ? precio_base : precio_emergencia })
      });
      data = await res.json();
      if (data.exito) {
        const idx = catalogo.findIndex(s => s.id === catalogoEditandoId);
        if (idx !== -1) catalogo[idx] = data.item;
        showToast('Servicio actualizado', 'success');
      }
    } else {
      res  = await fetch('/api/catalogo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji, nombre, precio_base, precio_emergencia: isNaN(precio_emergencia) ? precio_base : precio_emergencia })
      });
      data = await res.json();
      if (data.exito) {
        catalogo.push(data.item);
        showToast('Servicio agregado', 'success');
      }
    }

    if (data.exito) {
      cancelarEdicionCatalogo();
      renderCatalogo();
    } else {
      showToast(data.mensaje || 'Error al guardar', 'error');
    }
  } catch {
    showToast('Error de conexión', 'error');
  }
}

async function toggleActivoCatalogo(id) {
  const item = catalogo.find(s => s.id === id);
  if (!item) return;
  try {
    const res  = await fetch(`/api/catalogo/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activo: !item.activo })
    });
    const data = await res.json();
    if (data.exito) {
      const idx = catalogo.findIndex(s => s.id === id);
      if (idx !== -1) catalogo[idx] = data.item;
      renderCatalogo();
      showToast(`Servicio ${data.item.activo ? 'activado' : 'desactivado'}`, 'info');
    }
  } catch {
    showToast('Error de conexión', 'error');
  }
}

async function eliminarCatalogo(id) {
  const item = catalogo.find(s => s.id === id);
  if (!item) return;
  if (!confirm(`¿Eliminar "${item.nombre}" del catálogo?`)) return;
  try {
    const res  = await fetch(`/api/catalogo/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.exito) {
      catalogo = catalogo.filter(s => s.id !== id);
      renderCatalogo();
      showToast('Servicio eliminado', 'info');
    } else {
      showToast(data.mensaje || 'Error al eliminar', 'error');
    }
  } catch {
    showToast('Error de conexión', 'error');
  }
}

document.getElementById('cat-save-btn').addEventListener('click', guardarCatalogo);
document.getElementById('cat-cancel-btn').addEventListener('click', cancelarEdicionCatalogo);

// ── Init ──────────────────────────────────────────────────────────────────────
cargarDatos();
cargarCatalogo();
conectarSSE();
