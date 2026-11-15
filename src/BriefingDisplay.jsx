/* ============================================================
   PRIMARY SURVEILLANCE DISPLAY（トップの枠）
   流れ：① 今日の概況（全体像を目で見る）→ ② DUTY の空港（PFD）。乗務がない日は ② で空港を選ぶ
   ① ひまわり（昼はトゥルーカラー、夜は赤外）を主役に、地上天気図・国内悪天予想図・水蒸気、
      天気概況（気象庁の文章）、SIGMET、DUTY の空港（乗務がない日は主要空港）の METAR
   ② 操縦席の PFD に見立てた配置で、電文と数値をそのまま並べる（図は描かない）
      上：注意すべき電文の語句 / 左：地上風（TAF の予報・今と過去の METAR）/ 中央：METAR・TAF の電文
      右：上空の風と気温（Open-Meteo の気圧面の値）/ 下：QNH・滑走路ごとの風の成分・SIGMET
   画像は気象庁のものをそのまま使う。乗務の区間・時刻は DUTY で読み込んだ ICS から（WeatherBriefing から渡す）
   ============================================================ */
import { useState, useEffect, useMemo } from "react";
import { PanelFrame } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import { TileMap, COASTLINE, WORKER_URL, FBJP_URL, lon2px, lat2px } from "./DomesticWxPanel.jsx";
import { ChartViewer, DIM_FILTER, useDimPref } from "./ChartsGallery.jsx";

const JMA = "https://www.jma.go.jp";
const SAT = `${JMA}/bosai/himawari/data/satimg`;
const SAT_FD_TIMES = `${SAT}/targetTimes_fd.json`; // 全球の観測（10分毎）。日本付近を欠けなく覆う
const WM_LIST = `${JMA}/bosai/weather_map/data/list.json`;
const WM_PNG = `${JMA}/bosai/weather_map/data/png/`;
const overviewUrl = (code) => `${JMA}/bosai/forecast/data/overview_forecast/${code}.json`;
const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

const HERO_REGION = { w: 121, e: 151, n: 46.5, s: 26, z: 5 };
const THUMB_REGION = { w: 121, e: 151, n: 46.5, s: 26, z: 4 };
// 主役の枠の縦横比（ひまわりの範囲と同じ。天気図に切り替えても枠の大きさを変えない）
const HERO_ASPECT = (lon2px(HERO_REGION.e, HERO_REGION.z) - lon2px(HERO_REGION.w, HERO_REGION.z))
  / (lat2px(HERO_REGION.s, HERO_REGION.z) - lat2px(HERO_REGION.n, HERO_REGION.z));
const BANDS = [
  { key: "REP/ETC", label: "トゥルーカラー" },
  { key: "B13/TBB", label: "赤外" },
  { key: "B08/TBB", label: "水蒸気" },
];
const DEFAULT_AIRPORTS = ["RJTT", "RJCC", "RJCH", "RJBB", "RJFF", "ROAH"];
const BASE_ICAO = "RJTT"; // 拠点（乗務がない日の天気概況）
const REFRESH_MS = 5 * 60e3;
const PREF = {
  collapsed: "psd_collapsed", airports: "psd_airports", fl: "psd_fl", rwy: "psd_rwy", xw: "psd_xw_limit", tw: "psd_tw_limit",
};
// 注意（琥珀色）の目安：ガスト 25kt 以上か平均 20kt 以上・視程 1600m 未満・雲底 1000ft 未満・VWS 6kt/1000ft 以上
const LIMIT = { gust: 25, wind: 20, vis: 1600, ceil: 1000, vws: 6, jet: 80 };

// 空港 → 気象庁の天気概況の地域（府県予報区）
const JMA_OFFICE = {
  RJCC: "016000", RJCO: "016000", RJCH: "017000", RJEO: "017000", RJEC: "012000", RJCB: "014030", RJCK: "014100", RJCN: "014100",
  RJCM: "013000", RJEB: "013000", RJCW: "011000", RJER: "011000",
  RJSA: "020000", RJSM: "020000", RJSI: "030000", RJSS: "040000", RJSK: "050000", RJSR: "050000", RJSC: "060000", RJSY: "060000", RJSF: "070000",
  RJTT: "130000", RJTO: "130000", RJTQ: "130000", RJTH: "130000", RJAA: "120000", RJAH: "080000",
  RJGG: "230000", RJNA: "230000", RJSN: "150000", RJNT: "160000", RJNK: "170000", RJNW: "170000", RJNS: "220000", RJAF: "200000",
  RJOO: "270000", RJBB: "270000", RJBE: "280000", RJBT: "280000", RJBD: "300000",
  RJOB: "330000", RJOA: "340000", RJDC: "350000", RJOI: "350000", RJOC: "320000", RJOW: "320000", RJNO: "320000", RJOH: "310000", RJOR: "310000",
  RJOT: "370000", RJOS: "360000", RJOM: "380000", RJOK: "390000",
  RJFF: "400000", RJFR: "400000", RJFS: "410000", RJFU: "420000", RJDT: "420000", RJDB: "420000", RJFE: "420000", RJFT: "430000", RJDA: "430000",
  RJFO: "440000", RJFM: "450000", RJFK: "460100", RJFG: "460100", RJFC: "460100",
  RJKA: "460040", RJKI: "460040", RJKN: "460040", RJKB: "460040", RORY: "460040",
  ROAH: "471000", ROKJ: "471000", ROMY: "473000", RORS: "473000", RORT: "473000", ROIG: "474000", ROYN: "474000", RORK: "472000", ROMD: "472000",
};
// 磁気偏差（西偏、度。国土地理院の偏角の概ね値）。METAR の風（真方位）を滑走路（磁方位）にそろえるため
const MAG_VAR_W = {
  RJCC: 9, RJCH: 9, RJCB: 9.5, RJCK: 9.5, RJCM: 9.5, RJEC: 9.5, RJSA: 8.5, RJSS: 8, RJTT: 7.5, RJAA: 7.5, RJGG: 7.5, RJNK: 8,
  RJOO: 7.5, RJBB: 7.5, RJBD: 7, RJOB: 7.5, RJOA: 7.5, RJDC: 7.5, RJOT: 7.5, RJOS: 7, RJOM: 7.5, RJOK: 7,
  RJFF: 7.5, RJFR: 7.5, RJFO: 7, RJFU: 7.5, RJFT: 7, RJFM: 6.5, RJFK: 6.5, RJKA: 5.5, ROAH: 5, RCTP: 4.5,
};
// WeatherBriefing の RUNWAY_DATA に無い空港（滑走路番号からの磁方位。AIP で要確認）
const RUNWAY_EXTRA = {
  RJCH: [{ rwy: "12", hdg: 120 }, { rwy: "30", hdg: 300 }],
};
// 気圧面と標準大気の高度（ft）。FL の表示と、巡航高度の値の補間に使う
const LEVELS = [150, 200, 250, 300, 400, 500, 600, 700, 850, 925];
const STD_FT = { 150: 44647, 200: 38662, 250: 33999, 300: 30065, 400: 23574, 500: 18289, 600: 13801, 700: 9882, 850: 4781, 925: 2500 };
const STD_FL = { 150: "450", 200: "390", 250: "340", 300: "300", 400: "240", 500: "180", 600: "140", 700: "100", 850: "050", 925: "025" }; // 見慣れた呼び方
const FL_CHOICES = [290, 300, 310, 320, 330, 340, 350, 360, 370, 380, 390, 400, 410];

const CAT = {
  VFR: { fg: "#6ee7b7", bg: "#0f3d2b" },
  MVFR: { fg: "#93c5fd", bg: "#10233f" },
  IFR: { fg: "#fca5a5", bg: "#3b1010" },
  LIFR: { fg: "#e9d5ff", bg: "#3b1d5c" },
};
const COL = { amber: "#fbbf24", magenta: "#f0abfc", cyan: "#67e8f9", cyanSoft: "#a5f3fc", red: "#fca5a5", white: "#f1f5f9", pink: "#f9a8d4" };
const PFD_BORDER = "#2a3344";

/* ---------- 小さな道具 ---------- */
const pad = (n) => String(n).padStart(2, "0");
const hhmmZ = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`; };
const hhmmzShort = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
const agoText = (ms, now) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 60 ? `${m}分前` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}前`;
};
const loadPref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
function usePref(key, fallback) {
  const [v, setV] = useState(() => loadPref(key, fallback));
  const set = (nv) => {
    setV((p) => {
      const next = typeof nv === "function" ? nv(p) : nv;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  return [v, set];
}
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const iv = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(iv); }, [ms]);
  return now;
}
function useNarrow(px = 900) {
  const q = `(max-width: ${px}px)`;
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    return () => { mq.removeEventListener("change", on); window.removeEventListener("resize", on); };
  }, [q]);
  return m;
}
const toUv = (dir, spd) => [-spd * Math.sin((dir * Math.PI) / 180), -spd * Math.cos((dir * Math.PI) / 180)];
const fromUv = ([u, v]) => ({ spd: Math.hypot(u, v), dir: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 });
const windText = (dir, spd) => `${String(Math.round(dir / 10) * 10 || 360).padStart(3, "0")}/${pad(Math.round(spd))}`;
const tempText = (t) => (t == null ? "—" : `${t > 0 ? "+" : t < 0 ? "−" : ""}${Math.abs(Math.round(t))}`);

// 太陽の高度（度）。日本付近が昼か夜かで、ひまわりの画像の種類を選ぶ
function sunElevation(ms, lat, lon) {
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = ((357.529 + 0.98560028 * d) * Math.PI) / 180;
  const q = 280.459 + 0.98564736 * d;
  const L = ((q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI) / 180;
  const e = ((23.439 - 0.00000036 * d) * Math.PI) / 180;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (((gmst * 15 + lon) * Math.PI) / 180) - ra;
  const la = (lat * Math.PI) / 180;
  return (Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) * 180) / Math.PI;
}

/* ---------- METAR・TAF を読む（表示は電文のまま。色や成分の計算にだけ使う） ---------- */
const stripType = (raw) => (raw || "").replace(/^(METAR|SPECI)\s+/, "").trim();
const mainPart = (raw) => stripType(raw).split(/\s(?:TEMPO|BECMG|NOSIG|RMK)\b/)[0];
const WIND_RE = /\b(\d{3}|VRB)(P?\d{2,3})(?:G(P?\d{2,3}))?(KT|MPS)\b/;
const WX_RE = /^(\+|-)?(VC)?(MI|BC|PR|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)*$/;
const isSigWx = (t) => /TS|FZ|GR|SQ|FC|SN|PL|SS|DS|VA/.test(t) || t.startsWith("+");

