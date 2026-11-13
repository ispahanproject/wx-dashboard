// WX Dashboard CORS Proxy — Cloudflare Worker
// Proxies requests to aviationweather.gov & tenki.jp with CORS headers
import { SKYMARK } from "./skymark-timetable.js";

const AWC_BASE = "https://aviationweather.gov";
const TENKI_BASE = "https://static.tenki.jp";
const NOAA_TAF_BASE = "https://tgftp.nws.noaa.gov/data/forecasts/taf/stations";
const TT_SOUNDING_BASE = "https://www.tropicaltidbits.com/analysis/models/sounding/images";

// Allowed API paths (whitelist)
const ALLOWED_PATHS = ["/api/data/taf", "/api/data/metar", "/api/data/isigmet", "/api/data/airsigmet", "/api/data/pirep"];
const TENKI_PREFIX = "/tenki/";
const SOUNDING_PREFIX = "/sounding/";
// 高層観測（ラジオゾンデ実測）: University of Wyoming CSV を中継
const UPPER_AIR_PREFIX = "/upper-air/";
const UWYO_SOUNDING = "https://weather.uwyo.edu/wsgi/sounding";
// 東京 VAAC の火山灰情報（VAA）: 一覧ページから指定した火山の分を拾い、本文を JSON で返す
const VAAC_PREFIX = "/vaac/";
const VAAC_BASE = "https://ds.data.jma.go.jp/svd/vaac/data/";
// 空港の発着便（AeroDataBox の FIDS、RapidAPI 経由）。キーは秘密情報 AERODATABOX_KEY、結果は KV（FLIGHTS）に保存
const FLIGHTS_PREFIX = "/flights/";
const ADB_HOST = "aerodatabox.p.rapidapi.com";
const FLIGHTS_DAILY_LIMIT = 40; // 1日に AeroDataBox を呼ぶ回数の上限（無料枠は月400ユニット＝200回）
// 到着便（FlightAware AeroAPI）。キーは秘密情報 FLIGHTAWARE_KEY。アプリはこちらを使い、使えないときだけ AeroDataBox
const FA_BASE = "https://aeroapi.flightaware.com/aeroapi";
// 1日に FlightAware から取る結果セット（15便で 0.005 ドル）の上限。個人利用の無料分は月5ドル＝1000セット
const FA_DAILY_LIMIT = 30;

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

async function handleUpperAir(url, origin) {
  const id = url.searchParams.get("id") || "";
  const dt = url.searchParams.get("dt") || "";
  if (!/^\d{5}$/.test(id) || !/^\d{8}(00|12)$/.test(dt)) {
    return new Response("Bad id/dt", { status: 400, headers: corsHeaders(origin) });
  }
  // キャッシュキーは Origin に依存しない形にする
  const cacheKey = new Request(`https://upper-air.cache/${id}/${dt}`);
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (!cached) {
    const datetime = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)} ${dt.slice(8, 10)}:00:00`;
    const upstream = `${UWYO_SOUNDING}?datetime=${encodeURIComponent(datetime)}&id=${id}&src=UNKNOWN&type=TEXT:CSV`;
    let resp, body = "";
    // 混雑時 (503) は少し待って再試行
    for (let i = 0; i < 3; i++) {
      resp = await fetch(upstream, { headers: { "User-Agent": "wx-dashboard-proxy/1.0" } });
      body = await resp.text();
      if (resp.status !== 503) break;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    const ok = resp.ok && body.startsWith("time,");
    // 観測から6時間以上経過したデータは確定扱いで長めにキャッシュ
    const obsTime = Date.UTC(+dt.slice(0, 4), +dt.slice(4, 6) - 1, +dt.slice(6, 8), +dt.slice(8, 10));
    const settled = Date.now() - obsTime > 6 * 3600e3;
    const ttl = ok ? (settled ? 86400 : 1800) : 300;
    cached = new Response(ok ? body : (body || "No data"), {
      status: ok ? 200 : (resp.status === 503 ? 503 : 404),
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": `public, max-age=${ttl}` },
    });
    if (resp.status !== 503) await cache.put(cacheKey, cached.clone());
  }
  const headers = new Headers(cached.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(cached.body, { status: cached.status, headers });
}

// ページ本文を Cloudflare のキャッシュ付きで取得（キーは Origin に依存しない）
async function cachedText(key, upstream, ttl) {
  const cache = caches.default;
  const cacheKey = new Request(`https://vaac.cache/${key}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.text();
  const resp = await fetch(upstream, { headers: { "User-Agent": "wx-dashboard-proxy/1.0" } });
  if (!resp.ok) throw new Error(`upstream ${resp.status}`);
  const body = await resp.text();
  await cache.put(cacheKey, new Response(body, { headers: { "Cache-Control": `public, max-age=${ttl}` } }));
  return body;
}

