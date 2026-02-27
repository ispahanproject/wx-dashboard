// PRE-FLIGHT WX BRIEFING — Service Worker
// Temporary weather data cache for offline inflight use
// Does NOT cache app shell — app always fetches latest version

const CACHE_NAME = "wx-preflight-data";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Fetch: network first, fallback to cache (weather data only)
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);
  const isCacheable =
    url.hostname === "metar.vatsim.net" ||
    url.hostname === "aviationweather.gov" ||
    url.hostname === "api.allorigins.win" ||
    url.hostname === "www.data.jma.go.jp" ||
    url.hostname === "www.jma.go.jp";

  if (!isCacheable) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Preflight cache: bulk download weather data
self.addEventListener("message", (e) => {
  if (e.data?.type === "PREFLIGHT_CACHE") {
    const urls = e.data.urls || [];
    e.waitUntil(
      caches.open(CACHE_NAME).then(async (cache) => {
        let cached = 0, failed = 0;
        for (const url of urls) {
          try {
            const res = await fetch(url, { mode: "cors" });
            if (res.ok) { await cache.put(url, res); cached++; }
            else failed++;
          } catch { failed++; }
        }
        const clients = await self.clients.matchAll();
        clients.forEach((c) => c.postMessage({
          type: "PREFLIGHT_CACHE_DONE", cached, failed, total: urls.length,
          timestamp: new Date().toISOString(),
        }));
      })
    );
  }

  // Clear all cached data
  if (e.data?.type === "CLEAR_CACHE") {
    e.waitUntil(
      caches.delete(CACHE_NAME).then(() => {
        self.clients.matchAll().then((clients) =>
          clients.forEach((c) => c.postMessage({ type: "CACHE_CLEARED" }))
        );
      })
    );
  }
});