function parseWind(text) {
  const m = (text || "").match(WIND_RE);
  if (!m) return null;
  const k = m[4] === "MPS" ? 1.944 : 1;
  const spd = Math.round(parseInt(m[2].replace("P", ""), 10) * k);
  const gust = m[3] ? Math.round(parseInt(m[3].replace("P", ""), 10) * k) : null;
  return { token: m[0], dir: m[1] === "VRB" ? null : parseInt(m[1], 10), spd, gust };
}

function parseMetar(raw) {
  const body = mainPart(raw);
  const toks = body.split(/\s+/);
  const wind = parseWind(body);
  const iw = wind ? toks.indexOf(wind.token) : 1;
  let vis = null, visTok = null;
  for (let k = iw + 1; k < toks.length; k++) {
    const t = toks[k];
    if (/^\d{3}V\d{3}$/.test(t)) continue;
    if (t === "CAVOK") { vis = 9999; visTok = "CAVOK"; }
    else if (/^\d{4}$/.test(t)) { vis = parseInt(t, 10); visTok = t; }
    break;
  }
  const clouds = [...body.matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3})/g)].map((m) => ({ token: m[0], cover: m[1], base: parseInt(m[2], 10) * 100 }));
  const ceilC = clouds.find((c) => c.cover === "BKN" || c.cover === "OVC" || c.cover === "VV");
  const wx = toks.slice(iw + 1).filter((t) => t.length >= 2 && t !== "NSW" && t !== "CAVOK" && !/^\d/.test(t) && WX_RE.test(t) && !/^(FEW|SCT|BKN|OVC|VV|NSC|NCD|SKC|CLR)/.test(t));
  const tdTok = toks.find((t) => /^M?\d{2}\/(M?\d{2})?$/.test(t)) || null;
  const qTok = toks.find((t) => /^Q\d{4}$/.test(t)) || null;
  const aTok = toks.find((t) => /^A\d{4}$/.test(t)) || null;
  const qnh = qTok ? parseInt(qTok.slice(1), 10) : aTok ? Math.round(parseInt(aTok.slice(1), 10) / 100 / 0.02953) : null;
  const inHg = aTok ? parseInt(aTok.slice(1), 10) / 100 : qnh ? Math.round(qnh * 2.953) / 100 : null;
  const cavok = toks.includes("CAVOK");
  const ceil = cavok || !ceilC ? null : ceilC.base;
  let cat = "VFR";
  if (!cavok) {
    const vv = vis ?? 9999, cc = ceil ?? 99999;
    if (vv < 1600 || cc < 500) cat = "LIFR";
    else if (vv < 4800 || cc < 1000) cat = "IFR";
    else if (vv < 8000 || cc < 3000) cat = "MVFR";
  }
  const lowest = clouds[0]?.token || (cavok ? "CAVOK" : toks.find((t) => /^(NSC|NCD|SKC|CLR)$/.test(t)) || null);
  return { body, wind, vis, visTok, clouds, ceil, ceilTok: ceilC?.token || null, lowest, wx, tdTok, qTok: qTok || aTok, qnh, inHg, cavok, cat };
}

// 注意の判定（上の枠・たたんだときの要約）
function cautionsOf(m) {
  if (!m) return { wind: false, vis: false, ceil: false };
  const w = m.wind;
  return {
    wind: !!w && ((w.gust ?? 0) >= LIMIT.gust || w.spd >= LIMIT.wind),
    vis: (m.vis != null && m.vis < LIMIT.vis) || m.wx.some(isSigWx),
    ceil: m.ceil != null && m.ceil < LIMIT.ceil,
  };
}

// TAF の時刻（DDhh・DDhhmm）を UTC のミリ秒に。今日に近い月を当てる
function tafTime(dd, hh, mm = 0, ref = Date.now()) {
  const r = new Date(ref);
  let mo = r.getUTCMonth();
  if (dd < r.getUTCDate() - 15) mo += 1;
  else if (dd > r.getUTCDate() + 15) mo -= 1;
  return Date.UTC(r.getUTCFullYear(), mo, dd, hh, mm);
}
// TAF の各行（区切り）の種類・期間・風。行は AWC の電文の改行のまま（無ければ TEMPO などの前で区切る）
function tafRows(raw) {
  if (!raw) return [];
  let lines = raw.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  if (lines.length === 1) lines = lines[0].split(/\s(?=(?:BECMG|TEMPO|FM\d{6}|PROB\d{2})\b)/).map((l, i) => (i ? `  ${l}` : l));
  const rows = lines.map((line, i) => {
    const t = line.trim();
    const type = i === 0 ? "BASE" : (t.match(/^(BECMG|TEMPO|FM\d{6}|PROB\d{2}(?:\s+TEMPO)?)/)?.[1] || "").replace(/\s+/, " ");
    const fm = t.match(/^FM(\d{2})(\d{2})(\d{2})/);
    const per = t.match(/\b(\d{2})(\d{2})\/(\d{2})(\d{2})\b/);
    let from = null, to = null;
    if (fm) from = tafTime(+fm[1], +fm[2], +fm[3]);
    else if (per) { from = tafTime(+per[1], +per[2]); to = tafTime(+per[3], +per[4]); }
    const head = type.startsWith("FM") ? type : per ? `${type === "BASE" ? "" : `${type} `}${per[0]}`.trim() : type;
    return { line, type, from, to, wind: parseWind(t.replace(/^TAF\s+(AMD\s+|COR\s+)?\S+\s+\d{6}Z\s+/, "")), head };
  });
  const end = rows[0]?.to ?? null;
  rows.forEach((r, i) => { if (r.type.startsWith("FM")) r.to = rows.slice(i + 1).find((x) => x.type.startsWith("FM"))?.from ?? end; });
  return rows;
}
const covers = (r, t) => r.from != null && r.to != null && t >= r.from && t < r.to;
// その時刻に当てはまる TAF の行。TAF の有効期間の外なら無し
// 電文の強調：最初の行（FM が始まっていればその FM）・始まった BECMG・その時にかかる TEMPO と PROB
// windOnly（風のテープ）：風のある行だけで、その時の風（最初の行・始まった BECMG・FM のうち最後）と TEMPO・PROB
function tafActive(rows, t, windOnly = false) {
  const out = new Set();
  const v = rows[0];
  if (!v || (v.from != null && t < v.from) || (v.to != null && t >= v.to)) return out;
  let base = null;
  const becmg = [];
  for (const r of rows) {
    if (windOnly && !r.wind) continue;
    if (r.type === "BASE") base = r;
    else if (r.type.startsWith("FM")) { if (r.from != null && r.from <= t) { base = r; becmg.length = 0; } }
    else if (r.type === "BECMG") { if (r.from != null && r.from <= t) becmg.push(r); }
    else if (covers(r, t)) out.add(r);
  }
  if (windOnly) { const last = becmg.length ? becmg[becmg.length - 1] : base; if (last) out.add(last); }
  else { if (base) out.add(base); becmg.forEach((r) => out.add(r)); }
  return out;
}

/* ---------- 風の成分 ---------- */
function runwayEnds(icao, runwayData) {
  const list = runwayData?.[icao] || RUNWAY_EXTRA[icao];
  if (!list) return [];
  const ends = [];
  for (const r of list) {
    if (r.rwy.includes("/")) {
      const [a, b] = r.rwy.split("/");
      ends.push({ name: a, hdg: r.hdg }, { name: b, hdg: (r.hdg + 180) % 360 });
    } else ends.push({ name: r.rwy, hdg: r.hdg });
  }
  return ends;
}
// 風（真方位）の、滑走路（磁方位）に対する向かい風・横風。偏差は西偏を正として足す
function comp(wind, end, varW) {
  if (!wind || wind.dir == null || !end) return null;
  const rel = ((wind.dir + varW - end.hdg) * Math.PI) / 180;
  const one = (s) => ({ hw: s * Math.cos(rel), xw: s * Math.sin(rel) });
  return { ...one(wind.spd), g: wind.gust ? one(wind.gust) : null };
}
const fmtHw = (hw) => (Math.round(hw) >= 0 ? `HW${Math.round(hw)}` : `TW${Math.round(-hw)}`);
const fmtXw = (xw) => { const a = Math.round(Math.abs(xw)); return `XW${a}${a === 0 ? "" : xw > 0 ? "R" : "L"}`; };

/* ---------- SIGMET ---------- */
const polygonsOf = (coords) => (!Array.isArray(coords) || !coords.length ? [] : Array.isArray(coords[0]) ? coords : [coords]);
function inPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
const sigName = (s) => [s.qualifier, s.hazard].filter(Boolean).join(" ") || "SIGMET";
const sigFl = (ft) => String(Math.round(ft / 100)).padStart(3, "0");
const sigLevels = (s) => (s.base && s.top ? `FL${sigFl(s.base)}/${sigFl(s.top)}` : s.top ? `TOP FL${sigFl(s.top)}` : "");

