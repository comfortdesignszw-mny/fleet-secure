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
