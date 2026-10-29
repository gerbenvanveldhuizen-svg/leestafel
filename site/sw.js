/* De Leestafel — offline-opslag. Verhoog VERSIE bij elke wijziging aan de app. */
const VERSIE = "leestafel-v2";
const SHELL = ["./", "index.html", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSIE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSIE && k !== "leestafel-data").map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // afbeeldingen e.d. gewoon via het net

  // Nieuws: eerst het net, anders de bewaarde editie (gemarkeerd als offline).
  if (url.pathname.endsWith("/data/nieuws.json")) {
    e.respondWith((async () => {
      const cache = await caches.open("leestafel-data");
      try {
        const res = await fetch(e.request, { cache: "no-store" });
        if (res.ok) await cache.put("nieuws", res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match("nieuws");
        if (!hit) throw err;
        const headers = new Headers(hit.headers);
        headers.set("X-Leestafel-Cache", "1");
        return new Response(await hit.blob(), { status: 200, headers });
      }
    })());
    return;
  }

  // App zelf: direct uit de opslag, op de achtergrond verversen.
  e.respondWith((async () => {
    const cache = await caches.open(VERSIE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request, { cache: "no-cache" }).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || (await cache.match("index.html"));
  })());
});
