// WX Dashboard CORS Proxy — Cloudflare Worker
// Proxies requests to aviationweather.gov & tenki.jp with CORS headers

const AWC_BASE = "https://aviationweather.gov";
const TENKI_BASE = "https://static.tenki.jp";

// Allowed API paths (whitelist)
const ALLOWED_PATHS = ["/api/data/taf", "/api/data/metar", "/api/data/isigmet", "/api/data/airsigmet", "/api/data/pirep"];
const TENKI_PREFIX = "/tenki/";

// Allowed origins (restrict to our dashboard)
const ALLOWED_ORIGINS = [
  "https://ispahanproject.github.io",
  "http://localhost:5173",  // Vite dev
  "http://localhost:4173",  // Vite preview
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

    if (path.startsWith(TENKI_PREFIX)) {
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
        headers: {
          "User-Agent": "Mozilla/5.0 wx-dashboard-proxy/1.0",
        },
      });

      // Clone response with CORS headers
      const headers = new Headers(resp.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) {
        headers.set(k, v);
      }
      // Cache for 3 minutes (matches AWC cache-control)
      headers.set("Cache-Control", "public, max-age=180");

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
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