// /vaac/?volcano=SAKURAJIMA,KIRISHIMA&hours=24
// → { items: [{ time, volcano, area, number, text }], latest: { 指定名: { time, volcano, number } } }（latest は期間外も含む最新）
async function handleVaac(url, origin) {
  const names = (url.searchParams.get("volcano") || "").toUpperCase().split(",")
    .map((n) => n.trim()).filter((n) => /^[A-Z][A-Z \-]{2,39}$/.test(n)).slice(0, 5);
  const hours = Math.min(72, Math.max(1, Number(url.searchParams.get("hours")) || 24));
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=120" };
  if (!names.length) return new Response(JSON.stringify({ error: "volcano required" }), { status: 400, headers });
  try {
    const list = await cachedText("list", `${VAAC_BASE}vaac_list.html`, 300);
    const items = [];
    const latest = {};
    for (const m of list.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const row = m[1];
      const link = (row.match(/href="(TextData\/\d{4}\/\w+_Text\.html)"/) || [])[1];
      if (!link) continue;
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
      const t = (cells[0] || "").match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
      const volcano = cells[2] || "";
      const name = t && names.find((n) => volcano.toUpperCase().includes(n));
      if (!name) continue;
      const time = Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5]);
      const item = { time: new Date(time).toISOString(), volcano, area: cells[3] || "", number: cells[4] || "", link };
      if (!latest[name]) latest[name] = { time: item.time, volcano, number: item.number };
      if (Date.now() - time <= hours * 3600e3 && items.length < 6) items.push(item);
    }
    for (const it of items) {
      try {
        const html = await cachedText(it.link, VAAC_BASE + it.link, 86400);
        const body = html.match(/<!-- VAA Text Start -->([\s\S]*?)<!-- VAA Text End -->/);
        it.text = body ? body[1].replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim() : null;
      } catch { it.text = null; }
      delete it.link;
    }
    return new Response(JSON.stringify({ items, latest }), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers });
  }
}

