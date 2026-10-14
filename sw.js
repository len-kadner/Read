const CACHE_NAME = 'read-app-shell-v4';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg?v=4'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(cacheNames => Promise.all(
                cacheNames
                    .filter(cacheName => cacheName.startsWith('read-app-shell-') && cacheName !== CACHE_NAME)
                    .map(cacheName => caches.delete(cacheName))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(response => {
                    if (response.ok) {
                        const copy = response.clone();
                        return caches.open(CACHE_NAME)
                            .then(cache => cache.put('./index.html', copy))
                            .then(() => response);
                    }
                    return response;
                })
                .catch(async () => (await caches.match('./index.html')) || Response.error())
        );
        return;
    }

    if (APP_SHELL.some(path => new URL(path, self.location.href).href === url.href)) {
        event.respondWith(
            caches.match(request).then(cached => cached || fetch(request))
        );
    }
});
