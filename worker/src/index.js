// WX Dashboard CORS Proxy — Cloudflare Worker
// Proxies requests to aviationweather.gov & tenki.jp with CORS headers

const AWC_BASE = "https://aviationweather.gov";
const TENKI_BASE = "https://static.tenki.jp";
const NOAA_TAF_BASE = "https://tgftp.nws.noaa.gov/data/forecasts/taf/stations";
const TT_SOUNDING_BASE = "https://www.tropicaltidbits.com/analysis/models/sounding/images";

// Allowed API paths (whitelist)
const ALLOWED_PATHS = ["/api/data/taf", "/api/data/metar", "/api/data/isigmet", "/api/data/airsigmet", "/api/data/pirep"];
const TENKI_PREFIX = "/tenki/";
const SOUNDING_PREFIX = "/sounding/";

// Allowed origins (restrict to our dashboard)
const ALLOWED_ORIGINS = [
  "https://ispahanproject.github.io",
  "http://localhost:5173",  // Vite dev
  "http://localhost:4173",  // Vite preview
  "http://localhost:5175",  // Vite dev alt
];

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only allow GET
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    // Validate path & route
    const path = url.pathname;
    let upstreamUrl;

    if (path.startsWith(SOUNDING_PREFIX)) {
      // Tropical Tidbits sounding proxy: /sounding/?lat=33.58&lon=130.45&fh=12
      // Fetches the page, extracts the image URL, then fetches and returns the image
      const lat = url.searchParams.get("lat");
      const lon = url.searchParams.get("lon");
      const fh = url.searchParams.get("fh") || "12";
      const icao = url.searchParams.get("icao");
      if (!lat && !icao) {
        return new Response("Missing lat/lon or icao param", { status: 400, headers: corsHeaders(origin) });
      }
      // Build Tropical Tidbits page URL
      const ttParams = new URLSearchParams({ fh, model: "gfs" });
      if (icao) ttParams.set("stationID", icao);
      else { ttParams.set("lat", lat); ttParams.set("lon", lon); }
      const pageUrl = `https://www.tropicaltidbits.com/analysis/models/sounding/?${ttParams}`;
      try {
        const pageResp = await fetch(pageUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "text/html",
          },
        });
        const html = await pageResp.text();
        const imgMatch = html.match(/src="(images\/gfs_[^"]+\.png)"/) || html.match(/(images\/gfs_[^"'\s]+\.png)/);
        if (!imgMatch) {
          return new Response(`Sounding not available (page status: ${pageResp.status}, len: ${html.length})`, { status: 404, headers: corsHeaders(origin) });
        }
        const imgUrl = `https://www.tropicaltidbits.com/analysis/models/sounding/${imgMatch[1]}`;
        const imgResp = await fetch(imgUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Referer": pageUrl,
          },
        });
        if (!imgResp.ok) {
          return new Response("Sounding image fetch failed", { status: imgResp.status, headers: corsHeaders(origin) });
        }
        const imgHeaders = new Headers();
        imgHeaders.set("Content-Type", "image/png");
        for (const [k, v] of Object.entries(corsHeaders(origin))) imgHeaders.set(k, v);
        imgHeaders.set("Cache-Control", "public, max-age=900");
        return new Response(imgResp.body, { status: 200, headers: imgHeaders });
      } catch (err) {
        return new Response(`Sounding error: ${err.message}`, { status: 502, headers: corsHeaders(origin) });
      }
    } else if (path.startsWith(TENKI_PREFIX)) {
      // tenki.jp pollen API: /tenki/static-api/history/pollen/13101.js
      const tenkiPath = "/" + path.slice(TENKI_PREFIX.length);
      if (!tenkiPath.startsWith("/static-api/history/pollen/")) {
        return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
      }
      upstreamUrl = TENKI_BASE + tenkiPath;
    } else if (ALLOWED_PATHS.some(p => path === p || path.startsWith(p + "/"))) {
      upstreamUrl = AWC_BASE + path + url.search;
    } else {
      return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
    }

    try {
      const resp = await fetch(upstreamUrl, {
        headers: { "User-Agent": "Mozilla/5.0 wx-dashboard-proxy/1.0" },
      });

      // TAF fallback: AWCが空の場合、NOAA TGFtpを試す
      const isTafReq = path === "/api/data/taf";
      let body = await resp.text();

      if (isTafReq && !body.trim()) {
        const icao = url.searchParams.get("ids");
        if (icao && /^[A-Z]{4}$/.test(icao)) {
          try {
            const noaaResp = await fetch(`${NOAA_TAF_BASE}/${icao}.TXT`, {
              headers: { "User-Agent": "Mozilla/5.0 wx-dashboard-proxy/1.0" },
              redirect: "follow",
            });
            if (noaaResp.ok) {
              const noaaText = await noaaResp.text();
              // NOAA形式: 1行目=timestamp, 2行目以降=TAF本文
              const tafMatch = noaaText.match(/^(TAF\s.+)/ms);
              if (tafMatch) body = tafMatch[1].trim();
            }
          } catch { /* NOAA unavailable, return empty */ }
        }
      }

      // Clone response with CORS headers
      const headers = new Headers();
      headers.set("Content-Type", "text/plain; charset=utf-8");
      for (const [k, v] of Object.entries(corsHeaders(origin))) {
        headers.set(k, v);
      }
      // Cache for 3 minutes (matches AWC cache-control)
      headers.set("Cache-Control", "public, max-age=180");

      return new Response(body, {
        status: body.trim() ? 200 : 204,
        headers,
      });
    } catch (err) {
      return new Response(`Upstream error: ${err.message}`, {
        status: 502,
        headers: corsHeaders(origin),
      });
    }
  },
};