// /flights/?icao=RJFK&from=2026-11-12T07:00&to=2026-11-12T17:00（日本の空港のみ・現地時刻＝JST・最大12時間）
// → { icao, from, to, fetchedAt, usedToday, flights: [{ dir: "ARR"|"DEP", number, airline, other, otherIcao, otherSched, otherRevised, otherRunway, sched, revised, runway, status, model, reg, cargo }] }
// &fresh=1 で、保存から5分たった結果を取り直す。/flights/coverage?icao= は空港ごとのデータの範囲
// 時刻は UTC の ISO 文字列。回数に上限のある API なので、時間帯を30分単位に丸めて KV に保存し、呼び出し元と1日の回数も絞る
async function handleFlights(url, origin, env) {
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, max-age=300" };
  const fail = (error, status) => new Response(JSON.stringify({ error }), { status, headers });
  if (!ALLOWED_ORIGINS.includes(origin)) return fail("origin", 403);
  if (url.pathname.startsWith("/flights/fa")) return handleFlightsFA(url, env, headers, fail);
  if (!env?.AERODATABOX_KEY) return fail("no-key", 503);
  // 空港ごとのデータの範囲（時刻表のみか、リアルタイムの更新もあるか）。AeroDataBox では無料の問い合わせ
  if (url.pathname === "/flights/coverage") {
    const ap = (url.searchParams.get("icao") || "").toUpperCase();
    if (!/^R[JO][A-Z]{2}$/.test(ap)) return fail("icao", 400);
    const ck = `coverage/${ap}`;
    const hit = env.FLIGHTS ? await env.FLIGHTS.get(ck) : null;
    if (hit) return new Response(hit, { headers });
    const r = await fetch(`https://${ADB_HOST}/health/services/airports/${ap}/feeds`, {
      headers: { "X-RapidAPI-Key": env.AERODATABOX_KEY, "X-RapidAPI-Host": ADB_HOST },
    }).catch(() => null);
    if (!r || !r.ok) return fail(`upstream ${r ? r.status : "fetch"}`, 502);
    const body = await r.text();
    if (env.FLIGHTS) await env.FLIGHTS.put(ck, body, { expirationTtl: 86400 });
    return new Response(body, { headers });
  }
  const w = flightsWindow(url);
  if (w.error) return fail(w.error, 400);
  const { icao, from, to, nowLocal, fmt } = w;

  const kv = env.FLIGHTS;
  const key = `fids/${icao}/${fmt(from)}/${fmt(to)}`;
  const dayKey = `count/${fmt(nowLocal).slice(0, 10)}`;
  const used = kv ? Number(await kv.get(dayKey)) || 0 : 0;
  if (kv) {
    const hit = await kv.get(key);
    // fresh=1（「更新」）は、保存から5分たっていれば取り直す
    const age = hit ? Date.now() - Date.parse((hit.match(/"fetchedAt":"([^"]+)"/) || [])[1] || 0) : Infinity;
    const wantFresh = url.searchParams.get("fresh") === "1" && age > 5 * 60e3;
    if (hit && !wantFresh) return new Response(hit.replace('"usedToday":0', `"usedToday":${used}`), { headers });
  }
  if (used >= FLIGHTS_DAILY_LIMIT) return fail("daily-limit", 429);

  const q = "withLeg=true&direction=Both&withCancelled=true&withCodeshared=false&withCargo=true&withPrivate=false&withLocation=false";
  let resp;
  try {
    resp = await fetch(`https://${ADB_HOST}/flights/airports/icao/${icao}/${fmt(from)}/${fmt(to)}?${q}`, {
      headers: { "X-RapidAPI-Key": env.AERODATABOX_KEY, "X-RapidAPI-Host": ADB_HOST },
    });
  } catch (err) {
    return fail(`upstream: ${err.message}`, 502);
  }
  if (kv) await kv.put(dayKey, String(used + 1), { expirationTtl: 3 * 86400 });
  if (resp.status !== 200 && resp.status !== 204) {
    // RapidAPI のメッセージ（未契約・キー違い・回数超過など）を短く添える
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    const error = resp.status === 401 || resp.status === 403 ? "key" : resp.status === 429 ? "quota" : `upstream ${resp.status}`;
    return new Response(JSON.stringify({ error, status: resp.status, detail }), { status: resp.status === 429 ? 429 : 502, headers });
  }
  const data = resp.status === 204 ? {} : await resp.json().catch(() => ({}));

  // 時刻は { utc: "2026-11-12 05:35Z", local: … }（古い形式は scheduledTimeUtc など）
  const iso = (m, k) => {
    const s = m?.[`${k}Time`]?.utc || m?.[`${k}TimeUtc`] || null;
    const d = s ? new Date(s.replace(" ", "T")) : null;
    return d && !isNaN(d) ? d.toISOString() : null;
  };
  const norm = (f, dir) => {
    const here = dir === "ARR" ? f.arrival : f.departure;
    const there = dir === "ARR" ? f.departure : f.arrival;
    return {
      dir,
      number: f.number || "",
      airline: f.airline?.iata || f.airline?.icao || "",
      other: there?.airport?.iata || there?.airport?.icao || "",
      otherIcao: there?.airport?.icao || "",
      otherSched: iso(there, "scheduled"),
      // 相手の空港での見込み・実際の時刻（到着空港にリアルタイムの更新がないときの手がかり）
      otherRevised: iso(there, "revised") || iso(there, "actual"),
      otherRunway: iso(there, "runway"),
      sched: iso(here, "scheduled"),
      revised: iso(here, "revised") || iso(here, "actual"),
      runway: iso(here, "runway"),
      status: f.status || "Unknown",
      model: f.aircraft?.model || "",
      reg: f.aircraft?.reg || "",
      cargo: !!f.isCargo,
    };
  };
  const flights = [
    ...(data.arrivals || []).map((f) => norm(f, "ARR")),
    ...(data.departures || []).map((f) => norm(f, "DEP")),
  ].filter((f) => f.sched).sort((a, b) => a.sched.localeCompare(b.sched));

  const body = JSON.stringify({ icao, from: fmt(from), to: fmt(to), fetchedAt: new Date().toISOString(), usedToday: 0, flights });
  // 今から3時間以内にかかる時間帯は15分、それ以外は1時間で取り直す
  const near = from < nowLocal + 3 * 3600e3 && to > nowLocal;
  if (kv) await kv.put(key, body, { expirationTtl: near ? 900 : 3600 });
  return new Response(body.replace('"usedToday":0', `"usedToday":${used + 1}`), { headers });
}

// 発着便の問い合わせの空港と時間帯。現地時刻（JST）を30分単位に丸め、最大12時間・2日前〜3日後まで
function flightsWindow(url) {
  const icao = (url.searchParams.get("icao") || "").toUpperCase();
  if (!/^R[JO][A-Z]{2}$/.test(icao)) return { error: "icao" };
  const toMs = (s) => {
    const m = (s || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
  };
  const STEP = 30 * 60e3;
  const from = Math.floor(toMs(url.searchParams.get("from")) / STEP) * STEP;
  const to = Math.ceil(toMs(url.searchParams.get("to")) / STEP) * STEP;
  const nowLocal = Date.now() + 9 * 3600e3;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 12 * 3600e3) return { error: "range" };
  if (from < nowLocal - 2 * 86400e3 || to > nowLocal + 3 * 86400e3) return { error: "date" };
  return { icao, from, to, nowLocal, fmt: (t) => new Date(t).toISOString().slice(0, 16) };
}

// /flights/fa?icao=RJFK&from=2026-11-14T06:30&to=2026-11-14T10:30 → /flights/ と同じ形（到着便だけ）
// FlightAware AeroAPI：まだ着いていない便は scheduled_arrivals（estimated_on で絞る）、着いた便は arrivals（actual_on で絞る）。
// 15便ごとに料金がかかるので、KV に保存して使い回し、1日に取る量も絞る
async function handleFlightsFA(url, env, headers, fail) {
  if (!env?.FLIGHTAWARE_KEY) return fail("no-key", 503);
  const w = flightsWindow(url);
  if (w.error) return fail(w.error, 400);
  const { icao, from, to, nowLocal, fmt } = w;

  const kv = env.FLIGHTS;
  const key = `fa2/${icao}/${fmt(from)}/${fmt(to)}`;
  const dayKey = `fa-count/${fmt(nowLocal).slice(0, 10)}`;
  const used = kv ? Number(await kv.get(dayKey)) || 0 : 0;
  if (kv) {
    const hit = await kv.get(key);
    // fresh=1（「更新」）は、保存から5分たっていれば取り直す
    const age = hit ? Date.now() - Date.parse((hit.match(/"fetchedAt":"([^"]+)"/) || [])[1] || 0) : Infinity;
    const wantFresh = url.searchParams.get("fresh") === "1" && age > 5 * 60e3;
    if (hit && !wantFresh) return new Response(hit.replace('"usedToday":0', `"usedToday":${used}`), { headers });
  }
  if (used >= FA_DAILY_LIMIT) return fail("daily-limit", 429);

  // 現地時刻（JST）→ UTC。scheduled_arrivals は2日先までしか取れない
  const now = Date.now();
  const start = from - 9 * 3600e3;
  const end = Math.min(to - 9 * 3600e3, now + 2 * 86400e3);
  const z = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const parts = [];
  if (end > now) parts.push(["scheduled_arrivals", start, end]); // まだ着いていない便
  if (start < now) parts.push(["arrivals", start, Math.min(end, now)]); // もう着いた便
  const byId = new Map();
  let pages = 0;
  for (const [kind, a, b] of parts) {
    let resp;
    try {
      resp = await fetch(`${FA_BASE}/airports/${icao}/flights/${kind}?type=Airline&max_pages=2&start=${z(a)}&end=${z(b)}`, {
        headers: { "x-apikey": env.FLIGHTAWARE_KEY, Accept: "application/json" },
      });
    } catch (err) {
      return fail(`upstream: ${err.message}`, 502);
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => "")).slice(0, 200);
      const error = resp.status === 401 || resp.status === 403 ? "key" : resp.status === 429 ? "rate" : `upstream ${resp.status}`;
      if (kv && pages) await kv.put(dayKey, String(used + pages), { expirationTtl: 3 * 86400 });
      return new Response(JSON.stringify({ error, status: resp.status, detail }), { status: resp.status === 429 ? 429 : 502, headers });
    }
    const data = await resp.json().catch(() => ({}));
    pages += data.num_pages || 1;
    for (const f of data[kind] || []) {
      // 位置だけで追った便（出発地がわからない。時刻表の便と二重になることがある）は出さない
      if (f.position_only || !(f.origin?.code_iata || f.origin?.code_icao)) continue;
      byId.set(f.fa_flight_id || `${f.ident}/${f.scheduled_in}`, f);
    }
  }
  if (kv) await kv.put(dayKey, String(used + pages), { expirationTtl: 3 * 86400 });

  // 便名は「JL 641」の形に。子会社の運航便（EH 541、JC 3760 など）は、同じ番号の販売便名（NH 541、JL 3760）で出す
  const number = (f) => {
    const same = (f.codeshares_iata || []).find((c) => f.flight_number && c.slice(2) === String(f.flight_number));
    if (same) return `${same.slice(0, 2)} ${same.slice(2)}`;
    if (f.operator_iata && f.flight_number) return `${f.operator_iata} ${f.flight_number}`;
    const m = (f.ident_iata || f.ident || "").match(/^([A-Z0-9]{2,3}?)(\d+[A-Z]?)$/);
    return m ? `${m[1]} ${m[2]}` : f.ident_iata || f.ident || "";
  };
  const normalized = [...byId.values()].map((f) => ({
    dir: "ARR",
    number: number(f),
    airline: f.operator_iata || f.operator_icao || "",
    other: f.origin?.code_iata || f.origin?.code_icao || "",
    otherIcao: f.origin?.code_icao || "",
    otherSched: f.scheduled_out || f.scheduled_off || null,
    otherRevised: f.actual_out || f.estimated_out || null,
    otherRunway: f.actual_off || null,
    sched: f.scheduled_in || f.scheduled_on || null,
    revised: f.actual_in || f.estimated_in || null,
    runway: f.actual_on || null,
    status: f.cancelled ? "Canceled" : f.diverted ? "Diverted" : f.actual_in || f.actual_on ? "Arrived" : f.actual_off ? "EnRoute" : "Expected",
    model: (f.aircraft_type || "").trim(),
    reg: (f.registration || "").trim(),
    cargo: false,
  })).filter((f) => f.sched);
  const { flights, skymark } = mergeSkymark(icao, from, to, normalized);

  const body = JSON.stringify({ icao, from: fmt(from), to: fmt(to), source: "flightaware", skymark, limit: FA_DAILY_LIMIT, fetchedAt: new Date().toISOString(), usedToday: 0, flights });
  // 今から3時間以内にかかる時間帯は15分、それ以外は1時間で取り直す
  const near = from < nowLocal + 3 * 3600e3 && to > nowLocal;
  if (kv) await kv.put(key, body, { expirationTtl: near ? 900 : 3600 });
  return new Response(body.replace('"usedToday":0', `"usedToday":${used + pages}`), { headers });
}

