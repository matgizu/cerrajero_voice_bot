// Service worker de la app del dueño: recibe las notificaciones push aunque la
// página esté cerrada y abre la consulta al tocarlas.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { cuerpo: event.data && event.data.text() }; }
  const titulo = d.titulo || 'Tu Cerrajero PR';
  event.waitUntil((async () => {
    await self.registration.showNotification(titulo, {
      body: d.cuerpo || 'Tienes una consulta pendiente',
      icon: '/dueno/icon-192.png',
      badge: '/dueno/icon-192.png',
      tag: d.tag || 'consulta',
      renotify: true,              // vuelve a sonar aunque haya otra igual
      requireInteraction: true,    // se queda en pantalla hasta que la toquen
      // Zumbido largo (Android lo respeta si la vibración está activa para el
      // sitio; iPhone usa su vibración estándar de notificaciones)
      vibrate: [600, 200, 600, 200, 600, 200, 900],
      silent: false,
      data: { url: d.url || '/dueno/' },
    });
    // Si la app está abierta, que recargue la lista al instante
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    abiertas.forEach(c => c.postMessage({ tipo: 'consulta' }));
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dueno/';
  event.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abiertas) {
      if (new URL(c.url).pathname.startsWith('/dueno')) {
        await c.focus();
        c.postMessage({ tipo: 'abrir', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
