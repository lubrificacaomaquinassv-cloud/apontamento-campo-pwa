const CACHE_NAME = "campo-sv-v16";
const ASSETS = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/storage.js",
  "./js/api.js",
  "./js/app.js",
  "./config.js",
  "./manifest.json",
  "./icons/logo-placa-sv.png",
  "./icons/logo-sv.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin.includes("supabase.co")) return;
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request);
      try {
        const res = await fetch(e.request);
        if (res.ok) {
          const clone = res.clone();
          const c = await caches.open(CACHE_NAME);
          await c.put(e.request, clone);
        }
        return res;
      } catch (_err) {
        if (cached) return cached;
        if (e.request.mode === "navigate") {
          const home = await caches.match("./index.html");
          if (home) return home;
        }
        throw _err;
      }
    })()
  );
});