// Skymark は IATA に入っておらず、FlightAware の時刻表に抜けや誤り（BC 635 の定刻が 23:59 など）がある。
// Skymark の時刻表（skymark-timetable.js）で、Skymark の便の定刻を直し、FlightAware にない便を足す。
// from・to は現地時刻（JST）の時間帯、flights の時刻は UTC
function mergeSkymark(icao, from, to, flights) {
  const DAY = 86400e3, JST = 9 * 3600e3, H = 3600e3;
  const entries = SKYMARK.flights.filter((e) => e.toIcao === icao);
  if (!entries.length) return { flights: flights.sort((a, b) => a.sched.localeCompare(b.sched)), skymark: null };
  const validFrom = Date.parse(`${SKYMARK.valid[0]}T00:00:00Z`);
  const validTo = Date.parse(`${SKYMARK.valid[1]}T00:00:00Z`) + DAY;
  const hm = (s) => (+s.slice(0, 2) * 60 + +s.slice(3)) * 60e3;
  // 時間帯の前後1日に飛ぶ便（運休日・この日だけ・この曜日だけを見る。日付は日本時間の出発日）
  const plan = [];
  for (let day = Math.floor(from / DAY) * DAY - DAY; day <= to + DAY; day += DAY) {
    for (const e of entries) {
      const arr = day + hm(e.arr);
      const dep = day + hm(e.dep) - (hm(e.dep) > hm(e.arr) ? DAY : 0);
      const depDay = Math.floor(dep / DAY) * DAY;
      const date = new Date(depDay).toISOString().slice(0, 10);
      if (depDay < validFrom || depDay >= validTo) continue;
      if (e.off?.includes(date) || (e.only && !e.only.includes(date)) || (e.dow && !e.dow.includes(new Date(depDay).getUTCDay()))) continue;
      plan.push({ e, arr: arr - JST, dep: dep - JST });
    }
  }
  const digits = (n) => (String(n).match(/\d+/) || [""])[0].replace(/^0+/, "");
  const used = new Set();
  const out = [];
  for (const f of flights) {
    if (f.airline !== "BC") { out.push(f); continue; }
    // 見込み・実際の時刻（なければ定刻）が近い、同じ番号の時刻表の便に合わせる
    const t = Date.parse(f.runway || f.revised || f.sched);
    const same = plan.filter((p) => p.e.no === digits(f.number));
    const m = same.filter((p) => !used.has(p) && Math.abs(p.arr - t) < 4 * H).sort((a, b) => Math.abs(a.arr - t) - Math.abs(b.arr - t))[0];
    if (m) {
      used.add(m);
      out.push({ ...f, number: `BC ${m.e.no}`, other: m.e.from, sched: new Date(m.arr).toISOString(), otherSched: new Date(m.dep).toISOString(), timetable: true });
    } else if (!same.length) {
      out.push(f); // 時刻表にない便（臨時便など）はそのまま
    }
    // 同じ番号が時刻表にあるのに時刻がかけ離れた便は、FlightAware の壊れた予定なので出さない
  }
  // FlightAware にまだない便（前もって見るときなど）を、時刻表から足す
  for (const p of plan) {
    if (used.has(p) || p.arr + JST < from || p.arr + JST >= to) continue;
    out.push({
      dir: "ARR", number: `BC ${p.e.no}`, airline: "BC", other: p.e.from, otherIcao: "",
      otherSched: new Date(p.dep).toISOString(), otherRevised: null, otherRunway: null,
      sched: new Date(p.arr).toISOString(), revised: null, runway: null,
      status: "Expected", model: "", reg: "", cargo: false, timetable: true, timetableOnly: true,
    });
  }
  return { flights: out.sort((a, b) => a.sched.localeCompare(b.sched)), skymark: { until: SKYMARK.valid[1], expired: to > validTo } };
}

export default {
  async fetch(request, env) {
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

    if (path.startsWith(UPPER_AIR_PREFIX)) {
      // /upper-air/?id=47646&dt=2026110512  (dt = YYYYMMDDHH, HH は 00 or 12)
      return handleUpperAir(url, origin);
    }
    if (path.startsWith(VAAC_PREFIX)) {
      return handleVaac(url, origin);
    }
    if (path.startsWith(FLIGHTS_PREFIX)) {
      return handleFlights(url, origin, env);
    }

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
