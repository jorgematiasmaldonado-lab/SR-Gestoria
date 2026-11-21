/* SR Gestoría · SR Caja · funcionamiento sin señal */
const CACHE = 'sr-caja-v4';
const PROPIOS = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const CDN = [
  "https://cdn.tailwindcss.com/3.4.16",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/dist/umd/supabase.min.js"
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await c.addAll(PROPIOS);
    await Promise.all(CDN.map((u) => fetch(u, { mode: 'no-cors' }).then((r) => c.put(u, r)).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('sr-caja-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.hostname.endsWith('supabase.co')) return;   // la base de datos nunca se guarda en caché
  if (req.mode === 'navigate' || url.pathname.endsWith('/index.html')) {        // la página: primero internet (4 s), si no la copia guardada
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
        const r = await fetch(req, { signal: ctl.signal }); clearTimeout(t);
        if (r.ok) c.put('./index.html', r.clone());
        return r;
      } catch (err) { return (await c.match('./index.html')) || (await c.match('./')) || Response.error(); }
    })());
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {   // librerías e íconos: primero la copia guardada
    if (r.ok || r.type === 'opaque') caches.open(CACHE).then((c) => c.put(req, r.clone()));
    return r;
  })));
});
