/* Soma push-notification service worker. Scope: whole origin (registered from /). */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Soma', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Soma reminder';
  const options = {
    body: data.body || '',
    tag: data.tag || 'soma-reminder',
    icon: '/assets/icon.png',
    badge: '/assets/icon.png',
    // Keep the notification on screen until the user acts on it (supported on
    // Android/desktop; iOS ignores the flag but still holds it in Notification
    // Center until swiped). renotify re-alerts if an updated push reuses the tag.
    requireInteraction: true,
    renotify: true,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