/* ---------- データの取得 ---------- */
// METAR（AWC、JSON、3時間分）。空港ごとに新しい順。緯度経度も入る
// note：その空港の METAR が無いときの表示（取得中・無し・取得できない）
function useMetars(icaos, api, tick) {
  const key = icaos.join(",");
  const [state, setState] = useState({ key: "", map: {}, error: false });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    api.fetchViaProxy(`/api/data/metar?ids=${key}&format=json&hours=3`)
      .then((text) => {
        const list = JSON.parse(text);
        const by = {};
        for (const x of Array.isArray(list) ? list : []) {
          if (!x.icaoId || !x.rawOb) continue;
          (by[x.icaoId] ||= []).push({ raw: stripType(x.rawOb), time: (x.obsTime || 0) * 1000, lat: x.lat, lon: x.lon, elev: x.elev });
        }
        const out = {};
        for (const [icao, arr] of Object.entries(by)) {
          arr.sort((a, b) => b.time - a.time);
          out[icao] = { latest: arr[0], history: arr.slice(1), lat: arr[0].lat, lon: arr[0].lon, elev: arr[0].elev, m: parseMetar(arr[0].raw) };
        }
        if (alive) setState({ key, map: out, error: false });
      })
      .catch(() => { if (alive) setState((p) => ({ key, map: p.map, error: true })); });
    return () => { alive = false; };
  }, [key, api, tick]);
  const ready = state.key === key;
  return { map: state.map, note: ready && state.error ? "METAR を取得できません" : ready ? "METAR なし" : "METAR を取得中…" };
}
function useTaf(icao, api, tick) {
  const [taf, setTaf] = useState({ icao: null, raw: "" });
  useEffect(() => {
    if (!icao) return;
    let alive = true;
    api.fetchTafRaw(icao).then((raw) => alive && setTaf({ icao, raw: (raw || "").trim() })).catch(() => {});
    return () => { alive = false; };
  }, [icao, api, tick]);
  return taf.icao === icao ? taf.raw : "";
}
function useSigmets(tick) {
  const [list, setList] = useState([]);
  useEffect(() => {
    let alive = true;
    fetch(`${WORKER_URL}/api/data/isigmet?format=json`, { cache: "no-cache" })
      .then(async (r) => (r.status === 204 ? [] : r.ok ? JSON.parse((await r.text()) || "[]") : []))
      .then((arr) => {
        if (!alive) return;
        const now = Date.now();
        const seen = new Set();
        setList((Array.isArray(arr) ? arr : [])
          .filter((s) => s.firId === "RJJJ" && (s.validTimeTo || 0) * 1000 > now)
          .filter((s) => { const k = (s.rawSigmet || "").trim(); if (seen.has(k)) return false; seen.add(k); return true; }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [tick]);
  return list;
}
function useOverviews(codes, tick) {
  const key = codes.join(",");
  const [data, setData] = useState({});
  useEffect(() => {
    if (!key) return;
    let alive = true;
    Promise.all(key.split(",").map((code) => fetch(overviewUrl(code)).then((r) => (r.ok ? r.json() : null)).then((j) => [code, j]).catch(() => [code, null])))
      .then((pairs) => alive && setData(Object.fromEntries(pairs)));
    return () => { alive = false; };
  }, [key, tick]);
  return data;
}
function useSatTime(tick) {
  const [t, setT] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(SAT_FD_TIMES, { cache: "no-cache" }).then((r) => r.json()).then((list) => { if (alive && list.length) setT(list[list.length - 1]); }).catch(() => {});
    return () => { alive = false; };
  }, [tick]);
  return t;
}
function useSpas(tick) {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch(WM_LIST, { cache: "no-cache" }).then((r) => r.json()).then((list) => {
      const arr = list?.near?.now || [];
      const file = arr[arr.length - 1];
      if (!alive || !file) return;
      const m = file.match(/_(\d{14})_MET/);
      const valid = m ? Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[1].slice(8, 10)) : null;
      setS({ src: WM_PNG + file, valid });
    }).catch(() => {});
    return () => { alive = false; };
  }, [tick]);
  return s;
}
// 上空の風・気温・湿度・高度（Open-Meteo、気圧面）と 0℃ 高度
function useUpper(lat, lon, tick) {
  const key = lat != null && lon != null ? `${lat.toFixed(2)},${lon.toFixed(2)}` : "";
  const [state, setState] = useState({ key: "", json: null, error: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const vars = LEVELS.flatMap((L) => ["temperature", "relative_humidity", "wind_speed", "wind_direction", "geopotential_height"].map((v) => `${v}_${L}hPa`));
    const [la, lo] = key.split(",");
    fetch(`${OPEN_METEO}?latitude=${la}&longitude=${lo}&hourly=${[...vars, "freezing_level_height"].join(",")}&wind_speed_unit=kn&timezone=GMT&forecast_days=3`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((json) => alive && setState({ key, json, error: null }))
      .catch((e) => alive && setState({ key, json: null, error: e.message }));
    return () => { alive = false; };
  }, [key, tick]);
  return state.key === key ? state : { key, json: null, error: null };
}

// 指定した時刻にいちばん近い時の、高さごとの値（上から順）と、目印（巡航高度・圏界面・0℃・JET・ICE・VWS）
function upperProfile(json, t, flSel, sfc) {
  if (!json?.hourly?.time) return null;
  const times = json.hourly.time.map((s) => Date.parse(`${s}Z`));
  let idx = 0, best = Infinity;
  times.forEach((x, i) => { const d = Math.abs(x - t); if (d < best) { best = d; idx = i; } });
  const h = json.hourly;
  const rows = LEVELS.map((L) => ({
    L, ft: STD_FT[L], t: h[`temperature_${L}hPa`]?.[idx], rh: h[`relative_humidity_${L}hPa`]?.[idx],
    spd: h[`wind_speed_${L}hPa`]?.[idx], dir: h[`wind_direction_${L}hPa`]?.[idx], z: h[`geopotential_height_${L}hPa`]?.[idx],
  })).filter((r) => r.t != null && r.spd != null && r.dir != null && r.z != null);
  if (!rows.length) return null;
  // VWS：その高さと、ひとつ下（一番下は地上の METAR の風）との風の差（kt/1000ft）
  rows.forEach((r, i) => {
    const lo = rows[i + 1];
    const a = toUv(r.dir, r.spd);
    if (lo) {
      const b = toUv(lo.dir, lo.spd);
      r.vws = Math.hypot(a[0] - b[0], a[1] - b[1]) / (((r.z - lo.z) * 3.281) / 1000);
    } else if (sfc?.wind?.dir != null && sfc.elev != null) {
      const b = toUv(sfc.wind.dir, sfc.wind.spd);
      r.vws = Math.hypot(a[0] - b[0], a[1] - b[1]) / (((r.z - sfc.elev) * 3.281) / 1000);
    }
    r.ice = r.t <= 0 && r.t >= -20 && (r.rh ?? 0) >= 80;
  });
  const maxRow = rows.reduce((a, b) => (b.spd > a.spd ? b : a));
  if (maxRow.spd >= LIMIT.jet) maxRow.jet = true;
  // 圏界面：下から見て、気温の下がり方が 2℃/km 以下になる最初の層の下の面（400hPa より上で）
  let trop = null;
  for (let i = rows.length - 1; i > 0; i--) {
    const lo = rows[i], up = rows[i - 1];
    if (lo.L > 400) continue;
    const lapse = (lo.t - up.t) / ((up.z - lo.z) / 1000);
    if (lapse <= 2) { trop = lo; break; }
  }
  // 巡航高度の値：上下の面の間を、標準大気の高度で補間
  let sel = null;
  const target = flSel * 100;
  for (let i = 0; i < rows.length - 1; i++) {
    const up = rows[i], lo = rows[i + 1];
    if (target <= up.ft && target >= lo.ft) {
      const f = (target - lo.ft) / (up.ft - lo.ft);
      const a = toUv(lo.dir, lo.spd), b = toUv(up.dir, up.spd);
      const w = fromUv([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      sel = { ft: target, dir: w.dir, spd: w.spd, t: lo.t + (up.t - lo.t) * f };
      break;
    }
  }
  const fzlM = h.freezing_level_height?.[idx];
  const fzl = fzlM == null ? null : { ft: fzlM * 3.281, sfc: sfc?.elev != null && fzlM - sfc.elev < 150 };
  return { time: times[idx], rows, trop, sel, fzl };
}

/* ---------- 乗務の予定 ---------- */
// 今日（無ければ明日）の乗務の区間と、空港の並び（同じ空港の着・発はまとめる）。乗務が無い日は次の乗務
function dutyPlan(api, now) {
  const legsOf = (evs) => evs
    .filter((e) => e.type === "FLY" && e.legs?.length)
    .flatMap((e) => e.legs.map((l) => ({ ...l, fromIcao: api.iataToIcao(l.from), toIcao: api.iataToIcao(l.to) })))
    .filter((l) => l.fromIcao && l.toIcao)
    .sort((a, b) => a.dep - b.dep);
  let legs = legsOf(api.getTodayDutyEvents());
  let label = "今日";
  if (!legs.length) { legs = legsOf(api.getNextDutyEvents()); label = api.nextDutyDay().ja; }
  if (legs.length) {
    const stops = [{ icao: legs[0].fromIcao, dep: legs[0].dep, depNo: legs[0].no }];
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i], nx = legs[i + 1];
      const s = { icao: l.toIcao, arr: l.arr, arrNo: l.no };
      if (nx && nx.fromIcao === l.toIcao) { s.dep = nx.dep; s.depNo = nx.no; }
      stops.push(s);
      if (nx && nx.fromIcao !== l.toIcao) stops.push({ icao: nx.fromIcao, dep: nx.dep, depNo: nx.no });
    }
    return { mode: "duty", label, legs, stops };
  }
  // 次の乗務（明日より先）
  const next = api.loadDutyEvents()
    .filter((e) => e.type === "FLY" && e.start.getTime() > now)
    .sort((a, b) => a.start - b.start)[0];
  let nextText = null;
  if (next) {
    const d = new Date(next.start.getTime() + 9 * 3600e3);
    const l = next.legs?.[0];
    const leg = l ? `${l.no ? `${l.no} ` : ""}${api.iataToIcao(l.from) || l.from}→${api.iataToIcao(l.to) || l.to}` : (next.route || []).join("→");
    nextText = `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日月火水木金土"[d.getUTCDay()]}） ${leg}`;
  }
  return { mode: "none", label: null, legs: [], stops: [], nextText, loaded: api.loadDutyEvents().length > 0 };
}
// その空港で見る時刻：着いて30分までは到着の時刻、それより後（と出発だけの空港）は出発の時刻
function stopFocus(s, now) {
  if (!s) return null;
  if (s.arr != null && (s.dep == null || s.arr > now - 30 * 60e3)) return { kind: "arr", t: s.arr };
  return s.dep != null ? { kind: "dep", t: s.dep } : null;
}
const stopText = (s) => [s.arr != null ? `着 ${hhmmZ(s.arr)}` : null, s.dep != null ? `発 ${hhmmZ(s.dep)}` : null].filter(Boolean).join(" · ");

/* ---------- 見た目の部品 ---------- */
const chipBase = { display: "inline-flex", alignItems: "center", gap: "6px", height: "32px", padding: "0 10px", borderRadius: "6px", fontSize: FS.xs, whiteSpace: "nowrap" };
const stepBtn = (on) => ({
  height: "40px", boxSizing: "border-box", display: "inline-flex", alignItems: "center", gap: "8px", padding: "0 12px",
  borderRadius: "8px", fontSize: FS.sm, fontFamily: "inherit", cursor: on ? "default" : "pointer",
  border: on ? "1px solid transparent" : "1px solid #2c3a52", background: on ? "#123227" : "transparent",
  color: on ? C.accent : "#cbd5e1", fontWeight: on ? 700 : 400,
});
const segWrap = { display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: "2px", padding: "3px", borderRadius: "10px", background: "#070d18", border: "1px solid #1c2433" };
const segBtn = (on, mono = false) => ({
  height: "40px", padding: "0 11px", borderRadius: "8px", border: "none", cursor: "pointer",
  fontFamily: mono ? FONT.data : "inherit", fontSize: FS.sm, fontWeight: on ? 700 : 400,
  background: on ? "#123227" : "transparent", color: on ? C.accent : C.textSub,
});
const plainBtn = {
  height: "40px", padding: "0 14px", borderRadius: "8px", background: "#0f1726", border: "1px solid #2c3a52",
  color: C.text, fontFamily: "inherit", fontSize: FS.sm, display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer", whiteSpace: "nowrap",
};
function Chevron({ up }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}
function Arrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
function CatBadge({ cat, small }) {
  if (!cat) return null;
  const c = CAT[cat];
  return <span style={{ fontSize: small ? "10px" : FS.xs, fontWeight: 700, padding: small ? "1px 6px" : "2px 7px", borderRadius: "5px", background: c.bg, color: c.fg }}>{cat}</span>;
}

/* ============================================================
   本体
   ============================================================ */
export default function BriefingDisplay({ api }) {
  const now = useNow(60e3);
  const [tick, setTick] = useState(0);
  useEffect(() => { const iv = setInterval(() => setTick((t) => t + 1), REFRESH_MS); return () => clearInterval(iv); }, []);
  const [collapsed, setCollapsed] = usePref(PREF.collapsed, false);
  const [step, setStep] = useState("overview");
  const [favorites, setFavorites] = usePref(PREF.airports, DEFAULT_AIRPORTS);
  const [dutyVersion, setDutyVersion] = useState(0);
  useEffect(() => {
    // 乗務の予定を読み込んだ・消した、空港コードを登録した、別のタブで変えたとき
    const on = () => setDutyVersion((v) => v + 1);
    const names = ["storage", api.overrideEvent, api.dutyEvent];
    names.forEach((n) => window.addEventListener(n, on));
    return () => names.forEach((n) => window.removeEventListener(n, on));
  }, [api.overrideEvent, api.dutyEvent]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => dutyPlan(api, now), [api, Math.floor(now / 600e3), dutyVersion]);

  // ② で見る空港（乗務の日は空港の並びの何番目か、無い日は ICAO）と時刻
  const [stopIdx, setStopIdx] = useState(null);
  const [pick, setPick] = useState(null);
  const [offsetH, setOffsetH] = useState(0);
  const listIcaos = plan.mode === "duty" ? [...new Set(plan.stops.map((s) => s.icao))] : favorites;
  const defaultStop = useMemo(() => {
    if (plan.mode !== "duty") return 0;
    const i = plan.stops.findIndex((s) => (s.dep ?? s.arr ?? 0) >= now - 30 * 60e3);
    return i >= 0 ? i : plan.stops.length - 1;
  }, [plan, now]);
  const curStop = plan.mode === "duty" ? plan.stops[Math.min(stopIdx ?? defaultStop, plan.stops.length - 1)] : null;
  const pfdIcao = plan.mode === "duty" ? curStop?.icao : (pick && listIcaos.includes(pick) ? pick : listIcaos[0]);
  const focus = plan.mode === "duty" ? stopFocus(curStop, now) : null;
  const targetTime = plan.mode === "duty" ? (focus?.t ?? now) : Math.round(now / 3600e3) * 3600e3 + offsetH * 3600e3;
  // TAF・上空の値で見る時刻の札（乗務の日は「到着 13:05Z」、無い日は選んだ時刻）
  const focusTag = focus ? { text: `${focus.kind === "arr" ? "到着" : "出発"} ${hhmmZ(focus.t)}`, short: focus.kind === "arr" ? "到着" : "出発" }
    : plan.mode === "duty" ? null : { text: `${pad(new Date(targetTime).getUTCHours())}Z`, short: `${pad(new Date(targetTime).getUTCHours())}Z` };
  const metarIcaos = [...new Set([...listIcaos, pfdIcao].filter(Boolean))].sort();
  const { map: metars, note: metarNote } = useMetars(metarIcaos, api, tick);
  const sigmets = useSigmets(tick);

  // ② を開く。乗務の日は、その空港のこれからの立ち寄り（idx があればその立ち寄り）。icao が無ければ今の空港
  const openPfd = (icao, idx) => {
    if (plan.mode === "duty") {
      let i = idx ?? (icao ? plan.stops.findIndex((s) => s.icao === icao && (s.dep ?? s.arr ?? 0) >= now - 30 * 60e3) : -1);
      if (i < 0 && icao) i = plan.stops.findIndex((s) => s.icao === icao);
      setStopIdx(i >= 0 ? i : null);
    } else if (icao) setPick(icao);
    setStep("pfd");
    setCollapsed(false);
  };

  if (collapsed) {
    return <FoldedBar plan={plan} metars={metars} sigmets={sigmets} favorites={favorites} onOpen={() => setCollapsed(false)} onPick={openPfd} api={api} />;
  }
  return (
    <PanelFrame title="PRIMARY SURVEILLANCE DISPLAY" style={{ padding: "16px 14px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <nav aria-label="ブリーフィングの順番" style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <button type="button" aria-current={step === "overview" ? "step" : undefined} onClick={() => setStep("overview")} style={stepBtn(step === "overview")}>
            <span style={{ fontFamily: FONT.data, fontWeight: 700 }}>1</span>今日の概況
          </button>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          <button type="button" aria-current={step === "pfd" ? "step" : undefined} onClick={() => setStep("pfd")} style={stepBtn(step === "pfd")}>
            <span style={{ fontFamily: FONT.data, fontWeight: 700 }}>2</span>{plan.mode === "duty" ? "DUTY の空港" : "空港を選ぶ"}
          </button>
        </nav>
        {step === "pfd" && plan.mode === "duty" && (
          <div role="group" aria-label="DUTY の空港（乗務の順）" style={segWrap}>
            {plan.stops.map((s, i) => {
              const on = s === curStop;
              const legNo = s.depNo && i < plan.stops.length - 1 ? s.depNo : null;
              return (
                <span key={`${s.icao}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                  <button type="button" aria-pressed={on} onClick={() => setStopIdx(i)} style={{ ...segBtn(on), height: "auto", minHeight: "40px", display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: "2px 6px", fontSize: FS.xs, textAlign: "left" }}>
                    <span style={{ fontFamily: FONT.data, fontSize: FS.sm, fontWeight: 700, color: on ? C.accent : "#cbd5e1" }}>{s.icao}</span>{stopText(s)}
                  </button>
                  {legNo && <span style={{ fontFamily: FONT.data, fontSize: FS.xs, color: C.textMuted }}>{legNo}</span>}
                </span>
              );
            })}
          </div>
        )}
        {step === "pfd" && plan.mode === "none" && (
          <>
            <div role="group" aria-label="空港" style={segWrap}>
              {listIcaos.map((icao) => (
                <button key={icao} type="button" aria-pressed={icao === pfdIcao} onClick={() => setPick(icao)} style={segBtn(icao === pfdIcao, true)}>{icao}</button>
              ))}
            </div>
            <div role="group" aria-label="上空の値の時刻" style={segWrap}>
              {[0, 3, 6].map((h) => {
                const t = Math.round(now / 3600e3) * 3600e3 + h * 3600e3;
                return <button key={h} type="button" aria-pressed={offsetH === h} onClick={() => setOffsetH(h)} style={segBtn(offsetH === h)}>{`${pad(new Date(t).getUTCHours())}Z`}</button>;
              })}
            </div>
          </>
        )}
        {step === "overview" && (
          plan.mode === "duty"
            ? <span style={{ fontSize: FS.sm, color: "#cbd5e1" }}>{plan.label}の乗務 <span style={{ fontFamily: FONT.data, color: C.text }}>{plan.legs.map((l) => `${l.no ? `${l.no} ` : ""}${l.fromIcao}→${l.toIcao}`).join(" · ")}</span></span>
            : <span style={{ fontSize: FS.sm, color: "#cbd5e1" }}>今日は乗務なし{plan.nextText ? <> <span style={{ color: "#64748b" }}>·</span> 次の乗務 <span style={{ fontFamily: FONT.data, color: C.text }}>{plan.nextText}</span></> : !plan.loaded ? <> <span style={{ color: "#64748b" }}>·</span> 乗務の予定が未読み込み（DUTY で .ics を読み込む）</> : null}</span>
        )}
        <button type="button" onClick={() => setCollapsed(true)} style={{ ...plainBtn, marginLeft: "auto" }}><Chevron up />たたむ</button>
      </div>
      {step === "overview"
        ? <Overview plan={plan} metars={metars} metarNote={metarNote} sigmets={sigmets} listIcaos={listIcaos} favorites={favorites} setFavorites={setFavorites} onPick={openPfd} api={api} now={now} tick={tick} />
        : <Pfd icao={pfdIcao} focusTag={focusTag} targetTime={targetTime} metar={metars[pfdIcao]} metarNote={metarNote} sigmets={sigmets} api={api} now={now} tick={tick} />}
    </PanelFrame>
  );
}

/* ---------- たたんだとき：1行の要約 ---------- */
function FoldedBar({ plan, metars, sigmets, favorites, onOpen, onPick, api }) {
  const chainIcaos = plan.mode === "duty" ? plan.stops.map((s) => s.icao) : [];
  const sigChip = sigmets.length ? (
    <span style={{ ...chipBase, background: "#2a1f08", border: "1px solid #5c4410", color: "#fcd34d" }}>
      <span style={{ fontWeight: 700 }}>SIGMET {sigmets.length}</span>
      <span style={{ fontFamily: FONT.data, color: "#fef3c7" }}>{sigName(sigmets[0])} {sigLevels(sigmets[0])}</span>
    </span>
  ) : <span style={{ ...chipBase, background: "#0f1726", border: "1px solid #1c2433", color: C.textSub }}>SIGMET なし</span>;
  return (
    <PanelFrame title="PRIMARY SURVEILLANCE DISPLAY" style={{ display: "flex", alignItems: "center", gap: "10px", minHeight: "60px", padding: "9px 12px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", flex: 1, minWidth: 0 }}>
        {plan.mode === "duty" ? (
          <>
            <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px", marginRight: "2px" }}>DUTY {plan.label}</span>
            {chainIcaos.map((icao, i) => {
              const d = metars[icao];
              const m = d?.m;
              const ca = cautionsOf(m);
              const bad = m && (m.cat === "IFR" || m.cat === "LIFR" || ca.wind || ca.vis || ca.ceil);
              const tokens = m ? [ca.wind && m.wind?.token, ca.vis && [m.visTok, ...m.wx].filter(Boolean).join(" "), ca.ceil && m.ceilTok].filter(Boolean).join(" ") : "";
              return (
                <span key={`${icao}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  {i > 0 && <Arrow />}
                  <button type="button" onClick={() => onPick(icao, i)} aria-label={`${icao} の詳細を開く`} style={{ ...chipBase, cursor: "pointer", fontFamily: "inherit", color: "inherit", background: bad ? "#2a1010" : "#0f1726", border: `1px solid ${bad ? "#5b1d1d" : "#1c2433"}` }}>
                    <span style={{ fontFamily: FONT.data, fontSize: FS.sm, fontWeight: 700, color: COL.white }}>{icao}</span>
                    <CatBadge cat={m?.cat} small />
                    {tokens && <span style={{ fontFamily: FONT.data, fontSize: "12px", color: "#fcd34d" }}>{tokens}</span>}
                  </button>
                </span>
              );
            })}
          </>
        ) : (
          <>
            <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub }}>乗務なし{plan.nextText ? ` · 次の乗務 ${plan.nextText}` : ""}</span>
            <span style={{ ...chipBase, background: "#0f1726", border: "1px solid #1c2433", color: C.text }}>
              主要空港
              {["LIFR", "IFR", "MVFR", "VFR"].map((cat) => {
                const n = favorites.filter((icao) => metars[icao]?.m?.cat === cat).length;
                return n ? <span key={cat} style={{ fontWeight: 700, color: CAT[cat].fg }}>{cat} {n}</span> : null;
              })}
            </span>
          </>
        )}
        <span style={{ width: "1px", height: "22px", background: "#1c2433", margin: "0 4px" }} />
        {sigChip}
      </div>
      <button type="button" onClick={onOpen} style={plainBtn}><Chevron />開く</button>
    </PanelFrame>
  );
}

/* ---------- ① 今日の概況 ---------- */
function Overview({ plan, metars, metarNote, sigmets, listIcaos, favorites, setFavorites, onPick, api, now, tick }) {
  const narrow = useNarrow(900);
  const [dim] = useDimPref();
  const sat = useSatTime(tick);
  const spas = useSpas(tick);
  const [bandSel, setBandSel] = useState(null); // null＝昼夜で自動
  const autoBand = sunElevation(now, 36, 138) > 5 ? "REP/ETC" : "B13/TBB";
  const band = bandSel || autoBand;
  const [view, setView] = useState("sat"); // 主役の画像：sat（ひまわり、既定）・spas（地上天気図 実況）・fbjp
  const [viewer, setViewer] = useState(null); // 全画面（天気図の何枚目か）
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // 天気概況：乗務の日は乗務の空港の地域（順に）、無い日は拠点
  const codes = [...new Set((plan.mode === "duty" ? listIcaos : [BASE_ICAO]).map((icao) => JMA_OFFICE[icao]).filter(Boolean))];
  const overviews = useOverviews(codes, Math.floor(tick / 6));
  const vaCount = sigmets.filter((s) => s.hazard === "VA").length;
  const satLayer = (b) => sat && { id: `sat-${b}`, url: (z, x, y) => `${SAT}/${sat.basetime}/fd/${sat.validtime}/${b}/${z}/${x}/${y}.jpg` };
  const coast = { id: "coast", url: COASTLINE, pixelated: true };
  const charts = [
    { key: "spas", title: "地上天気図 実況", code: "SPAS", meta: spas?.valid ? `${pad(new Date(spas.valid).getUTCDate())}日 ${hhmmZ(spas.valid)}` : "", src: spas?.src || null, href: spas?.src },
    { key: "fbjp", title: "国内悪天予想図", code: "FBJP", meta: "", src: FBJP_URL, href: FBJP_URL },
  ];
  const chart = charts.find((c) => c.key === view) || null;
  const viewerList = charts.filter((c) => c.src);
  const openFull = () => { const i = viewerList.findIndex((c) => c.key === view); if (i >= 0) setViewer(i); };
  const satTime = sat ? Date.UTC(+sat.validtime.slice(0, 4), +sat.validtime.slice(4, 6) - 1, +sat.validtime.slice(6, 8), +sat.validtime.slice(8, 10), +sat.validtime.slice(10, 12)) : null;
  const bandLabel = BANDS.find((b) => b.key === band)?.label || "";

  // 主役の見出し：ひまわりは画像に重ねる（狭い画面と天気図のときは画像の上に置く）
  const overlayHead = view === "sat" && !narrow;
  const heroHead = (
    <div style={{ ...(overlayHead ? { position: "absolute", top: 0, left: 0, right: 0 } : {}), display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", minHeight: "62px", boxSizing: "border-box", padding: "8px 10px 8px 14px", background: overlayHead ? "rgba(3,8,16,0.78)" : "#070d18", borderBottom: overlayHead ? "none" : "1px solid #1c2433" }}>
      {view === "sat" ? (
        <>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: COL.white }}>ひまわり</span>
          {satTime && <span style={{ fontFamily: FONT.data, fontSize: "12px", color: "#cbd5e1" }}>{hhmmZ(satTime)}</span>}
          <div role="group" aria-label="衛星画像の種類" style={{ marginLeft: "auto", display: "inline-flex", gap: "2px", padding: "2px", borderRadius: "9px", background: "rgba(7,13,24,0.92)", border: "1px solid #1c2433" }}>
            {BANDS.map((b) => (
              <button key={b.key} type="button" aria-pressed={band === b.key} onClick={() => setBandSel(b.key)} style={{ ...segBtn(band === b.key), fontSize: "12px" }}>{b.label}</button>
            ))}
          </div>
        </>
      ) : (
        <>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: COL.white }}>{chart.title}</span>
          <span style={{ fontFamily: FONT.data, fontSize: "12px", color: "#cbd5e1" }}>{chart.meta || chart.code}</span>
          <button type="button" onClick={openFull} disabled={!chart.src} style={{ ...plainBtn, marginLeft: "auto", opacity: chart.src ? 1 : 0.5 }}>全画面</button>
        </>
      )}
    </div>
  );

  // 下の3枚：タップで主役の画像を切り替える（実況・FBJP・ひまわり）
  const thumbs = [
    { key: "spas", title: "地上天気図 実況", short: "実況", note: spas?.valid ? hhmmZ(spas.valid) : "", label: "地上天気図（実況）" },
    { key: "fbjp", title: "国内悪天予想図", short: "FBJP", note: "FBJP", label: "国内悪天予想図（FBJP）" },
    { key: "sat", title: "ひまわり", short: "ひまわり", note: bandLabel, label: "ひまわり" },
  ];
  const thumbStyle = (on) => ({
    display: "flex", flexDirection: "column", padding: 0, borderRadius: "8px", overflow: "hidden", fontFamily: "inherit", color: "inherit", textAlign: "left", cursor: on ? "default" : "pointer", minWidth: 0,
    border: `1px solid ${on ? C.accent : "#1c2433"}`, background: on ? "#0f2a22" : "#0f1726",
  });

  return (
    <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "minmax(0, 1.25fr) minmax(0, 1fr)", gap: "14px", alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 }}>
        <div style={{ position: "relative", borderRadius: "8px", border: "1px solid #1c2433", overflow: "hidden", background: "#000" }}>
          {view === "sat" ? (
            <>
              {narrow && heroHead}
              <div style={{ filter: dim ? DIM_FILTER : "none" }}>
                <TileMap region={HERO_REGION} layers={[satLayer(band), coast]} bg="#000" />
              </div>
              {overlayHead && heroHead}
              {overlayHead && (
                <span style={{ position: "absolute", left: "12px", bottom: "10px", padding: "3px 8px", borderRadius: "5px", background: "rgba(3,8,16,0.72)", fontSize: FS.xs, color: "#cbd5e1" }}>
                  気象庁 ひまわりの画像をそのまま{bandSel ? "" : " · 昼はトゥルーカラー、夜は赤外"}
                </span>
              )}
            </>
          ) : narrow ? (
            <>
              {heroHead}
              <div style={{ position: "relative", aspectRatio: HERO_ASPECT }}><HeroChart item={chart} dim={dim} onOpen={openFull} /></div>
            </>
          ) : (
            <div style={{ aspectRatio: HERO_ASPECT, display: "flex", flexDirection: "column" }}>
              {heroHead}
              <div style={{ position: "relative", flex: 1, minHeight: 0 }}><HeroChart item={chart} dim={dim} onOpen={openFull} /></div>
            </div>
          )}
        </div>
        <div role="group" aria-label="主役の画像を切り替える" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px" }}>
          {thumbs.map((t) => {
            const on = view === t.key;
            return (
              <button key={t.key} type="button" aria-pressed={on} aria-label={`${t.label}を大きく表示`} onClick={() => setView(t.key)} style={thumbStyle(on)}>
                <span style={{ display: "flex", alignItems: "baseline", gap: "6px", padding: "6px 10px", fontSize: "12px", fontWeight: 700, color: on ? C.accent : C.text, whiteSpace: "nowrap", overflow: "hidden" }}>
                  {narrow ? t.short : t.title}{!narrow && t.note && <span style={{ fontSize: "10px", fontWeight: 400, color: C.textSub }}>{t.note}</span>}
                </span>
                <span style={{ margin: "0 8px 8px", height: "84px", borderRadius: "5px", background: t.key === "sat" ? "#000" : "#fff", overflow: "hidden", display: "flex", alignItems: "center", filter: dim ? DIM_FILTER : "none" }}>
                  {t.key === "sat"
                    ? <div style={{ width: "100%" }}><TileMap region={THUMB_REGION} layers={[satLayer(band)]} bg="#000" /></div>
                    : charts.find((c) => c.key === t.key)?.src && <img src={charts.find((c) => c.key === t.key).src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px" }}>天気概況（気象庁）</span>
          {codes.map((code) => <OverviewCard key={code} data={overviews[code]} icaos={(plan.mode === "duty" ? listIcaos : [BASE_ICAO]).filter((i) => JMA_OFFICE[i] === code)} base={plan.mode !== "duty"} />)}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {sigmets.length ? (
            <span style={{ ...chipBase, height: "30px", background: "#2a1f08", border: "1px solid #5c4410", color: "#fcd34d" }}>
              <span style={{ fontWeight: 700 }}>SIGMET {sigmets.length}</span>
              <span style={{ fontFamily: FONT.data, color: "#fef3c7" }}>{sigName(sigmets[0])} {sigLevels(sigmets[0])}</span>
            </span>
          ) : <span style={{ ...chipBase, height: "30px", background: "#0f1726", border: "1px solid #1c2433", color: C.textSub }}>SIGMET なし</span>}
          <span style={{ ...chipBase, height: "30px", background: vaCount ? "#2a1f08" : "#0f1726", border: `1px solid ${vaCount ? "#5c4410" : "#1c2433"}`, color: vaCount ? "#fcd34d" : C.textSub }}>
            {vaCount ? `火山灰 SIGMET ${vaCount}` : "火山灰 なし"}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px" }}>{plan.mode === "duty" ? "DUTY の空港（乗務の順）" : "主要空港"}</span>
            {plan.mode !== "duty" && (
              <button type="button" onClick={() => { setDraft(favorites.join(" ")); setEditing((e) => !e); }} style={{ marginLeft: "auto", height: "32px", padding: "0 10px", borderRadius: "6px", background: "transparent", border: "1px solid #2c3a52", color: "#cbd5e1", fontFamily: "inherit", fontSize: FS.xs, cursor: "pointer" }}>
                {editing ? "閉じる" : "並びを編集"}
              </button>
            )}
          </div>
          {editing && (
            <form onSubmit={(e) => {
              e.preventDefault();
              const list = [...new Set(draft.toUpperCase().split(/[\s,、]+/).filter((x) => /^[A-Z]{4}$/.test(x)))];
              if (list.length) setFavorites(list);
              setEditing(false);
            }} style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "200px", fontSize: FS.xs, color: C.textSub }}>
                ICAO をスペース区切りで（上から順に並ぶ）
                <input value={draft} onChange={(e) => setDraft(e.target.value)} style={{ height: "40px", padding: "0 10px", borderRadius: "8px", border: "1px solid #2c3a52", background: "#070d18", color: C.text, fontFamily: FONT.data, fontSize: FS.sm }} />
              </label>
              <button type="submit" style={{ ...plainBtn, alignSelf: "flex-end" }}>保存</button>
              <button type="button" onClick={() => { setFavorites(DEFAULT_AIRPORTS); setEditing(false); }} style={{ ...plainBtn, alignSelf: "flex-end", color: C.textSub }}>元に戻す</button>
            </form>
          )}
          {plan.mode === "duty"
            ? [...new Set(plan.stops.map((s) => s.icao))].map((icao) => {
              const roles = plan.stops.filter((s) => s.icao === icao).map(stopText).join(" · ");
              return <DutyRow key={icao} icao={icao} roles={roles} d={metars[icao]} note={metarNote} name={api.airportName(icao)} onPick={onPick} />;
            })
            : listIcaos.map((icao) => <CompactRow key={icao} icao={icao} d={metars[icao]} note={metarNote} onPick={onPick} />)}
        </div>
        <button type="button" onClick={() => onPick()} style={{ height: "44px", borderRadius: "8px", border: "1px solid #1f5c45", background: "#123227", color: C.accent, fontFamily: "inherit", fontSize: FS.md, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", cursor: "pointer" }}>
          {plan.mode === "duty" ? "DUTY の空港を順に見る" : "空港を選んで詳しく見る"}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
      {viewer !== null && viewerList[viewer] && (
        <ChartViewer items={viewerList} index={viewer} setIndex={setViewer} onClose={() => setViewer(null)} dim={dim} />
      )}
    </div>
  );
}

// 主役の枠に天気図を1枚（枠いっぱいに収める。タップで全画面）
function HeroChart({ item, dim, onOpen }) {
  const [errSrc, setErrSrc] = useState(null);
  const ok = item?.src && errSrc !== item.src;
  return (
    <button type="button" onClick={onOpen} disabled={!ok} aria-label={`${item?.title || "図"}を全画面で開く`}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", padding: 0, border: "none", display: "flex", alignItems: "center", justifyContent: "center", background: ok ? "#fff" : "#0f1726", cursor: ok ? "zoom-in" : "default", filter: dim && ok ? DIM_FILTER : "none" }}>
      {ok
        ? <img src={item.src} alt={item.title} onError={() => setErrSrc(item.src)} draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
        : <span style={{ color: C.textSub, fontSize: FS.sm }}>{item?.src ? "この図を読み込めません" : "読み込み中…"}</span>}
    </button>
  );
}

function OverviewCard({ data, icaos, base }) {
  const [open, setOpen] = useState(false);
  if (!data) return <div style={{ padding: "9px 12px", borderRadius: "8px", border: "1px solid #1c2433", background: "#0f1726", fontSize: FS.xs, color: C.textSub }}>{icaos.join(" · ")} の天気概況を取得中…</div>;
  const paras = (data.text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const t = data.reportDatetime ? new Date(data.reportDatetime) : null;
  const jst = t ? new Date(t.getTime() + 9 * 3600e3) : null;
  return (
    <article aria-label={`${data.targetArea}の天気概況`} style={{ background: "#0f1726", border: "1px solid #1c2433", borderRadius: "8px", padding: "9px 12px", display: "flex", flexDirection: "column", gap: "3px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
        <span style={{ fontSize: FS.sm, fontWeight: 700 }}>{data.targetArea}</span>
        <span style={{ fontFamily: FONT.data, fontSize: "12px", color: C.textSub }}>{base ? `拠点 ${icaos.join(" ")}` : icaos.join(" ")}</span>
        {jst && <span style={{ marginLeft: "auto", fontSize: FS.xs, color: C.textSub }}>{pad(jst.getUTCHours())}:{pad(jst.getUTCMinutes())} 発表</span>}
      </div>
      {data.headlineText && <p style={{ margin: 0, fontSize: FS.sm, lineHeight: 1.6, fontWeight: 700, color: "#fcd34d" }}>{data.headlineText}</p>}
      <p style={{ margin: 0, fontSize: FS.sm, lineHeight: 1.6, color: C.text, whiteSpace: "pre-wrap", ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }) }}>
        {open ? paras.join("\n\n") : paras[0]}
      </p>
      {(paras.length > 1 || (paras[0] || "").length > 120) && (
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ alignSelf: "flex-start", height: "32px", padding: "0 8px", border: "none", background: "transparent", color: C.accent, fontFamily: "inherit", fontSize: FS.xs, cursor: "pointer" }}>
          {open ? "たたむ" : "続きを読む"}
        </button>
      )}
    </article>
  );
}

function DutyRow({ icao, roles, d, note, name, onPick }) {
  const m = d?.m;
  const bad = m && (m.cat === "IFR" || m.cat === "LIFR");
  return (
    <button type="button" onClick={() => onPick(icao)} aria-label={`${icao} の詳細を見る`} style={{ display: "flex", flexDirection: "column", gap: "3px", padding: "9px 12px", borderRadius: "8px", border: `1px solid ${bad ? "#5b1d1d" : "#1c2433"}`, background: bad ? "#170b0e" : "#0f1726", color: "inherit", fontFamily: "inherit", textAlign: "left", cursor: "pointer" }}>
      <span style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", flexWrap: "wrap" }}>
        <span style={{ fontFamily: FONT.data, fontSize: "16px", fontWeight: 700, color: COL.white }}>{icao}</span>
        <span style={{ fontSize: FS.sm, color: "#cbd5e1" }}>{name || ""}</span>
        <CatBadge cat={m?.cat} />
        <span style={{ marginLeft: "auto", fontSize: FS.xs, color: C.textSub }}>{roles}</span>
      </span>
      <span style={{ fontFamily: FONT.data, fontSize: "12.5px", lineHeight: 1.5, color: C.text }}>{d ? d.latest.raw : note}</span>
    </button>
  );
}

function CompactRow({ icao, d, note, onPick }) {
  const m = d?.m;
  const bad = m && (m.cat === "IFR" || m.cat === "LIFR");
  const key = m ? [m.wind?.token, m.visTok, ...m.wx, m.ceilTok || m.lowest, m.tdTok].filter(Boolean).join(" ") : note;
  return (
    <button type="button" onClick={() => onPick(icao)} aria-label={`${icao} の詳細を見る`} style={{ display: "grid", gridTemplateColumns: "52px 50px minmax(0, 1fr)", alignItems: "center", gap: "8px", minHeight: "40px", padding: "0 12px", borderRadius: "8px", border: `1px solid ${bad ? "#5b1d1d" : "#1c2433"}`, background: bad ? "#170b0e" : "#0f1726", color: "inherit", fontFamily: "inherit", textAlign: "left", cursor: "pointer" }}>
      <span style={{ fontFamily: FONT.data, fontSize: "14px", fontWeight: 700, color: COL.white }}>{icao}</span>
      <span style={{ justifySelf: "start" }}><CatBadge cat={m?.cat} small /></span>
      <span style={{ fontFamily: FONT.data, fontSize: "12px", color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{key}</span>
    </button>
  );
}

/* ---------- ② PFD ---------- */
function Pfd({ icao, focusTag, targetTime, metar, metarNote, sigmets, api, now, tick }) {
  const narrow = useNarrow(980);
  const taf = useTaf(icao, api, tick);
  const upperState = useUpper(metar?.lat, metar?.lon, Math.floor(tick / 6));
  const [flSel, setFlSel] = usePref(PREF.fl, 370);
  const [rwyPref, setRwyPref] = usePref(PREF.rwy, {});
  const [xwLimit, setXwLimit] = usePref(PREF.xw, "");
  const [twLimit, setTwLimit] = usePref(PREF.tw, "");
  const m = metar?.m;
  const ends = runwayEnds(icao, api.runwayData);
  const varW = MAG_VAR_W[icao] ?? 7.5;
  // 選んだ滑走路（無ければ今の風で向かい風がいちばん強い端）
  const bestEnd = m?.wind?.dir != null && ends.length ? ends.reduce((a, b) => (comp(m.wind, b, varW).hw > comp(m.wind, a, varW).hw ? b : a)) : ends[0];
  const end = ends.find((e) => e.name === rwyPref[icao]) || bestEnd;
  const xwLim = Number(xwLimit) || null, twLim = Number(twLimit) || null;
  const overXw = (c) => c && xwLim && Math.abs(c.xw) > xwLim;
  const overTw = (c) => c && twLim && c.hw < -twLim;
  const rows = tafRows(taf);
  const applying = tafActive(rows, targetTime, true); // 風のテープ
  const active = tafActive(rows, targetTime); // 電文の強調
  const ca = cautionsOf(m);
  const sigHere = metar?.lat != null ? sigmets.filter((s) => polygonsOf(s.coords).some((p) => inPoly(metar.lat, metar.lon, p))) : [];
  const prof = upperProfile(upperState.json, targetTime, flSel, { wind: m?.wind, elev: metar?.elev });
  const name = api.airportName(icao);

  if (!icao) return <div style={{ padding: "20px", color: C.textSub, fontSize: FS.sm }}>空港がありません</div>;

  // 上の枠（注意の語句）
  const fma = [
    { label: "SFC WIND", text: m?.wind?.token || "—", warn: ca.wind },
    { label: "VIS / WX", text: m ? [m.visTok, ...m.wx].filter(Boolean).join(" ") || "—" : "—", warn: ca.vis },
    { label: "CEILING", text: m ? m.ceilTok || m.lowest || "—" : "—", warn: ca.ceil },
    { label: "TEMP / QNH", text: m ? [m.tdTok, m.qTok].filter(Boolean).join(" ") || "—" : "—", warn: false },
    { label: "SIGMET", text: sigHere.length ? sigName(sigHere[0]) : "NIL", warn: sigHere.length > 0 },
  ];

  // 左のテープ：見る時刻に当てはまる TAF の行（足りなければ、その後に変わる行）・今の METAR・過去の METAR。上ほど先
  const tape = rows.filter((r) => applying.has(r));
  if (tape.length < 2) {
    const next = rows.find((r) => r.wind && !applying.has(r) && r.from != null && r.from > targetTime);
    if (next) tape.push(next);
  }
  const tapeRows = tape.slice(0, 3).sort((a, b) => (b.from ?? 0) - (a.from ?? 0));
  const cur = comp(m?.wind, end, varW);

  const cell = { borderRight: `1px solid ${PFD_BORDER}` };
  return (
    <div style={{ display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "210px minmax(0, 1fr) 330px", background: "#000", border: `1px solid ${PFD_BORDER}`, borderRadius: "8px", overflow: "hidden" }}>
      {/* 上：注意すべき値 */}
      <div aria-label="注意すべき値（電文の語句）" style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(128px, 1fr))", overflow: "hidden", borderBottom: `1px solid ${PFD_BORDER}` }}>
        {fma.map((f) => (
          <div key={f.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "4px", minHeight: "60px", padding: "6px 8px", boxShadow: `1px 0 0 0 ${PFD_BORDER}, 0 1px 0 0 ${PFD_BORDER}`, boxSizing: "border-box" }}>
            <span style={{ fontSize: "10px", color: C.textSub, letterSpacing: "1px" }}>{f.label}</span>
            <span style={{ fontFamily: FONT.data, fontSize: "16px", fontWeight: 700, color: f.warn ? COL.amber : COL.white, padding: "1px 8px", border: f.warn ? `1.5px solid ${COL.amber}` : "1.5px solid transparent", borderRadius: "3px", textAlign: "center" }}>{f.text}</span>
          </div>
        ))}
      </div>

      {/* 左：地上風 */}
      <div aria-label="地上風の推移（上が予報、下が過去の観測）" style={{ ...cell, display: "flex", flexDirection: "column", padding: "8px 0 6px", order: narrow ? 2 : 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "0 12px 4px" }}>
          <span style={{ fontSize: FS.xs, color: C.textSub, letterSpacing: "1px" }}>SFC WIND</span>
          {end && <span style={{ fontFamily: FONT.data, fontSize: "12px", fontWeight: 700, color: COL.magenta }}>RWY {end.name}</span>}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: "3px", padding: "0 8px" }}>
          {tapeRows.map((r, i) => {
            const c = comp(r.wind, end, varW);
            const hit = focusTag && applying.has(r);
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: "1px", padding: "4px 6px", borderRadius: "4px", background: hit ? "#0e2a33" : "transparent" }}>
                <span style={{ fontSize: "10px", color: COL.cyan }}>TAF {r.head}{hit ? ` · ${focusTag.short}` : ""}</span>
                <span style={{ fontFamily: FONT.data, fontSize: "13px", color: COL.cyan }}>{r.wind.token}</span>
                {c && <span style={{ fontFamily: FONT.data, fontSize: FS.xs, color: overXw(c) || overTw(c) ? COL.red : c.hw < 0 ? COL.amber : COL.cyanSoft }}>{fmtHw(c.hw)} {fmtXw(c.xw)}{c.g ? ` · G ${fmtXw(c.g.xw)}` : ""}</span>}
              </div>
            );
          })}
          {metar && (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "6px 8px", border: `1.5px solid ${COL.white}`, borderRadius: "4px", background: "#0b0f16" }}>
              <span style={{ fontSize: "10px", color: "#cbd5e1" }}>METAR {hhmmzShort(metar.latest.time)}</span>
              <span style={{ fontFamily: FONT.data, fontSize: "17px", fontWeight: 700, color: COL.white }}>{m?.wind?.token || "—"}</span>
              {cur && <span style={{ fontFamily: FONT.data, fontSize: "12px", color: overXw(cur) || overTw(cur) ? COL.red : cur.hw < 0 ? COL.amber : COL.white }}>{fmtHw(cur.hw)} {fmtXw(cur.xw)}</span>}
              {cur?.g && <span style={{ fontFamily: FONT.data, fontSize: "12px", color: overXw(cur.g) || overTw(cur.g) ? COL.red : COL.amber }}>G {fmtHw(cur.g.hw)} {fmtXw(cur.g.xw)}</span>}
            </div>
          )}
          {(metar?.history || []).slice(0, 3).map((h, i) => {
            const w = parseWind(mainPart(h.raw));
            const c = comp(w, end, varW);
            return (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: "6px", padding: "3px 6px", fontFamily: FONT.data, fontSize: "12px", color: "#cbd5e1" }}>
                <span>{hhmmzShort(h.time)} {w?.token || ""}</span>{c && <span style={{ color: C.textSub }}>{fmtXw(c.xw).replace(/[RL]$/, "")}</span>}
              </div>
            );
          })}
          {!ends.length && <span style={{ padding: "4px 6px", fontSize: FS.xs, color: C.textSub }}>この空港は滑走路のデータが無いため、成分は出せません</span>}
        </div>
        <div style={{ display: "flex", gap: "8px", padding: "6px 12px 0", borderTop: "1px solid #1c2433", flexWrap: "wrap" }}>
          {[["XW", xwLimit, setXwLimit], ["TW", twLimit, setTwLimit]].map(([k, v, set]) => (
            <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: FS.xs, color: COL.magenta }}>
              {k} 制限
              <input inputMode="numeric" value={v} onChange={(e) => set(e.target.value.replace(/[^\d]/g, "").slice(0, 2))} placeholder="—" aria-label={`${k} の制限（kt）`}
                style={{ width: "34px", height: "28px", padding: "0 4px", borderRadius: "5px", border: "1px solid #3b2a44", background: "#0b0f16", color: COL.magenta, fontFamily: FONT.data, fontSize: "12px", textAlign: "center" }} />kt
            </label>
          ))}
        </div>
      </div>

      {/* 中央：電文 */}
      <div aria-label={`${icao} の METAR と TAF（電文のまま）`} style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "12px 18px", minWidth: 0, order: narrow ? 1 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontFamily: FONT.data, fontSize: "21px", fontWeight: 700, color: COL.white }}>{icao}</span>
          {name && <span style={{ fontSize: FS.sm, color: "#cbd5e1" }}>{name}</span>}
          <CatBadge cat={m?.cat} />
          {metar && <span style={{ marginLeft: "auto", fontSize: FS.xs, color: C.textSub }}>観測 {hhmmzShort(metar.latest.time)} · {agoText(metar.latest.time, now)}</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px" }}>METAR</span>
          <pre style={{ margin: 0, fontFamily: FONT.data, fontSize: "18px", lineHeight: 1.5, color: COL.white, whiteSpace: "pre-wrap" }}>{metar ? metar.latest.raw : metarNote}</pre>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px" }}>TAF</span>
          {rows.length ? (
            <div style={{ fontFamily: FONT.data, fontSize: "14px", lineHeight: 1.6, color: C.text }}>
              {rows.map((r, i) => {
                const hit = focusTag && active.has(r);
                return (
                  <div key={i} style={hit ? { display: "flex", alignItems: "baseline", gap: "10px", margin: "0 -6px", padding: "0 6px", borderRadius: "4px", background: "#0e2a33" } : { whiteSpace: "pre-wrap" }}>
                    <span style={{ whiteSpace: "pre-wrap" }}>{r.line}</span>
                    {hit && <span style={{ marginLeft: "auto", fontFamily: FONT.ui, fontSize: FS.xs, color: COL.cyan, whiteSpace: "nowrap" }}>{focusTag.text}</span>}
                  </div>
                );
              })}
            </div>
          ) : <span style={{ fontSize: FS.xs, color: C.textSub }}>{taf === "" ? "TAF なし（または取得中）" : ""}</span>}
        </div>
        {m && (
          <div style={{ marginTop: "auto", display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 18px", paddingTop: "8px", borderTop: "1px solid #1c2433" }}>
            <span style={{ fontSize: "10px", color: C.textSub }}>電文の値の読み替え（補助）</span>
            <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: ca.ceil ? COL.amber : C.text }}>{m.ceil != null ? `CIG ${m.ceil}ft` : "CIG なし"}</span>
            <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: m.vis != null && m.vis < LIMIT.vis ? COL.amber : C.text }}>{m.vis == null ? "VIS —" : m.vis >= 9999 ? "VIS 10km 以上" : `VIS ${m.vis}m`}</span>
          </div>
        )}
      </div>

      {/* 右：上空 */}
      <UpperTape prof={prof} state={upperState} flSel={flSel} setFlSel={setFlSel} focusTag={focusTag} narrow={narrow} metar={metar} metarNote={metarNote} />

      {/* 下：QNH・滑走路・SIGMET */}
      <div aria-label="QNH・滑走路ごとの風の成分・SIGMET" style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "210px minmax(0, 1fr) 330px", borderTop: `1px solid ${PFD_BORDER}`, order: 5 }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "1px", padding: "8px 14px", borderRight: narrow ? "none" : `1px solid ${PFD_BORDER}` }}>
          <span style={{ fontSize: "10px", color: C.textSub, letterSpacing: "1px" }}>QNH</span>
          <span style={{ fontFamily: FONT.data, fontSize: "20px", fontWeight: 700, color: COL.white }}>{m?.qTok || "—"}</span>
          {m?.inHg && <span style={{ fontFamily: FONT.data, fontSize: "12px", color: "#cbd5e1" }}>{m.inHg.toFixed(2)} inHg</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "5px", padding: "8px 14px" }}>
          {ends.length ? (
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {ends.map((e) => {
                const c = comp(m?.wind, e, varW);
                const on = e === end;
                const bad = c && (c.hw < 0 || overXw(c));
                return (
                  <button key={e.name} type="button" aria-pressed={on} onClick={() => setRwyPref((p) => ({ ...p, [icao]: e.name }))}
                    style={{ flex: "1 1 auto", minHeight: "46px", display: "flex", alignItems: "center", gap: "8px", padding: "0 12px", borderRadius: "6px", border: on ? `1.5px solid ${COL.magenta}` : "1px solid #2c3a52", background: on ? "#160b18" : "#070b12", color: COL.white, fontFamily: FONT.data, fontSize: "13px", textAlign: "left", cursor: "pointer", whiteSpace: "nowrap" }}>
                    <span style={{ fontWeight: 700, color: on ? COL.magenta : "#cbd5e1" }}>RWY {e.name}</span>
                    {c ? <><span style={{ color: c.hw < 0 ? COL.red : COL.white, fontWeight: c.hw < 0 ? 700 : 400 }}>{fmtHw(c.hw)}</span><span style={{ color: overXw(c) ? COL.red : COL.white }}>{fmtXw(c.xw)}</span>{c.g && <span style={{ color: bad ? COL.red : COL.amber }}>G {fmtXw(c.g.xw)}</span>}</> : <span style={{ color: C.textSub }}>{m?.wind?.dir == null && m?.wind ? "風向不定" : "—"}</span>}
                  </button>
                );
              })}
            </div>
          ) : <span style={{ fontSize: FS.xs, color: C.textSub }}>滑走路のデータがありません</span>}
          {ends.length > 0 && <span style={{ fontSize: "10px", color: C.textSub }}>METAR の風は真方位、滑走路は磁方位。偏差（約{varW}°W）で換算して成分を出す</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "2px", padding: "8px 14px", borderLeft: narrow ? "none" : `1px solid ${PFD_BORDER}`, borderTop: narrow ? `1px solid ${PFD_BORDER}` : "none" }}>
          <span style={{ fontSize: "10px", color: C.textSub, letterSpacing: "1px" }}>SIGMET（RJJJ）</span>
          {sigHere.length ? sigHere.map((s, i) => (
            <span key={i} style={{ fontFamily: FONT.data, fontSize: "12.5px", lineHeight: 1.45, color: COL.amber }}>
              {(s.seriesId || "").replace(/F$/, "")} {sigName(s)} {sigLevels(s)} {s.validTimeTo ? `〜${hhmmzShort(s.validTimeTo * 1000)}` : ""}
            </span>
          )) : <span style={{ fontFamily: FONT.data, fontSize: "12.5px", lineHeight: 1.45, color: "#cbd5e1" }}>{icao} 付近は NIL{sigmets.length ? ` · FIR 内 ${sigmets.length}件` : ""}</span>}
        </div>
      </div>
    </div>
  );
}

