const CACHE_NAME = "campo-sv-v21";
const ASSETS = [
  "./",
  "./index.html",
  "./offline.html",
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

async function cacheAddAllSafe(cache) {
  for (const url of ASSETS) {
    try {
      await cache.add(new Request(url, { cache: "reload" }));
    } catch (err) {
      console.warn("[SW] cache skip", url, err);
    }
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => cacheAddAllSafe(c)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isAppRequest(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.includes("/rest/v1")) return false;
  return true;
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.hostname.includes("supabase.co")) return;
  if (!isAppRequest(url)) return;

  if (e.request.mode === "navigate") {
    e.respondWith(
      (async () => {
        const cached =
          (await caches.match("./index.html")) || (await caches.match("/index.html"));
        if (cached) {
          fetch(e.request)
            .then((res) => {
              if (res.ok) caches.open(CACHE_NAME).then((c) => c.put("./index.html", res.clone()));
            })
            .catch(() => {});
          return cached;
        }
        try {
          const res = await fetch(e.request);
          if (res.ok) {
            const c = await caches.open(CACHE_NAME);
            await c.put("./index.html", res.clone());
          }
          return res;
        } catch (_err) {
          const off = await caches.match("./offline.html");
          if (off) return off;
          return new Response(
            "Sem conexão — abra o app com sinal uma vez para gravar no aparelho.",
            { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
          );
        }
      })()
    );
    return;
  }

  // App shell: cache primeiro (pátio sem sinal não trava em fetch)
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      try {
        const res = await fetch(e.request);
        if (res.ok) {
          const c = await caches.open(CACHE_NAME);
          await c.put(e.request, res.clone());
        }
        return res;
      } catch (_err) {
        const fallback = await caches.match(e.request);
        if (fallback) return fallback;
        if (e.request.url.includes("config.js")) {
          return new Response(
            'window.SV_CONFIG=window.SV_CONFIG||{SUPABASE_URL:"",SUPABASE_ANON_KEY:""};',
            { headers: { "Content-Type": "application/javascript" } }
          );
        }
        throw _err;
      }
    })()
  );
});
