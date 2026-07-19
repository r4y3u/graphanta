const CACHE = 'graphanta-runtime-v1';
const ROOT = new URL('./', self.registration.scope).toString();

async function precacheAppShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch(ROOT, { cache: 'reload' });
  if (!response.ok) return;
  const html = await response.clone().text();
  await cache.put(ROOT, response);

  const paths = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => !path.startsWith('data:') && !path.startsWith('#'));
  const urls = [...new Set(paths.map((path) => new URL(path, ROOT).toString()))];
  await Promise.all(urls.map(async (url) => {
    try {
      const asset = await fetch(url, { cache: 'reload' });
      if (asset.ok) await cache.put(url, asset);
    } catch {
      // 個別資産の失敗でインストール全体を止めない。
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().finally(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetched = fetch(event.request)
        .then((response) => {
          if (response.ok && new URL(event.request.url).origin === self.location.origin) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(async () => {
          if (event.request.mode === 'navigate') return (await caches.match(ROOT)) || cached;
          return cached;
        });
      return cached || fetched;
    })
  );
});
