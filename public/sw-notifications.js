const VEHICLE_IMAGE_CACHE = 'fleet-secure-vehicle-images-v1';
const VEHICLE_3D_IMAGE_URLS = [
  '/src/assets/images/sedan_left_3d_1795723683091.jpg',
  '/src/assets/images/sedan_right_3d_1795723683783.jpg',
  '/src/assets/images/vehicle_left_3d_1795721974462.jpg',
  '/src/assets/images/vehicle_right_3d_1795721974156.jpg',
  '/src/assets/images/doublecab_left_3d_1795723685048.jpg',
  '/src/assets/images/doublecab_right_3d_1795723685317.jpg',
  '/src/assets/images/singlecab_left_3d_1795766653871.jpg',
  '/src/assets/images/singlecab_right_3d_1795766654083.jpg',
  '/src/assets/images/kombi_left_3d_1795723686440.jpg',
  '/src/assets/images/kombi_right_3d_1795723686552.jpg',
  '/src/assets/images/hatchback_left_3d_1795766654853.jpg',
  '/src/assets/images/hatchback_right_3d_1795766655296.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VEHICLE_IMAGE_CACHE)
      .then((cache) =>
        Promise.allSettled(
          VEHICLE_3D_IMAGE_URLS.map((url) =>
            cache.match(url).then((existing) => (existing ? null : cache.add(url)))
          )
        )
      )
      .catch(() => undefined)
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let pathname = '';
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return;
  }
  if (!pathname.startsWith('/src/assets/images/')) return;

  event.respondWith(
    caches.open(VEHICLE_IMAGE_CACHE).then((cache) =>
      cache.match(pathname).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((networkRes) => {
          if (networkRes && networkRes.ok) {
            cache.put(pathname, networkRes.clone()).catch(() => undefined);
          }
          return networkRes;
        });
      })
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const notificationId = data.notificationId ?? null;
  const tripId = data.tripId ?? null;
  const targetUrl =
    data.url ||
    (notificationId
      ? `/?section=notifications&notificationId=${notificationId}`
      : '/?section=notifications');

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) {
            try {
              client.postMessage({
                type: 'OPEN_NOTIFICATION',
                notificationId,
                tripId,
                url: targetUrl,
              });
            } catch {
              // Ignore postMessage failure
            }
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