// 右のテープ：上空の風・気温（上から）。巡航高度（桃色の枠）・JET・ICE・圏界面・0℃ の目印、VWS（6 以上は琥珀色）
function UpperTape({ prof, state, flSel, setFlSel, focusTag, narrow, metar, metarNote }) {
  const grid = { display: "grid", gridTemplateColumns: "66px minmax(0, 1fr) 46px 34px", gap: "0 6px", alignItems: "baseline" };
  const items = [];
  if (prof) {
    for (const r of prof.rows) items.push({ ft: r.ft, kind: "row", r });
    if (prof.sel) items.push({ ft: prof.sel.ft + 1, kind: "sel" });
    if (prof.trop) items.push({ ft: prof.trop.ft + 2, kind: "trop" });
    if (prof.fzl) items.push({ ft: prof.fzl.sfc ? -1 : prof.fzl.ft, kind: "fzl" });
    items.push({ ft: 0, kind: "sfc" });
    items.sort((a, b) => b.ft - a.ft);
  }
  const tag = (text, color, border) => <span style={{ fontSize: "10px", fontWeight: 700, color, padding: "0 4px", border: `1px solid ${border}`, borderRadius: "3px", marginLeft: "4px" }}>{text}</span>;
  const sfcWind = metar?.m?.wind;
  return (
    <div aria-label="上空の風と気温（Open-Meteo の予報値）" style={{ borderLeft: narrow ? "none" : `1px solid ${PFD_BORDER}`, borderTop: narrow ? `1px solid ${PFD_BORDER}` : "none", display: "flex", flexDirection: "column", padding: "6px 0 4px", order: narrow ? 3 : 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", padding: "0 12px 3px" }}>
        <span style={{ fontSize: FS.xs, color: C.textSub, letterSpacing: "1px" }}>UPPER AIR · {prof ? `${pad(new Date(prof.time).getUTCHours())}Z` : "--Z"}{focusTag && /^[到出]/.test(focusTag.short) ? ` ${focusTag.short}` : ""}</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", color: COL.magenta }}>
          <span style={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)" }}>巡航高度</span>
          <select value={flSel} onChange={(e) => setFlSel(Number(e.target.value))} style={{ height: "28px", borderRadius: "5px", border: "1px solid #3b2a44", background: "#0b0f16", color: COL.magenta, fontFamily: FONT.data, fontSize: "12px", fontWeight: 700 }}>
            {FL_CHOICES.map((f) => <option key={f} value={f}>FL{f}</option>)}
          </select>
        </label>
      </div>
      <div style={{ ...grid, padding: "1px 12px 3px", fontSize: "10px", color: C.textSub, borderBottom: "1px solid #1c2433" }}>
        <span>FL / hPa</span><span>WIND</span><span style={{ textAlign: "right" }}>℃</span><span style={{ textAlign: "right" }}>VWS</span>
      </div>
      {!prof ? (
        <span style={{ padding: "12px", fontSize: FS.xs, color: C.textSub }}>{state.error ? `上空の値を取得できません（${state.error}）` : metar ? "上空の値を取得中…" : metarNote === "METAR を取得中…" ? "METAR の取得を待っています" : "空港の位置（METAR）が無いため、上空の値は出せません"}</span>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: "2px", padding: "2px 0", fontFamily: FONT.data, fontSize: "12.5px" }}>
          {items.map((it, i) => {
            if (it.kind === "row") {
              const r = it.r;
              const vws = r.vws == null ? "—" : Math.round(r.vws);
              return (
                <div key={i} style={{ ...grid, padding: "0 12px", color: C.text }}>
                  <span>{STD_FL[r.L]}<span style={{ fontSize: "10px", color: C.textSub }}> {r.L}</span></span>
                  <span>{windText(r.dir, r.spd)}{r.jet && tag("JET", COL.pink, "#f472b6")}{r.ice && tag("ICE", COL.cyan, "#22d3ee")}</span>
                  <span style={{ textAlign: "right" }}>{tempText(r.t)}</span>
                  <span style={{ textAlign: "right", color: r.vws >= LIMIT.vws ? COL.amber : C.text, fontWeight: r.vws >= LIMIT.vws ? 700 : 400 }}>{vws}</span>
                </div>
              );
            }
            if (it.kind === "sel") {
              const s = prof.sel;
              return (
                <div key={i} style={{ ...grid, margin: "0 6px", padding: "2px 6px", border: `1.5px solid ${COL.magenta}`, borderRadius: "4px", color: COL.magenta, fontWeight: 700 }}>
                  <span>{flSel}<span style={{ fontSize: "10px", fontWeight: 400 }}> 補間</span></span><span>{windText(s.dir, s.spd)}</span><span style={{ textAlign: "right" }}>{tempText(s.t)}</span><span style={{ textAlign: "right" }}>—</span>
                </div>
              );
            }
            if (it.kind === "trop") {
              return <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "0 12px", fontSize: "10px", color: "#cbd5e1" }}><span style={{ flex: 1, borderTop: "1px dashed #7a889d" }} />TROP FL{STD_FL[prof.trop.L]}<span style={{ flex: 1, borderTop: "1px dashed #7a889d" }} /></div>;
            }
            if (it.kind === "fzl") {
              return <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "0 12px", fontSize: "10px", color: COL.cyan }}><span style={{ flex: 1, borderTop: "1px dashed #0e7490" }} />FZL {prof.fzl.sfc ? "SFC" : `FL${String(Math.round(prof.fzl.ft / 100)).padStart(3, "0")}`}<span style={{ flex: 1, borderTop: "1px dashed #0e7490" }} /></div>;
            }
            return (
              <div key={i} style={{ ...grid, padding: "0 12px", color: COL.white, fontWeight: 700 }}>
                <span>SFC<span style={{ fontSize: "10px", fontWeight: 400, color: C.textSub }}> MTR</span></span>
                <span>{sfcWind ? (sfcWind.dir == null ? `VRB/${pad(sfcWind.spd)}` : `${String(sfcWind.dir).padStart(3, "0")}/${pad(sfcWind.spd)}${sfcWind.gust ? `G${sfcWind.gust}` : ""}`) : "—"}</span>
                <span style={{ textAlign: "right" }}>{metar?.m?.tdTok ? metar.m.tdTok.split("/")[0] : "—"}</span><span style={{ textAlign: "right" }}>—</span>
              </div>
            );
          })}
        </div>
      )}
      <span style={{ padding: "4px 12px 0", fontSize: "10px", color: C.textSub }}>Open-Meteo の予報値（空港上空）· FL は標準大気の高さ</span>
    </div>
  );
}
