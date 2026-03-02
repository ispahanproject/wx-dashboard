import { useState, useEffect, useCallback, useRef } from "react";

/* ============================================================
   AWC API BASE URL
   dev → Vite proxy (/awc-api)
   prod → CORS proxy 経由で aviationweather.gov
   ============================================================ */
const AWC_BASE = import.meta.env.DEV
  ? "/awc-api"
  : "https://api.allorigins.win/raw?url=" + encodeURIComponent("https://aviationweather.gov");

// AWC proxy URL — CF Worker 優先、allorigins フォールバック
const CF_WORKER = "https://wx-awc-proxy.trinity-funkyboy.workers.dev";

function awcProxyUrls(path) {
  if (import.meta.env.DEV) return [`/awc-api${path}`];
  const target = encodeURIComponent("https://aviationweather.gov" + path);
  return [
    `${CF_WORKER}${path}`,                            // Cloudflare Worker (fastest)
    `https://api.allorigins.win/raw?url=${target}`,    // allorigins fallback
    `https://api.allorigins.win/get?url=${target}`,    // allorigins JSON wrapper
  ];
}

// 順番にプロキシを試す共通ヘルパー
async function fetchViaProxy(path, signal, timeoutMs = 8000) {
  const urls = awcProxyUrls(path);
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const combinedSignal = signal
        ? { signal: (typeof AbortSignal.any === "function" ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal) }
        : { signal: ctrl.signal };
      const r = await fetch(url, combinedSignal);
      clearTimeout(timer);
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.trim()) continue;
      // /get endpoint returns JSON with "contents" field
      if (url.includes("/get?")) {
        try { const j = JSON.parse(text); return (j.contents || "").trim(); } catch { continue; }
      }
      return text.trim();
    } catch { /* try next */ }
  }
  throw new Error("All proxies failed");
}

// VATSIM METAR API — CORS対応、プロキシ不要、高速
function vatsimMetarUrl(icaos) {
  return `https://metar.vatsim.net/metar.php?id=${icaos}`;
}

// METAR取得: VATSIM優先 → AWCフォールバック
async function fetchMetarRaw(icaos, signal) {
  try {
    const r = await fetch(vatsimMetarUrl(icaos), { signal });
    if (r.ok) {
      const text = await r.text();
      if (text.trim()) return text.trim();
    }
  } catch { /* fallback */ }
  // フォールバック: AWC via proxy
  return fetchViaProxy(`/api/data/metar?ids=${icaos}&format=raw&taf=false&hours=3`, signal);
}

// TAF取得: AWC via proxy (多段フォールバック)
async function fetchTafRaw(icao, signal) {
  return fetchViaProxy(`/api/data/taf?ids=${icao}&format=raw`, signal, 12000);
}

/* ============================================================
   花粉飛散情報 (tenki.jp JSONP API)
   ============================================================ */
const POLLEN_AREA_JIS = "13101"; // 千代田区（東京）

const POLLEN_LEVELS = {
  0: { text: "飛散前", emoji: "😴", color: "#475569" },
  1: { text: "少ない", emoji: "😊", color: "#6ee7b7" },
  2: { text: "やや多い", emoji: "😐", color: "#fbbf24" },
  3: { text: "多い", emoji: "😷", color: "#f97316" },
  4: { text: "非常に多い", emoji: "🤧", color: "#ef4444" },
  5: { text: "極めて多い", emoji: "💀", color: "#e879f9" },
  99: { text: "欠測", emoji: "❓", color: "#334155" },
};

async function fetchPollenForArea(jis) {
  // CF Worker経由（tenki.jpは直接fetchで503を返すため）
  const url = import.meta.env.DEV
    ? `https://static.tenki.jp/static-api/history/pollen/${jis}.js`
    : `${CF_WORKER}/tenki/static-api/history/pollen/${jis}.js`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    const m = text.match(/\{.*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function fetchPollenTokyo() {
  const data = await fetchPollenForArea(POLLEN_AREA_JIS);
  if (!data) return null;
  return { level: Number(data.i), areaName: data.n, text: data.t };
}

/* ============================================================
   ALMANAC UTILITIES
   ============================================================ */

/** ユリウス日 */
function toJulian(d) {
  return d / 86400000 + 2440587.5;
}

/** 月齢 (0-29.53...) と月相名 */
function moonPhase(date) {
  const jd = toJulian(date);
  const cycle = (jd - 2451549.5) / 29.53058868; // Jan 6 2000 = new moon
  const age = (cycle - Math.floor(cycle)) * 29.53058868;
  const pct = age / 29.53058868;
  const emojis = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘", "🌑"];
  const names = ["新月", "三日月", "上弦", "十三夜", "満月", "十六夜", "下弦", "有明", "新月"];
  const idx = Math.round(pct * 8) % 9;
  return { age: age.toFixed(1), emoji: emojis[idx], name: names[idx], pct };
}

/** 日の出・日の入り (度数法) — 簡易計算 */
function sunriseSunset(date, lat, lng) {
  const JD = toJulian(date);
  const n = Math.floor(JD - 2451545.0 + 0.0008);
  const Jstar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const Mr = M * Math.PI / 180;
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lam = ((M + C + 180 + 102.9372) % 360) * Math.PI / 180;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lam);
  const sinDec = Math.sin(lam) * Math.sin(23.4397 * Math.PI / 180);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH0 = (Math.sin(-0.8333 * Math.PI / 180) - Math.sin(lat * Math.PI / 180) * sinDec)
    / (Math.cos(lat * Math.PI / 180) * cosDec);
  if (cosH0 < -1 || cosH0 > 1) return null;
  const H0 = Math.acos(cosH0) * 180 / Math.PI;
  const Jrise = Jtransit - H0 / 360;
  const Jset = Jtransit + H0 / 360;
  const toUTC = (jd) => {
    const ms = (jd - 2440587.5) * 86400000;
    const d = new Date(ms);
    return d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0");
  };
  return { rise: toUTC(Jrise), set: toUTC(Jset) };
}

/** 日変換ユーティリティ */
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}
function weekNumber(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
}
function seasonEmoji(month) {
  if (month <= 2 || month === 12) return "❄️ 冬";
  if (month <= 5) return "🌸 春";
  if (month <= 8) return "☀️ 夏";
  return "🍂 秋";
}
function lunarJpName(age) {
  const names = {
    0: "朔", 1: "一日月", 2: "二日月", 3: "三日月", 4: "四日月", 5: "五日月",
    6: "六日月", 7: "七夕月", 8: "八日月", 9: "九日月", 10: "十日月", 11: "十一日月", 12: "十二日月",
    13: "十三夜", 14: "十四日月", 15: "十五夜", 16: "十六夜", 17: "立待月", 18: "居待月",
    19: "寝待月", 20: "更待月", 21: "二十一夜", 22: "二十二夜", 23: "二十三夜",
    24: "二十四夜", 25: "二十五夜", 26: "二十六夜", 27: "二十七夜", 28: "二十八夜", 29: "二十九夜"
  };
  return names[Math.round(parseFloat(age))] ?? `${Math.round(parseFloat(age))}日月`;
}

/* ============================================================
   INFO TICKER  — ヘッダー直下に横スクロール情報帯
   ============================================================ */
function InfoTicker({ now }) {
  const moon = moonPhase(now);
  const sun = sunriseSunset(now, 35.5494, 139.7798); // RJTT
  const sun2 = sunriseSunset(now, 33.5853, 130.4508); // RJFF
  const sun3 = sunriseSunset(now, 26.1958, 127.6461); // ROAH
  const doy = dayOfYear(now);
  const wk = weekNumber(now);
  const jd = toJulian(now).toFixed(2);
  const jstDate = new Date(now.getTime() + 9 * 3600000);
  const month = jstDate.getUTCMonth() + 1;

  const items = [
    `${moon.emoji} 月齢 ${moon.age}日 — ${lunarJpName(moon.age)} (${moon.name})`,
    sun ? `🌅 RJTT 日出 ${sun.rise}z / 日没 ${sun.set}z` : "",
    sun2 ? `🌅 RJFF 日出 ${sun2.rise}z / 日没 ${sun2.set}z` : "",
    sun3 ? `🌅 ROAH 日出 ${sun3.rise}z / 日没 ${sun3.set}z` : "",
    `📅 DOY-${doy}  WK-${String(wk).padStart(2, "0")}  ${seasonEmoji(month)}`,
    `📐 ユリウス日 JD ${jd}`,
    `🕐 JST = UTC+9  /  JST→UTC : −09:00`,
    `⚡ METAR SRC: aviationweather.gov (AWC)  /  IMAGE SRC: data.jma.go.jp`,
    `🌐 本システムは参照専用です。運航判断には必ず公式情報源を使用してください。`,
  ].filter(Boolean).join("　　　◈　　　");

  return (
    <div style={{
      overflow: "hidden", background: "rgba(0,0,0,0.6)",
      borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
      padding: "5px 0", position: "relative",
    }}>
      <div style={{
        display: "inline-block",
        whiteSpace: "nowrap",
        animation: "ticker 60s linear infinite",
        color: "#64748b", fontSize: "10px",
        fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.5px",
        paddingLeft: "100%",
      }}>
        {items}
      </div>
      <style>{`@keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-100%); } }`}</style>
    </div>
  );
}

/* ============================================================
   ALMANAC WIDGET — ヘッダー下の横断型情報バー
   ============================================================ */
function AlmanacBar({ now }) {
  const moon = moonPhase(now);
  const sun = sunriseSunset(now, 35.5494, 139.7798);
  const doy = dayOfYear(now);
  const wk = weekNumber(now);
  const jstDate = new Date(now.getTime() + 9 * 3600000);
  const month = jstDate.getUTCMonth() + 1;
  const dom = jstDate.getUTCDate();
  const dow = ["日", "月", "火", "水", "木", "金", "土"][jstDate.getUTCDay()];
  const jd = toJulian(now).toFixed(1);

  const moonBar = Math.round(moon.pct * 20);

  const cells = [
    {
      label: "MOON PHASE", icon: moon.emoji,
      main: `${moon.age}d`,
      sub: lunarJpName(moon.age),
      extra: (
        <div style={{ display: "flex", gap: "1px", marginTop: "4px" }}>
          {Array.from({ length: 20 }).map((_, i) => (
            <div key={i} style={{
              width: "8px", height: "4px", borderRadius: "1px",
              background: i < moonBar ? "#6ee7b7" : "rgba(110,231,183,0.1)",
            }} />
          ))}
        </div>
      ),
    },
    {
      label: "SUNRISE / TOKYO", icon: "🌅",
      main: sun ? `${sun.rise}z` : "---",
      sub: sun ? `日没 ${sun.set}z` : "---",
      extra: null,
    },
    {
      label: "DATE / DOY",
      icon: "📅",
      main: `${String(month).padStart(2, "0")}/${String(dom).padStart(2, "0")} (${dow})`,
      sub: `第${wk}週  DOY-${doy}`,
      extra: null,
    },
    {
      label: "SEASON / JD",
      icon: "🌐",
      main: seasonEmoji(month),
      sub: `JD ${jd}`,
      extra: null,
    },
  ];

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "1px",
      background: "rgba(110, 231, 183, 0.06)",
      borderBottom: "1px solid rgba(110, 231, 183, 0.1)",
      borderTop: "1px solid rgba(110, 231, 183, 0.06)",
    }}>
      {cells.map((c) => (
        <div key={c.label} style={{
          padding: "8px 14px",
          background: "rgba(3, 8, 16, 0.9)",
          position: "relative",
        }}>
          <div style={{ fontSize: "8px", color: "#334155", letterSpacing: "2px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "2px" }}>{c.label}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
            <span style={{ fontSize: "14px" }}>{c.icon}</span>
            <span style={{ fontSize: "16px", fontWeight: 700, color: "#6ee7b7", fontFamily: "'JetBrains Mono', monospace", textShadow: "0 0 10px rgba(110,231,183,0.4)" }}>{c.main}</span>
          </div>
          <div style={{ fontSize: "10px", color: "#475569", fontFamily: "'JetBrains Mono', monospace", marginTop: "1px" }}>{c.sub}</div>
          {c.extra}
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   六曜 (ROKUYO) — 旧暦ベースの日本伝統暦注
   ============================================================ */
function getRokuyo(date) {
  // 旧暦月日を天文計算で求め、六曜を算出 (JST基準)

  const JD = (y, m, d) => {
    if (m <= 2) { y--; m += 12; }
    const A = Math.floor(y / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
  };

  // Meeus法 朔(新月)JDE
  const newMoonJDE = (k) => {
    const T = k / 1236.85, T2 = T * T, T3 = T2 * T;
    let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.000000150 * T3;
    const M = (2.5534 + 29.10535670 * k) * Math.PI / 180;
    const Mp = (201.5643 + 385.81693528 * k) * Math.PI / 180;
    const F = (160.7108 + 390.67050284 * k) * Math.PI / 180;
    jde += -0.40720 * Math.sin(Mp) + 0.17241 * Math.sin(M)
         + 0.01608 * Math.sin(2 * Mp) + 0.01039 * Math.sin(2 * F)
         + 0.00739 * Math.sin(Mp - M);
    return jde;
  };

  // 朔のJST日付 (y,m,d)
  const nmJST = (k) => {
    const ms = (newMoonJDE(k) - 2440587.5) * 86400000;
    const j = new Date(ms + 9 * 3600000);
    return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate() };
  };

  // JST日付
  const jst = new Date(date.getTime() + 9 * 3600000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth() + 1, d = jst.getUTCDate();
  const jdToday = JD(y, m, d);

  // 直前の朔を探す (JST日付ベース)
  let k = Math.floor((y + (m - 1) / 12 - 2000) * 12.3685) + 1;
  while (JD(nmJST(k).y, nmJST(k).m, nmJST(k).d) > jdToday) k--;
  // kが直前の朔。次の朔が今日以前なら進める
  while (JD(nmJST(k + 1).y, nmJST(k + 1).m, nmJST(k + 1).d) <= jdToday) k++;

  const cur = nmJST(k);
  const lunarDay = Math.round(jdToday - JD(cur.y, cur.m, cur.d)) + 1;

  // 旧暦正月朔: 雨水を含む朔月の朔
  const getNewYearK = (yr) => {
    const usui = JD(yr, 2, 19);
    let kk = Math.floor((yr + 1.5 / 12 - 2000) * 12.3685) + 1;
    // 雨水より後の最初の朔を探す
    while (JD(nmJST(kk).y, nmJST(kk).m, nmJST(kk).d) <= usui) kk++;
    return kk - 1; // 雨水を含む月の朔
  };

  const nyK = getNewYearK(y);
  let lunarMonth = k - nyK + 1;
  if (lunarMonth <= 0) lunarMonth = k - getNewYearK(y - 1) + 1;
  if (lunarMonth > 12) lunarMonth -= 12;
  if (lunarMonth < 1) lunarMonth = 1;

  const ROKUYO = ["大安", "赤口", "先勝", "友引", "先負", "仏滅"];
  const ROKUYO_EN = ["Taian", "Shakku", "Sensho", "Tomobiki", "Senbu", "Butsumetsu"];
  const ROKUYO_DESC = [
    "大吉日・万事良し",
    "正午のみ吉",
    "午前中が吉",
    "朝夕は吉、昼は凶",
    "午後が吉",
    "万事凶・慎む日",
  ];
  const idx = (lunarMonth + lunarDay) % 6;
  return { name: ROKUYO[idx], en: ROKUYO_EN[idx], desc: ROKUYO_DESC[idx], lunarMonth, lunarDay, idx };
}

/* ============================================================
   ASTRO SIDEBAR PANEL — 月・太陽詳細 (タブコンテンツ内サイドバー用)
   ============================================================ */
function AstroDetail({ now }) {
  const [pollenData, setPollenData] = useState(null);

  useEffect(() => {
    const jst = new Date(now.getTime() + 9 * 3600000);
    const m = jst.getUTCMonth() + 1;
    // 花粉シーズン: 1-6月のみ取得
    if (m < 1 || m > 6) { setPollenData(null); return; }
    let cancelled = false;
    fetchPollenTokyo().then((d) => { if (!cancelled) setPollenData(d); });
    const iv = setInterval(() => {
      fetchPollenTokyo().then((d) => { if (!cancelled) setPollenData(d); });
    }, 30 * 60 * 1000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  const moon = moonPhase(now);
  const airports = [
    { icao: "RJCC", name: "新千歳", lat: 42.7752, lng: 141.6920 },
    { icao: "RJAA", name: "成田", lat: 35.7647, lng: 140.3864 },
    { icao: "RJTT", name: "羽田", lat: 35.5494, lng: 139.7798 },
    { icao: "RJBB", name: "関西", lat: 34.4347, lng: 135.2440 },
    { icao: "RJFF", name: "福岡", lat: 33.5853, lng: 130.4508 },
    { icao: "ROAH", name: "那覇", lat: 26.1958, lng: 127.6461 },
  ];

  const jstDate = new Date(now.getTime() + 9 * 3600000);
  const month = jstDate.getUTCMonth() + 1;
  const year = jstDate.getUTCFullYear();

  // 24節気 (近似)
  const sekki = [
    [1, 6, "小寒"], [1, 20, "大寒"], [2, 4, "立春"], [2, 19, "雨水"],
    [3, 6, "啓蟄"], [3, 21, "春分"], [4, 5, "清明"], [4, 20, "穀雨"],
    [5, 6, "立夏"], [5, 21, "小満"], [6, 6, "芒種"], [6, 21, "夏至"],
    [7, 7, "小暑"], [7, 23, "大暑"], [8, 7, "立秋"], [8, 23, "処暑"],
    [9, 8, "白露"], [9, 23, "秋分"], [10, 8, "寒露"], [10, 23, "霜降"],
    [11, 7, "立冬"], [11, 22, "小雪"], [12, 7, "大雪"], [12, 22, "冬至"],
  ];
  const today = new Date(jstDate);
  today.setUTCHours(0, 0, 0, 0);
  const upcomingSekki = sekki
    .map(([m, d, n]) => ({ date: new Date(Date.UTC(year, m - 1, d)), name: n }))
    .concat(sekki.map(([m, d, n]) => ({ date: new Date(Date.UTC(year + 1, m - 1, d)), name: n })))
    .filter(s => s.date >= today)
    .sort((a, b) => a.date - b.date)
    .slice(0, 3);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* 月齢詳細 */}
      <div style={{ padding: "14px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px" }}>
        <div style={{ fontSize: "9px", color: "#334155", letterSpacing: "2px", marginBottom: "8px" }}>LUNAR STATUS</div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span style={{ fontSize: "40px" }}>{moon.emoji}</span>
          <div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: "#6ee7b7", fontFamily: "'JetBrains Mono', monospace", textShadow: "0 0 16px rgba(110,231,183,0.6)" }}>
              月齢 {moon.age}
            </div>
            <div style={{ fontSize: "13px", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace" }}>{lunarJpName(moon.age)} / {moon.name}</div>
          </div>
        </div>
        {/* 月相バー */}
        <div style={{ display: "flex", gap: "2px", marginTop: "10px" }}>
          {Array.from({ length: 30 }).map((_, i) => (
            <div key={i} style={{
              flex: 1, height: "6px", borderRadius: "1px",
              background: i < Math.round(moon.pct * 30) ? "#6ee7b7" : "rgba(110,231,183,0.08)",
              boxShadow: i < Math.round(moon.pct * 30) ? "0 0 4px rgba(110,231,183,0.3)" : "none",
            }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px" }}>
          <span style={{ fontSize: "8px", color: "#1e293b", fontFamily: "'JetBrains Mono', monospace" }}>🌑 NEW</span>
          <span style={{ fontSize: "8px", color: "#1e293b", fontFamily: "'JetBrains Mono', monospace" }}>🌕 FULL</span>
        </div>
      </div>

      {/* 日の出没テーブル */}
      <div style={{ padding: "14px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px" }}>
        <div style={{ fontSize: "9px", color: "#334155", letterSpacing: "2px", marginBottom: "8px" }}>SUNRISE / SUNSET (UTC)</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {airports.map(ap => {
              const s = sunriseSunset(now, ap.lat, ap.lng);
              return s ? (
                <tr key={ap.icao} style={{ borderBottom: "1px solid rgba(110,231,183,0.05)" }}>
                  <td style={{ padding: "4px 0", fontSize: "10px", color: "#6ee7b7", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{ap.icao}</td>
                  <td style={{ padding: "4px 0", fontSize: "10px", color: "#64748b", fontFamily: "'JetBrains Mono', monospace" }}>{ap.name}</td>
                  <td style={{ padding: "4px 0", fontSize: "10px", color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", textAlign: "right" }}>🌅{s.rise}z</td>
                  <td style={{ padding: "4px 0", fontSize: "10px", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace", textAlign: "right" }}>🌇{s.set}z</td>
                </tr>
              ) : null;
            })}
          </tbody>
        </table>
      </div>

      {/* 二十四節気 */}
      <div style={{ padding: "14px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px" }}>
        <div style={{ fontSize: "9px", color: "#334155", letterSpacing: "2px", marginBottom: "8px" }}>二十四節気 UPCOMING</div>
        {upcomingSekki.map((s, i) => {
          const jst = new Date(s.date.getTime());
          const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
          const dd = String(jst.getUTCDate()).padStart(2, "0");
          const diff = Math.round((s.date - today) / 86400000);
          return (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 0", borderBottom: i < 2 ? "1px solid rgba(110,231,183,0.05)" : "none" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: i === 0 ? "#6ee7b7" : "#475569", fontFamily: "'JetBrains Mono', monospace", textShadow: i === 0 ? "0 0 8px rgba(110,231,183,0.5)" : "none" }}>{s.name}</span>
              <span style={{ fontSize: "10px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>{mm}/{dd}</span>
              <span style={{ fontSize: "10px", color: i === 0 ? "#fbbf24" : "#334155", fontFamily: "'JetBrains Mono', monospace" }}>あと{diff}日</span>
            </div>
          );
        })}
      </div>

      {/* 六曜 */}
      {(() => {
        const rokuyo = getRokuyo(now);
        const rokuyoColors = ["#6ee7b7", "#ef4444", "#3b82f6", "#a855f7", "#f97316", "#64748b"];
        const rokuyoBg = ["rgba(110,231,183,0.08)", "rgba(239,68,68,0.08)", "rgba(59,130,246,0.08)", "rgba(168,85,247,0.08)", "rgba(249,115,22,0.08)", "rgba(100,116,139,0.08)"];
        // 7日分の六曜カレンダー
        const days = Array.from({ length: 7 }).map((_, i) => {
          const d = new Date(now.getTime() + i * 86400000);
          const r = getRokuyo(d);
          const jst = new Date(d.getTime() + 9 * 3600000);
          const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
          return { ...r, date: d, jstDay: jst.getUTCDate(), jstDow: dayNames[jst.getUTCDay()] };
        });
        return (
          <div style={{ padding: "14px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px" }}>
            <div style={{ fontSize: "9px", color: "#334155", letterSpacing: "2px", marginBottom: "8px" }}>六曜 ROKUYO</div>
            {/* 今日の六曜（大きく表示） */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "10px" }}>
              <div style={{
                padding: "6px 14px", borderRadius: "4px",
                background: rokuyoBg[rokuyo.idx],
                border: `1px solid ${rokuyoColors[rokuyo.idx]}40`,
              }}>
                <span style={{ fontSize: "20px", fontWeight: 700, color: rokuyoColors[rokuyo.idx], fontFamily: "'JetBrains Mono', monospace" }}>{rokuyo.name}</span>
              </div>
              <div>
                <div style={{ fontSize: "10px", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace" }}>{rokuyo.en}</div>
                <div style={{ fontSize: "9px", color: "#475569", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{rokuyo.desc}</div>
                <div style={{ fontSize: "8px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>旧暦 {rokuyo.lunarMonth}月{rokuyo.lunarDay}日</div>
              </div>
            </div>
            {/* 7日分ミニカレンダー */}
            <div style={{ display: "flex", gap: "3px" }}>
              {days.map((d, i) => (
                <div key={i} style={{
                  flex: 1, textAlign: "center", padding: "4px 2px", borderRadius: "3px",
                  background: i === 0 ? "rgba(110,231,183,0.1)" : "rgba(0,0,0,0.3)",
                  border: i === 0 ? "1px solid rgba(110,231,183,0.2)" : "1px solid transparent",
                }}>
                  <div style={{ fontSize: "8px", color: i === 0 ? "#6ee7b7" : "#475569", fontFamily: "'JetBrains Mono', monospace" }}>{d.jstDay}{d.jstDow}</div>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: rokuyoColors[d.idx], fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{d.name}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* 花粉飛散情報 */}
      {(() => {
        const jst = new Date(now.getTime() + 9 * 3600000);
        const m = jst.getUTCMonth() + 1;
        if (m < 1 || m > 6) return null; // シーズン外は非表示
        const info = pollenData ? POLLEN_LEVELS[pollenData.level] || POLLEN_LEVELS[99] : null;
        return (
          <div style={{ padding: "14px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px" }}>
            <div style={{ fontSize: "10px", color: "#e879f9", letterSpacing: "2px", marginBottom: "8px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>🌿 花粉 POLLEN</div>
            {pollenData && info ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: "32px" }}>{info.emoji}</span>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "16px", fontWeight: 700, color: info.color, fontFamily: "'JetBrains Mono', monospace" }}>{info.text}</div>
                  <div style={{ fontSize: "9px", color: "#475569", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>東京 / tenki.jp</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "10px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>
                データ取得中...
              </div>
            )}
          </div>
        );
      })()}

      {/* 暦情報 */}
      <div style={{ padding: "14px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px" }}>
        <div style={{ fontSize: "9px", color: "#334155", letterSpacing: "2px", marginBottom: "8px" }}>CALENDAR DATA</div>
        {[
          ["Day of Year", `DOY-${dayOfYear(now)} / 365`],
          ["Week No.", `第 ${weekNumber(now)} 週`],
          ["Julian Date", toJulian(now).toFixed(2)],
          ["Season (JST)", seasonEmoji(month)],
          ["UTC Offset", "JST = UTC+9:00"],
          ["ICAO Day", new Date(now).toISOString().slice(2, 10).replace(/-/g, "")],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
            <span style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>{k}</span>
            <span style={{ fontSize: "10px", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace" }}>{v}</span>
          </div>
        ))}
      </div>
      {/* 天気概況テキストはメインモニター直下のティッカーに移動済 */}
    </div>
  );
}

/* ============================================================
   JMA WEATHER OVERVIEW  — 気象庁 天気概況テキスト
   ============================================================ */
// JMA forecast overview area codes
const JMA_AREAS = [
  { code: "016000", name: "札幌", short: "CTS" },
  { code: "130000", name: "東京", short: "TYO" },
  { code: "230000", name: "名古屋", short: "NGO" },
  { code: "270000", name: "大阪", short: "OSA" },
  { code: "400000", name: "福岡", short: "FUK" },
  { code: "471000", name: "沖縄", short: "OKA" },
];

function JmaWeatherOverview() {
  const [areaIdx, setAreaIdx] = useState(0);
  const [overviews, setOverviews] = useState({});
  const [loading, setLoading] = useState({});
  const [error, setError] = useState({});
  const [ticker, setTicker] = useState(false); // ticker or fixed

  const fetchArea = useCallback(async (area) => {
    if (overviews[area.code] || loading[area.code]) return;
    setLoading(p => ({ ...p, [area.code]: true }));
    try {
      const r = await fetch(
        `https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${area.code}.json`
      );
      const j = await r.json();
      setOverviews(p => ({ ...p, [area.code]: j }));
    } catch {
      setError(p => ({ ...p, [area.code]: true }));
    } finally {
      setLoading(p => ({ ...p, [area.code]: false }));
    }
  }, [overviews, loading]);

  // Fetch current & adjacent on mount / area change
  useEffect(() => {
    JMA_AREAS.forEach(a => fetchArea(a));
  }, []); // eslint-disable-line

  const area = JMA_AREAS[areaIdx];
  const data = overviews[area.code];
  const isLoad = loading[area.code];
  const isErr = error[area.code];

  // Format report time
  const reportTime = data?.reportDatetime
    ? new Date(data.reportDatetime).toLocaleString("ja-JP", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
      hour12: false,
    }) + " 発表"
    : "";

  // Paragraphs (split on \n\n)
  const paragraphs = data?.text ? data.text.replace(/　/g, "").split(/\n\n+/).filter(Boolean) : [];

  return (
    <div style={{ padding: "14px", background: "rgba(5,10,20,0.9)", border: "1px solid rgba(110,231,183,0.15)", borderRadius: "4px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div style={{ fontSize: "9px", color: "#334155", letterSpacing: "2px", fontFamily: "'JetBrains Mono', monospace" }}>
          JMA WEATHER OVERVIEW
        </div>
        <button
          onClick={() => setTicker(t => !t)}
          style={{
            padding: "2px 8px",
            background: ticker ? "rgba(110,231,183,0.1)" : "transparent",
            border: `1px solid ${ticker ? "rgba(110,231,183,0.4)" : "rgba(110,231,183,0.1)"}`,
            borderRadius: "2px",
            color: ticker ? "#6ee7b7" : "#334155",
            fontSize: "8px", cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          {ticker ? "▶ TICKER" : "≡ TEXT"}
        </button>
      </div>

      {/* Area selector */}
      <div style={{ display: "flex", gap: "3px", flexWrap: "wrap", marginBottom: "8px" }}>
        {JMA_AREAS.map((a, i) => (
          <button key={a.code} onClick={() => setAreaIdx(i)} style={{
            padding: "3px 8px",
            background: areaIdx === i ? "rgba(110,231,183,0.12)" : "transparent",
            border: areaIdx === i ? "1px solid rgba(110,231,183,0.5)" : "1px solid rgba(110,231,183,0.08)",
            borderRadius: "2px",
            color: areaIdx === i ? "#6ee7b7" : "#475569",
            fontSize: "9px", cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "0.5px",
          }}>
            {a.short}
          </button>
        ))}
      </div>

      {/* Area name + time */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", alignItems: "baseline" }}>
        <span style={{ color: "#e2e8f0", fontSize: "12px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textShadow: "0 0 8px rgba(226,232,240,0.3)" }}>{area.name}</span>
        <span style={{ color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>{reportTime}</span>
      </div>

      {/* Headline */}
      {data?.headlineText && (
        <div style={{ padding: "5px 8px", marginBottom: "8px", background: "rgba(251,191,36,0.07)", border: "1px solid rgba(251,191,36,0.2)", borderRadius: "2px" }}>
          <span style={{ color: "#fbbf24", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>⚠ {data.headlineText}</span>
        </div>
      )}

      {/* Body */}
      {isLoad && (
        <div style={{ color: "#334155", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", textAlign: "center", padding: "20px 0" }}>
          LOADING...
        </div>
      )}
      {isErr && (
        <div style={{ color: "#f87171", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", textAlign: "center", padding: "12px 0" }}>
          FETCH ERROR
        </div>
      )}
      {data && !ticker && (
        <div style={{
          maxHeight: "120px", overflowY: "auto",
          paddingRight: "4px",
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(110,231,183,0.2) transparent",
        }}>
          {paragraphs.map((p, i) => (
            <p key={i} style={{
              margin: "0 0 8px",
              color: i === 0 ? "#94a3b8" : "#64748b",
              fontSize: "10px", lineHeight: "1.7",
              fontFamily: "'JetBrains Mono', monospace",
              borderLeft: i === 0 ? "2px solid rgba(110,231,183,0.3)" : "none",
              paddingLeft: i === 0 ? "8px" : "0",
            }}>
              {p}
            </p>
          ))}
        </div>
      )}
      {data && ticker && (
        <div style={{ overflow: "hidden", height: "20px", position: "relative" }}>
          <div style={{
            whiteSpace: "nowrap",
            animation: "ticker 40s linear infinite",
            color: "#6ee7b7", fontSize: "10px",
            fontFamily: "'JetBrains Mono', monospace",
            paddingLeft: "100%",
            textShadow: "0 0 8px rgba(110,231,183,0.4)",
          }}>
            {paragraphs.join("　◈　")}
          </div>
        </div>
      )}

      {/* Source */}
      <div style={{ marginTop: "8px", textAlign: "right" }}>
        <a href={`https://www.jma.go.jp/bosai/forecast/#area_type=offices&area_code=${area.code}`}
          target="_blank" rel="noopener noreferrer"
          style={{ color: "#1e293b", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none" }}>
          SRC: jma.go.jp ↗
        </a>
      </div>
    </div>
  );
}


const AIRPORT_GROUPS = [
  { region: "北海道・東北", airports: [
    { icao: "RJCC", name: "新千歳" }, { icao: "RJCB", name: "帯広" }, { icao: "RJCK", name: "釧路" },
    { icao: "RJCM", name: "女満別" }, { icao: "RJEC", name: "旭川" },
    { icao: "RJSA", name: "青森" }, { icao: "RJSS", name: "仙台" },
  ]},
  { region: "関東", airports: [
    { icao: "RJTT", name: "東京/羽田" }, { icao: "RJAA", name: "成田" },
  ]},
  { region: "中部・北陸", airports: [
    { icao: "RJGG", name: "中部" }, { icao: "RJNK", name: "小松" },
  ]},
  { region: "関西", airports: [
    { icao: "RJOO", name: "伊丹" }, { icao: "RJBB", name: "関西" },
  ]},
  { region: "中国・四国", airports: [
    { icao: "RJOB", name: "岡山" }, { icao: "RJOA", name: "広島" }, { icao: "RJDC", name: "山口宇部" },
    { icao: "RJOT", name: "高松" },
    { icao: "RJOS", name: "徳島" }, { icao: "RJOM", name: "松山" }, { icao: "RJOK", name: "高知" },
  ]},
  { region: "九州", airports: [
    { icao: "RJFF", name: "福岡" }, { icao: "RJFO", name: "大分" }, { icao: "RJFU", name: "長崎" },
    { icao: "RJFT", name: "熊本" }, { icao: "RJFM", name: "宮崎" }, { icao: "RJFK", name: "鹿児島" },
    { icao: "RJKA", name: "奄美大島" },
  ]},
  { region: "沖縄", airports: [
    { icao: "ROAH", name: "那覇" },
  ]},
  { region: "海外", airports: [
    { icao: "RCTP", name: "台北桃園" },
  ]},
];
const AIRPORTS = AIRPORT_GROUPS.flatMap(g => g.airports);

// Runway magnetic headings (SkyVector verified) — hdg = lower-numbered end true magnetic heading
const RUNWAY_DATA = {
  // 北海道
  RJCC: [{ rwy: "01L", hdg: 2 }, { rwy: "19R", hdg: 182 }],
  RJCB: [{ rwy: "17", hdg: 167 }, { rwy: "35", hdg: 347 }],
  RJCK: [{ rwy: "17", hdg: 168 }, { rwy: "35", hdg: 348 }],
  RJCM: [{ rwy: "18", hdg: 184 }, { rwy: "36", hdg: 4 }],
  RJEC: [{ rwy: "16", hdg: 164 }, { rwy: "34", hdg: 344 }],
  // 東北
  RJSA: [{ rwy: "06", hdg: 60 }, { rwy: "24", hdg: 240 }],
  RJSS: [{ rwy: "09/27", hdg: 91 }, { rwy: "12/30", hdg: 126 }],
  // 関東
  RJTT: [{ rwy: "05", hdg: 50 }, { rwy: "34R", hdg: 337 },
         { rwy: "16R", hdg: 157 }, { rwy: "22", hdg: 222 }],
  RJAA: [{ rwy: "34L", hdg: 337 }, { rwy: "16R", hdg: 157 }],
  // 中部・北陸
  RJGG: [{ rwy: "18", hdg: 176 }, { rwy: "36", hdg: 356 }],
  RJNK: [{ rwy: "06", hdg: 63 }, { rwy: "24", hdg: 243 }],
  // 関西
  RJOO: [{ rwy: "32L", hdg: 323 }, { rwy: "14R", hdg: 143 }],
  RJBB: [{ rwy: "06R", hdg: 58 }, { rwy: "24L", hdg: 238 }],
  // 中国・四国
  RJOB: [{ rwy: "07", hdg: 67 }, { rwy: "25", hdg: 247 }],
  RJOA: [{ rwy: "10", hdg: 97 }, { rwy: "28", hdg: 277 }],
  RJDC: [{ rwy: "07", hdg: 69 }, { rwy: "25", hdg: 249 }],
  RJOT: [{ rwy: "08", hdg: 80 }, { rwy: "26", hdg: 260 }],
  RJOS: [{ rwy: "11", hdg: 110 }, { rwy: "29", hdg: 290 }],
  RJOM: [{ rwy: "14", hdg: 137 }, { rwy: "32", hdg: 317 }],
  RJOK: [{ rwy: "14", hdg: 137 }, { rwy: "32", hdg: 317 }],
  // 九州
  RJFF: [{ rwy: "16L", hdg: 157 }, { rwy: "34R", hdg: 337 }],
  RJFO: [{ rwy: "01", hdg: 7 }, { rwy: "19", hdg: 187 }],
  RJFU: [{ rwy: "14", hdg: 145 }, { rwy: "32", hdg: 325 }],
  RJFT: [{ rwy: "07", hdg: 72 }, { rwy: "25", hdg: 252 }],
  RJFM: [{ rwy: "09", hdg: 92 }, { rwy: "27", hdg: 272 }],
  RJFK: [{ rwy: "16", hdg: 157 }, { rwy: "34", hdg: 337 }],
  RJKA: [{ rwy: "03", hdg: 31 }, { rwy: "21", hdg: 211 }],
  // 沖縄
  ROAH: [{ rwy: "18R", hdg: 183 }, { rwy: "36L", hdg: 3 }],
  // 海外
  RCTP: [{ rwy: "05L/23R", hdg: 54 }, { rwy: "05R/23L", hdg: 54 }],
};

// Parse METAR wind token → { dir, speed, gust, isCalm, isVrb }
function parseMetarWind(metarRaw) {
  if (!metarRaw) return null;
  const m = metarRaw.match(/\b(\d{3}|VRB)(P?\d{2,3})(G(P?\d{2,3}))?KT\b/);
  if (!m) return null;
  const dirStr = m[1];
  const speed = parseInt(m[2].replace("P", ""), 10);
  const gust = m[4] ? parseInt(m[4].replace("P", ""), 10) : null;
  if (dirStr === "VRB") return { dir: 0, speed, gust, isCalm: false, isVrb: true };
  const dir = parseInt(dirStr, 10);
  if (dir === 0 && speed === 0) return { dir: 0, speed: 0, gust: null, isCalm: true, isVrb: false };
  return { dir, speed, gust, isCalm: false, isVrb: false };
}

// Calculate crosswind & tailwind components for each unique runway heading
function calcWindComponents(windDir, windSpeed, gustSpeed, runways) {
  const deg2rad = Math.PI / 180;
  // Deduplicate by heading (parallel runways share same hdg)
  const seen = new Map();
  for (const r of runways) {
    if (!seen.has(r.hdg)) seen.set(r.hdg, r);
  }
  const unique = [...seen.values()];

  const results = unique.map(r => {
    const calc = (hdg, spd) => {
      const diff = (windDir - hdg) * deg2rad;
      return { xw: spd * Math.sin(diff), hw: spd * Math.cos(diff) };
    };
    const isFixedEnd = !r.rwy.includes("/");
    let chosen, chosenHdg, rwyName;

    if (isFixedEnd) {
      // Fixed runway end — use specified heading directly
      chosenHdg = r.hdg;
      chosen = calc(chosenHdg, windSpeed);
      rwyName = r.rwy;
    } else {
      // Both ends — pick the one with more headwind
      const hdg1 = r.hdg;
      const hdg2 = (r.hdg + 180) % 360;
      const c1 = calc(hdg1, windSpeed);
      const c2 = calc(hdg2, windSpeed);
      const useEnd2 = c2.hw > c1.hw;
      chosen = useEnd2 ? c2 : c1;
      chosenHdg = useEnd2 ? hdg2 : hdg1;
      const parts = r.rwy.split("/");
      rwyName = useEnd2 ? parts[1] : parts[0];
    }

    // Gust components
    let gustXw = null;
    if (gustSpeed) {
      const gc = calc(chosenHdg, gustSpeed);
      gustXw = gc.xw;
    }

    const tailwind = chosen.hw < 0 ? Math.abs(chosen.hw) : 0;
    return {
      rwyName,
      hdg: chosenHdg,
      xw: chosen.xw,           // positive = right, negative = left
      tailwind,                 // 0 if headwind
      gustXw,
    };
  });

  // Sort by |crosswind| ascending → best runway first
  results.sort((a, b) => Math.abs(a.xw) - Math.abs(b.xw));
  return results;
}

// Crosswind severity color
function crosswindSeverity(xwKt) {
  const abs = Math.abs(xwKt);
  if (abs < 10) return "#6ee7b7";
  if (abs < 15) return "#60a5fa";
  if (abs < 20) return "#fbbf24";
  return "#f87171";
}

const IATA_TO_ICAO = {
  HND: "RJTT", NRT: "RJAA", CTS: "RJCC", OBO: "RJCB", AKJ: "RJEC",
  AOJ: "RJSA", OKJ: "RJOB", MYJ: "RJOM", FUK: "RJFF", ITM: "RJOO",
  NGO: "RJGG", NGS: "RJFU", TAK: "RJOT", KMI: "RJFM", KMQ: "RJNK",
  OIT: "RJFO", TPE: "RCTP",
};
function iataToIcao(iata) { return IATA_TO_ICAO[iata?.toUpperCase()] || null; }

function Clock() {
  const [time, setTime] = useState(new Date());
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    const iv = setInterval(() => { setTime(new Date()); setBlink((b) => !b); }, 1000);
    return () => clearInterval(iv);
  }, []);
  const utcH = time.getUTCHours().toString().padStart(2, "0");
  const utcM = time.getUTCMinutes().toString().padStart(2, "0");
  const utcS = time.getUTCSeconds().toString().padStart(2, "0");
  const jst = time.toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  const utcDate = time.toISOString().slice(0, 10);

  // METAR更新カウントダウン（毎時00分・30分に更新）
  const utcMin = time.getUTCMinutes();
  const utcSec = time.getUTCSeconds();
  const nextMetar = utcMin < 30 ? 30 - utcMin : 60 - utcMin;
  const countdownMin = nextMetar - 1;
  const countdownSec = 60 - utcSec;
  const totalRemainSec = countdownMin * 60 + countdownSec;
  const metarCountdown = totalRemainSec <= 0
    ? "NOW"
    : `${String(Math.floor(totalRemainSec / 60)).padStart(2, "0")}:${String(totalRemainSec % 60).padStart(2, "0")}`;
  const metarUrgent = totalRemainSec <= 120; // 2分以内

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "2px" }}>
      {/* メインUTC時計 — 大型中央配置 */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <div style={{
            width: "7px", height: "7px", borderRadius: "50%",
            background: blink ? "#6ee7b7" : "transparent",
            boxShadow: blink ? "0 0 10px #6ee7b7, 0 0 20px rgba(110,231,183,0.4)" : "none",
            transition: "all 0.3s ease",
          }} />
          <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>LIVE</span>
        </div>
        <div>
          <span style={{
            color: "#6ee7b7", fontSize: "36px", fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 700, letterSpacing: "4px",
            textShadow: "0 0 20px rgba(110, 231, 183, 0.8), 0 0 40px rgba(110, 231, 183, 0.3)",
          }}>
            {utcH}<span style={{ opacity: blink ? 1 : 0.3, transition: "opacity 0.3s" }}>:</span>{utcM}<span style={{ opacity: blink ? 1 : 0.3, transition: "opacity 0.3s" }}>:</span>{utcS}
          </span>
          <span style={{ color: "#6ee7b7", fontSize: "11px", marginLeft: "8px", opacity: 0.6, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>UTC</span>
        </div>
      </div>
      {/* サブ情報行 */}
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <span style={{ color: "#334155", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>{utcDate}</span>
        <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>|</span>
        <span style={{ color: "#64748b", fontSize: "12px", fontFamily: "'JetBrains Mono', monospace" }}>{jst} <span style={{ opacity: 0.5, fontSize: "10px" }}>JST</span></span>
        <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>|</span>
        {/* METAR更新カウントダウン */}
        <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
          <span style={{ fontSize: "8px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>NEXT METAR</span>
          <span style={{
            fontSize: "11px", fontWeight: 700,
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "1px",
            color: metarUrgent ? "#fbbf24" : "#6ee7b7",
            textShadow: metarUrgent ? "0 0 8px rgba(251,191,36,0.6)" : "0 0 6px rgba(110,231,183,0.4)",
            animation: metarUrgent ? "statusBlink 1s ease infinite" : "none",
          }}>T-{metarCountdown}</span>
        </div>
      </div>
    </div>
  );
}

/* ========== WORLD CLOCK BAR — アナログ時計（東→西） ========== */
function MiniAnalogClock({ hours, minutes, seconds, size = 36, color = "#6ee7b7", isNight = false }) {
  const cx = size / 2;
  const r = size / 2 - 2;
  const hAngle = ((hours % 12) + minutes / 60) * 30 - 90;
  const mAngle = (minutes + seconds / 60) * 6 - 90;
  const sAngle = seconds * 6 - 90;
  const hand = (angle, len, w, col) => {
    const rad = (angle * Math.PI) / 180;
    return <line x1={cx} y1={cx} x2={cx + Math.cos(rad) * len} y2={cx + Math.sin(rad) * len} stroke={col} strokeWidth={w} strokeLinecap="round" />;
  };
  const opacity = isNight ? 0.45 : 1;
  return (
    <svg width={size} height={size} style={{ opacity }}>
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={color} strokeWidth="0.8" opacity="0.3" />
      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => {
        const a = (i * 30 - 90) * Math.PI / 180;
        const len = i % 3 === 0 ? 3 : 1.5;
        return <line key={i} x1={cx + Math.cos(a) * (r - len)} y1={cx + Math.sin(a) * (r - len)} x2={cx + Math.cos(a) * r} y2={cx + Math.sin(a) * r} stroke={color} strokeWidth={i % 3 === 0 ? "0.8" : "0.4"} opacity="0.5" />;
      })}
      {hand(hAngle, r * 0.5, 1.5, color)}
      {hand(mAngle, r * 0.75, 1, color)}
      {hand(sAngle, r * 0.7, 0.4, "#ef4444")}
      <circle cx={cx} cy={cx} r="1.2" fill={color} />
    </svg>
  );
}

function WorldClockBar() {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const iv = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);

  const cities = [
    { label: "TYO", tz: "Asia/Tokyo", color: "#6ee7b7" },
    { label: "PEK", tz: "Asia/Shanghai", color: "#94a3b8" },
    { label: "BKK", tz: "Asia/Bangkok", color: "#94a3b8" },
    { label: "DEL", tz: "Asia/Kolkata", color: "#94a3b8" },
    { label: "DXB", tz: "Asia/Dubai", color: "#94a3b8" },
    { label: "UTC", tz: "UTC", color: "#fbbf24" },
    { label: "LON", tz: "Europe/London", color: "#94a3b8" },
    { label: "PAR", tz: "Europe/Paris", color: "#94a3b8" },
    { label: "NYC", tz: "America/New_York", color: "#94a3b8" },
    { label: "LAX", tz: "America/Los_Angeles", color: "#94a3b8" },
    { label: "ANC", tz: "America/Anchorage", color: "#94a3b8" },
    { label: "HNL", tz: "Pacific/Honolulu", color: "#94a3b8" },
  ];

  return (
    <div style={{
      display: "flex", justifyContent: "center", gap: "0",
      background: "rgba(0,0,0,0.5)",
      borderBottom: "1px solid rgba(110,231,183,0.06)",
      padding: "4px 0",
    }}>
      {cities.map((c, i) => {
        const tStr = time.toLocaleTimeString("en-GB", { timeZone: c.tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        const [hh, mm, ss] = tStr.split(":").map(Number);
        const isNight = hh < 6 || hh >= 19;
        const digital = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
        return (
          <div key={c.label} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: "1px",
            padding: "0 8px",
            borderRight: i < cities.length - 1 ? "1px solid rgba(110,231,183,0.06)" : "none",
          }}>
            <span style={{
              fontSize: "7px",
              color: c.label === "UTC" ? "#fbbf24" : c.label === "TYO" ? "#6ee7b7" : "#475569",
              fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1.5px",
              fontWeight: c.label === "UTC" || c.label === "TYO" ? 700 : 400,
            }}>{c.label}</span>
            <MiniAnalogClock hours={hh} minutes={mm} seconds={ss} size={32} color={c.color} isNight={isNight} />
            <span style={{
              fontSize: "8px",
              color: c.color,
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: c.label === "UTC" || c.label === "TYO" ? 700 : 400,
              opacity: isNight ? 0.45 : 0.8,
            }}>{digital}{isNight ? " ☾" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

/* HUD panel decorator */
function PanelFrame({ children, title, code, style = {} }) {
  return (
    <div style={{
      position: "relative",
      background: "rgba(5, 10, 20, 0.7)",
      border: "1px solid rgba(110, 231, 183, 0.15)",
      borderRadius: "4px",
      ...style,
    }}>
      {/* corner brackets */}
      {[[0, 0], [0, 1], [1, 0], [1, 1]].map(([t, l], i) => (
        <div key={i} style={{
          position: "absolute",
          top: t ? "auto" : "-1px", bottom: t ? "-1px" : "auto",
          left: l ? "auto" : "-1px", right: l ? "-1px" : "auto",
          width: "12px", height: "12px",
          borderTop: t ? "none" : "2px solid #6ee7b7",
          borderBottom: t ? "2px solid #6ee7b7" : "none",
          borderLeft: l ? "none" : "2px solid #6ee7b7",
          borderRight: l ? "2px solid #6ee7b7" : "none",
        }} />
      ))}
      {title && (
        <div style={{
          position: "absolute", top: "-11px", left: "16px",
          background: "#050a14",
          padding: "0 8px",
          color: "#6ee7b7", fontSize: "9px", fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px",
          textShadow: "0 0 8px rgba(110,231,183,0.5)",
        }}>{title}</div>
      )}
      {code && (
        <div style={{
          position: "absolute", top: "-11px", right: "16px",
          background: "#050a14",
          padding: "0 8px",
          color: "#334155", fontSize: "9px",
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px",
        }}>{code}</div>
      )}
      {children}
    </div>
  );
}

function TabBtn({ active, onClick, children, icon, shortcut }) {
  return (
    <button onClick={onClick} style={{
      padding: "10px 20px",
      background: active ? "rgba(110, 231, 183, 0.10)" : "transparent",
      border: "none",
      borderBottom: active ? "2px solid #6ee7b7" : "2px solid transparent",
      color: active ? "#6ee7b7" : "#64748b",
      fontSize: "12px", fontWeight: active ? 700 : 500, cursor: "pointer",
      display: "flex", alignItems: "center", gap: "8px",
      transition: "all 0.15s ease",
      fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1.5px",
      textShadow: active ? "0 0 10px rgba(110,231,183,0.5)" : "none",
      position: "relative",
    }}>
      <span style={{ fontSize: "15px", opacity: active ? 1 : 0.6 }}>{icon}</span>
      <span>{children.toUpperCase?.() ?? children}</span>
      {shortcut && (
        <span style={{
          fontSize: "8px", color: active ? "#6ee7b780" : "#334155",
          fontFamily: "'JetBrains Mono', monospace",
          marginLeft: "2px",
        }}>{shortcut}</span>
      )}
    </button>
  );
}

function ExtLink({ href, children, accent }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 14px",
      background: accent ? "rgba(110, 231, 183, 0.07)" : "rgba(15, 23, 42, 0.6)",
      border: `1px solid ${accent ? "rgba(110, 231, 183, 0.3)" : "rgba(110, 231, 183, 0.08)"}`,
      borderRadius: "2px", color: accent ? "#6ee7b7" : "#94a3b8",
      fontSize: "11px", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace",
      transition: "all 0.15s ease", cursor: "pointer", letterSpacing: "0.5px",
    }}>
      {children}<span style={{ fontSize: "10px", opacity: 0.6 }}>↗</span>
    </a>
  );
}

/* ========== METAR QUICK STATUS — 主要空港ミニサマリ ========== */
const QUICK_AIRPORTS = [
  { icao: "RJCC", name: "千歳" },
  { icao: "RJAA", name: "成田" },
  { icao: "RJTT", name: "羽田" },
  { icao: "RJBB", name: "関西" },
  { icao: "RJFF", name: "福岡" },
  { icao: "ROAH", name: "那覇" },
];

function MetarQuickStatus() {
  const [data, setData] = useState({});

  useEffect(() => {
    const fetchAll = async () => {
      const icaos = QUICK_AIRPORTS.map(a => a.icao).join(",");
      try {
        const text = await fetchMetarRaw(icaos);
        const lines = text.split("\n").filter(Boolean);
        const parsed = {};
        for (let line of lines) {
          // AWC形式 "METAR RJTT..." / "SPECI RJTT..." のプレフィックス除去
          line = line.replace(/^(METAR|SPECI)\s+/, "");
          const icao = line.slice(0, 4);
          // 風抽出
          const windMatch = line.match(/\b(\d{3}|VRB)(\d{2,3})(G\d{2,3})?KT\b/);
          const wind = windMatch ? windMatch[0] : "---";
          // 視程抽出 — 風の後の最初の独立4桁数字が視程(m)
          const afterWind = line.replace(/.*?\d{3,5}(G\d{2,3})?KT\b/, "");
          const visMatch = afterWind.match(/\b(\d{4})\b/);
          const vis = visMatch ? visMatch[1] : "----";
          // 雲抽出（表示用=最低雲底、ceiling判定=BKN/OVC/VVのみ）
          const cloudMatches = [...line.matchAll(/(FEW|SCT|BKN|OVC|VV)(\d{3})/g)];
          const clouds = cloudMatches.length > 0 ? cloudMatches[0][0] : (line.includes("CAVOK") ? "CAVOK" : "---");
          const ceilingMatch = cloudMatches.find(m => /^(BKN|OVC|VV)/.test(m[0]));
          // 現象
          const wxMatch = line.match(/\b(\+?-?)(TS|TSRA|RA|SN|FG|BR|HZ|DZ|GR|SQ|FC|SS|DS|FZRA|FZDZ|SHRA|SHSN)\b/);
          const wx = wxMatch ? wxMatch[0] : "";
          // ステータス判定 — FAA基準: LIFR <500ft/<1SM, IFR <1000ft/<3SM, MVFR <3000ft/<5SM
          const visNum = parseInt(vis, 10);
          const ceilFt = ceilingMatch ? parseInt(ceilingMatch[2], 10) * 100 : 99999;
          let status = "VFR";
          let statusColor = "#6ee7b7";
          if (visNum < 1600 || ceilFt < 500) { status = "LIFR"; statusColor = "#c084fc"; }
          else if (visNum < 4800 || ceilFt < 1000) { status = "IFR"; statusColor = "#f87171"; }
          else if (visNum < 8000 || ceilFt < 3000) { status = "MVFR"; statusColor = "#60a5fa"; }
          if (line.includes("CAVOK")) { status = "VFR"; statusColor = "#6ee7b7"; }

          parsed[icao] = { wind, vis, clouds, wx, status, statusColor, raw: line };
        }
        setData(parsed);
      } catch { /* silent */ }
    };
    fetchAll();
    const iv = setInterval(fetchAll, 120000);
    return () => clearInterval(iv);
  }, []);

  return (
    <PanelFrame title="METAR STATUS" code="QCK" style={{ padding: "0" }}>
      <div style={{ padding: "14px 10px 6px" }}>
        {QUICK_AIRPORTS.map(ap => {
          const d = data[ap.icao];
          return (
            <div key={ap.icao} style={{
              display: "flex", alignItems: "center", gap: "6px",
              padding: "5px 6px",
              borderBottom: "1px solid rgba(110,231,183,0.05)",
            }}>
              {/* ステータスドット */}
              <div style={{
                width: "6px", height: "6px", borderRadius: "50%", flexShrink: 0,
                background: d?.statusColor ?? "#334155",
                boxShadow: d ? `0 0 6px ${d.statusColor}` : "none",
              }} />
              {/* ICAO */}
              <span style={{
                fontSize: "10px", fontWeight: 700, color: "#6ee7b7",
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "1px", width: "36px", flexShrink: 0,
              }}>{ap.icao}</span>
              {d ? (
                <div style={{ display: "flex", alignItems: "center", gap: "5px", flex: 1, overflow: "hidden" }}>
                  {/* フライトカテゴリ */}
                  <span style={{
                    fontSize: "8px", fontWeight: 700, color: d.statusColor,
                    fontFamily: "'JetBrains Mono', monospace",
                    padding: "1px 4px", borderRadius: "1px",
                    background: `${d.statusColor}18`,
                    border: `1px solid ${d.statusColor}40`,
                    letterSpacing: "1px", flexShrink: 0,
                  }}>{d.status}</span>
                  {/* 風 */}
                  <span style={{ fontSize: "9px", color: "#60a5fa", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{d.wind}</span>
                  {/* 雲 */}
                  <span style={{ fontSize: "9px", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{d.clouds}</span>
                  {/* 現象 */}
                  {d.wx && <span style={{ fontSize: "9px", color: "#f87171", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, flexShrink: 0 }}>{d.wx}</span>}
                </div>
              ) : (
                <span style={{ fontSize: "9px", color: "#1e293b", fontFamily: "'JetBrains Mono', monospace" }}>---</span>
              )}
            </div>
          );
        })}
      </div>
      {/* 凡例 */}
      <div style={{
        display: "flex", gap: "8px", padding: "4px 10px 8px", flexWrap: "wrap",
        borderTop: "1px solid rgba(110,231,183,0.05)",
      }}>
        {[
          { label: "VFR", color: "#6ee7b7" },
          { label: "MVFR", color: "#60a5fa" },
          { label: "IFR", color: "#f87171" },
          { label: "LIFR", color: "#c084fc" },
        ].map(c => (
          <div key={c.label} style={{ display: "flex", alignItems: "center", gap: "3px" }}>
            <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: c.color }} />
            <span style={{ fontSize: "7px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.5px" }}>{c.label}</span>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}

/* ========== UPPER-AIR DATA TABLE — PRIMARY DISPLAY下 ========== */
function UpperAirTable() {
  const [airportData, setAirportData] = useState({});
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);

  const jstNow = new Date(Date.now() + 9 * 3600000);
  const month = jstNow.getUTCMonth() + 1;
  const isWinter = month <= 2 || month === 12;
  const isSummer = month >= 6 && month <= 9;

  const fetchAirportData = useCallback(async () => {
    setDataLoading(true);
    setDataError(null);
    try {
      const results = {};
      await Promise.all(OPS_AIRPORTS.map(async (ap) => {
        const url = `https://api.open-meteo.com/v1/forecast`
          + `?latitude=${ap.lat}&longitude=${ap.lon}`
          + `&hourly=windspeed_300hPa,winddirection_300hPa`
          + `,windspeed_250hPa,winddirection_250hPa`
          + `,temperature_850hPa,cape`
          + `&forecast_days=1&timezone=UTC`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${ap.icao}: HTTP ${res.status}`);
        const json = await res.json();
        const idx = Math.min(new Date().getUTCHours(), (json.hourly?.time?.length ?? 1) - 1);
        const toKt = (v) => v != null ? Math.round(v * 0.539957) : null;
        results[ap.icao] = {
          wind300spd: toKt(json.hourly?.windspeed_300hPa?.[idx]),
          wind300dir: json.hourly?.winddirection_300hPa?.[idx] != null ? Math.round(json.hourly.winddirection_300hPa[idx]) : null,
          wind250spd: toKt(json.hourly?.windspeed_250hPa?.[idx]),
          wind250dir: json.hourly?.winddirection_250hPa?.[idx] != null ? Math.round(json.hourly.winddirection_250hPa[idx]) : null,
          temp850: json.hourly?.temperature_850hPa?.[idx] != null ? Math.round(json.hourly.temperature_850hPa[idx] * 10) / 10 : null,
          cape: json.hourly?.cape?.[idx] != null ? Math.round(json.hourly.cape[idx]) : null,
        };
      }));
      setAirportData(results);
      setLastFetch(new Date());
    } catch (e) {
      setDataError(e.message);
    } finally {
      setDataLoading(false);
    }
  }, []);

  const fetchRef = useRef(fetchAirportData);
  useEffect(() => { fetchRef.current = fetchAirportData; }, [fetchAirportData]);
  useEffect(() => {
    fetchRef.current();
    const iv = setInterval(() => fetchRef.current(), 600000);
    return () => clearInterval(iv);
  }, []);

  const fmtWind = (dir, spd) => {
    if (dir == null || spd == null) return "---/---KT";
    return `${String(dir).padStart(3, "0")}/${String(spd).padStart(3, "0")}KT`;
  };
  const jetColor = (spd) => {
    if (spd == null) return "#475569";
    if (spd >= 120) return "#f87171";
    if (spd >= 80) return "#fbbf24";
    if (spd >= 50) return "#6ee7b7";
    return "#94a3b8";
  };
  const temp850Color = (t) => {
    if (t == null) return "#475569";
    if (t <= -15) return "#c084fc";
    if (t <= -6) return "#60a5fa";
    if (t <= 0) return "#93c5fd";
    if (t >= 24) return "#f87171";
    return "#94a3b8";
  };
  const capeColor = (c) => {
    if (c == null) return "#475569";
    if (c >= 2500) return "#f87171";
    if (c >= 1000) return "#fbbf24";
    if (c >= 300) return "#fde68a";
    return "#94a3b8";
  };

  return (
    <PanelFrame title={`UPPER-AIR DATA${isWinter ? " ❄️" : isSummer ? " ⚡" : ""}`} code="UA-TBL" style={{ padding: "0" }}>
      {/* ヘッダー */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 12px", background: "rgba(0,0,0,0.4)",
        borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <div style={{
            width: "5px", height: "5px", borderRadius: "50%",
            background: dataLoading ? "#fbbf24" : dataError ? "#f87171" : "#6ee7b7",
            boxShadow: `0 0 6px ${dataLoading ? "#fbbf24" : dataError ? "#f87171" : "#6ee7b7"}`,
          }} />
          <span style={{ color: "#475569", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>
            {dataLoading ? "FETCHING..." : dataError ? "ERROR" : "OPEN-METEO ECMWF"}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {lastFetch && <span style={{ color: "#334155", fontSize: "7px", fontFamily: "'JetBrains Mono', monospace" }}>UPD {lastFetch.toISOString().slice(11, 16)}Z</span>}
          <button onClick={() => fetchRef.current()} style={{
            padding: "2px 6px", background: "rgba(110,231,183,0.06)",
            border: "1px solid rgba(110,231,183,0.15)", borderRadius: "2px",
            color: "#6ee7b7", fontSize: "7px", cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
          }}>↻</button>
        </div>
      </div>

      {/* テーブル */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace" }}>
          <thead>
            <tr style={{ background: "rgba(0,0,0,0.5)", borderBottom: "1px solid rgba(110,231,183,0.15)" }}>
              {["ICAO", "300hPa", "250hPa", "850T", "CAPE"].map((h, i) => (
                <th key={h} style={{
                  padding: "5px 8px", textAlign: i === 0 ? "left" : "right",
                  color: (isWinter && h === "850T") ? "#60a5fa" : (isSummer && h === "CAPE") ? "#fbbf24" : "#334155",
                  fontSize: "7px", letterSpacing: "1px", fontWeight: 700,
                  background: (isWinter && h === "850T") ? "rgba(96,165,250,0.06)" : (isSummer && h === "CAPE") ? "rgba(251,191,36,0.06)" : "transparent",
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {OPS_AIRPORTS.map((ap, ri) => {
              const d = airportData[ap.icao] || {};
              return (
                <tr key={ap.icao} style={{
                  borderBottom: "1px solid rgba(110,231,183,0.04)",
                  background: ri % 2 === 0 ? "rgba(255,255,255,0.01)" : "transparent",
                }}>
                  <td style={{ padding: "4px 8px", fontSize: "9px", fontWeight: 700, color: "#6ee7b7" }}>
                    {ap.icao}<span style={{ marginLeft: "4px", fontSize: "7px", color: "#334155", fontWeight: 400 }}>{ap.name}</span>
                  </td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontSize: "9px", color: jetColor(d.wind300spd) }}>{fmtWind(d.wind300dir, d.wind300spd)}</td>
                  <td style={{ padding: "4px 8px", textAlign: "right", fontSize: "9px", color: jetColor(d.wind250spd) }}>{fmtWind(d.wind250dir, d.wind250spd)}</td>
                  <td style={{
                    padding: "4px 8px", textAlign: "right", fontSize: "9px",
                    fontWeight: isWinter ? 700 : 400, color: temp850Color(d.temp850),
                    background: isWinter ? "rgba(96,165,250,0.04)" : "transparent",
                  }}>
                    {d.temp850 != null ? `${d.temp850 > 0 ? "+" : ""}${d.temp850}` : "---"}
                  </td>
                  <td style={{
                    padding: "4px 8px", textAlign: "right", fontSize: "9px",
                    fontWeight: isSummer ? 700 : 400, color: capeColor(d.cape),
                    background: isSummer ? "rgba(251,191,36,0.04)" : "transparent",
                  }}>
                    {d.cape != null ? d.cape : "---"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div style={{
        display: "flex", gap: "8px", padding: "4px 10px", flexWrap: "wrap",
        borderTop: "1px solid rgba(110,231,183,0.05)", background: "rgba(0,0,0,0.3)",
      }}>
        <span style={{ fontSize: "7px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>JET:</span>
        {[{ l: ">120kt", c: "#f87171" }, { l: "80-120", c: "#fbbf24" }, { l: "50-80", c: "#6ee7b7" }].map(x => (
          <div key={x.l} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            <div style={{ width: "3px", height: "3px", borderRadius: "50%", background: x.c }} />
            <span style={{ fontSize: "6px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>{x.l}</span>
          </div>
        ))}
        <span style={{ color: "#1e293b", fontSize: "7px" }}>│</span>
        <span style={{ fontSize: "7px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>850T:</span>
        {[{ l: "<-15", c: "#c084fc" }, { l: "<-6", c: "#60a5fa" }, { l: "<0", c: "#93c5fd" }].map(x => (
          <div key={x.l} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
            <div style={{ width: "3px", height: "3px", borderRadius: "50%", background: x.c }} />
            <span style={{ fontSize: "6px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>{x.l}</span>
          </div>
        ))}
      </div>
    </PanelFrame>
  );
}

/* ========== JAPAN OVERVIEW — ALWAYS AT TOP ========== */
function JapanOverview() {
  const [overlayType, setOverlayType] = useState("jet300");

  const month = new Date().getMonth();
  const isSummer = month >= 5 && month <= 8; // Jun-Sep

  const overlays = [
    // --- OPS: パイロット重要情報 ---
    { key: "jet300", label: "JET 300", icon: "🌀", group: "ops",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=wind&product=ecmwf&level=300h&calendar=now&message=true" },
    { key: "jet250", label: "JET 250", icon: "🌀", group: "ops",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=wind&product=ecmwf&level=250h&calendar=now&message=true" },
    { key: "cold850", label: "850T", icon: "❄️", group: "ops",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=temp&product=ecmwf&level=850h&calendar=now&message=true" },
    { key: "cape", label: "CAPE", icon: "⚡", group: "ops",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=cape&product=ecmwf&level=surface&calendar=now&message=true" },
    { key: "pressure", label: "SFC PRES", icon: "🗺️", group: "ops",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=pressure&product=ecmwf&level=surface&calendar=now&message=true" },
    // --- SFC: 地上気象 ---
    { key: "radar", label: "RADAR", icon: "🌧️", group: "sfc",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=36.5&lon=137&overlay=radar&product=radar&level=surface&calendar=now&message=true" },
    { key: "satellite", label: "SAT IR", icon: "🛰️", group: "sfc",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=36.5&lon=137&overlay=satellite&product=satellite&level=surface&calendar=now&message=true" },
    { key: "wind", label: "SFC WIND", icon: "💨", group: "sfc",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=36.5&lon=137&overlay=wind&product=ecmwf&level=surface&calendar=now&message=true" },
    { key: "cloud", label: "CLOUD", icon: "☁️", group: "sfc",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=36.5&lon=137&overlay=clouds&product=ecmwf&level=surface&calendar=now&message=true" },
    { key: "turb", label: "CAT", icon: "🔶", group: "sfc",
      src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=140&overlay=turbulence&product=ecmwf&level=300h&calendar=now&message=true" },
  ];

  const opsOverlays = overlays.filter(o => o.group === "ops");
  const sfcOverlays = overlays.filter(o => o.group === "sfc");

  const current = overlays.find((o) => o.key === overlayType) ?? overlays[0];

  return (
    <div style={{ marginBottom: "24px" }}>
      <PanelFrame title="PRIMARY SURVEILLANCE DISPLAY" code="SECT-01" style={{ padding: "0" }}>
        {/* Overlay control bar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", flexWrap: "wrap", gap: "8px",
          borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
          background: "rgba(0,0,0,0.4)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ee7b7", boxShadow: "0 0 8px #6ee7b7" }} />
            <span style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", textShadow: "0 0 8px rgba(110,231,183,0.5)" }}>JAPAN AREA MONITOR</span>
          </div>
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: "#f59e0b", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px", marginRight: "2px" }}>OPS</span>
            {opsOverlays.map((o) => (
              <button key={o.key} onClick={() => setOverlayType(o.key)} style={{
                padding: "4px 10px",
                background: overlayType === o.key ? "rgba(245, 158, 11, 0.15)" : "transparent",
                border: overlayType === o.key ? "1px solid rgba(245, 158, 11, 0.6)" : "1px solid rgba(110, 231, 183, 0.06)",
                borderRadius: "2px",
                color: overlayType === o.key ? "#f59e0b" : "#475569",
                fontSize: "10px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.5px",
                textShadow: overlayType === o.key ? "0 0 8px rgba(245,158,11,0.5)" : "none",
                transition: "all 0.15s ease",
              }}>
                {o.icon} {o.label}
              </button>
            ))}
            <div style={{ width: "1px", height: "18px", background: "rgba(110,231,183,0.15)", margin: "0 4px" }} />
            <span style={{ color: "#6ee7b7", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px", marginRight: "2px" }}>SFC</span>
            {sfcOverlays.map((o) => (
              <button key={o.key} onClick={() => setOverlayType(o.key)} style={{
                padding: "4px 10px",
                background: overlayType === o.key ? "rgba(110, 231, 183, 0.12)" : "transparent",
                border: overlayType === o.key ? "1px solid rgba(110, 231, 183, 0.5)" : "1px solid rgba(110, 231, 183, 0.06)",
                borderRadius: "2px",
                color: overlayType === o.key ? "#6ee7b7" : "#475569",
                fontSize: "10px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.5px",
                textShadow: overlayType === o.key ? "0 0 8px rgba(110,231,183,0.5)" : "none",
                transition: "all 0.15s ease",
              }}>
                {o.icon} {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Windy map */}
        <div style={{ position: "relative", background: "#000" }}>
          <iframe
            key={current.key}
            src={current.src}
            style={{ width: "100%", height: "480px", border: "none", display: "block" }}
            title={current.label}
            loading="lazy"
            allow="autoplay"
          />
          {/* HUD overlay corners on map */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none", boxShadow: "inset 0 0 60px rgba(0,0,0,0.4)" }} />
        </div>

        {/* Bottom link bar */}
        <div style={{
          display: "flex", gap: "4px", padding: "8px 14px", flexWrap: "wrap",
          borderTop: "1px solid rgba(110, 231, 183, 0.08)",
          background: "rgba(0,0,0,0.4)",
        }}>
          <ExtLink href="https://www.jma.go.jp/bosai/nowc/" accent>ナウキャスト</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/satellite/">衛星</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/weather_map/">ASAS天気図</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/numericmap/#type:aupq78">AUPQ78 500/300</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/numericmap/#type:aupq35">AUPQ35 850/700</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/numericmap/#type:analysis">大気解析</ExtLink>
          <ExtLink href="https://www.data.jma.go.jp/airinfo/data/awfo_maiji.html">空域悪天情報</ExtLink>
          <ExtLink href="https://himawari.asia/">ひまわりRT</ExtLink>
        </div>
      </PanelFrame>
    </div>
  );
}

/* ========== TODAY DUTY BAR（PSD直上表示） ========== */
function TodayDutyBar() {
  const [todayEvents, setTodayEvents] = useState([]);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    setTodayEvents(getTodayDutyEvents());
    const iv = setInterval(() => {
      setNow(new Date());
      setTodayEvents(getTodayDutyEvents());
    }, 10000);
    return () => clearInterval(iv);
  }, []);

  if (todayEvents.length === 0) return null;

  const currentEvent = todayEvents.find(e => now >= e.start && now < e.end);
  const flyEvents = todayEvents.filter(e => e.type === "FLY");
  const nextEvent = todayEvents.find(e => e.start > now);

  // Build full route
  const fullRoute = [];
  for (const ev of flyEvents) {
    if (ev.route) ev.route.forEach(c => { if (fullRoute.length === 0 || fullRoute[fullRoute.length - 1] !== c) fullRoute.push(c); });
  }

  const firstStart = todayEvents[0]?.start;
  const lastEnd = todayEvents[todayEvents.length - 1]?.end;

  const fmtZ = (d) => {
    if (!d) return "--:--Z";
    return d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0") + "Z";
  };
  const fmtL = (d) => {
    if (!d) return "--:--";
    const jst = new Date(d.getTime() + 9 * 3600000);
    return jst.getUTCHours().toString().padStart(2, "0") + ":" + jst.getUTCMinutes().toString().padStart(2, "0");
  };

  // Countdown
  const cdStr = (target) => {
    if (!target) return null;
    const diff = target - now;
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
  };

  // Timeline progress: compute position of each event on a normalized bar
  const totalSpan = lastEnd && firstStart ? lastEnd - firstStart : 1;
  const nowPct = firstStart && lastEnd && now >= firstStart && now <= lastEnd
    ? ((now - firstStart) / totalSpan) * 100
    : now > lastEnd ? 100 : 0;

  const mono = "'JetBrains Mono', 'Fira Code', monospace";

  // Determine if it's a rest day (only OFF events)
  const isRestDay = todayEvents.every(e => e.type === "OFF");
  if (isRestDay) {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: "12px",
        padding: "10px 16px", marginBottom: "8px",
        background: "rgba(5, 10, 20, 0.8)", border: "1px solid rgba(71,85,105,0.2)", borderRadius: "4px",
      }}>
        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#475569", flexShrink: 0 }} />
        <span style={{ color: "#475569", fontSize: "9px", fontWeight: 700, fontFamily: mono, letterSpacing: "2px" }}>TODAY</span>
        <span style={{ color: "#94a3b8", fontSize: "13px", fontFamily: mono }}>REST DAY</span>
      </div>
    );
  }

  return (
    <div style={{
      padding: "10px 16px", marginBottom: "8px",
      background: "rgba(5, 10, 20, 0.85)", border: "1px solid rgba(110, 231, 183, 0.12)", borderRadius: "4px",
    }}>
      {/* Row 1: Header + Route + Countdown */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
        {/* Status dot */}
        <div style={{
          width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0,
          background: currentEvent ? (DUTY_COLORS[currentEvent.type] || "#94a3b8") : "#334155",
          boxShadow: currentEvent ? `0 0 10px ${DUTY_COLORS[currentEvent.type]}` : "none",
          animation: currentEvent && currentEvent.type === "FLY" ? "statusBlink 2s ease infinite" : "none",
        }} />
        {/* Label */}
        <span style={{ color: "#6ee7b7", fontSize: "9px", fontWeight: 700, fontFamily: mono, letterSpacing: "2px", flexShrink: 0 }}>TODAY DUTY</span>
        {/* Current badge */}
        {currentEvent && (
          <span style={{
            background: DUTY_COLORS[currentEvent.type] || "#94a3b8",
            color: currentEvent.type === "OFF" ? "#e2e8f0" : "#030810",
            padding: "2px 8px", borderRadius: "2px", fontSize: "9px", fontWeight: 700, fontFamily: mono,
          }}>{currentEvent.type}</span>
        )}
        {/* Separator */}
        <div style={{ width: "1px", height: "16px", background: "rgba(110,231,183,0.12)" }} />
        {/* Route */}
        {fullRoute.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            {fullRoute.map((code, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                {i > 0 && <span style={{ color: "#334155", fontSize: "10px" }}>→</span>}
                <span style={{
                  color: currentEvent?.type === "FLY" && currentEvent.route?.includes(code) ? "#6ee7b7" : "#e2e8f0",
                  fontSize: "13px", fontWeight: 700, fontFamily: mono,
                }}>{code}</span>
              </span>
            ))}
          </div>
        )}
        {/* Spacer */}
        <div style={{ flex: 1 }} />
        {/* Countdown to next event */}
        {nextEvent && cdStr(nextEvent.start) && (
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
            <span style={{ color: "#475569", fontSize: "8px", fontFamily: mono, letterSpacing: "1px" }}>NEXT</span>
            <span style={{
              background: DUTY_COLORS[nextEvent.type] || "#94a3b8",
              color: nextEvent.type === "OFF" ? "#e2e8f0" : "#030810",
              padding: "1px 5px", borderRadius: "2px", fontSize: "8px", fontWeight: 700, fontFamily: mono,
            }}>{nextEvent.type}</span>
            <span style={{ color: "#fbbf24", fontSize: "12px", fontWeight: 700, fontFamily: mono }}>T-{cdStr(nextEvent.start)}</span>
          </div>
        )}
        {/* Time range */}
        <span style={{ color: "#475569", fontSize: "9px", fontFamily: mono, flexShrink: 0 }}>
          {fmtZ(firstStart)}–{fmtZ(lastEnd)} / {fmtL(firstStart)}–{fmtL(lastEnd)}L
        </span>
      </div>

      {/* Row 2: Visual Timeline Bar */}
      <div style={{ position: "relative", height: "22px", background: "rgba(15,23,42,0.6)", borderRadius: "3px", overflow: "hidden" }}>
        {/* Event segments */}
        {todayEvents.map((ev, i) => {
          const evStart = Math.max(ev.start.getTime(), firstStart.getTime());
          const evEnd = Math.min(ev.end.getTime(), lastEnd.getTime());
          const left = ((evStart - firstStart.getTime()) / totalSpan) * 100;
          const width = ((evEnd - evStart) / totalSpan) * 100;
          const col = DUTY_COLORS[ev.type] || "#94a3b8";
          const isCurrent = currentEvent && currentEvent.uid === ev.uid;
          return (
            <div key={i} style={{
              position: "absolute", top: "2px", bottom: "2px",
              left: `${left}%`, width: `${Math.max(width, 0.5)}%`,
              background: isCurrent ? col : `${col}33`,
              border: isCurrent ? `1px solid ${col}` : `1px solid ${col}22`,
              borderRadius: "2px",
              display: "flex", alignItems: "center", justifyContent: "center",
              overflow: "hidden",
              boxShadow: isCurrent ? `0 0 8px ${col}55` : "none",
            }}>
              {width > 8 && (
                <span style={{
                  color: isCurrent ? (ev.type === "OFF" ? "#e2e8f0" : "#030810") : col,
                  fontSize: "7px", fontWeight: 700, fontFamily: mono,
                  whiteSpace: "nowrap", letterSpacing: "0.5px",
                }}>
                  {ev.type === "FLY" && ev.route.length > 0 ? ev.route.join("-") : ev.type}
                </span>
              )}
            </div>
          );
        })}
        {/* Now marker */}
        {nowPct > 0 && nowPct < 100 && (
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: `${nowPct}%`,
            width: "2px", background: "#ef4444", boxShadow: "0 0 6px #ef4444",
            zIndex: 2,
          }}>
            <div style={{
              position: "absolute", top: "-3px", left: "-3px",
              width: "8px", height: "8px", borderRadius: "50%",
              background: "#ef4444", border: "1px solid #030810",
            }} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ========== WIND COMPONENT DISPLAY ========== */
function CrosswindDisplay({ icao, metarRaw }) {
  const runways = RUNWAY_DATA[icao];
  if (!runways) return null;
  const wind = parseMetarWind(metarRaw);
  if (!wind) return null;

  const mono = "'JetBrains Mono', monospace";
  const boxStyle = {
    marginBottom: "12px", padding: "8px 10px",
    background: "rgba(0,0,0,0.25)", borderRadius: "6px",
    borderLeft: "3px solid rgba(251, 191, 36, 0.4)",
  };
  const titleStyle = {
    color: "#fbbf24", fontSize: "10px", fontWeight: 600,
    letterSpacing: "2px", marginBottom: "4px", fontFamily: mono,
  };

  // CALM
  if (wind.isCalm) {
    return (
      <div style={boxStyle}>
        <div style={titleStyle}>WIND COMPONENT</div>
        <div style={{ fontFamily: mono, fontSize: "12px", color: "#6ee7b7" }}>CALM</div>
      </div>
    );
  }

  // VRB
  if (wind.isVrb) {
    return (
      <div style={boxStyle}>
        <div style={titleStyle}>WIND COMPONENT</div>
        <div style={{ fontFamily: mono, fontSize: "12px", color: "#94a3b8" }}>
          VRB {wind.speed}kt <span style={{ color: "#64748b", fontSize: "10px" }}>(max XW any rwy)</span>
        </div>
      </div>
    );
  }

  // Normal wind — calculate components
  const comps = calcWindComponents(wind.dir, wind.speed, wind.gust, runways);
  return (
    <div style={boxStyle}>
      <div style={titleStyle}>WIND COMPONENT</div>
      {comps.map((c, i) => {
        const absXw = Math.round(Math.abs(c.xw));
        const side = c.xw >= 0 ? "R" : "L";
        const xwColor = crosswindSeverity(c.xw);
        const tw = Math.round(c.tailwind);
        const gustAbsXw = c.gustXw != null ? Math.round(Math.abs(c.gustXw)) : null;

        return (
          <div key={i} style={{ fontFamily: mono, fontSize: "11px", lineHeight: "1.6", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <span style={{ color: "#94a3b8", minWidth: "58px" }}>RWY {c.rwyName.padEnd(3)}</span>
            <span style={{ color: xwColor, fontWeight: 600 }}>XW {String(absXw).padStart(2)}kt {side}</span>
            {tw > 0 && (
              <span style={{ color: "#f87171", fontWeight: 600 }}>TW {tw}kt</span>
            )}
            {gustAbsXw != null && (
              <span style={{ color: "#64748b", fontSize: "10px" }}>(G: XW {gustAbsXw}kt)</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ========== METAR/TAF ========== */
function MetarTafPanel() {
  const [selectedAirports, setSelectedAirports] = useState(() => {
    const todayEvents = getTodayDutyEvents();
    const dutyIcaos = getDutyRouteIcaoCodes(todayEvents);
    if (dutyIcaos.length > 0) {
      const base = new Set(["RJTT", ...dutyIcaos]);
      return [...base];
    }
    return ["RJTT", "RJAA"];
  });
  const [customIcao, setCustomIcao] = useState("");
  const [metarData, setMetarData] = useState({});
  const [tafData, setTafData] = useState({});
  const [prevMetarData, setPrevMetarData] = useState({}); // 前回のMETARデータ（変化検知用）
  const [changedFields, setChangedFields] = useState({}); // 変化があったICAOコード
  const [loading, setLoading] = useState({});
  const [lastUpdate, setLastUpdate] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchMetar = useCallback(async (icao) => {
    setLoading((prev) => ({ ...prev, [icao]: true }));
    try {
      const [mText, tText] = await Promise.all([
        fetchMetarRaw(icao),
        fetchTafRaw(icao),
      ]);
      const newMetar = mText || "No METAR available";

      // 変化検知: 前回と異なる場合にフラグ
      setMetarData((prev) => {
        if (prev[icao] && prev[icao] !== newMetar && !newMetar.includes("error") && !newMetar.includes("No METAR")) {
          setPrevMetarData(p => ({ ...p, [icao]: prev[icao] }));
          setChangedFields(p => ({ ...p, [icao]: Date.now() }));
        }
        return { ...prev, [icao]: newMetar };
      });
      setTafData((prev) => ({ ...prev, [icao]: tText.trim() || "No TAF available" }));
    } catch (e) {
      console.error(`[fetchMetar] ${icao}:`, e);
      setMetarData((prev) => ({ ...prev, [icao]: "Fetch error — open AWC link" }));
      setTafData((prev) => ({ ...prev, [icao]: "Fetch error — open AWC link" }));
    } finally {
      setLoading((prev) => ({ ...prev, [icao]: false }));
    }
  }, []);

  const fetchAll = useCallback(() => {
    selectedAirports.forEach((icao) => fetchMetar(icao));
    setLastUpdate(new Date());
  }, [selectedAirports, fetchMetar]);

  // Refで最新のfetchAllを保持し、stale closureを防ぐ
  const fetchAllRef = useRef(fetchAll);
  useEffect(() => { fetchAllRef.current = fetchAll; }, [fetchAll]);

  // マウント時に一度だけ自動フェッチ
  useEffect(() => {
    fetchAllRef.current();
  }, []);

  // 自動更新: 90秒ごとにリフレッシュ
  useEffect(() => {
    if (!autoRefresh) return;
    const iv = setInterval(() => { fetchAllRef.current(); }, 90000);
    return () => clearInterval(iv);
  }, [autoRefresh]);

  // 変化ハイライトを5秒後にクリア
  useEffect(() => {
    const keys = Object.keys(changedFields);
    if (keys.length === 0) return;
    const timer = setTimeout(() => setChangedFields({}), 8000);
    return () => clearTimeout(timer);
  }, [changedFields]);

  const addAirport = (icao) => {
    const code = icao.toUpperCase().trim();
    if (code.length === 4 && !selectedAirports.includes(code)) {
      setSelectedAirports((prev) => [...prev, code]);
      fetchMetar(code);
    }
  };
  const removeAirport = (icao) => {
    setSelectedAirports((prev) => prev.filter((a) => a !== icao));
    setMetarData((prev) => { const n = { ...prev }; delete n[icao]; return n; });
    setTafData((prev) => { const n = { ...prev }; delete n[icao]; return n; });
  };

  const highlightMetar = (text) => {
    if (!text) return null;
    if (text.includes("error") || text.includes("No METAR")) return <span style={{ color: "#64748b" }}>{text}</span>;
    return text.split("\n").map((line, i) => {
      if (!line.trim()) return null;
      return (
        <div key={i} style={{ marginBottom: "4px", lineHeight: "1.6" }}>
          {line.split(" ").map((token, j) => {
            let color = "#e2e8f0";
            if (/^\d{5}(G\d{2,3})?KT$/.test(token) || /^\d{5}MPS$/.test(token)) color = "#60a5fa";
            // 視程: 文字列比較ではなく数値比較に修正
            else if (/^\d{4}$/.test(token) && j > 1 && j < 5) {
              const vis = parseInt(token, 10);
              color = vis < 3000 ? "#f87171" : vis < 5000 ? "#fbbf24" : "#6ee7b7";
            }
            else if (/^(FEW|SCT|BKN|OVC|VV)\d{3}/.test(token)) {
              // 雲高: NaN時は色変更しない（デフォルト色を維持）
              const h = parseInt(token.replace(/^[A-Z]+/, ""), 10) * 100;
              if (!isNaN(h)) color = h < 500 ? "#f87171" : h < 1500 ? "#fbbf24" : "#6ee7b7";
            }
            else if (/^(TSRA|TS|\+RA|\+SN|FG|BR|HZ|SN|RA|DZ|GR|SQ|FC|SS|DS)/.test(token)) color = "#f87171";
            else if (/^(CAVOK|SKC|NSC|NCD)$/.test(token)) color = "#6ee7b7";
            else if (/^(NOSIG|BECMG|TEMPO)$/.test(token)) color = "#c084fc";
            else if (/^(RMK|A\d{4}|Q\d{4})/.test(token)) color = "#94a3b8";
            return <span key={j} style={{ color }}>{token} </span>;
          })}
        </div>
      );
    });
  };

  const [activeRegion, setActiveRegion] = useState(null);

  return (
    <div>
      <div style={{ marginBottom: "16px" }}>
        {/* 地域タブ横並び + 空港チップ展開 */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: activeRegion ? "8px" : "0" }}>
          {AIRPORT_GROUPS.map((group) => {
            const selectedCount = group.airports.filter(ap => selectedAirports.includes(ap.icao)).length;
            const isActive = activeRegion === group.region;
            return (
              <button key={group.region} onClick={() => setActiveRegion(isActive ? null : group.region)} style={{
                padding: "3px 8px", background: isActive ? "rgba(110,231,183,0.12)" : "transparent",
                border: `1px solid ${isActive ? "rgba(110,231,183,0.4)" : selectedCount > 0 ? "rgba(110,231,183,0.2)" : "rgba(148,163,184,0.1)"}`,
                borderRadius: "4px", cursor: "pointer",
                color: isActive ? "#6ee7b7" : selectedCount > 0 ? "#6ee7b7" : "#64748b",
                fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", fontWeight: isActive ? 700 : 400,
              }}>
                {group.region}{selectedCount > 0 && <span style={{ marginLeft: "3px", fontSize: "9px", opacity: 0.7 }}>({selectedCount})</span>}
              </button>
            );
          })}
        </div>
        {activeRegion && (() => {
          const group = AIRPORT_GROUPS.find(g => g.region === activeRegion);
          return group ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", padding: "6px 0" }}>
              {group.airports.map((ap) => {
                const sel = selectedAirports.includes(ap.icao);
                return (
                  <button key={ap.icao} onClick={() => sel ? removeAirport(ap.icao) : addAirport(ap.icao)}
                    style={{
                      padding: "3px 8px",
                      background: sel ? "rgba(110, 231, 183, 0.15)" : "rgba(30, 41, 59, 0.5)",
                      border: sel ? "1px solid rgba(110, 231, 183, 0.4)" : "1px solid rgba(148, 163, 184, 0.12)",
                      borderRadius: "4px", color: sel ? "#6ee7b7" : "#94a3b8",
                      fontSize: "10px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
                    }}>
                    {ap.icao} <span style={{ opacity: 0.6, fontSize: "9px" }}>{ap.name}</span>
                  </button>
                );
              })}
            </div>
          ) : null;
        })()}
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <input type="text" placeholder="ICAO (e.g. RJBE)" value={customIcao}
            onChange={(e) => setCustomIcao(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === "Enter") { addAirport(customIcao); setCustomIcao(""); } }}
            maxLength={4}
            style={{
              padding: "8px 14px", background: "rgba(15, 23, 42, 0.6)",
              border: "1px solid rgba(148, 163, 184, 0.15)", borderRadius: "6px",
              color: "#e2e8f0", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace",
              outline: "none", width: "160px", letterSpacing: "2px",
            }} />
          <button onClick={() => { addAirport(customIcao); setCustomIcao(""); }}
            style={{ padding: "8px 16px", background: "rgba(110, 231, 183, 0.12)", border: "1px solid rgba(110, 231, 183, 0.3)", borderRadius: "6px", color: "#6ee7b7", fontSize: "12px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>追加</button>
          <button onClick={fetchAll}
            style={{ padding: "8px 20px", background: "linear-gradient(135deg, rgba(110, 231, 183, 0.2), rgba(96, 165, 250, 0.2))", border: "1px solid rgba(110, 231, 183, 0.4)", borderRadius: "6px", color: "#6ee7b7", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>↻ REFRESH</button>
          {/* 自動更新トグル */}
          <button onClick={() => setAutoRefresh(a => !a)} style={{
            padding: "8px 14px",
            background: autoRefresh ? "rgba(110,231,183,0.08)" : "transparent",
            border: `1px solid ${autoRefresh ? "rgba(110,231,183,0.4)" : "rgba(148,163,184,0.15)"}`,
            borderRadius: "6px",
            color: autoRefresh ? "#6ee7b7" : "#64748b",
            fontSize: "10px", cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace",
            display: "flex", alignItems: "center", gap: "6px",
          }}>
            <div style={{
              width: "6px", height: "6px", borderRadius: "50%",
              background: autoRefresh ? "#6ee7b7" : "#475569",
              boxShadow: autoRefresh ? "0 0 6px #6ee7b7" : "none",
              animation: autoRefresh ? "statusBlink 2s ease infinite" : "none",
            }} />
            AUTO {autoRefresh ? "ON" : "OFF"}
          </button>
          {/* 最終更新表示 */}
          {lastUpdate && (
            <span style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>
              LAST: {lastUpdate.toISOString().slice(11, 19)}z
            </span>
          )}
        </div>
        {/* DUTY ROUTE indicator */}
        {(() => {
          const todayEvts = getTodayDutyEvents();
          const dutyIcaos = getDutyRouteIcaoCodes(todayEvts);
          if (dutyIcaos.length === 0) return null;
          const flyEvts = todayEvts.filter(e => e.type === "FLY");
          const route = [];
          for (const ev of flyEvts) {
            if (ev.route) ev.route.forEach(c => { if (route.length === 0 || route[route.length - 1] !== c) route.push(c); });
          }
          return (
            <div style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "5px 12px", marginTop: "6px",
              background: "rgba(251,191,36,0.06)",
              border: "1px solid rgba(251,191,36,0.2)",
              borderRadius: "4px",
            }}>
              <span style={{ color: "#fbbf24", fontSize: "9px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>DUTY ROUTE</span>
              <span style={{ color: "#e2e8f0", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
                {route.join(" → ")}
              </span>
              <span style={{ color: "#64748b", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" }}>
                ICAO: {dutyIcaos.join(", ")}
              </span>
            </div>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {selectedAirports.map((icao) => {
          const apInfo = AIRPORTS.find((a) => a.icao === icao);
          const hasChanged = !!changedFields[icao];
          return (
            <div key={icao} style={{
              background: hasChanged ? "rgba(251,191,36,0.04)" : "rgba(15, 23, 42, 0.5)",
              border: `1px solid ${hasChanged ? "rgba(251,191,36,0.3)" : "rgba(148, 163, 184, 0.1)"}`,
              borderRadius: "10px", padding: "16px 20px",
              transition: "all 0.5s ease",
              boxShadow: hasChanged ? "0 0 20px rgba(251,191,36,0.08)" : "none",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <span style={{ color: "#6ee7b7", fontSize: "16px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>{icao}</span>
                  {apInfo && <span style={{ color: "#64748b", fontSize: "12px" }}>{apInfo.name}</span>}
                  {loading[icao] && <span style={{ color: "#fbbf24", fontSize: "11px" }}>loading...</span>}
                  {hasChanged && (
                    <span style={{
                      padding: "2px 8px", borderRadius: "2px",
                      background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.4)",
                      color: "#fbbf24", fontSize: "9px", fontWeight: 700,
                      fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
                      animation: "statusBlink 1s ease 3",
                    }}>UPDATED</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <ExtLink href={`https://aviationweather.gov/gfa/#obs=metar&region=other&extent=${icao}`}>AWC</ExtLink>
                  <button onClick={() => removeAirport(icao)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: "14px" }}>✕</button>
                </div>
              </div>
              {metarData[icao] && (
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ color: "#60a5fa", fontSize: "10px", fontWeight: 600, letterSpacing: "2px", marginBottom: "6px", fontFamily: "'JetBrains Mono', monospace" }}>METAR</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", lineHeight: "1.7", padding: "10px 14px", background: "rgba(0,0,0,0.3)", borderRadius: "6px", borderLeft: "3px solid rgba(96, 165, 250, 0.4)" }}>
                    {highlightMetar(metarData[icao])}
                  </div>
                </div>
              )}
              <CrosswindDisplay icao={icao} metarRaw={metarData[icao]} />
              {tafData[icao] && (
                <div>
                  <div style={{ color: "#c084fc", fontSize: "10px", fontWeight: 600, letterSpacing: "2px", marginBottom: "6px", fontFamily: "'JetBrains Mono', monospace" }}>TAF</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", lineHeight: "1.7", color: "#cbd5e1", padding: "10px 14px", background: "rgba(0,0,0,0.3)", borderRadius: "6px", borderLeft: "3px solid rgba(192, 132, 252, 0.4)", whiteSpace: "pre-wrap" }}>
                    {tafData[icao]}
                  </div>
                </div>
              )}
              {!metarData[icao] && !loading[icao] && (
                <div style={{ color: "#64748b", fontSize: "12px", fontStyle: "italic" }}>REFRESHで取得</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ========== HIMAWARI DIRECT IMAGE VIEW ========== */
// mscweb直接JPG方式 — CORS不要、<img>タグで直接表示
// URL: https://www.data.jma.go.jp/mscweb/data/himawari/img/jpn/jpn_{band}_{HHMM}.jpg
// 10分毎更新 (2分30秒遅延あり)
function HimawariTileView({ band }) {
  // バンドキーをURLキーにマッピング
  const bandKey = {
    B13: "b13", B03: "b03", B08: "b08", B07: "b07", TrueColor: "tre",
  }[band] ?? "b13";

  // 現在UTC時刻から最新10分刻みのHHMMを生成（5分遅延を見込む）
  const getLatestHhmm = (offset = 0) => {
    const now = new Date(Date.now() - (offset * 10 + 5) * 60000);
    const h = now.getUTCHours().toString().padStart(2, "0");
    const m = (Math.floor(now.getUTCMinutes() / 10) * 10).toString().padStart(2, "0");
    return h + m;
  };

  const [hhmm, setHhmm] = useState(getLatestHhmm(0));
  const [imgKey, setImgKey] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  const [imgLoaded, setImgLoaded] = useState(false);

  // バンド変更時にリセット
  useEffect(() => {
    setHhmm(getLatestHhmm(0));
    setRetryCount(0);
    setImgLoaded(false);
    setImgKey(k => k + 1);
  }, [band]);

  const imgUrl = `https://www.data.jma.go.jp/mscweb/data/himawari/img/jpn/jpn_${bandKey}_${hhmm}.jpg`;

  const handleError = () => {
    // 最大6回（60分）遡ってリトライ
    if (retryCount < 6) {
      const next = retryCount + 1;
      setRetryCount(next);
      setHhmm(getLatestHhmm(next));
      setImgKey(k => k + 1);
    }
  };

  const displayTime = `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)} UTC`;

  return (
    <div style={{ position: "relative", background: "#010408", minHeight: "420px", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <img
        key={`${band}-${imgKey}`}
        src={imgUrl}
        alt={`HIMAWARI-9 ${band}`}
        onLoad={() => setImgLoaded(true)}
        onError={handleError}
        style={{
          width: "100%", display: "block",
          maxHeight: "520px", objectFit: "contain",
          imageRendering: "crisp-edges",
          opacity: imgLoaded ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}
      />
      {!imgLoaded && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          color: "#334155", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px",
        }}>
          {retryCount >= 6 ? "IMAGE NOT AVAILABLE" : "LOADING SATELLITE DATA..."}
        </div>
      )}
      {/* HUDオーバーレイ */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 80px rgba(0,0,0,0.5)" }} />
      {/* タイムスタンプ */}
      <div style={{
        position: "absolute", bottom: "8px", right: "10px", pointerEvents: "none",
        background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: "2px",
        color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
      }}>
        {new Date().toISOString().slice(0, 10)} {displayTime}
      </div>
      {/* 外部リンク */}
      <a
        href={imgUrl} target="_blank" rel="noopener noreferrer"
        style={{
          position: "absolute", bottom: "8px", left: "10px", pointerEvents: "auto",
          background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: "2px",
          color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace",
          textDecoration: "none", letterSpacing: "1px",
        }}
      >
        ↗ JMA mscweb
      </a>
    </div>
  );
}



/* ========== SATELLITE ========== */

function SatellitePanel() {
  const [band, setBand] = useState("B13");

  const bands = [
    {
      key: "B13", label: "赤外 (IR/B13)", emoji: "🌡️", color: "#60a5fa",
      desc: "雲頂温度。白＝高く冷たい雲（Cb等）、黒＝晴天または低い暖かい雲。上層雲の把握に最適。"
    },
    {
      key: "B03", label: "可視 (VIS/B03)", emoji: "☀️", color: "#fbbf24",
      desc: "太陽光反射。厚い雲＝白輝、薄い雲・晴天＝暗い。日中のみ有効。霧・層雲の識別に有効。"
    },
    {
      key: "B08", label: "水蒸気 (WV/B08)", emoji: "💧", color: "#a78bfa",
      desc: "上中層の水蒸気量。白＝湿潤、暗＝乾燥。ジェット気流・トラフの位置把握に有効。"
    },
    {
      key: "B07", label: "中赤外 (B07)", emoji: "🔥", color: "#f97316",
      desc: "低層雲・霧と高層雲の識別。夜間の低層雲検出に特に有効。海面温度推定にも使用。"
    },
    {
      key: "TrueColor", label: "疑似カラー (RGB)", emoji: "🌍", color: "#6ee7b7",
      desc: "自然色。雲の種類（水雲 vs 氷雲）・砂塵・火山灰・海色の識別に有効。"
    },
  ];

  const current = bands.find(b => b.key === band) ?? bands[0];

  // バンドカラーのrgb値マップ（インライン三項を排除）
  const rgbMap = {
    "#60a5fa": "96,165,250",
    "#fbbf24": "251,191,36",
    "#a78bfa": "167,139,250",
    "#f97316": "249,115,22",
    "#6ee7b7": "110,231,183",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <PanelFrame title="HIMAWARI-9 IMAGERY" code="SECT-02" style={{ padding: "0" }}>
        {/* Control bar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", flexWrap: "wrap", gap: "8px",
          borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
          background: "rgba(0,0,0,0.4)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ee7b7", boxShadow: "0 0 8px #6ee7b7" }} />
            <span style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", textShadow: "0 0 8px rgba(110,231,183,0.5)" }}>SATELLITE / HIMAWARI-9</span>
          </div>
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {bands.map(b => (
              <button key={b.key} onClick={() => setBand(b.key)} style={{
                padding: "4px 10px",
                background: band === b.key ? `rgba(${rgbMap[b.color]}, 0.15)` : "transparent",
                border: band === b.key ? `1px solid ${b.color}` : "1px solid rgba(110, 231, 183, 0.06)",
                borderRadius: "2px",
                color: band === b.key ? b.color : "#475569",
                fontSize: "9px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.5px",
                transition: "all 0.15s ease",
              }}>
                {b.emoji} {b.label}
              </button>
            ))}
          </div>
        </div>

        {/* JMA Himawari tile image grid */}
        <HimawariTileView band={band} />


        {/* Band description */}
        <div style={{
          padding: "10px 14px", background: "rgba(0,0,0,0.5)",
          borderTop: "1px solid rgba(110, 231, 183, 0.08)",
          display: "flex", alignItems: "flex-start", gap: "10px",
        }}>
          <span style={{ fontSize: "18px" }}>{current.emoji}</span>
          <div>
            <span style={{ color: current.color, fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>{current.label}</span>
            <p style={{ margin: "3px 0 0", color: "#64748b", fontSize: "11px", lineHeight: "1.6", fontFamily: "'JetBrains Mono', monospace" }}>{current.desc}</p>
          </div>
        </div>

        {/* Links */}
        <div style={{
          display: "flex", gap: "4px", padding: "8px 14px", flexWrap: "wrap",
          borderTop: "1px solid rgba(110, 231, 183, 0.06)",
          background: "rgba(0,0,0,0.4)",
        }}>
          <ExtLink href="https://www.jma.go.jp/bosai/himawari/" accent>気象庁 ひまわりビューア</ExtLink>
          <ExtLink href="https://himawari.asia/">ひまわりリアルタイムWeb</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/satellite/">気象庁 衛星画像</ExtLink>
        </div>
      </PanelFrame>

      {/* バンド説明カード — クリックでバンド切り替え可能 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "8px" }}>
        {bands.map(b => (
          <div
            key={b.key}
            onClick={() => setBand(b.key)}
            style={{
              padding: "10px 12px",
              background: band === b.key ? `rgba(${rgbMap[b.color]}, 0.08)` : "rgba(5,10,20,0.8)",
              border: `1px solid ${band === b.key ? b.color : "rgba(110,231,183,0.08)"}`,
              borderRadius: "4px", cursor: "pointer",
              transition: "all 0.15s ease",
            }}
          >
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px" }}>
              <span style={{ fontSize: "16px" }}>{b.emoji}</span>
              <span style={{ color: b.color, fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{b.label}</span>
            </div>
            <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", lineHeight: "1.5" }}>{b.desc}</div>
          </div>
        ))}
        {/* 読み方ガイド */}
        {[
          { icon: "❄️", label: "高層雲 / Cb", value: "赤外 白輝点", hint: "雲頂温度が低い（-60°C以下）" },
          { icon: "🌫️", label: "低層雲 / 霧", value: "VIS白 / B07差", hint: "夜間は中赤外差分で識別" },
          { icon: "💨", label: "ジェット気流", value: "WV 輝度境界", hint: "水蒸気バンドの明暗境界部" },
          { icon: "🌪️", label: "台風眼", value: "IR 円形暖色域", hint: "雲がなく地表温度が見える" },
        ].map(c => (
          <div key={c.label} style={{ padding: "10px 12px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.08)", borderRadius: "4px" }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px" }}>
              <span style={{ fontSize: "16px" }}>{c.icon}</span>
              <span style={{ color: "#e2e8f0", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{c.label}</span>
            </div>
            <div style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "2px" }}>{c.value}</div>
            <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>{c.hint}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ========== RADAR ========== */
function RadarPanel() {
  const [radarType, setRadarType] = useState("radar");

  const types = [
    { key: "radar", label: "降水強度", emoji: "🌧️", windyOverlay: "radar" },
    { key: "rain", label: "降水量", emoji: "☔", windyOverlay: "rainAccu" },
    { key: "wind", label: "地上風", emoji: "💨", windyOverlay: "wind" },
    { key: "gust", label: "突風", emoji: "🌬️", windyOverlay: "gust" },
  ];

  const current = types.find(t => t.key === radarType) ?? types[0];
  const windySrc = `https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=36.5&lon=137&overlay=${current.windyOverlay}&product=${current.windyOverlay === "radar" ? "radar" : "ecmwf"}&level=surface&calendar=now&message=true`;

  // 悪天チェック項目
  const hazards = [
    { icon: "⛈️", label: "Cb / Thunderstorm", steps: ["レーダーで>40dBZ輝点を確認", "雷ナウキャスト活動度2以上", "衛星IR白輝点・急速発達"] },
    { icon: "🌫️", label: "Fog / Low Visibility", steps: ["METAR VV / RVR確認", "衛星VIS薄灰色エリア", "地上温度 − 露点差 < 3°C"] },
    { icon: "🌬️", label: "Wind Shear / Turb", steps: ["CAT領域（Windyタービュランス）", "高層天気図 AUPQ78 風速差", "PIREP・SIGMET確認"] },
    { icon: "🌊", label: "Heavy Rain / Flood", steps: ["レーダー連続エコー>20mm/h", "AMEDAS積算雨量", "土砂災害警戒情報"] },
    { icon: "❄️", label: "Icing", steps: ["FL050-200 0°C面高度", "AICING SIGMET", "ACARS報告確認"] },
    { icon: "🌋", label: "Volcanic Ash", steps: ["Tokyo VAAC情報", "SIGMET VOLCANIC ASH", "衛星SO2バンド確認"] },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <PanelFrame title="RADAR / SURFACE WEATHER" code="SECT-03" style={{ padding: "0" }}>
        {/* Control bar */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", flexWrap: "wrap", gap: "8px",
          borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
          background: "rgba(0,0,0,0.4)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ee7b7", boxShadow: "0 0 8px #6ee7b7" }} />
            <span style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>RADAR / SURFACE CONDITIONS</span>
          </div>
          <div style={{ display: "flex", gap: "4px" }}>
            {types.map(t => (
              <button key={t.key} onClick={() => setRadarType(t.key)} style={{
                padding: "4px 10px",
                background: radarType === t.key ? "rgba(110, 231, 183, 0.12)" : "transparent",
                border: radarType === t.key ? "1px solid rgba(110, 231, 183, 0.5)" : "1px solid rgba(110, 231, 183, 0.06)",
                borderRadius: "2px",
                color: radarType === t.key ? "#6ee7b7" : "#475569",
                fontSize: "9px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace",
                transition: "all 0.15s ease",
              }}>
                {t.emoji} {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Map */}
        <div style={{ position: "relative", background: "#000" }}>
          <iframe
            key={current.windyOverlay}
            src={windySrc}
            style={{ width: "100%", height: "440px", border: "none", display: "block" }}
            title="Radar"
            loading="lazy"
            allow="autoplay"
          />
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none", boxShadow: "inset 0 0 60px rgba(0,0,0,0.4)" }} />
        </div>

        {/* Echo scale */}
        <div style={{ padding: "10px 14px", background: "rgba(0,0,0,0.5)", borderTop: "1px solid rgba(110, 231, 183, 0.08)" }}>
          <div style={{ color: "#334155", fontSize: "9px", letterSpacing: "2px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "6px" }}>ECHO INTENSITY (mm/h)</div>
          <div style={{ display: "flex", gap: "3px", alignItems: "center" }}>
            {[
              { color: "#a3d4ff", val: "〜1" }, { color: "#4da6ff", val: "1-5" },
              { color: "#2a6eff", val: "5-10" }, { color: "#ffff00", val: "10-20" },
              { color: "#ffa500", val: "20-30" }, { color: "#ff4500", val: "30-50" },
              { color: "#ff0000", val: "50-80" }, { color: "#b30000", val: "80〜" },
            ].map((item, i) => (
              <div key={i} style={{ textAlign: "center" }}>
                <div style={{ width: "32px", height: "12px", background: item.color, borderRadius: "1px" }} />
                <span style={{ color: "#334155", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace" }}>{item.val}</span>
              </div>
            ))}
            <div style={{ marginLeft: "12px", display: "flex", gap: "8px" }}>
              <span style={{ color: "#f87171", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>⚠ &gt;30mm/h = ヘビーレイン</span>
              <span style={{ color: "#fbbf24", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>⚠ &gt;50mm/h = 猛烈な雨</span>
            </div>
          </div>
        </div>

        {/* Links */}
        <div style={{ display: "flex", gap: "4px", padding: "8px 14px", flexWrap: "wrap", borderTop: "1px solid rgba(110, 231, 183, 0.06)", background: "rgba(0,0,0,0.4)" }}>
          <ExtLink href="https://www.jma.go.jp/bosai/nowc/" accent>気象庁ナウキャスト</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/rain/">雨雲の動き</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/nowc/#zoom:6/lat:36.0/lon:139.0/colordepth:normal/elements:thunder">雷ナウキャスト</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/nowc/#zoom:6/lat:36.0/lon:139.0/colordepth:normal/elements:tornado">竜巻ナウキャスト</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/amedas/">AMEDAS</ExtLink>
        </div>
      </PanelFrame>

      {/* Hazard checklist */}
      <div>
        <div style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", marginBottom: "8px" }}>AVIATION HAZARD CHECKLIST</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px" }}>
          {hazards.map(h => (
            <div key={h.label} style={{ padding: "12px", background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.08)", borderRadius: "4px" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" }}>
                <span style={{ fontSize: "16px" }}>{h.icon}</span>
                <span style={{ color: "#e2e8f0", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{h.label}</span>
              </div>
              {h.steps.map((s, i) => (
                <div key={i} style={{ display: "flex", gap: "6px", alignItems: "flex-start", marginBottom: "3px" }}>
                  <span style={{ color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginTop: "1px" }}>{i + 1}.</span>
                  <span style={{ color: "#64748b", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", lineHeight: "1.5" }}>{s}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/* ========== ANALYSIS ========== */
function AnalysisPanel() {
  const [timestamp, setTimestamp] = useState(null);
  const [tsLabel, setTsLabel] = useState("");
  const [tsIndex, setTsIndex] = useState(0);
  const [tsList, setTsList] = useState([]);
  const [viewMode, setViewMode] = useState("cross"); // "cross" | "plane"
  const [planeLevel, setPlaneLevel] = useState("35"); // FL350
  const [imgError, setImgError] = useState({});
  const [zoomImg, setZoomImg] = useState(null); // { src, label }

  // JMAの断面図コード: 経度→内部コード (functions_maiji.jsより)
  const LONS = [
    { label: "E145°", code: "50" },
    { label: "E140°", code: "52" },
    { label: "E135°", code: "54" },
    { label: "E130°", code: "56" },
  ];

  const PLANE_LEVELS = [
    { code: "45", label: "FL450", hPa: "150hPa", ft: "≈45,000ft" },
    { code: "35", label: "FL350", hPa: "250hPa", ft: "≈35,000ft" },
    { code: "25", label: "FL250", hPa: "400hPa", ft: "≈25,000ft" },
    { code: "15", label: "FL150", hPa: "550hPa", ft: "≈15,000ft" },
  ];

  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);

  // list_maiji.js からタイムスタンプ一覧を取得
  const fetchTimestamps = useCallback((isManual = false) => {
    if (isManual) setRefreshing(true);
    fetch("https://www.data.jma.go.jp/airinfo/data/conf/list_maiji.js", { cache: "no-store" })
      .then((r) => r.text())
      .then((text) => {
        const matches = [...text.matchAll(/"(\d{14})"/g)].map((m) => m[1]);
        const labels = [...text.matchAll(/"(\d{2}\/\d{2} \d{2}:\d{2})"/g)].map((m) => m[1]);
        if (matches.length > 0) {
          const list = matches.map((ts, i) => ({ ts, label: labels[i] || ts }));
          setTsList(list);
          setTsIndex(0);
          setTimestamp(list[0].ts);
          setTsLabel(list[0].label);
          setImgError({});
        }
        setLastRefresh(new Date());
      })
      .catch(() => {
        if (!timestamp) {
          const now = new Date();
          now.setUTCMinutes(0, 0, 0);
          const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 14).padEnd(14, "0");
          setTimestamp(ts);
          setTsLabel("latest");
        }
      })
      .finally(() => setRefreshing(false));
  }, [timestamp]);

  useEffect(() => { fetchTimestamps(); }, []);

  const goTs = (dir) => {
    const next = tsIndex + dir;
    if (next >= 0 && next < tsList.length) {
      setTsIndex(next);
      setTimestamp(tsList[next].ts);
      setTsLabel(tsList[next].label);
      setImgError({});
    }
  };

  const imageUrl = (code) =>
    `https://www.data.jma.go.jp/airinfo/data/pict/maiji/WANLC1${code}_RJTD_${timestamp}.PNG`;
  const planeUrl = (level) =>
    `https://www.data.jma.go.jp/airinfo/data/pict/maiji/WANLF1${level}_RJTD_${timestamp}.PNG`;

  const panelStyle = {
    background: "rgba(15, 23, 42, 0.5)",
    border: "1px solid rgba(148, 163, 184, 0.1)",
    borderRadius: "12px",
    padding: "20px",
    marginBottom: "20px",
  };

  const headerLabel = {
    color: "#6ee7b7",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "3px",
    fontFamily: "'JetBrains Mono', monospace",
    textShadow: "0 0 8px rgba(110, 231, 183, 0.5)",
  };

  return (
    <div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      {/* SVGフィルター定義（エッジ強調・シャープネス） */}
      <svg style={{ position: "absolute", width: 0, height: 0 }} xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="sharpen-lines">
            <feConvolveMatrix order="3" kernelMatrix="0 -0.6 0 -0.6 3.4 -0.6 0 -0.6 0" preserveAlpha="true" />
          </filter>
        </defs>
      </svg>

      {/* ヘッダー */}
      <div style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
          <div>
            <div style={headerLabel}>◈ JMA 三十分大気解析 / 30-MIN ATMOSPHERIC ANALYSIS</div>
            <div style={{ color: "#64748b", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", marginTop: "3px" }}>
              SOURCE: data.jma.go.jp/airinfo — REAL-TIME IMAGE FEED
            </div>
          </div>
          {/* ビューモード切り替え */}
          <div style={{ display: "flex", gap: "6px" }}>
            {[{ key: "cross", label: "断面図 (経度別)" }, { key: "plane", label: "平面図 (FL別)" }].map((m) => (
              <button key={m.key} onClick={() => setViewMode(m.key)} style={{
                padding: "5px 14px",
                background: viewMode === m.key ? "rgba(110, 231, 183, 0.15)" : "rgba(15, 23, 42, 0.6)",
                border: `1px solid ${viewMode === m.key ? "rgba(110, 231, 183, 0.5)" : "rgba(148, 163, 184, 0.15)"}`,
                borderRadius: "6px", color: viewMode === m.key ? "#6ee7b7" : "#64748b",
                fontSize: "11px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
                transition: "all 0.15s ease",
              }}>{m.label}</button>
            ))}
          </div>
        </div>

        {/* タイムスタンプ操作 */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
          <button onClick={() => goTs(1)} disabled={tsIndex >= tsList.length - 1} style={{
            padding: "4px 10px", background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(148, 163, 184, 0.2)",
            borderRadius: "4px", color: "#94a3b8", fontSize: "12px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
          }}>◀ PREV</button>
          <div style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(110, 231, 183, 0.3)", borderRadius: "6px", padding: "4px 16px" }}>
            <span style={{ color: "#6ee7b7", fontSize: "13px", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>
              {tsLabel ? `${tsLabel} UTC` : "Loading..."}
            </span>
          </div>
          <button onClick={() => goTs(-1)} disabled={tsIndex <= 0} style={{
            padding: "4px 10px", background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(148, 163, 184, 0.2)",
            borderRadius: "4px", color: "#94a3b8", fontSize: "12px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
          }}>NEXT ▶</button>
          <div style={{ color: "#475569", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>
            {tsIndex + 1} / {tsList.length}
          </div>
          <button onClick={() => fetchTimestamps(true)} disabled={refreshing} style={{
            padding: "4px 10px", background: "rgba(30, 41, 59, 0.8)", border: "1px solid rgba(148, 163, 184, 0.2)",
            borderRadius: "4px", color: refreshing ? "#6ee7b7" : "#94a3b8", fontSize: "12px", cursor: refreshing ? "wait" : "pointer",
            fontFamily: "'JetBrains Mono', monospace", transition: "all 0.15s ease",
          }}>
            <span style={{ display: "inline-block", animation: refreshing ? "spin 1s linear infinite" : "none" }}>↻</span>
            {refreshing ? " UPDATING…" : " REFRESH"}
          </button>
          {lastRefresh && (
            <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>
              {lastRefresh.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
          )}
          {/* FL切り替え（平面図時のみ） */}
          {viewMode === "plane" && (
            <div style={{ display: "flex", gap: "6px", marginLeft: "auto" }}>
              {PLANE_LEVELS.map((lv) => (
                <button key={lv.code} onClick={() => { setPlaneLevel(lv.code); setImgError({}); }} style={{
                  padding: "4px 10px",
                  background: planeLevel === lv.code ? "rgba(110, 231, 183, 0.15)" : "rgba(15, 23, 42, 0.6)",
                  border: `1px solid ${planeLevel === lv.code ? "rgba(110, 231, 183, 0.4)" : "rgba(148, 163, 184, 0.1)"}`,
                  borderRadius: "4px", color: planeLevel === lv.code ? "#6ee7b7" : "#64748b",
                  fontSize: "11px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
                }}>{lv.label} <span style={{ fontSize: "9px", opacity: 0.6 }}>{lv.hPa}</span></button>
              ))}
            </div>
          )}
        </div>

        {/* 断面図: 東経4地点グリッド */}
        {viewMode === "cross" && timestamp && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
            {LONS.map((lon) => (
              <div key={lon.code} style={{
                background: "rgba(0,0,0,0.5)",
                border: `1px solid ${imgError[lon.code] ? "rgba(248, 113, 113, 0.3)" : "rgba(110, 231, 183, 0.2)"}`,
                borderRadius: "8px", overflow: "hidden",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 10px", background: "rgba(0,0,0,0.6)", borderBottom: "1px solid rgba(110, 231, 183, 0.15)" }}>
                  <span style={{ color: "#6ee7b7", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>{lon.label}</span>
                  <a href={imageUrl(lon.code)} target="_blank" rel="noopener noreferrer" style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none" }}>↗ JMA</a>
                </div>
                {imgError[lon.code] ? (
                  <div style={{ height: "220px", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
                    NO DATA FOR {tsLabel}
                  </div>
                ) : (
                  <div
                    style={{ background: "#3d4044", borderRadius: "4px", overflow: "hidden", cursor: "pointer" }}
                    onClick={() => setZoomImg({ src: imageUrl(lon.code), label: `${lon.label} — ${tsLabel}` })}
                  >
                    <img
                      src={imageUrl(lon.code)}
                      alt={`大気解析 ${lon.label} ${tsLabel}`}
                      onError={() => setImgError((prev) => ({ ...prev, [lon.code]: true }))}
                      style={{ width: "100%", display: "block", imageRendering: "crisp-edges", filter: "invert(0.88) hue-rotate(180deg) contrast(1.3) saturate(1.3) url(#sharpen-lines)" }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 平面図: FL別 */}
        {viewMode === "plane" && timestamp && (
          <div style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(110, 231, 183, 0.2)", borderRadius: "8px", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 10px", background: "rgba(0,0,0,0.6)", borderBottom: "1px solid rgba(110, 231, 183, 0.15)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <span style={{ color: "#6ee7b7", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>
                  {PLANE_LEVELS.find((l) => l.code === planeLevel)?.label} PLANE VIEW
                </span>
                <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>
                  {PLANE_LEVELS.find((l) => l.code === planeLevel)?.hPa} / {PLANE_LEVELS.find((l) => l.code === planeLevel)?.ft}
                </span>
              </div>
              <a href={planeUrl(planeLevel)} target="_blank" rel="noopener noreferrer" style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none" }}>↗ JMA</a>
            </div>
            {imgError["plane"] ? (
              <div style={{ height: "300px", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
                NO DATA FOR {tsLabel}
              </div>
            ) : (
              <div
                style={{ background: "#3d4044", borderRadius: "4px", overflow: "hidden", cursor: "pointer" }}
                onClick={() => setZoomImg({ src: planeUrl(planeLevel), label: `${PLANE_LEVELS.find(l => l.code === planeLevel)?.label} PLANE — ${tsLabel}` })}
              >
                <img
                  src={planeUrl(planeLevel)}
                  alt={`平面図 FL${planeLevel}0 ${tsLabel}`}
                  onError={() => setImgError((prev) => ({ ...prev, plane: true }))}
                  style={{ width: "100%", display: "block", imageRendering: "crisp-edges", filter: "invert(0.88) hue-rotate(180deg) contrast(1.3) saturate(1.3) url(#sharpen-lines)" }}
                />
              </div>
            )}
          </div>
        )}

        {/* リンク */}
        <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" }}>
          <ExtLink href="https://www.data.jma.go.jp/airinfo/data/awfo_maiji.html" accent>📊 気象庁 三十分大気解析</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/weather_map/">🗺️ 天気図</ExtLink>
          <ExtLink href="https://www.jma.go.jp/bosai/numericmap/">📈 数値予報天気図</ExtLink>
        </div>
      </div>

      {/* 参照リンク群 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
        {[
          {
            title: "地上天気図 (ASAS/FSAS)", desc: "高気圧・低気圧・前線の位置と動向", links: [
              { label: "実況天気図 ASAS", url: "https://www.jma.go.jp/bosai/weather_map/" },
              { label: "予想天気図 FSAS24/48", url: "https://www.jma.go.jp/bosai/weather_map/#type=forecast" },
            ]
          },
          {
            title: "高層天気図", desc: "ジェット気流・トラフ・リッジ", links: [
              { label: "AUPQ35 (850/700hPa)", url: "https://www.jma.go.jp/bosai/numericmap/#type:aupq35" },
              { label: "AUPQ78 (500/300hPa)", url: "https://www.jma.go.jp/bosai/numericmap/#type:aupq78" },
            ]
          },
          {
            title: "悪天予想図", desc: "Turbulence, Icing, Cb 予想域", links: [
              { label: "国内悪天 FBJP", url: "https://www.jma.go.jp/bosai/numericmap/#type:fbjp" },
              { label: "下層悪天 FBFE", url: "https://www.jma.go.jp/bosai/numericmap/#type:fbfe" },
            ]
          },
          {
            title: "航空気象 (AWC)", desc: "国際線向け SIGWX・乱気流", links: [
              { label: "Aviation Weather Center", url: "https://aviationweather.gov" },
              { label: "SIGWX Chart", url: "https://aviationweather.gov/gfa/#area=other" },
              { label: "Turbulence Forecast", url: "https://aviationweather.gov/gfa/#obs=turb" },
            ]
          },
          {
            title: "Windy 高層風", desc: "FL別の風・気温ビジュアル", links: [
              { label: "上層風 250hPa", url: "https://www.windy.com/-Wind-250hPa-wind250h?wind250h" },
              { label: "気温分布", url: "https://www.windy.com/-Temperature-temp?temp" },
            ]
          },
          {
            title: "ウィンドプロファイラ", desc: "上空の風向風速の時間変化", links: [
              { label: "気象庁 WINDAS", url: "https://www.jma.go.jp/bosai/windprofiler/" },
            ]
          },
        ].map((s, i) => (
          <div key={i} style={{ padding: "16px", background: "rgba(15, 23, 42, 0.4)", border: "1px solid rgba(148, 163, 184, 0.08)", borderRadius: "10px" }}>
            <div style={{ color: "#e2e8f0", fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>{s.title}</div>
            <div style={{ color: "#64748b", fontSize: "11px", marginBottom: "10px" }}>{s.desc}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {s.links.map((l, j) => (
                <a key={j} href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "#60a5fa", fontSize: "12px", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace" }}>→ {l.label}</a>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ズームオーバーレイ */}
      {zoomImg && (
        <div
          onClick={() => setZoomImg(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.92)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            cursor: "pointer",
            padding: "env(safe-area-inset-top, 10px) env(safe-area-inset-right, 10px) env(safe-area-inset-bottom, 10px) env(safe-area-inset-left, 10px)",
          }}
        >
          {/* ヘッダー */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%", maxWidth: "95vw", padding: "8px 4px", marginBottom: "8px",
          }}>
            <span style={{ color: "#6ee7b7", fontSize: "12px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>
              {zoomImg.label}
            </span>
            <span style={{ color: "#64748b", fontSize: "20px", fontFamily: "'JetBrains Mono', monospace", padding: "4px 12px" }}>✕</span>
          </div>
          {/* 画像 */}
          <div style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            width: "100%", maxWidth: "95vw", overflow: "auto", WebkitOverflowScrolling: "touch",
          }}>
            <img
              src={zoomImg.src}
              alt={zoomImg.label}
              style={{
                maxWidth: "100%", maxHeight: "85vh", objectFit: "contain",
                imageRendering: "crisp-edges",
                borderRadius: "4px",
                background: "#ffffff",
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </div>
  );
}


/* ========== WX CHARTS — 気象チャート一覧 ========== */
function WxChartsPanel() {
  const [surfaceCharts, setSurfaceCharts] = useState(null);
  const [imgError, setImgError] = useState({});
  const [zoomImg, setZoomImg] = useState(null);

  const WM_BASE = "https://www.jma.go.jp/bosai/weather_map/data/png/";

  // list.json から地上天気図ファイル名を取得
  useEffect(() => {
    fetch("https://www.jma.go.jp/bosai/weather_map/data/list.json")
      .then((r) => r.json())
      .then((data) => {
        // ファイル名からUTC時刻を抽出する helper
        const extractTime = (fname) => {
          const m = fname.match(/_(\d{12})_MET/);
          if (!m) return "";
          const t = m[1]; // YYYYMMDDHHmmss → YYYYMMDDHHMMSS
          return `${t.slice(4,6)}/${t.slice(6,8)} ${t.slice(8,10)}:${t.slice(10,12)}z`;
        };

        setSurfaceCharts({
          spas: { file: data.near?.now?.slice(-1)[0], label: "SPAS 実況 (日本付近)", time: extractTime(data.near?.now?.slice(-1)[0] || "") },
          asas: { file: data.asia?.now?.slice(-1)[0], label: "ASAS 実況 (アジア広域)", time: extractTime(data.asia?.now?.slice(-1)[0] || "") },
          fsas24: { file: data.near?.ft24?.[0], label: "FSAS 24h 予想", time: extractTime(data.near?.ft24?.[0] || "") },
          fsas48: { file: data.near?.ft48?.[0], label: "FSAS 48h 予想", time: extractTime(data.near?.ft48?.[0] || "") },
        });
      })
      .catch(() => {});
  }, []);

  // FBJP URLs — 国内悪天予想図 + 12h予想図（最新初期値自動選択）
  const FBJP_URL = "https://www.data.jma.go.jp/airinfo/data/pict/fbjp/fbjp.png";
  const fbjp112BaseTime = (() => {
    const utcH = new Date().getUTCHours();
    // 初期値は3h毎（00,03,...,21）、約2.5h後に掲載 → 直近の掲載済みを選択
    const available = utcH >= 2 ? Math.floor((utcH - 2) / 3) * 3 : 21;
    return String(available).padStart(2, "0");
  })();
  const FBJP112_URL = `https://www.data.jma.go.jp/airinfo/data/pict/nwp/fbjp112_${fbjp112BaseTime}.png`;
  const fbjp112VT = (() => {
    const bt = parseInt(fbjp112BaseTime, 10);
    return String((bt + 12) % 24).padStart(2, "0");
  })();

  // AUPQ PDF — 現在のUTCに応じて00z/12z
  const aupqSuffix = new Date().getUTCHours() >= 12 ? "_12" : "_00";

  // カテゴリデータ
  const LINK_CATEGORIES = [
    {
      title: "高層天気図 (UPPER AIR)",
      icon: "📐",
      desc: "500/300hPa, 850/700hPa 高層解析",
      items: [
        { label: "AUPQ78 500/300hPa", desc: "ジェット気流・トラフ位置", url: `https://www.jma.go.jp/bosai/numericmap/data/nwpmap/aupq78${aupqSuffix}.pdf`, type: "pdf" },
        { label: "AUPQ35 850/700hPa", desc: "暖気寒気移流・降水域", url: `https://www.jma.go.jp/bosai/numericmap/data/nwpmap/aupq35${aupqSuffix}.pdf`, type: "pdf" },
        { label: "数値予報天気図一覧", desc: "JMA全チャート", url: "https://www.jma.go.jp/bosai/numericmap/", type: "link" },
      ],
    },
    {
      title: "国際 SIGWX",
      icon: "⚠️",
      desc: "Significant Weather / AWC",
      items: [
        { label: "AWC SIGWX Chart", desc: "国際悪天予想図", url: "https://aviationweather.gov/gfa/#area=other", type: "link" },
        { label: "AWC Turbulence", desc: "乱気流予想", url: "https://aviationweather.gov/gfa/#obs=turb", type: "link" },
        { label: "AWC Icing", desc: "着氷予想", url: "https://aviationweather.gov/gfa/#obs=ice", type: "link" },
      ],
    },
    {
      title: "Wind / Temp",
      icon: "💨",
      desc: "上層風・気温チャート",
      items: [
        { label: "Windy 250hPa Wind", desc: "FL350-410 ジェット気流", url: "https://www.windy.com/-Wind-250hPa-wind250h?wind250h,36,137,5", type: "link" },
        { label: "Windy 850hPa Temp", desc: "下層気温分布", url: "https://www.windy.com/-Temperature-temp?temp,36,137,5", type: "link" },
        { label: "JMA WINDAS", desc: "ウィンドプロファイラ", url: "https://www.jma.go.jp/bosai/windprofiler/", type: "link" },
      ],
    },
    {
      title: "火山灰 (VAAC)",
      icon: "🌋",
      desc: "火山灰情報・降灰予報",
      items: [
        { label: "Tokyo VAAC", desc: "火山灰拡散予測", url: "https://ds.data.jma.go.jp/svd/vaac/data/", type: "link" },
        { label: "気象庁 降灰予報", desc: "降灰予報", url: "https://www.jma.go.jp/bosai/ashfall/", type: "link" },
      ],
    },
  ];

  // 画像カードコンポーネント
  const ChartImageCard = ({ src, label, time, chartKey }) => (
    <div style={{
      background: "rgba(0,0,0,0.5)",
      border: `1px solid ${imgError[chartKey] ? "rgba(248,113,113,0.3)" : "rgba(110,231,183,0.2)"}`,
      borderRadius: "8px", overflow: "hidden",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 10px", background: "rgba(0,0,0,0.6)", borderBottom: "1px solid rgba(110,231,183,0.15)" }}>
        <div>
          <span style={{ color: "#6ee7b7", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>{label}</span>
          {time && <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginLeft: "8px" }}>{time}</span>}
        </div>
        <a href={src} target="_blank" rel="noopener noreferrer" style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none" }}>↗ JMA</a>
      </div>
      {imgError[chartKey] ? (
        <div style={{ height: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
          NO DATA
        </div>
      ) : (
        <div
          style={{ background: "#ffffff", borderRadius: "4px", overflow: "hidden", cursor: "pointer" }}
          onClick={() => setZoomImg({ src, label: `${label} — ${time}` })}
        >
          <img
            src={src}
            alt={label}
            onError={() => setImgError((prev) => ({ ...prev, [chartKey]: true }))}
            style={{ width: "100%", display: "block" }}
          />
        </div>
      )}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* 地上天気図 */}
      <div style={{
        background: "rgba(15, 23, 42, 0.5)",
        border: "1px solid rgba(148, 163, 184, 0.1)",
        borderRadius: "12px",
        padding: "20px",
      }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#6ee7b7", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "3px", marginBottom: "4px", textShadow: "0 0 12px rgba(110,231,183,0.6)" }}>
          ◈ WX CHARTS / WEATHER CHARTS
        </div>
        <div style={{ color: "#64748b", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "16px" }}>
          SOURCE: jma.go.jp — SURFACE ANALYSIS / FORECAST
        </div>

        {/* 地上天気図 2×2グリッド */}
        {surfaceCharts ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
            {["spas", "asas", "fsas24", "fsas48"].map((key) => {
              const chart = surfaceCharts[key];
              if (!chart?.file) return null;
              return <ChartImageCard key={key} src={`${WM_BASE}${chart.file}`} label={chart.label} time={chart.time} chartKey={key} />;
            })}
          </div>
        ) : (
          <div style={{ height: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
            LOADING CHART LIST...
          </div>
        )}
      </div>

      {/* 悪天予想図 */}
      <div style={{
        background: "rgba(15, 23, 42, 0.5)",
        border: "1px solid rgba(148, 163, 184, 0.1)",
        borderRadius: "12px",
        padding: "20px",
      }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "#e2e8f0", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", marginBottom: "4px" }}>
          ⚡ 悪天予想図 (SEVERE WEATHER PROGNOSIS)
        </div>
        <div style={{ color: "#64748b", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "12px" }}>
          FBJP 国内悪天 / FBJP 12h予想 / FBFE 下層悪天
        </div>

        {/* FBJP + FBJP112 画像 2枚並び */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
          <ChartImageCard src={FBJP_URL} label="FBJP 国内悪天予想図" time="CAT/ICE/CB FL別" chartKey="fbjp" />
          <ChartImageCard src={FBJP112_URL} label="FBJP 12h悪天予想" time={`BT ${fbjp112BaseTime}Z → VT ${fbjp112VT}Z`} chartKey="fbjp112" />
        </div>

        {/* FBFE + 関連リンク */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "8px" }}>
          {[
            { label: "FBFE 下層悪天予想図", desc: "FL100以下 ICE/TURB/VIS", url: "https://www.data.jma.go.jp/airinfo/data/awfo_low-level_sigwx.html" },
            { label: "下層悪天 詳細版", desc: "より詳細な下層悪天情報", url: "https://www.data.jma.go.jp/airinfo/data/awfo_low-level_detailed-sigwx.html" },
            { label: "FBJP 12h全時刻", desc: "他の初期値時刻を参照", url: "https://www.data.jma.go.jp/airinfo/awfo_fbjp112/awfo_fbjp112.html" },
            { label: "空域悪天情報一覧", desc: "JMA 航空気象情報", url: "https://www.data.jma.go.jp/airinfo/data/awfo_maiji.html" },
          ].map((item, i) => (
            <a key={i} href={item.url} target="_blank" rel="noopener noreferrer" style={{
              display: "block", padding: "10px 12px",
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(110,231,183,0.1)",
              borderRadius: "6px",
              textDecoration: "none",
            }}>
              <div style={{ color: "#e2e8f0", fontSize: "11px", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>→ {item.label}</div>
              <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{item.desc}</div>
            </a>
          ))}
        </div>
      </div>

      {/* リンクカテゴリグリッド */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "12px" }}>
        {LINK_CATEGORIES.map((cat) => (
          <div key={cat.title} style={{
            padding: "16px",
            background: "rgba(5,10,20,0.8)",
            border: "1px solid rgba(110,231,183,0.12)",
            borderRadius: "8px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
              <span style={{ fontSize: "14px" }}>{cat.icon}</span>
              <span style={{ color: "#e2e8f0", fontSize: "12px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>{cat.title}</span>
            </div>
            <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "10px" }}>{cat.desc}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {cat.items.map((item, j) => (
                <a key={j} href={item.url} target="_blank" rel="noopener noreferrer" style={{
                  display: "flex", alignItems: "center", gap: "8px",
                  padding: "8px 10px",
                  background: "rgba(0,0,0,0.3)",
                  border: "1px solid rgba(110,231,183,0.06)",
                  borderRadius: "4px",
                  textDecoration: "none",
                  transition: "border-color 0.15s ease",
                }}>
                  <span style={{ color: item.type === "pdf" ? "#f97316" : "#60a5fa", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
                    {item.type === "pdf" ? "PDF" : "↗"}
                  </span>
                  <div>
                    <div style={{ color: "#e2e8f0", fontSize: "11px", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{item.label}</div>
                    <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>{item.desc}</div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ズームオーバーレイ */}
      {zoomImg && (
        <div
          onClick={() => setZoomImg(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.92)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            cursor: "pointer",
            padding: "env(safe-area-inset-top, 10px) env(safe-area-inset-right, 10px) env(safe-area-inset-bottom, 10px) env(safe-area-inset-left, 10px)",
          }}
        >
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            width: "100%", maxWidth: "95vw", padding: "8px 4px", marginBottom: "8px",
          }}>
            <span style={{ color: "#6ee7b7", fontSize: "12px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>
              {zoomImg.label}
            </span>
            <span style={{ color: "#64748b", fontSize: "20px", fontFamily: "'JetBrains Mono', monospace", padding: "4px 12px" }}>✕</span>
          </div>
          <div style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
            width: "100%", maxWidth: "95vw", overflow: "auto", WebkitOverflowScrolling: "touch",
          }}>
            <img
              src={zoomImg.src}
              alt={zoomImg.label}
              style={{
                maxWidth: "100%", maxHeight: "85vh", objectFit: "contain",
                borderRadius: "4px",
                background: "#ffffff",
              }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </div>
  );
}


/* ========== OPS WEATHER BRIEFING ========== */

const OPS_AIRPORTS = [
  { icao: "RJCC", name: "新千歳", lat: 42.7752, lon: 141.6920 },
  { icao: "RJAA", name: "成田", lat: 35.7647, lon: 140.3864 },
  { icao: "RJTT", name: "羽田", lat: 35.5494, lon: 139.7798 },
  { icao: "RJBB", name: "関西", lat: 34.4347, lon: 135.2440 },
  { icao: "RJFF", name: "福岡", lat: 33.5853, lon: 130.4508 },
  { icao: "ROAH", name: "那覇", lat: 26.1958, lon: 127.6461 },
];

const OPS_OVERLAYS = [
  { key: "jet300", label: "JET 300hPa", icon: "🌀", desc: "FL300付近のジェット気流。コア位置と風速勾配に注目。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=wind&product=ecmwf&level=300h&calendar=now&message=true" },
  { key: "jet250", label: "JET 250hPa", icon: "🌀", desc: "FL350-410のジェット気流。国際線巡航高度帯。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=wind&product=ecmwf&level=250h&calendar=now&message=true" },
  { key: "cold850", label: "850hPa TEMP", icon: "❄️", desc: "850hPa気温分布。寒気移流と降雪の目安。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=temp&product=ecmwf&level=850h&calendar=now&message=true" },
  { key: "cape", label: "CAPE", icon: "⚡", desc: "対流有効位置エネルギー。雷雨・Cbポテンシャル。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=cape&product=ecmwf&level=surface&calendar=now&message=true" },
  { key: "pressure", label: "SFC PRESSURE", icon: "🗺️", desc: "海面更正気圧。前線・高低気圧の位置確認。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=5&lat=36&lon=137&overlay=pressure&product=ecmwf&level=surface&calendar=now&message=true" },
  { key: "radar", label: "RADAR", icon: "🌧️", desc: "降水エコー合成レーダー。現在の降水分布。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=36.5&lon=137&overlay=radar&product=radar&level=surface&calendar=now&message=true" },
];

/* ========== SEVERE WX — ゲリラ豪雨・台風 ========== */
const SEVERE_OVERLAYS = [
  { key: "thunder", label: "THUNDERSTORMS", icon: "⛈️", desc: "雷雨確率分布。高確率域=Cb活動予測。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=35.5&lon=137&overlay=thunder&product=ecmwf&level=surface&calendar=now&message=true" },
  { key: "cape", label: "CAPE", icon: "⚡", desc: "対流有効位置エネルギー。>1000 J/kg=ゲリラ豪雨リスク。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=35.5&lon=137&overlay=cape&product=ecmwf&level=surface&calendar=now&message=true" },
  { key: "rainAccu", label: "3h RAIN", icon: "🌊", desc: "3時間積算雨量予想。集中豪雨域の特定。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=35.5&lon=137&overlay=rainAccu&product=ecmwf&level=surface&calendar=now&message=true" },
  { key: "cloudtop", label: "CLOUD TOP", icon: "☁️", desc: "雲頂高度。FL350超=Cb頂部。積乱雲の発達度合い。",
    src: "https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=6&lat=35.5&lon=137&overlay=cloudtop&product=ecmwf&level=surface&calendar=now&message=true" },
];

const TYPHOON_LINKS = [
  { label: "JMA 台風情報", desc: "経路図・基本情報・予報円", url: "https://www.jma.go.jp/bosai/typhoon/", accent: true },
  { label: "JTWC", desc: "Joint Typhoon Warning Center", url: "https://www.metoc.navy.mil/jtwc/jtwc.html" },
  { label: "Windy Hurricanes", desc: "Global tropical cyclone tracks", url: "https://www.windy.com/-Hurricanes-tropical-storms/hurricanes?36,137,5" },
  { label: "earth.nullschool", desc: "Global wind visualization", url: "https://earth.nullschool.net/#current/wind/surface/level/orthographic=-222.00,35.00,512" },
  { label: "過去の台風経路", desc: "JMA Best Track Archive", url: "https://www.data.jma.go.jp/yoho/typhoon/route_map/bstv.html" },
];

const RISK_CRITERIA = [
  { condition: "CAPE >1000", level: "MOD", color: "#fbbf24" },
  { condition: "CAPE >2500", level: "HIGH", color: "#f87171" },
  { condition: "雷活動度 3+", level: "CB", color: "#f87171" },
  { condition: "雲頂 >FL400", level: "SEV CB", color: "#ef4444" },
  { condition: ">50mm/h", level: "EXTREME", color: "#ef4444" },
];

function SevereWxPanel() {
  const [activeSection, setActiveSection] = useState("rain");
  const [overlayKey, setOverlayKey] = useState("thunder");

  const jstMonth = new Date(Date.now() + 9 * 3600000).getUTCMonth() + 1;
  const isTyphoonSeason = jstMonth >= 6 && jstMonth <= 11;

  const sections = [
    { key: "rain", label: "ゲリラ豪雨", icon: "⛈️" },
    { key: "typhoon", label: "台風", icon: "🌀" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* サブタブ切替 */}
      <div style={{ display: "flex", gap: "6px" }}>
        {sections.map(s => (
          <button key={s.key} onClick={() => setActiveSection(s.key)} style={{
            padding: "6px 16px", background: activeSection === s.key ? "rgba(110,231,183,0.12)" : "transparent",
            border: `1px solid ${activeSection === s.key ? "rgba(110,231,183,0.4)" : "rgba(148,163,184,0.12)"}`,
            borderRadius: "4px", color: activeSection === s.key ? "#6ee7b7" : "#64748b",
            fontSize: "12px", fontWeight: activeSection === s.key ? 700 : 400, cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
          }}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {activeSection === "rain" && (
        <PanelFrame title="GUERRILLA RAIN MONITOR / ゲリラ豪雨モニター" code="SECT-GR">
          {/* Overlay切替 */}
          <div style={{ display: "flex", gap: "4px", padding: "12px 16px", borderBottom: "1px solid rgba(110,231,183,0.08)", flexWrap: "wrap" }}>
            {SEVERE_OVERLAYS.map(o => (
              <button key={o.key} onClick={() => setOverlayKey(o.key)} style={{
                padding: "4px 10px", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace",
                background: overlayKey === o.key ? "rgba(110,231,183,0.15)" : "transparent",
                border: `1px solid ${overlayKey === o.key ? "rgba(110,231,183,0.4)" : "rgba(148,163,184,0.1)"}`,
                borderRadius: "3px", color: overlayKey === o.key ? "#6ee7b7" : "#94a3b8", cursor: "pointer",
              }}>
                {o.icon} {o.label}
              </button>
            ))}
          </div>
          {/* Overlay説明 */}
          <div style={{ padding: "6px 16px", color: "#475569", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>
            {SEVERE_OVERLAYS.find(o => o.key === overlayKey)?.desc}
          </div>
          {/* Windy iframe */}
          <div style={{ position: "relative", background: "#000" }}>
            <iframe
              key={overlayKey}
              src={SEVERE_OVERLAYS.find(o => o.key === overlayKey)?.src}
              style={{ width: "100%", height: "440px", border: "none", display: "block" }}
              title={`Severe WX - ${overlayKey}`}
              loading="lazy"
            />
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 40px rgba(0,0,0,0.4)" }} />
          </div>
          {/* リスク判定基準 */}
          <div style={{ display: "flex", gap: "8px", padding: "10px 16px", flexWrap: "wrap", borderTop: "1px solid rgba(110,231,183,0.08)" }}>
            <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", alignSelf: "center" }}>RISK:</span>
            {RISK_CRITERIA.map((r, i) => (
              <span key={i} style={{
                fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", padding: "2px 6px",
                border: `1px solid ${r.color}33`, borderRadius: "3px", color: r.color,
              }}>
                {r.condition} = {r.level}
              </span>
            ))}
          </div>
          {/* JMAリンク */}
          <div style={{ display: "flex", gap: "6px", padding: "10px 16px", flexWrap: "wrap", borderTop: "1px solid rgba(110,231,183,0.08)" }}>
            <ExtLink href="https://www.jma.go.jp/bosai/nowc/#zoom:6/lat:36.0/lon:139.0/colordepth:normal/elements:hrpns" accent>降水ナウキャスト</ExtLink>
            <ExtLink href="https://www.jma.go.jp/bosai/nowc/#zoom:6/lat:36.0/lon:139.0/colordepth:normal/elements:thunder">雷ナウキャスト</ExtLink>
            <ExtLink href="https://www.jma.go.jp/bosai/nowc/#zoom:6/lat:36.0/lon:139.0/colordepth:normal/elements:tornado">竜巻ナウキャスト</ExtLink>
            <ExtLink href="https://www.river.go.jp/kawabou/mb/rd/xbandmap.html">XRAIN 高精度降水</ExtLink>
            <ExtLink href="https://www.jma.go.jp/bosai/risk/">キキクル</ExtLink>
          </div>
        </PanelFrame>
      )}

      {activeSection === "typhoon" && (
        <PanelFrame title="TYPHOON TRACKER / 台風トラッカー" code="SECT-TY">
          {/* 台風シーズン表示 */}
          <div style={{
            padding: "8px 16px", borderBottom: "1px solid rgba(110,231,183,0.08)",
            background: isTyphoonSeason ? "rgba(251,191,36,0.06)" : "transparent",
          }}>
            <span style={{
              fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
              color: isTyphoonSeason ? "#fbbf24" : "#334155",
            }}>
              {isTyphoonSeason ? "TYPHOON SEASON ACTIVE (JUN-NOV) — 台風情報を定期的に確認" : "OFF-SEASON — 台風発生は稀ですが監視継続"}
            </span>
          </div>
          {/* Windy wind overlay 広域 */}
          <div style={{ position: "relative", background: "#000" }}>
            <iframe
              src="https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C&metricWind=kt&zoom=4&lat=25&lon=135&overlay=wind&product=ecmwf&level=surface&calendar=now&message=true"
              style={{ width: "100%", height: "400px", border: "none", display: "block" }}
              title="Typhoon Wind"
              loading="lazy"
            />
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 40px rgba(0,0,0,0.4)" }} />
          </div>
          {/* 台風関連リンク */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px", padding: "12px 16px" }}>
            {TYPHOON_LINKS.map((link, i) => (
              <a key={i} href={link.url} target="_blank" rel="noopener noreferrer" style={{
                display: "block", padding: "10px 12px",
                background: link.accent ? "rgba(110,231,183,0.07)" : "rgba(0,0,0,0.3)",
                border: `1px solid ${link.accent ? "rgba(110,231,183,0.25)" : "rgba(148,163,184,0.08)"}`,
                borderRadius: "4px", textDecoration: "none",
              }}>
                <div style={{ color: link.accent ? "#6ee7b7" : "#e2e8f0", fontSize: "11px", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>
                  {link.label} <span style={{ fontSize: "9px", opacity: 0.5 }}>↗</span>
                </div>
                <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{link.desc}</div>
              </a>
            ))}
          </div>
        </PanelFrame>
      )}
    </div>
  );
}

const JMA_UPPER_CHARTS = [
  { title: "AUPQ78 (500/300hPa)", desc: "ジェット気流・トラフ・リッジ位置", url: "https://www.jma.go.jp/bosai/numericmap/#type:aupq78" },
  { title: "AUPQ35 (850/700hPa)", desc: "暖気・寒気移流。850hPa 0℃/-6℃ライン", url: "https://www.jma.go.jp/bosai/numericmap/#type:aupq35" },
  { title: "FBJP 国内悪天予想図", desc: "CAT/ICE/CB予想域。FL別6-18h予想", url: "https://www.jma.go.jp/bosai/numericmap/#type:fbjp" },
  { title: "FBFE 下層悪天予想図", desc: "FL100以下 ICE/TURB/VIS", url: "https://www.jma.go.jp/bosai/numericmap/#type:fbfe" },
  { title: "ASAS 地上実況天気図", desc: "高・低気圧中心と前線位置", url: "https://www.jma.go.jp/bosai/weather_map/" },
  { title: "FSAS 地上予想天気図", desc: "24h/48h先の前線・気圧配置予想", url: "https://www.jma.go.jp/bosai/weather_map/#type=forecast" },
];

const PILOT_GUIDE = [
  { icon: "🌀", title: "ジェット気流の読み方", items: [
    "300hPa: 70kt以上のシアーライン＝ジェットコア",
    "250hPa: FL350-410付近。冬期日本上空120-180kt",
    "コアの南側＝強いCAT帯（風速勾配大の領域）",
    "トラフ軸の東側で上昇流 → 悪天域になりやすい",
  ]},
  { icon: "❄️", title: "寒気の目安 (850hPa)", items: [
    "850T -6℃以下: 平地で雪（太平洋側は-3℃目安）",
    "850T -12℃以下: 強い冬型、日本海側大雪",
    "850T -15℃以下: 記録的寒気、JPCZに警戒",
    "地上気温 ≒ 850T + 12℃ (目安)",
  ]},
  { icon: "⚡", title: "不安定度 (CAPE)", items: [
    "0-300 J/kg: 安定～やや不安定",
    "300-1000 J/kg: 中程度。孤立Cb発生",
    "1000-2500 J/kg: 強い不安定。組織化した対流",
    "2500+ J/kg: 極めて不安定。スーパーセルリスク",
  ]},
  { icon: "🗺️", title: "地上天気図の前線読解", items: [
    "温暖前線: 前方300-500nmに上層雲→中層雲→層雲",
    "寒冷前線: 前線直近にCb/TS。通過後は急速に改善",
    "閉塞前線: 温暖前線型の雲域＋寒冷前線型Cb混在",
    "等圧線の間隔狭い領域: 強風域。CAT誘発",
  ]},
];

function OpsWxPanel() {
  const [overlayKey, setOverlayKey] = useState("jet300");
  const [airportData, setAirportData] = useState({});
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [guideOpen, setGuideOpen] = useState(null);

  // 季節判定
  const jstNow = new Date(Date.now() + 9 * 3600000);
  const month = jstNow.getUTCMonth() + 1;
  const isWinter = month <= 2 || month === 12;
  const isSummer = month >= 6 && month <= 9;

  // Open-Meteo APIからデータ取得
  const fetchAirportData = useCallback(async () => {
    setDataLoading(true);
    setDataError(null);
    try {
      const results = {};
      await Promise.all(OPS_AIRPORTS.map(async (ap) => {
        const url = `https://api.open-meteo.com/v1/forecast`
          + `?latitude=${ap.lat}&longitude=${ap.lon}`
          + `&hourly=windspeed_300hPa,winddirection_300hPa`
          + `,windspeed_250hPa,winddirection_250hPa`
          + `,temperature_850hPa,cape`
          + `&forecast_days=1&timezone=UTC`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${ap.icao}: HTTP ${res.status}`);
        const json = await res.json();
        const idx = Math.min(new Date().getUTCHours(), (json.hourly?.time?.length ?? 1) - 1);
        const toKt = (v) => v != null ? Math.round(v * 0.539957) : null;
        results[ap.icao] = {
          wind300spd: toKt(json.hourly?.windspeed_300hPa?.[idx]),
          wind300dir: json.hourly?.winddirection_300hPa?.[idx] != null ? Math.round(json.hourly.winddirection_300hPa[idx]) : null,
          wind250spd: toKt(json.hourly?.windspeed_250hPa?.[idx]),
          wind250dir: json.hourly?.winddirection_250hPa?.[idx] != null ? Math.round(json.hourly.winddirection_250hPa[idx]) : null,
          temp850: json.hourly?.temperature_850hPa?.[idx] != null ? Math.round(json.hourly.temperature_850hPa[idx] * 10) / 10 : null,
          cape: json.hourly?.cape?.[idx] != null ? Math.round(json.hourly.cape[idx]) : null,
        };
      }));
      setAirportData(results);
      setLastFetch(new Date());
    } catch (e) {
      setDataError(e.message);
    } finally {
      setDataLoading(false);
    }
  }, []);

  const fetchRef = useRef(fetchAirportData);
  useEffect(() => { fetchRef.current = fetchAirportData; }, [fetchAirportData]);
  useEffect(() => {
    fetchRef.current();
    const iv = setInterval(() => fetchRef.current(), 600000);
    return () => clearInterval(iv);
  }, []);

  // ヘルパー
  const fmtWind = (dir, spd) => {
    if (dir == null || spd == null) return "---/---KT";
    return `${String(dir).padStart(3, "0")}/${String(spd).padStart(3, "0")}KT`;
  };
  const jetColor = (spd) => {
    if (spd == null) return "#475569";
    if (spd >= 120) return "#f87171";
    if (spd >= 80) return "#fbbf24";
    if (spd >= 50) return "#6ee7b7";
    return "#94a3b8";
  };
  const temp850Color = (t) => {
    if (t == null) return "#475569";
    if (t <= -15) return "#c084fc";
    if (t <= -6) return "#60a5fa";
    if (t <= 0) return "#93c5fd";
    if (t >= 24) return "#f87171";
    return "#94a3b8";
  };
  const capeColor = (c) => {
    if (c == null) return "#475569";
    if (c >= 2500) return "#f87171";
    if (c >= 1000) return "#fbbf24";
    if (c >= 300) return "#fde68a";
    return "#94a3b8";
  };

  const currentOverlay = OPS_OVERLAYS.find(o => o.key === overlayKey) ?? OPS_OVERLAYS[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

      {/* 上段: Windy iframe */}
      <PanelFrame title="OPS WEATHER BRIEFING" code="SECT-OPS" style={{ padding: "0" }}>
        {/* コントロールバー */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "10px 14px", flexWrap: "wrap", gap: "8px",
          borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
          background: "rgba(0,0,0,0.4)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ee7b7", boxShadow: "0 0 8px #6ee7b7" }} />
            <span style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", textShadow: "0 0 8px rgba(110,231,183,0.5)" }}>UPPER-AIR / OPS DISPLAY</span>
          </div>
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            {OPS_OVERLAYS.map(o => (
              <button key={o.key} onClick={() => setOverlayKey(o.key)} style={{
                padding: "4px 10px",
                background: overlayKey === o.key ? "rgba(110, 231, 183, 0.12)" : "transparent",
                border: overlayKey === o.key ? "1px solid rgba(110, 231, 183, 0.5)" : "1px solid rgba(110, 231, 183, 0.06)",
                borderRadius: "2px",
                color: overlayKey === o.key ? "#6ee7b7" : "#475569",
                fontSize: "9px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.5px",
                textShadow: overlayKey === o.key ? "0 0 8px rgba(110,231,183,0.5)" : "none",
                transition: "all 0.15s ease",
              }}>
                {o.icon} {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Windy iframe */}
        <div style={{ position: "relative", background: "#000" }}>
          <iframe
            key={currentOverlay.key}
            src={currentOverlay.src}
            style={{ width: "100%", height: "480px", border: "none", display: "block" }}
            title={currentOverlay.label}
            loading="lazy"
            allow="autoplay"
          />
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", boxShadow: "inset 0 0 60px rgba(0,0,0,0.4)" }} />
        </div>

        {/* オーバーレイ説明 */}
        <div style={{
          padding: "8px 14px", background: "rgba(0,0,0,0.5)",
          borderTop: "1px solid rgba(110, 231, 183, 0.08)",
          display: "flex", alignItems: "center", gap: "10px",
        }}>
          <span style={{ fontSize: "16px" }}>{currentOverlay.icon}</span>
          <span style={{ color: "#6ee7b7", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>{currentOverlay.label}</span>
          <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>{currentOverlay.desc}</span>
        </div>
      </PanelFrame>

      {/* 下段: 2カラム */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "16px", alignItems: "start" }}>

        {/* 左: 空港数値テーブル */}
        <PanelFrame title={`AIRPORT UPPER-AIR DATA${isWinter ? " ❄️ WINTER" : isSummer ? " ⚡ SUMMER" : ""}`} code="OPS-DATA" style={{ padding: "0" }}>
          {/* ヘッダーバー */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 14px", background: "rgba(0,0,0,0.4)",
            borderBottom: "1px solid rgba(110, 231, 183, 0.08)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div style={{
                width: "5px", height: "5px", borderRadius: "50%",
                background: dataLoading ? "#fbbf24" : dataError ? "#f87171" : "#6ee7b7",
                boxShadow: `0 0 8px ${dataLoading ? "#fbbf24" : dataError ? "#f87171" : "#6ee7b7"}`,
              }} />
              <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>
                {dataLoading ? "FETCHING..." : dataError ? "DATA ERROR" : "OPEN-METEO ECMWF"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {lastFetch && <span style={{ color: "#334155", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace" }}>UPD {lastFetch.toISOString().slice(11, 16)}Z</span>}
              <button onClick={() => fetchRef.current()} style={{
                padding: "3px 8px", background: "rgba(110,231,183,0.06)",
                border: "1px solid rgba(110,231,183,0.15)", borderRadius: "2px",
                color: "#6ee7b7", fontSize: "8px", cursor: "pointer",
                fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
              }}>REFRESH</button>
            </div>
          </div>

          {/* テーブル */}
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace" }}>
              <thead>
                <tr style={{ background: "rgba(0,0,0,0.5)", borderBottom: "1px solid rgba(110,231,183,0.15)" }}>
                  {["ICAO", "300hPa WIND", "250hPa WIND", "850T (℃)", "CAPE (J/kg)"].map((h, i) => (
                    <th key={h} style={{
                      padding: "8px 10px", textAlign: i === 0 ? "left" : "right",
                      color: (isWinter && h.includes("850T")) ? "#60a5fa" : (isSummer && h.includes("CAPE")) ? "#fbbf24" : "#334155",
                      fontSize: "8px", letterSpacing: "1.5px", fontWeight: 700,
                      background: (isWinter && h.includes("850T")) ? "rgba(96,165,250,0.06)" : (isSummer && h.includes("CAPE")) ? "rgba(251,191,36,0.06)" : "transparent",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {OPS_AIRPORTS.map((ap, ri) => {
                  const d = airportData[ap.icao] || {};
                  return (
                    <tr key={ap.icao} style={{
                      borderBottom: "1px solid rgba(110,231,183,0.05)",
                      background: ri % 2 === 0 ? "rgba(255,255,255,0.01)" : "transparent",
                    }}>
                      <td style={{ padding: "8px 10px", fontSize: "11px", fontWeight: 700, color: "#6ee7b7", textShadow: "0 0 6px rgba(110,231,183,0.3)" }}>
                        {ap.icao}<span style={{ marginLeft: "6px", fontSize: "9px", color: "#334155", fontWeight: 400 }}>{ap.name}</span>
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontSize: "11px", color: jetColor(d.wind300spd) }}>{fmtWind(d.wind300dir, d.wind300spd)}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", fontSize: "11px", color: jetColor(d.wind250spd) }}>{fmtWind(d.wind250dir, d.wind250spd)}</td>
                      <td style={{
                        padding: "8px 10px", textAlign: "right", fontSize: "11px",
                        fontWeight: isWinter ? 700 : 400, color: temp850Color(d.temp850),
                        background: isWinter ? "rgba(96,165,250,0.04)" : "transparent",
                        textShadow: (isWinter && d.temp850 != null && d.temp850 <= -6) ? "0 0 8px rgba(96,165,250,0.5)" : "none",
                      }}>
                        {d.temp850 != null ? `${d.temp850 > 0 ? "+" : ""}${d.temp850}` : "---"}
                      </td>
                      <td style={{
                        padding: "8px 10px", textAlign: "right", fontSize: "11px",
                        fontWeight: isSummer ? 700 : 400, color: capeColor(d.cape),
                        background: isSummer ? "rgba(251,191,36,0.04)" : "transparent",
                        textShadow: (isSummer && d.cape != null && d.cape >= 1000) ? "0 0 8px rgba(251,191,36,0.5)" : "none",
                      }}>
                        {d.cape != null ? d.cape : "---"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 凡例 */}
          <div style={{
            display: "flex", gap: "10px", padding: "8px 14px", flexWrap: "wrap",
            borderTop: "1px solid rgba(110,231,183,0.05)", background: "rgba(0,0,0,0.3)",
          }}>
            <span style={{ fontSize: "8px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>JET:</span>
            {[{ l: ">120kt", c: "#f87171" }, { l: "80-120", c: "#fbbf24" }, { l: "50-80", c: "#6ee7b7" }, { l: "<50", c: "#94a3b8" }].map(x => (
              <div key={x.l} style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: x.c }} />
                <span style={{ fontSize: "7px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>{x.l}</span>
              </div>
            ))}
            <span style={{ color: "#1e293b", fontSize: "8px" }}>|</span>
            <span style={{ fontSize: "8px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>850T:</span>
            {[{ l: "<-15℃", c: "#c084fc" }, { l: "<-6℃", c: "#60a5fa" }, { l: "<0℃", c: "#93c5fd" }].map(x => (
              <div key={x.l} style={{ display: "flex", alignItems: "center", gap: "3px" }}>
                <div style={{ width: "4px", height: "4px", borderRadius: "50%", background: x.c }} />
                <span style={{ fontSize: "7px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>{x.l}</span>
              </div>
            ))}
          </div>
        </PanelFrame>

        {/* 右: JMAリンク + 季節サマリ */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {/* 季節バッジ */}
          <div style={{
            padding: "10px 14px",
            background: isWinter ? "rgba(96,165,250,0.08)" : isSummer ? "rgba(251,191,36,0.08)" : "rgba(110,231,183,0.05)",
            border: `1px solid ${isWinter ? "rgba(96,165,250,0.3)" : isSummer ? "rgba(251,191,36,0.3)" : "rgba(110,231,183,0.12)"}`,
            borderRadius: "4px",
          }}>
            <div style={{
              fontSize: "9px",
              color: isWinter ? "#60a5fa" : isSummer ? "#fbbf24" : "#6ee7b7",
              fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", fontWeight: 700, marginBottom: "4px",
            }}>
              {isWinter ? "❄️ WINTER OPS FOCUS" : isSummer ? "⚡ SUMMER OPS FOCUS" : "🌤️ SEASONAL FOCUS"}
            </div>
            <div style={{ fontSize: "10px", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace", lineHeight: "1.6" }}>
              {isWinter ? "寒気(850T)を重点監視。-6℃以下で平地降雪、-12℃以下で大雪域拡大。JPCZに注意。"
                : isSummer ? "CAPE値を重点監視。300J/kg以上で孤立Cb、1000J/kg以上で組織化した雷雲。午後の急発達に注意。"
                : "春秋はジェット気流と前線の動向を優先監視。"}
            </div>
          </div>

          {/* JMA高層天気図リンク */}
          <PanelFrame title="JMA UPPER-AIR CHARTS" code="LINKS" style={{ padding: "0" }}>
            <div style={{ padding: "10px" }}>
              {JMA_UPPER_CHARTS.map((chart, i) => (
                <a key={i} href={chart.url} target="_blank" rel="noopener noreferrer" style={{
                  display: "block", padding: "8px 10px",
                  marginBottom: i < JMA_UPPER_CHARTS.length - 1 ? "2px" : 0,
                  background: "rgba(0,0,0,0.3)",
                  borderLeft: "2px solid rgba(110,231,183,0.2)",
                  borderRadius: "0 2px 2px 0",
                  textDecoration: "none", transition: "all 0.15s ease",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ color: "#6ee7b7", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{chart.title}</span>
                    <span style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>↗</span>
                  </div>
                  <div style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginTop: "2px" }}>{chart.desc}</div>
                </a>
              ))}
            </div>
          </PanelFrame>

          {/* 外部リンク */}
          <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
            <ExtLink href="https://aviationweather.gov" accent>AWC</ExtLink>
            <ExtLink href="https://www.windy.com/-Wind-250hPa-wind250h?wind250h">Windy 250hPa</ExtLink>
            <ExtLink href="https://www.jma.go.jp/bosai/windprofiler/">WINDAS</ExtLink>
          </div>
        </div>
      </div>

      {/* パイロット判読ガイド */}
      <div>
        <div style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px", marginBottom: "8px" }}>PILOT INTERPRETATION GUIDE</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "8px" }}>
          {PILOT_GUIDE.map((section, si) => (
            <div key={si} onClick={() => setGuideOpen(guideOpen === si ? null : si)} style={{
              padding: "12px",
              background: guideOpen === si ? "rgba(110,231,183,0.06)" : "rgba(5,10,20,0.8)",
              border: `1px solid ${guideOpen === si ? "rgba(110,231,183,0.25)" : "rgba(110,231,183,0.08)"}`,
              borderRadius: "4px", cursor: "pointer", transition: "all 0.15s ease",
            }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: guideOpen === si ? "8px" : "0" }}>
                <span style={{ fontSize: "16px" }}>{section.icon}</span>
                <span style={{ color: "#e2e8f0", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{section.title}</span>
                <span style={{ marginLeft: "auto", color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", transition: "transform 0.15s ease", transform: guideOpen === si ? "rotate(90deg)" : "none" }}>▶</span>
              </div>
              {guideOpen === si && (
                <div style={{ paddingLeft: "28px" }}>
                  {section.items.map((item, ii) => (
                    <div key={ii} style={{ display: "flex", gap: "6px", alignItems: "flex-start", marginBottom: "4px" }}>
                      <span style={{ color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginTop: "1px", flexShrink: 0 }}>{">"}</span>
                      <span style={{ color: "#64748b", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", lineHeight: "1.6" }}>{item}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ========== JMA WEATHER TICKER — 6地域 並行ティッカー ========== */
function JmaWeatherTicker() {
  const AREAS = [
    { code: "016000", short: "CTS", name: "札幌", color: "#c4b5fd" },
    { code: "130000", short: "TYO", name: "東京", color: "#6ee7b7" },
    { code: "230000", short: "NGO", name: "名古屋", color: "#6ee7b7" },
    { code: "270000", short: "OSA", name: "大阪", color: "#93c5fd" },
    { code: "400000", short: "FUK", name: "福岡", color: "#fca5a5" },
    { code: "471000", short: "OKA", name: "沖縄", color: "#fde68a" },
  ];

  const [rows, setRows] = useState(
    AREAS.map(a => ({ ...a, text: "LOADING...", speed: 70 }))
  );

  useEffect(() => {
    AREAS.forEach((a, i) => {
      fetch(`https://www.jma.go.jp/bosai/forecast/data/overview_forecast/${a.code}.json`)
        .then(r => r.json())
        .then(j => {
          const raw = (j.text || "").replace(/\n\n+/g, "　").replace(/\n/g, " ").trim();
          // テキスト長に応じてスクロール速度を調整（長いほど速く）
          const speed = Math.max(50, Math.min(120, raw.length * 0.5));
          setRows(prev => prev.map((row, idx) =>
            idx === i ? { ...row, text: raw || "データなし", speed } : row
          ));
        })
        .catch(() => {
          setRows(prev => prev.map((row, idx) =>
            idx === i ? { ...row, text: "FETCH ERROR" } : row
          ));
        });
    });
  }, []); // eslint-disable-line

  return (
    <div style={{
      background: "rgba(2, 6, 12, 0.97)",
      borderTop: "2px solid rgba(110, 231, 183, 0.25)",
      borderBottom: "2px solid rgba(110, 231, 183, 0.1)",
    }}>
      <style>{`
        @keyframes ticker-tyo { from { transform: translateX(0); } to { transform: translateX(-100%); } }
        @keyframes ticker-osa { from { transform: translateX(0); } to { transform: translateX(-100%); } }
        @keyframes ticker-cts { from { transform: translateX(0); } to { transform: translateX(-100%); } }
        @keyframes ticker-fuk { from { transform: translateX(0); } to { transform: translateX(-100%); } }
        @keyframes ticker-oka { from { transform: translateX(0); } to { transform: translateX(-100%); } }
        @keyframes ticker-ngo { from { transform: translateX(0); } to { transform: translateX(-100%); } }
      `}</style>
      {rows.map((row, i) => {
        const animName = ["ticker-tyo", "ticker-osa", "ticker-cts", "ticker-fuk", "ticker-oka", "ticker-ngo"][i];
        const isEven = i % 2 === 0;
        return (
          <div key={row.code} style={{
            display: "flex", alignItems: "center",
            borderBottom: i < rows.length - 1 ? `1px solid ${row.color}18` : "none",
            height: "30px",
            overflow: "hidden",
            background: isEven ? "rgba(255,255,255,0.018)" : "transparent",
          }}>
            {/* 地域ラベル（固定） */}
            <div style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "0 12px",
              borderRight: `2px solid ${row.color}50`,
              background: `${row.color}12`,
              minWidth: "110px", flexShrink: 0, height: "100%",
            }}>
              <div style={{
                width: "5px", height: "5px", borderRadius: "50%",
                background: row.color,
                boxShadow: `0 0 8px ${row.color}, 0 0 16px ${row.color}60`,
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: "10px", fontWeight: 700,
                color: row.color,
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "2px",
                textShadow: `0 0 10px ${row.color}`,
              }}>{row.short}</span>
              <span style={{
                fontSize: "9px", color: `${row.color}90`,
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 500,
              }}>{row.name}</span>
            </div>
            {/* テキストティッカー（スクロール） */}
            <div style={{ flex: 1, overflow: "hidden", position: "relative", padding: "0 8px" }}>
              <div style={{
                display: "inline-block",
                whiteSpace: "nowrap",
                animation: `${animName} ${row.speed}s linear infinite`,
                paddingLeft: "100%",
                fontSize: "11px",
                color: isEven ? "#e2e8f0" : "#cbd5e1",
                fontFamily: "'JetBrains Mono', monospace",
                letterSpacing: "0.5px",
                textShadow: `0 0 12px ${row.color}30`,
              }}>
                {row.text}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}


/* ========== ICS PARSER ========== */
function parseICS(text) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const get = (key) => {
      const m = b.match(new RegExp(`${key}:(.*)`));
      return m ? m[1].trim() : "";
    };
    const uid = get("UID");
    const summary = get("SUMMARY");
    const location = get("LOCATION");
    const dtstart = get("DTSTART");
    const dtend = get("DTEND");

    // Parse type and route from SUMMARY like "FLY (HND-AOJ-HND)"
    const typeMatch = summary.match(/^(FLY|NON-FLY|OFF|STANDBY|GROUND)\s*\(([^)]*)\)/);
    const type = typeMatch ? typeMatch[1] : summary;
    const routeStr = typeMatch ? typeMatch[2] : "";
    const route = type === "FLY" && routeStr ? routeStr.split("-") : [];

    // Parse dates: 20260201T030000Z → Date
    const parseD = (s) => {
      if (!s) return null;
      const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
      const h = s.slice(9, 11), mi = s.slice(11, 13), se = s.slice(13, 15);
      return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se));
    };

    const tripId = uid.replace(/-\d+$/, "");

    events.push({
      uid, summary, location, type, route, tripId,
      start: parseD(dtstart),
      end: parseD(dtend),
    });
  }
  events.sort((a, b) => a.start - b.start);
  return events;
}

/* ========== DUTY SCHEDULE PANEL ========== */
const DUTY_STORAGE_KEY = "wx-dashboard-duty-ics";
const DUTY_COLORS = {
  FLY: "#6ee7b7",
  "NON-FLY": "#fbbf24",
  OFF: "#475569",
  STANDBY: "#c4b5fd",
  GROUND: "#67e8f9",
};

function getTodayDutyEvents() {
  try {
    const saved = localStorage.getItem(DUTY_STORAGE_KEY);
    if (!saved) return [];
    const events = JSON.parse(saved).map(e => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
    const now = new Date();
    // JST-based "today"
    const JST = 9 * 3600000;
    const nowJST = new Date(now.getTime() + JST);
    const todayJST = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate()));
    const todayStartUTC = new Date(todayJST.getTime() - JST);
    const todayEndUTC = new Date(todayStartUTC.getTime() + 86400000);
    return events.filter(e => e.start < todayEndUTC && e.end > todayStartUTC);
  } catch { return []; }
}

function getDutyRouteIcaoCodes(events) {
  const iataSet = new Set();
  for (const ev of events) {
    if (ev.type === "FLY" && ev.route) ev.route.forEach(c => iataSet.add(c));
  }
  const icaos = [];
  for (const iata of iataSet) {
    const icao = iataToIcao(iata);
    if (icao) icaos.push(icao);
  }
  return icaos;
}

function DutySchedulePanel() {
  const [events, setEvents] = useState(() => {
    try {
      const saved = localStorage.getItem(DUTY_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return parsed.map(e => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
      }
    } catch (e) { /* ignore */ }
    return [];
  });
  const [dragOver, setDragOver] = useState(false);
  const [now, setNow] = useState(new Date());
  const [summaryMonth, setSummaryMonth] = useState(() => new Date());
  const fileRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  const loadICS = (text) => {
    const parsed = parseICS(text);
    setEvents(parsed);
    localStorage.setItem(DUTY_STORAGE_KEY, JSON.stringify(parsed));
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => loadICS(ev.target.result);
      reader.readAsText(file);
    }
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => loadICS(ev.target.result);
      reader.readAsText(file);
    }
  };

  const clearData = () => {
    setEvents([]);
    localStorage.removeItem(DUTY_STORAGE_KEY);
  };

  const fmtZ = (d) => {
    if (!d) return "--:--Z";
    return d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0") + "Z";
  };

  const fmtDate = (d) => {
    const mo = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const dow = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][d.getUTCDay()];
    return `${mo}/${day} (${dow})`;
  };

  // Current duty
  const currentEvent = events.find(e => now >= e.start && now < e.end);
  // Next FLY duty
  const nextFly = events.find(e => e.type === "FLY" && e.start > now);
  // Next non-OFF duty
  const nextDuty = events.find(e => e.type !== "OFF" && e.start > now);

  // Countdown to next duty
  const countdown = (target) => {
    if (!target) return null;
    const diff = target.start - now;
    if (diff <= 0) return null;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return `${h}h ${m}m`;
  };

  // Group events by JST date for timeline (today + 6 days)
  const JST_OFFSET = 9 * 3600000;
  const nowJST = new Date(now.getTime() + JST_OFFSET);
  const todayJST = new Date(Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate()));
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dayStartJST = new Date(todayJST.getTime() + i * 86400000);
    const dayEndJST = new Date(dayStartJST.getTime() + 86400000);
    // Convert JST day boundaries back to UTC for filtering
    const dayStartUTC = new Date(dayStartJST.getTime() - JST_OFFSET);
    const dayEndUTC = new Date(dayEndJST.getTime() - JST_OFFSET);
    const dayEvents = events.filter(e => e.start < dayEndUTC && e.end > dayStartUTC);
    days.push({ date: dayStartJST, events: dayEvents });
  }

  // No data — show drop zone
  if (events.length === 0) {
    return (
      <div style={{ padding: "20px" }}>
        <div style={{ fontSize: "11px", color: "#6ee7b7", letterSpacing: "2px", marginBottom: "16px", fontFamily: "'JetBrains Mono', monospace" }}>
          ▸ DUTY SCHEDULE — CREWACCESS ICS IMPORT
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#6ee7b7" : "rgba(110,231,183,0.3)"}`,
            borderRadius: "8px",
            padding: "60px 20px",
            textAlign: "center",
            cursor: "pointer",
            background: dragOver ? "rgba(110,231,183,0.05)" : "transparent",
            transition: "all 0.2s",
          }}
        >
          <div style={{ fontSize: "36px", marginBottom: "12px" }}>📋</div>
          <div style={{ color: "#94a3b8", fontSize: "13px", marginBottom: "8px" }}>
            CrewAccess の .ics ファイルをここにドロップ
          </div>
          <div style={{ color: "#475569", fontSize: "11px" }}>
            またはクリックしてファイルを選択
          </div>
          <input ref={fileRef} type="file" accept=".ics" onChange={handleFile} style={{ display: "none" }} />
        </div>
      </div>
    );
  }

  // Group events by tripId for trip summary
  const trips = [];
  const seenTrips = new Set();
  for (const ev of events) {
    if (!seenTrips.has(ev.tripId)) {
      seenTrips.add(ev.tripId);
      const tripEvts = events.filter(e => e.tripId === ev.tripId);
      const flyLegs = tripEvts.filter(e => e.type === "FLY");
      const route = [];
      for (const f of flyLegs) {
        if (f.route) f.route.forEach(c => { if (route.length === 0 || route[route.length - 1] !== c) route.push(c); });
      }
      trips.push({ tripId: ev.tripId, events: tripEvts, route, start: tripEvts[0].start, end: tripEvts[tripEvts.length - 1].end, type: tripEvts[0].type });
    }
  }

  // Duration helper
  const durStr = (start, end) => {
    const diff = end - start;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return h > 0 ? `${h}h${m > 0 ? m + "m" : ""}` : `${m}m`;
  };

  // JST helper
  const fmtJST = (d) => {
    if (!d) return "--:--";
    const jst = new Date(d.getTime() + 9 * 3600000);
    return jst.getUTCHours().toString().padStart(2, "0") + ":" + jst.getUTCMinutes().toString().padStart(2, "0");
  };

  return (
    <div style={{ padding: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: "#6ee7b7", letterSpacing: "2px", fontFamily: "'JetBrains Mono', monospace" }}>
          ▸ DUTY SCHEDULE — {events.length} EVENTS LOADED
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={() => fileRef.current?.click()}
            style={{ background: "rgba(110,231,183,0.15)", border: "1px solid rgba(110,231,183,0.3)", color: "#6ee7b7", padding: "4px 10px", borderRadius: "3px", fontSize: "10px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            ↑ RELOAD
          </button>
          <button onClick={clearData}
            style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)", color: "#ef4444", padding: "4px 10px", borderRadius: "3px", fontSize: "10px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            ✕ CLEAR
          </button>
          <input ref={fileRef} type="file" accept=".ics" onChange={handleFile} style={{ display: "none" }} />
        </div>
      </div>

      {/* Status Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px", marginBottom: "20px" }}>
        {/* Current Status */}
        <div style={{ background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px", padding: "14px" }}>
          <div style={{ fontSize: "9px", color: "#64748b", letterSpacing: "1px", marginBottom: "8px" }}>CURRENT STATUS</div>
          {currentEvent ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: DUTY_COLORS[currentEvent.type] || "#94a3b8", boxShadow: `0 0 8px ${DUTY_COLORS[currentEvent.type]}`, animation: "statusBlink 2s ease infinite" }} />
                <span style={{ background: DUTY_COLORS[currentEvent.type] || "#94a3b8", color: currentEvent.type === "OFF" ? "#e2e8f0" : "#030810", padding: "2px 8px", borderRadius: "3px", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
                  {currentEvent.type}
                </span>
              </div>
              {currentEvent.route.length > 0 && (
                <div style={{ color: "#e2e8f0", fontSize: "16px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
                  {currentEvent.route.join(" → ")}
                </div>
              )}
              {currentEvent.type === "NON-FLY" && <div style={{ color: "#fbbf24", fontSize: "14px", fontWeight: 600 }}>STAY: {currentEvent.summary.match(/\(([^)]+)\)/)?.[1] || ""}</div>}
              {currentEvent.type === "OFF" && <div style={{ color: "#94a3b8", fontSize: "14px" }}>REST DAY</div>}
              {currentEvent.type === "STANDBY" && <div style={{ color: "#c4b5fd", fontSize: "14px" }}>STANDBY</div>}
              <div style={{ color: "#64748b", fontSize: "10px", marginTop: "6px", fontFamily: "'JetBrains Mono', monospace" }}>
                {fmtZ(currentEvent.start)} – {fmtZ(currentEvent.end)} ({fmtJST(currentEvent.start)} – {fmtJST(currentEvent.end)} JST)
              </div>
            </>
          ) : (
            <div style={{ color: "#475569", fontSize: "12px", marginTop: "4px" }}>NO ACTIVE DUTY</div>
          )}
        </div>

        {/* Next Flight */}
        <div style={{ background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px", padding: "14px" }}>
          <div style={{ fontSize: "9px", color: "#64748b", letterSpacing: "1px", marginBottom: "8px" }}>NEXT FLIGHT</div>
          {nextFly ? (
            <>
              <div style={{ color: "#e2e8f0", fontSize: "16px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", marginBottom: "4px" }}>
                {nextFly.route.join(" → ")}
              </div>
              <div style={{ color: "#6ee7b7", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>
                {fmtDate(nextFly.start)} {fmtZ(nextFly.start)}
              </div>
              <div style={{ color: "#64748b", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace" }}>
                ({fmtJST(nextFly.start)} JST)
              </div>
              {countdown(nextFly) && (
                <div style={{ color: "#fbbf24", fontSize: "20px", fontWeight: 700, marginTop: "6px", fontFamily: "'JetBrains Mono', monospace" }}>
                  T-{countdown(nextFly)}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: "#475569", fontSize: "12px", marginTop: "4px" }}>NO UPCOMING FLIGHTS</div>
          )}
        </div>

        {/* Monthly Summary */}
        <div style={{ background: "rgba(5,10,20,0.8)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px", padding: "14px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
            <div style={{ fontSize: "9px", color: "#64748b", letterSpacing: "1px" }}>MONTHLY SUMMARY</div>
            <div style={{ display: "flex", alignItems: "center", gap: "2px" }}>
              <button onClick={() => setSummaryMonth(p => { const d = new Date(p); d.setMonth(d.getMonth() - 1); return d; })} style={{
                background: "none", border: "none", color: "#64748b", fontSize: "10px", cursor: "pointer", padding: "0 4px", fontFamily: "'JetBrains Mono', monospace",
              }}>◀</button>
              <span style={{ color: "#94a3b8", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", minWidth: "60px", textAlign: "center" }}>
                {summaryMonth.getFullYear()}/{String(summaryMonth.getMonth() + 1).padStart(2, "0")}
              </span>
              <button onClick={() => setSummaryMonth(p => { const d = new Date(p); d.setMonth(d.getMonth() + 1); return d; })} style={{
                background: "none", border: "none", color: "#64748b", fontSize: "10px", cursor: "pointer", padding: "0 4px", fontFamily: "'JetBrains Mono', monospace",
              }}>▶</button>
            </div>
          </div>
          {(() => {
            const y = summaryMonth.getFullYear(), m = summaryMonth.getMonth();
            const monthStart = new Date(Date.UTC(y, m, 1));
            const monthEnd = new Date(Date.UTC(y, m + 1, 1));
            const me = events.filter(e => e.start < monthEnd && e.end > monthStart);
            const flyCount = me.filter(e => e.type === "FLY").length;
            const offCount = me.filter(e => e.type === "OFF").length;
            const nonFlyCount = me.filter(e => e.type === "NON-FLY").length;
            const stbyCount = me.filter(e => e.type === "STANDBY").length;
            const gndCount = me.filter(e => e.type === "GROUND").length;
            const totalFlyMs = me.filter(e => e.type === "FLY").reduce((s, e) => s + (e.end - e.start), 0);
            const flyH = Math.floor(totalFlyMs / 3600000);
            const flyM = Math.floor((totalFlyMs % 3600000) / 60000);
            const total = me.length;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {total === 0 ? (
                  <div style={{ color: "#334155", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", textAlign: "center", padding: "8px 0" }}>NO DATA</div>
                ) : (<>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>FLY LEGS</span>
                  <span style={{ color: "#e2e8f0", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{flyCount}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#6ee7b7", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>DUTY TIME</span>
                  <span style={{ color: "#e2e8f0", fontSize: "11px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{flyH}h{flyM}m</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#475569", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>OFF DAYS</span>
                  <span style={{ color: "#94a3b8", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>{offCount}</span>
                </div>
                {stbyCount > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#c4b5fd", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>STANDBY</span>
                  <span style={{ color: "#94a3b8", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>{stbyCount}</span>
                </div>}
                {gndCount > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#67e8f9", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>GROUND</span>
                  <span style={{ color: "#94a3b8", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>{gndCount}</span>
                </div>}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#fbbf24", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace" }}>STAYS</span>
                  <span style={{ color: "#94a3b8", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>{nonFlyCount}</span>
                </div>
                </>)}
              </div>
            );
          })()}
        </div>
      </div>

      {/* 7-Day Timeline */}
      <div style={{ fontSize: "9px", color: "#64748b", letterSpacing: "1px", marginBottom: "10px" }}>7-DAY SCHEDULE</div>
      {days.map((day, di) => {
        const isToday = di === 0;
        // Get trip summaries that start on this day
        const dayTrips = trips.filter(t => {
          const tStart = new Date(Date.UTC(t.start.getUTCFullYear(), t.start.getUTCMonth(), t.start.getUTCDate()));
          return tStart.getTime() === day.date.getTime();
        });
        return (
          <div key={di} style={{ marginBottom: "4px" }}>
            {/* Day header */}
            <div style={{
              display: "flex", alignItems: "center", gap: "10px",
              padding: "7px 12px",
              background: isToday ? "rgba(110,231,183,0.1)" : "rgba(5,10,20,0.5)",
              borderLeft: isToday ? "3px solid #6ee7b7" : "3px solid #1e293b",
              borderRadius: "2px",
            }}>
              <span style={{
                color: isToday ? "#6ee7b7" : "#94a3b8", fontSize: "11px", fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace", minWidth: "110px",
              }}>
                {isToday ? "▶ " : "  "}{fmtDate(day.date)}
              </span>
              {/* Day summary badges */}
              {day.events.length > 0 && (
                <div style={{ display: "flex", gap: "4px", flex: 1 }}>
                  {(() => {
                    const types = [...new Set(day.events.map(e => e.type))];
                    return types.map(t => (
                      <span key={t} style={{
                        background: DUTY_COLORS[t] || "#94a3b8",
                        color: t === "OFF" ? "#e2e8f0" : "#030810",
                        padding: "1px 6px", borderRadius: "2px", fontSize: "8px", fontWeight: 700,
                        fontFamily: "'JetBrains Mono', monospace", opacity: 0.8,
                      }}>{t}</span>
                    ));
                  })()}
                </div>
              )}
            </div>
            {/* Events */}
            {day.events.length === 0 ? (
              <div style={{ padding: "4px 12px 4px 24px", color: "#1e293b", fontSize: "10px" }}>—</div>
            ) : (
              day.events.map((ev, ei) => {
                const col = DUTY_COLORS[ev.type] || "#94a3b8";
                const tripEvts = events.filter(e => e.tripId === ev.tripId);
                const isMultiLeg = tripEvts.length > 1;
                const legIdx = tripEvts.findIndex(e => e.uid === ev.uid);
                const isCurrent = currentEvent && currentEvent.uid === ev.uid;
                return (
                  <div key={ei} style={{
                    display: "flex", alignItems: "center", gap: "8px",
                    padding: "6px 12px 6px 24px",
                    borderLeft: isMultiLeg ? `2px solid ${col}` : "2px solid transparent",
                    marginLeft: "14px",
                    background: isCurrent ? "rgba(110,231,183,0.06)" : "transparent",
                    borderRadius: "2px",
                  }}>
                    {/* Current indicator */}
                    {isCurrent ? (
                      <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#6ee7b7", boxShadow: "0 0 8px #6ee7b7", animation: "statusBlink 2s ease infinite", flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: "6px", flexShrink: 0 }} />
                    )}
                    {/* Time UTC */}
                    <span style={{ color: "#64748b", fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", minWidth: "95px" }}>
                      {fmtZ(ev.start)}–{fmtZ(ev.end)}
                    </span>
                    {/* Time JST */}
                    <span style={{ color: "#334155", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", minWidth: "75px" }}>
                      {fmtJST(ev.start)}-{fmtJST(ev.end)}L
                    </span>
                    {/* Duration */}
                    <span style={{ color: "#475569", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", minWidth: "40px" }}>
                      {durStr(ev.start, ev.end)}
                    </span>
                    {/* Type badge */}
                    <span style={{
                      background: col, color: ev.type === "OFF" ? "#e2e8f0" : "#030810",
                      padding: "2px 8px", borderRadius: "2px", fontSize: "9px", fontWeight: 700,
                      fontFamily: "'JetBrains Mono', monospace", minWidth: "58px", textAlign: "center",
                    }}>{ev.type}</span>
                    {/* Route / Location */}
                    <span style={{ color: "#e2e8f0", fontSize: "12px", fontWeight: ev.type === "FLY" ? 700 : 400, fontFamily: "'JetBrains Mono', monospace" }}>
                      {ev.type === "FLY" && ev.route.length > 0
                        ? ev.route.join(" → ")
                        : ev.type === "NON-FLY"
                        ? `STAY: ${ev.summary.match(/\(([^)]+)\)/)?.[1] || ""}`
                        : ev.type === "OFF"
                        ? "REST"
                        : ev.summary.match(/\(([^)]+)\)/)?.[1] || ""
                      }
                    </span>
                    {/* Leg indicator for multi-leg trips */}
                    {isMultiLeg && ev.type === "FLY" && (
                      <span style={{ color: "#334155", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", marginLeft: "auto" }}>
                        LEG {tripEvts.filter(e => e.type === "FLY").indexOf(ev) + 1}/{tripEvts.filter(e => e.type === "FLY").length}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}


/* ========== LIVE CAMERA PANEL（空港ライブカメラ） ========== */
function LiveCameraPanel() {
  const [tick, setTick] = useState(0);

  // 60秒ごとに画像リフレッシュ
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(iv);
  }, []);

  const cameras = [
    { id: "chitose", name: "新千歳空港", code: "RJCC", camId: "410000164", ytSearch: "新千歳空港+ライブカメラ", desc: "New Chitose / CTS" },
    { id: "sendai", name: "仙台空港", code: "RJSS", camId: "410000175", ytSearch: "仙台空港+ライブカメラ", desc: "Sendai / SDJ" },
    { id: "niigata", name: "新潟空港", code: "RJSN", camId: "410000156", ytSearch: "新潟空港+ライブカメラ", desc: "Niigata / KIJ" },
    { id: "narita", name: "成田空港", code: "RJAA", camId: "410000160", ytSearch: "成田空港+ライブカメラ", desc: "Narita Intl / NRT" },
    { id: "haneda", name: "羽田空港", code: "RJTT", camId: "410000155", ytSearch: "羽田空港+ライブカメラ", desc: "Tokyo Intl / HND" },
    { id: "itami", name: "伊丹空港", code: "RJOO", camId: "410000168", ytSearch: "伊丹空港+ライブカメラ", desc: "Osaka Itami / ITM" },
    { id: "kix", name: "関西空港", code: "RJBB", camId: "410000153", ytSearch: "関西空港+ライブカメラ", desc: "Kansai Intl / KIX" },
    { id: "fukuoka", name: "福岡空港", code: "RJFF", camId: "410000158", ytSearch: "福岡空港+ライブカメラ", desc: "Fukuoka / FUK" },
    { id: "nagasaki", name: "長崎空港", code: "RJFU", camId: "410000154", ytSearch: "長崎空港+ライブカメラ", desc: "Nagasaki / NGS" },
    { id: "naha", name: "那覇空港", code: "ROAH", camId: "410001066", ytSearch: "那覇空港+ライブカメラ", desc: "Naha / OKA" },
  ];

  const imgSrc = (cam) => {
    const cid = cam.camId || cam.jalSpot;
    if (!cid) return null;
    return `https://gvs.weathernews.jp/livecam/${cid}/latest.jpg?_=${tick}`;
  };

  const CameraCell = ({ cam }) => {
    const [err, setErr] = useState(false);
    const sun = (() => {
      const coords = {
        RJTT: [35.5494, 139.7798], RJAA: [35.7647, 140.3864], RJCC: [42.7752, 141.6920],
        RJFF: [33.5853, 130.4508], RJBB: [34.4347, 135.2440], ROAH: [26.1958, 127.6461],
        RJOO: [34.7855, 135.4385], RJSS: [38.1397, 140.9170], RJSN: [37.9566, 139.1064],
        RJFU: [32.9169, 129.9136],
      };
      const c = coords[cam.code];
      return c ? sunriseSunset(new Date(), c[0], c[1]) : null;
    })();

    return (
      <div style={{
        position: "relative",
        background: "rgba(2, 6, 12, 0.9)",
        border: "1px solid rgba(110,231,183,0.12)",
        borderRadius: "4px",
        overflow: "hidden",
      }}>
        {/* ヘッダー */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "6px 10px",
          background: "rgba(0,0,0,0.6)",
          borderBottom: "1px solid rgba(110,231,183,0.06)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <div>
              <span style={{ color: "#e2e8f0", fontSize: "10px", fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>
                {cam.name}
              </span>
              <span style={{ color: "#6ee7b7", fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", marginLeft: "6px" }}>
                {cam.code}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#ef4444", boxShadow: "0 0 6px #ef4444", animation: "livePulse 2s ease infinite" }} />
            <span style={{ fontSize: "8px", color: "#ef4444", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>LIVE</span>
          </div>
        </div>

        {/* 映像エリア */}
        <div style={{ position: "relative", background: "#000", height: "160px", overflow: "hidden" }}>
          {imgSrc(cam) && !err ? (
            <img
              src={imgSrc(cam)}
              alt={`${cam.name} Live`}
              onError={() => setErr(true)}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px" }}>
              <span style={{ fontSize: "24px", opacity: 0.3 }}>📷</span>
              <span style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>NO FEED</span>
            </div>
          )}
          {/* コーナーブラケット */}
          {[[0, 0], [0, 1], [1, 0], [1, 1]].map(([t, l], i) => (
            <div key={i} style={{
              position: "absolute",
              top: t ? "auto" : "4px", bottom: t ? "4px" : "auto",
              left: l ? "auto" : "4px", right: l ? "4px" : "auto",
              width: "10px", height: "10px",
              borderTop: t ? "none" : "1px solid rgba(110,231,183,0.35)",
              borderBottom: t ? "1px solid rgba(110,231,183,0.35)" : "none",
              borderLeft: l ? "none" : "1px solid rgba(110,231,183,0.35)",
              borderRight: l ? "1px solid rgba(110,231,183,0.35)" : "none",
              pointerEvents: "none",
            }} />
          ))}
          {/* タイムスタンプ */}
          <div style={{ position: "absolute", bottom: "4px", left: "6px", fontSize: "8px", color: "rgba(255,255,255,0.6)", fontFamily: "'JetBrains Mono', monospace", textShadow: "0 1px 3px #000" }}>
            {new Date().toISOString().slice(11, 16)}z — JAL/WNI
          </div>
          {/* スキャンライン */}
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.06) 3px, rgba(0,0,0,0.06) 4px)" }} />
        </div>

        {/* フッター：リンク＋日出没 */}
        <div style={{ padding: "5px 8px", background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: "6px" }}>
            <a href={`https://www.youtube.com/results?search_query=${cam.ytSearch}`} target="_blank" rel="noopener noreferrer"
              style={{ padding: "2px 8px", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "2px", color: "#ef4444", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none" }}>
              ▶ YT LIVE
            </a>
            <a href={`https://www.flightradar24.com/${cam.code}/airport`} target="_blank" rel="noopener noreferrer"
              style={{ padding: "2px 8px", background: "rgba(110,231,183,0.08)", border: "1px solid rgba(110,231,183,0.2)", borderRadius: "2px", color: "#6ee7b7", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", textDecoration: "none" }}>
              ↗ FR24
            </a>
          </div>
          {sun && (
            <div style={{ display: "flex", gap: "8px", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ color: "#fbbf24" }}>↑{sun.rise}z</span>
              <span style={{ color: "#64748b" }}>↓{sun.set}z</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <style>{`@keyframes livePulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }`}</style>

      {/* ヘッダー */}
      <div style={{ marginBottom: "12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "10px", color: "#6ee7b7", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "3px", fontWeight: 700, textShadow: "0 0 8px rgba(110,231,183,0.5)" }}>
            ◈ AIRPORT SURVEILLANCE MONITOR
          </div>
          <div style={{ fontSize: "9px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", marginTop: "3px" }}>
            JAL/WeatherNews LIVE FEED — 60s AUTO REFRESH
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <div style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#ef4444", boxShadow: "0 0 8px #ef4444", animation: "livePulse 2s ease infinite" }} />
          <span style={{ fontSize: "9px", color: "#ef4444", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px" }}>REC</span>
        </div>
      </div>

      {/* カメラグリッド 5×2 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px" }}>
        {cameras.map(cam => (
          <CameraCell key={cam.id} cam={cam} />
        ))}
      </div>

      {/* フッターリンク */}
      <div style={{ marginTop: "12px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <ExtLink href="https://weather.jal.co.jp/livecam/index.html" accent>JAL LiveCam</ExtLink>
        <ExtLink href="https://www.flightradar24.com">FlightRadar24</ExtLink>
        <ExtLink href="https://flightaware.com/live/">FlightAware</ExtLink>
        <ExtLink href="https://aisjapan.mlit.go.jp/">AIS Japan</ExtLink>
      </div>
    </div>
  );
}


/* ========== SYSTEM STATUS MONITOR — リアルタイムヘルスチェック ========== */
/** AbortSignal.timeout互換ヘルパー（Safari等の旧ブラウザ対応） */
function fetchTimeout(ms) {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

function useSystemStatus() {
  const [status, setStatus] = useState({
    jma: { state: "CHECKING", color: "#fbbf24", lastCheck: null },
    metar: { state: "CHECKING", color: "#fbbf24", lastCheck: null },
    himawari: { state: "CHECKING", color: "#fbbf24", lastCheck: null },
  });

  const check = useCallback(async () => {
    // JMA API チェック
    try {
      const r = await fetch(
        "https://www.jma.go.jp/bosai/forecast/data/overview_forecast/130000.json",
        { signal: fetchTimeout(8000) }
      );
      if (r.ok) {
        setStatus(p => ({ ...p, jma: { state: "ONLINE", color: "#6ee7b7", lastCheck: new Date() } }));
      } else {
        setStatus(p => ({ ...p, jma: { state: "DEGRADED", color: "#fbbf24", lastCheck: new Date() } }));
      }
    } catch {
      setStatus(p => ({ ...p, jma: { state: "OFFLINE", color: "#f87171", lastCheck: new Date() } }));
    }

    // METAR (VATSIM → AWC fallback) チェック
    try {
      const text = await fetchMetarRaw("RJTT", fetchTimeout(8000));
      if (text && text.length > 10) {
        setStatus(p => ({ ...p, metar: { state: "ONLINE", color: "#6ee7b7", lastCheck: new Date() } }));
      } else {
        setStatus(p => ({ ...p, metar: { state: "NO DATA", color: "#fbbf24", lastCheck: new Date() } }));
      }
    } catch {
      setStatus(p => ({ ...p, metar: { state: "OFFLINE", color: "#f87171", lastCheck: new Date() } }));
    }

    // Himawari 画像チェック
    try {
      const now = new Date(Date.now() - 5 * 60000);
      const h = now.getUTCHours().toString().padStart(2, "0");
      const m = (Math.floor(now.getUTCMinutes() / 10) * 10).toString().padStart(2, "0");
      const r = await fetch(
        `https://www.data.jma.go.jp/mscweb/data/himawari/img/jpn/jpn_b13_${h}${m}.jpg`,
        { method: "HEAD", signal: AbortSignal.timeout(8000) }
      );
      setStatus(p => ({ ...p, himawari: { state: r.ok ? "ONLINE" : "DEGRADED", color: r.ok ? "#6ee7b7" : "#fbbf24", lastCheck: new Date() } }));
    } catch {
      setStatus(p => ({ ...p, himawari: { state: "OFFLINE", color: "#f87171", lastCheck: new Date() } }));
    }
  }, []);

  useEffect(() => {
    check();
    const iv = setInterval(check, 120000); // 2分毎にヘルスチェック
    return () => clearInterval(iv);
  }, [check]);

  // 総合ステータス
  const states = Object.values(status);
  const allOnline = states.every(s => s.state === "ONLINE");
  const anyOffline = states.some(s => s.state === "OFFLINE");
  const overall = allOnline ? { state: "ALL SYSTEMS NOMINAL", color: "#6ee7b7" }
    : anyOffline ? { state: "SYSTEM ALERT", color: "#f87171" }
    : { state: "PARTIAL", color: "#fbbf24" };

  return { status, overall, recheck: check };
}

function SystemStatusIndicator({ sysStatus }) {
  const { status, overall, recheck } = sysStatus;
  const items = [
    { label: "JMA API", ...status.jma },
    { label: "METAR/AWC", ...status.metar },
    { label: "HIMAWARI", ...status.himawari },
  ];

  return (
    <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
      {items.map((s) => (
        <div key={s.label} style={{ textAlign: "center", position: "relative" }}>
          <div style={{ fontSize: "8px", color: "#334155", letterSpacing: "1.5px" }}>{s.label}</div>
          <div style={{ display: "flex", alignItems: "center", gap: "4px", justifyContent: "center" }}>
            <div style={{
              width: "5px", height: "5px", borderRadius: "50%",
              background: s.color,
              boxShadow: `0 0 6px ${s.color}, 0 0 12px ${s.color}60`,
              animation: s.state === "OFFLINE" ? "statusBlink 1s ease infinite" : "none",
            }} />
            <span style={{
              fontSize: "10px", fontWeight: 700, color: s.color,
              letterSpacing: "1px", textShadow: `0 0 8px ${s.color}`,
              fontFamily: "'JetBrains Mono', monospace",
            }}>{s.state}</span>
          </div>
        </div>
      ))}
      {/* 総合ステータス区切り線 + overall */}
      <div style={{ width: "1px", height: "24px", background: "rgba(110,231,183,0.15)", margin: "0 2px" }} />
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "8px", color: "#334155", letterSpacing: "1.5px" }}>SYSTEM</div>
        <div style={{
          fontSize: "10px", fontWeight: 700, color: overall.color,
          letterSpacing: "1px", textShadow: `0 0 8px ${overall.color}`,
          fontFamily: "'JetBrains Mono', monospace",
        }}>{overall.state}</div>
      </div>
      <style>{`@keyframes statusBlink { 0%,100%{opacity:1;} 50%{opacity:0.3;} }`}</style>
    </div>
  );
}

/* ========== WEATHER ALERT BANNER — 気象庁警報・注意報 ========== */
function WeatherAlertBanner() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  // 警報レベル定義
  const LEVEL_MAP = {
    "特別警報": { level: 5, color: "#1e0a2e", borderColor: "#7c3aed", textColor: "#c4b5fd", icon: "🟣", label: "CRITICAL" },
    "警報":     { level: 4, color: "#2a0a0a", borderColor: "#dc2626", textColor: "#fca5a5", icon: "🔴", label: "WARNING" },
    "注意報":   { level: 3, color: "#2a1a00", borderColor: "#d97706", textColor: "#fde68a", icon: "🟡", label: "ADVISORY" },
  };

  // 対象地域
  const WATCH_AREAS = [
    { code: "130000", name: "東京" },
    { code: "270000", name: "大阪" },
    { code: "016000", name: "北海道" },
    { code: "400000", name: "福岡" },
    { code: "471000", name: "沖縄" },
    { code: "230000", name: "愛知" },
  ];

  useEffect(() => {
    const fetchAlerts = async () => {
      setLoading(true);
      const results = [];
      for (const area of WATCH_AREAS) {
        try {
          const r = await fetch(
            `https://www.jma.go.jp/bosai/warning/data/warning/${area.code}.json`,
            { signal: fetchTimeout(8000) }
          );
          if (!r.ok) continue;
          const data = await r.json();
          // areaTypesからwarning情報を抽出
          const areaTypes = data.areaTypes ?? [];
          for (const at of areaTypes) {
            for (const region of (at.areas ?? [])) {
              for (const w of (region.warnings ?? [])) {
                if (w.status === "発表" || w.status === "継続") {
                  const kindName = w.code ? getWarningName(w.code) : "不明";
                  const levelInfo = getWarningLevel(kindName);
                  results.push({
                    area: area.name,
                    region: region.name,
                    kind: kindName,
                    status: w.status,
                    ...levelInfo,
                  });
                }
              }
            }
          }
        } catch {
          // skip failed area
        }
      }
      // レベル降順でソート
      results.sort((a, b) => b.level - a.level);
      setAlerts(results);
      setLoading(false);
    };

    fetchAlerts();
    const iv = setInterval(fetchAlerts, 300000); // 5分毎
    return () => clearInterval(iv);
  }, []);

  // 警報コード→名前
  function getWarningName(code) {
    const map = {
      "33": "大雨特別警報", "03": "大雨警報", "10": "大雨注意報",
      "35": "暴風特別警報", "05": "暴風警報", "15": "強風注意報",
      "32": "暴風雪特別警報", "04": "暴風雪警報", "13": "風雪注意報",
      "36": "大雪特別警報", "06": "大雪警報", "12": "大雪注意報",
      "37": "波浪特別警報", "07": "波浪警報", "16": "波浪注意報",
      "38": "高潮特別警報", "08": "高潮警報", "19": "高潮注意報",
      "02": "洪水警報", "18": "洪水注意報",
      "14": "雷注意報", "17": "融雪注意報",
      "20": "濃霧注意報", "21": "乾燥注意報",
      "22": "なだれ注意報", "23": "低温注意報",
      "24": "霜注意報", "25": "着氷注意報",
      "26": "着雪注意報",
    };
    return map[String(code)] ?? `警報(${code})`;
  }

  // 名前→レベル情報
  function getWarningLevel(name) {
    if (name.includes("特別警報")) return LEVEL_MAP["特別警報"];
    if (name.includes("警報")) return LEVEL_MAP["警報"];
    return LEVEL_MAP["注意報"];
  }

  // 最高脅威レベル
  const maxLevel = alerts.length > 0 ? Math.max(...alerts.map(a => a.level)) : 0;
  const threatConfig = maxLevel >= 5
    ? { bg: "rgba(124,58,237,0.08)", border: "#7c3aed", text: "THREAT LEVEL: CRITICAL", glow: "rgba(124,58,237,0.4)" }
    : maxLevel >= 4
    ? { bg: "rgba(220,38,38,0.06)", border: "#dc2626", text: "THREAT LEVEL: ELEVATED", glow: "rgba(220,38,38,0.4)" }
    : maxLevel >= 3
    ? { bg: "rgba(217,119,6,0.05)", border: "#d97706", text: "THREAT LEVEL: GUARDED", glow: "rgba(217,119,6,0.3)" }
    : { bg: "rgba(110,231,183,0.03)", border: "#6ee7b7", text: "THREAT LEVEL: NORMAL", glow: "rgba(110,231,183,0.2)" };

  return (
    <div style={{
      background: threatConfig.bg,
      borderBottom: `2px solid ${threatConfig.border}40`,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* 脅威レベルバー */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 24px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {/* DEFCON風レベルインジケータ */}
          <div style={{ display: "flex", gap: "3px", alignItems: "center" }}>
            {[5, 4, 3, 2, 1].map(lv => (
              <div key={lv} style={{
                width: "18px", height: "10px", borderRadius: "1px",
                background: lv <= maxLevel
                  ? lv >= 5 ? "#7c3aed" : lv >= 4 ? "#dc2626" : lv >= 3 ? "#d97706" : "#6ee7b7"
                  : "rgba(110,231,183,0.06)",
                border: `1px solid ${lv <= maxLevel
                  ? lv >= 5 ? "#7c3aed" : lv >= 4 ? "#dc2626" : lv >= 3 ? "#d97706" : "#6ee7b7"
                  : "rgba(110,231,183,0.08)"}`,
                boxShadow: lv <= maxLevel ? `0 0 6px ${lv >= 5 ? "#7c3aed" : lv >= 4 ? "#dc2626" : lv >= 3 ? "#d97706" : "#6ee7b7"}60` : "none",
                transition: "all 0.3s ease",
              }} />
            ))}
          </div>
          <span style={{
            fontSize: "10px", fontWeight: 700,
            color: threatConfig.border,
            fontFamily: "'JetBrains Mono', monospace",
            letterSpacing: "2px",
            textShadow: `0 0 10px ${threatConfig.glow}`,
          }}>{threatConfig.text}</span>
          <span style={{
            fontSize: "9px", color: "#475569",
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            {loading ? "SCANNING..." : `${alerts.length} ACTIVE`}
          </span>
        </div>
        <div style={{
          fontSize: "8px", color: "#334155",
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "1px",
        }}>
          JMA WARNING MONITOR
        </div>
      </div>

      {/* アラート一覧（ティッカー） */}
      {alerts.length > 0 && (
        <div style={{
          overflow: "hidden", height: "22px",
          borderTop: `1px solid ${threatConfig.border}20`,
          background: "rgba(0,0,0,0.3)",
        }}>
          <div style={{
            display: "inline-block",
            whiteSpace: "nowrap",
            animation: `alertTicker ${Math.max(30, alerts.length * 8)}s linear infinite`,
            paddingLeft: "100%",
            lineHeight: "22px",
          }}>
            {alerts.map((a, i) => (
              <span key={i} style={{
                fontSize: "10px",
                fontFamily: "'JetBrains Mono', monospace",
                color: a.textColor,
                marginRight: "32px",
                letterSpacing: "0.5px",
              }}>
                {a.icon} {a.area}/{a.region} — {a.kind} [{a.label}]
              </span>
            ))}
          </div>
          <style>{`@keyframes alertTicker { from { transform: translateX(0); } to { transform: translateX(-100%); } }`}</style>
        </div>
      )}

      {/* NORMAL時のメッセージ */}
      {!loading && alerts.length === 0 && (
        <div style={{
          padding: "0 24px 6px",
          fontSize: "9px", color: "#334155",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          NO ACTIVE WARNINGS — ALL WATCH AREAS CLEAR
        </div>
      )}
    </div>
  );
}

/* ========== EVENT LOG — イベントコンソール ========== */
function EventLog() {
  const [logs, setLogs] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const logRef = useRef(null);

  // ログ追加ヘルパー
  const addLog = useCallback((type, message) => {
    const now = new Date();
    const ts = now.toISOString().slice(11, 19);
    setLogs(prev => [{ ts, type, message, id: Date.now() }, ...prev].slice(0, 100));
  }, []);

  // 起動時ログ
  useEffect(() => {
    addLog("SYS", "WEATHER INTELLIGENCE DASHBOARD INITIALIZED");
    addLog("SYS", "DATA FEED CONNECTIONS ESTABLISHED");

    // JMA概況取得を監視
    const checkJma = async () => {
      try {
        const r = await fetch("https://www.jma.go.jp/bosai/forecast/data/overview_forecast/130000.json");
        if (r.ok) {
          const d = await r.json();
          addLog("JMA", `東京 天気概況更新 — ${d.reportDatetime?.slice(0, 16) ?? "N/A"}`);
        }
      } catch { addLog("ERR", "JMA API CONNECTION FAILED"); }
    };

    // METAR取得を監視
    const checkMetar = async () => {
      try {
        const text = await fetchMetarRaw("RJTT");
        const line = text.split("\n")[0] ?? "";
        if (line.length > 10) {
          const obsTime = line.match(/\d{6}Z/)?.[0] ?? "";
          addLog("METAR", `RJTT ${obsTime} DATA RECEIVED`);
        }
      } catch { addLog("ERR", "AWC METAR FETCH FAILED"); }
    };

    // 警報チェック
    const checkWarnings = async () => {
      try {
        const r = await fetch("https://www.jma.go.jp/bosai/warning/data/warning/130000.json");
        if (r.ok) {
          const d = await r.json();
          let count = 0;
          for (const at of (d.areaTypes ?? [])) {
            for (const region of (at.areas ?? [])) {
              for (const w of (region.warnings ?? [])) {
                if (w.status === "発表" || w.status === "継続") count++;
              }
            }
          }
          if (count > 0) addLog("WARN", `東京エリア ${count}件の警報・注意報を検出`);
          else addLog("INFO", "東京エリア 警報・注意報なし — ALL CLEAR");
        }
      } catch { /* silent */ }
    };

    setTimeout(() => checkJma(), 2000);
    setTimeout(() => checkMetar(), 4000);
    setTimeout(() => checkWarnings(), 6000);

    // 定期ログ
    const iv = setInterval(() => {
      checkMetar();
      addLog("SYS", "PERIODIC HEALTH CHECK COMPLETED");
    }, 180000); // 3分毎

    return () => clearInterval(iv);
  }, [addLog]);

  const typeConfig = {
    SYS:   { color: "#6ee7b7", icon: "◈" },
    METAR: { color: "#60a5fa", icon: "📡" },
    JMA:   { color: "#c084fc", icon: "🌐" },
    WARN:  { color: "#fbbf24", icon: "⚠" },
    ERR:   { color: "#f87171", icon: "✕" },
    INFO:  { color: "#94a3b8", icon: "ℹ" },
  };

  const visibleLogs = expanded ? logs.slice(0, 30) : logs.slice(0, 5);

  return (
    <div style={{
      background: "rgba(2, 4, 10, 0.95)",
      borderTop: "1px solid rgba(110,231,183,0.12)",
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {/* ヘッダー */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "4px 24px",
        borderBottom: "1px solid rgba(110,231,183,0.06)",
        background: "rgba(0,0,0,0.4)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "#334155", fontSize: "8px", letterSpacing: "2px" }}>EVENT LOG</span>
          <span style={{ color: "#1e293b", fontSize: "8px" }}>|</span>
          <span style={{ color: "#334155", fontSize: "8px" }}>{logs.length} ENTRIES</span>
        </div>
        <button onClick={() => setExpanded(e => !e)} style={{
          background: "none", border: "none", color: "#475569",
          fontSize: "9px", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: "1px",
        }}>{expanded ? "▼ COLLAPSE" : "▲ EXPAND"}</button>
      </div>
      {/* ログ本体 */}
      <div ref={logRef} style={{
        maxHeight: expanded ? "200px" : "90px",
        overflowY: "auto",
        padding: "2px 24px",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(110,231,183,0.15) transparent",
        transition: "max-height 0.3s ease",
      }}>
        {visibleLogs.map(log => {
          const cfg = typeConfig[log.type] ?? typeConfig.INFO;
          return (
            <div key={log.id} style={{
              display: "flex", alignItems: "flex-start", gap: "8px",
              padding: "2px 0",
              borderBottom: "1px solid rgba(110,231,183,0.02)",
            }}>
              <span style={{ color: "#1e293b", fontSize: "9px", flexShrink: 0, minWidth: "60px" }}>{log.ts}z</span>
              <span style={{ fontSize: "9px", flexShrink: 0 }}>{cfg.icon}</span>
              <span style={{
                fontSize: "9px", fontWeight: 700, color: cfg.color,
                letterSpacing: "1px", flexShrink: 0, minWidth: "44px",
              }}>{log.type}</span>
              <span style={{ fontSize: "9px", color: "#64748b" }}>{log.message}</span>
            </div>
          );
        })}
        {logs.length === 0 && (
          <div style={{ color: "#1e293b", fontSize: "9px", padding: "8px 0", textAlign: "center" }}>
            AWAITING EVENTS...
          </div>
        )}
      </div>
    </div>
  );
}

/* ========== BOOT SEQUENCE — 起動シーケンス ========== */
function BootSequence({ onComplete }) {
  const [lines, setLines] = useState([]);
  const [phase, setPhase] = useState(0); // 0=typing, 1=done

  const bootMessages = [
    { text: "WEATHER INTELLIGENCE DASHBOARD v2.4.1", delay: 0, color: "#6ee7b7" },
    { text: "────────────────────────────────────────", delay: 150, color: "#1e293b" },
    { text: "INITIALIZING CORE SYSTEMS...", delay: 300, color: "#94a3b8" },
    { text: "[OK] Display subsystem loaded", delay: 600, color: "#6ee7b7" },
    { text: "[OK] JetBrains Mono font verified", delay: 800, color: "#6ee7b7" },
    { text: "CONNECTING DATA FEEDS...", delay: 1100, color: "#94a3b8" },
    { text: "[OK] JMA Forecast API ── ONLINE", delay: 1400, color: "#6ee7b7" },
    { text: "[OK] AWC METAR/TAF ── CONNECTED", delay: 1700, color: "#6ee7b7" },
    { text: "[OK] HIMAWARI-9 Imagery ── LINKED", delay: 2000, color: "#6ee7b7" },
    { text: "[OK] Windy Embed API ── READY", delay: 2200, color: "#6ee7b7" },
    { text: "LOADING MODULES...", delay: 2500, color: "#94a3b8" },
    { text: "[OK] METAR/TAF Parser ── ACTIVE", delay: 2700, color: "#6ee7b7" },
    { text: "[OK] Satellite Band Selector ── ACTIVE", delay: 2900, color: "#6ee7b7" },
    { text: "[OK] Almanac Engine ── COMPUTED", delay: 3100, color: "#6ee7b7" },
    { text: "[OK] Alert Monitor ── SCANNING", delay: 3300, color: "#6ee7b7" },
    { text: "[OK] Event Logger ── RECORDING", delay: 3500, color: "#6ee7b7" },
    { text: "────────────────────────────────────────", delay: 3700, color: "#1e293b" },
    { text: "ALL SYSTEMS NOMINAL ── DASHBOARD READY", delay: 3900, color: "#6ee7b7", bold: true },
    { text: "KEYBOARD: [1-9] TAB  [M] MULTI  [F] FULLSCREEN  [R] REFRESH", delay: 4100, color: "#334155" },
  ];

  useEffect(() => {
    const timers = bootMessages.map((msg, i) =>
      setTimeout(() => {
        setLines(prev => [...prev, msg]);
      }, msg.delay)
    );
    // 起動完了
    const doneTimer = setTimeout(() => {
      setPhase(1);
    }, 4500);
    const completeTimer = setTimeout(() => {
      onComplete();
    }, 5200);
    return () => { timers.forEach(clearTimeout); clearTimeout(doneTimer); clearTimeout(completeTimer); };
  }, []); // eslint-disable-line

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 99999,
      background: "#030810",
      display: "flex", alignItems: "center", justifyContent: "center",
      opacity: phase === 1 ? 0 : 1,
      transition: "opacity 0.7s ease",
      pointerEvents: phase === 1 ? "none" : "auto",
    }}>
      {/* Scanline */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px)",
      }} />
      {/* Vignette */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        background: "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.6) 100%)",
      }} />

      <div style={{ maxWidth: "640px", width: "100%", padding: "40px" }}>
        {/* タイトルロゴ */}
        <div style={{ textAlign: "center", marginBottom: "30px" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "60px", height: "60px",
            border: "2px solid #6ee7b7",
            borderRadius: "4px",
            fontSize: "32px",
            boxShadow: "0 0 30px rgba(110,231,183,0.4), inset 0 0 20px rgba(110,231,183,0.08)",
            marginBottom: "16px",
          }}>✈</div>
          <div style={{
            fontSize: "22px", fontWeight: 700,
            letterSpacing: "6px", color: "#e2e8f0",
            textShadow: "0 0 30px rgba(226,232,240,0.4)",
            fontFamily: "'JetBrains Mono', monospace",
          }}>PRE-FLIGHT WX BRIEFING</div>
          <div style={{
            fontSize: "9px", color: "#334155",
            letterSpacing: "4px", fontFamily: "'JetBrains Mono', monospace",
            marginTop: "6px",
          }}>◈ WEATHER INTELLIGENCE DASHBOARD</div>
        </div>

        {/* ターミナル出力 */}
        <div style={{
          background: "rgba(0,0,0,0.5)",
          border: "1px solid rgba(110,231,183,0.15)",
          borderRadius: "4px",
          padding: "16px 20px",
          minHeight: "280px",
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {lines.map((line, i) => (
            <div key={i} style={{
              fontSize: "11px",
              color: line.color,
              fontWeight: line.bold ? 700 : 400,
              lineHeight: "1.8",
              textShadow: line.bold ? `0 0 12px ${line.color}` : "none",
              letterSpacing: line.bold ? "2px" : "0.5px",
            }}>
              {line.text}
            </div>
          ))}
          {/* 点滅カーソル */}
          {phase === 0 && (
            <span style={{
              display: "inline-block",
              width: "8px", height: "14px",
              background: "#6ee7b7",
              animation: "statusBlink 0.8s ease infinite",
              verticalAlign: "middle",
              marginTop: "4px",
            }} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ========== MAIN APP ========== */
export default function WeatherBriefing() {
  const [booted, setBooted] = useState(false);
  const [activeTab, setActiveTab] = useState("metar");
  const [displayMode, setDisplayMode] = useState("single"); // "single" | "multi"
  const [multiPanels, setMultiPanels] = useState(["metar", "satellite", "radar", "analysis"]);
  const [now, setNow] = useState(new Date());
  const sysStatus = useSystemStatus();
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(iv);
  }, []);

  // === Offline / Preflight Cache ===
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [cacheState, setCacheState] = useState("idle"); // idle | caching | done | error
  const [cacheInfo, setCacheInfo] = useState(() => {
    try { return JSON.parse(localStorage.getItem("wx-cache-info")); } catch { return null; }
  });

  useEffect(() => {
    const goOffline = () => setIsOffline(true);
    const goOnline = () => setIsOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    // Listen for SW messages
    const swHandler = (e) => {
      if (e.data?.type === "PREFLIGHT_CACHE_DONE") {
        const info = { cached: e.data.cached, failed: e.data.failed, total: e.data.total, ts: e.data.timestamp };
        setCacheInfo(info);
        localStorage.setItem("wx-cache-info", JSON.stringify(info));
        setCacheState("done");
        setTimeout(() => setCacheState("idle"), 5000);
      }
      if (e.data?.type === "CACHE_CLEARED") {
        setCacheInfo(null);
        localStorage.removeItem("wx-cache-info");
        setCacheState("idle");
      }
    };
    navigator.serviceWorker?.addEventListener("message", swHandler);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      navigator.serviceWorker?.removeEventListener("message", swHandler);
    };
  }, []);

  const doPreflightCache = async () => {
    if (!navigator.serviceWorker?.controller) return;
    setCacheState("caching");

    // Collect URLs to cache
    const urls = [];

    // METAR/TAF — current duty airports + defaults
    const todayEvents = getTodayDutyEvents();
    const dutyIcaos = getDutyRouteIcaoCodes(todayEvents);
    const metarAirports = [...new Set(["RJTT", "RJAA", ...dutyIcaos])];
    const metarIds = metarAirports.join(",");
    urls.push(vatsimMetarUrl(metarIds));
    urls.push(...awcProxyUrls(`/api/data/taf?ids=${metarIds}&format=raw`));

    // Atmospheric analysis images — all 4 cross sections + 4 plane levels × latest timestamp
    try {
      const tsRes = await fetch("https://www.data.jma.go.jp/airinfo/data/conf/list_maiji.js");
      const tsText = await tsRes.text();
      const tsMatches = [...tsText.matchAll(/"(\d{14})"/g)].map(m => m[1]);
      const latestTs = tsMatches[0];
      if (latestTs) {
        for (const code of ["50", "52", "54", "56"]) {
          urls.push(`https://www.data.jma.go.jp/airinfo/data/pict/maiji/WANLC1${code}_RJTD_${latestTs}.PNG`);
        }
        for (const code of ["15", "25", "35", "45"]) {
          urls.push(`https://www.data.jma.go.jp/airinfo/data/pict/maiji/WANLF1${code}_RJTD_${latestTs}.PNG`);
        }
      }
    } catch {}

    // JMA weather maps — surface charts
    urls.push("https://www.jma.go.jp/bosai/weather_map/data/png/spas_color.png");
    try {
      const listRes = await fetch("https://www.jma.go.jp/bosai/weather_map/data/list.json");
      const listData = await listRes.json();
      if (listData?.near?.length) {
        const latest = listData.near[listData.near.length - 1];
        for (const el of latest.elements) {
          if (["SPAS", "FSAS24", "FSAS48", "ASAS"].some(t => el.includes(t)) && el.endsWith(".png")) {
            urls.push(`https://www.jma.go.jp/bosai/weather_map/data/png/${el}`);
          }
        }
      }
    } catch {}
    // FBJP severe weather charts
    urls.push("https://www.data.jma.go.jp/airinfo/data/pict/fbjp/fbjp.png");
    // FBJP 12h — cache latest base time
    const cacheUtcH = new Date().getUTCHours();
    const cacheBT = cacheUtcH >= 2 ? Math.floor((cacheUtcH - 2) / 3) * 3 : 21;
    urls.push(`https://www.data.jma.go.jp/airinfo/data/pict/nwp/fbjp112_${String(cacheBT).padStart(2, "0")}.png`);

    navigator.serviceWorker.controller.postMessage({ type: "PREFLIGHT_CACHE", urls });
  };

  const doClearCache = () => {
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_CACHE" });
  };

  const tabs = [
    { key: "metar", label: "METAR / TAF", icon: "📡" },
    { key: "satellite", label: "衛星画像", icon: "🛰️" },
    { key: "radar", label: "レーダー", icon: "🌧️" },
    { key: "analysis", label: "大気解析", icon: "📊" },
    { key: "charts", label: "WX CHARTS", icon: "📈" },
    { key: "opswx", label: "OPS WX", icon: "🎯" },
    { key: "livecam", label: "LIVE CAM", icon: "📹" },
    { key: "duty", label: "DUTY", icon: "📋" },
    { key: "severe", label: "SEVERE WX", icon: "⛈️" },
  ];

  const panelMap = {
    metar: <MetarTafPanel />,
    satellite: <SatellitePanel />,
    radar: <RadarPanel />,
    analysis: <AnalysisPanel />,
    charts: <WxChartsPanel />,
    opswx: <OpsWxPanel />,
    livecam: <LiveCameraPanel />,
    duty: <DutySchedulePanel />,
    severe: <SevereWxPanel />,
  };

  // マルチディスプレイのスロット切り替え
  const cycleMultiPanel = (slotIdx) => {
    setMultiPanels(prev => {
      const next = [...prev];
      const allKeys = tabs.map(t => t.key);
      const currentIdx = allKeys.indexOf(next[slotIdx]);
      next[slotIdx] = allKeys[(currentIdx + 1) % allKeys.length];
      return next;
    });
  };

  // ===== キーボードショートカット =====
  const [showShortcuts, setShowShortcuts] = useState(false);
  useEffect(() => {
    const handler = (e) => {
      // 入力中はスキップ
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

      const key = e.key;

      // 1-9,0: タブ切り替え
      if (key >= "1" && key <= "9") {
        e.preventDefault();
        const idx = parseInt(key, 10) - 1;
        if (tabs[idx]) {
          setActiveTab(tabs[idx].key);
          setDisplayMode("single");
        }
      }
      // M: マルチディスプレイ切り替え
      if (key === "m" || key === "M") {
        e.preventDefault();
        setDisplayMode(d => d === "multi" ? "single" : "multi");
      }
      // R: リフレッシュ（全ページリロード）
      if (key === "r" || key === "R") {
        e.preventDefault();
        window.location.reload();
      }
      // F: フルスクリーン
      if (key === "f" || key === "F") {
        e.preventDefault();
        if (document.fullscreenElement) {
          document.exitFullscreen();
        } else {
          document.documentElement.requestFullscreen().catch(() => {});
        }
      }
      // ?: ショートカットヘルプ
      if (key === "?" || key === "/") {
        e.preventDefault();
        setShowShortcuts(s => !s);
      }
      // Escape: ヘルプ閉じる
      if (key === "Escape") {
        setShowShortcuts(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [tabs]);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#030810",
      color: "#94a3b8",
      fontFamily: "'JetBrains Mono', monospace",
      position: "relative",
    }}>
      {/* 起動シーケンス */}
      {!booted && <BootSequence onComplete={() => setBooted(true)} />}

      {/* キーボードショートカット ヘルプ */}
      {showShortcuts && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 99990,
          background: "rgba(3,8,16,0.92)",
          display: "flex", alignItems: "center", justifyContent: "center",
          backdropFilter: "blur(8px)",
        }} onClick={() => setShowShortcuts(false)}>
          <div style={{
            background: "rgba(5,10,20,0.95)",
            border: "1px solid rgba(110,231,183,0.3)",
            borderRadius: "6px",
            padding: "28px 36px",
            maxWidth: "420px",
            boxShadow: "0 0 40px rgba(110,231,183,0.1)",
          }} onClick={e => e.stopPropagation()}>
            <div style={{
              fontSize: "12px", fontWeight: 700, color: "#6ee7b7",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "3px", marginBottom: "20px",
              textShadow: "0 0 10px rgba(110,231,183,0.5)",
            }}>◈ KEYBOARD SHORTCUTS</div>
            {[
              { keys: "1-9", desc: "タブ切り替え（METAR / 衛星 / レーダー / 解析 / CHARTS / OPS / CAM / DUTY / SEVERE）" },
              { keys: "M", desc: "マルチディスプレイモード ON/OFF" },
              { keys: "F", desc: "フルスクリーン ON/OFF" },
              { keys: "R", desc: "ページリフレッシュ" },
              { keys: "?", desc: "このヘルプを表示/非表示" },
              { keys: "ESC", desc: "ヘルプを閉じる" },
            ].map(s => (
              <div key={s.keys} style={{
                display: "flex", alignItems: "center", gap: "12px",
                padding: "8px 0",
                borderBottom: "1px solid rgba(110,231,183,0.06)",
              }}>
                <span style={{
                  display: "inline-block",
                  padding: "3px 10px",
                  background: "rgba(110,231,183,0.08)",
                  border: "1px solid rgba(110,231,183,0.25)",
                  borderRadius: "3px",
                  color: "#6ee7b7", fontSize: "11px", fontWeight: 700,
                  fontFamily: "'JetBrains Mono', monospace",
                  letterSpacing: "1px",
                  minWidth: "52px", textAlign: "center",
                }}>{s.keys}</span>
                <span style={{
                  color: "#94a3b8", fontSize: "11px",
                  fontFamily: "'JetBrains Mono', monospace",
                }}>{s.desc}</span>
              </div>
            ))}
            <div style={{
              marginTop: "16px", textAlign: "center",
              color: "#334155", fontSize: "9px",
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "1px",
            }}>PRESS ? OR ESC TO CLOSE</div>
          </div>
        </div>
      )}
      {/* Scanline overlay */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999,
        backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.08) 2px, rgba(0,0,0,0.08) 4px)",
      }} />
      {/* Radial vignette */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9998,
        background: "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.5) 100%)",
      }} />

      {/* ===== HEADER ===== */}
      <div style={{
        padding: "12px 24px",
        borderBottom: "1px solid rgba(110, 231, 183, 0.1)",
        background: "rgba(3, 8, 16, 0.95)",
        backdropFilter: "blur(12px)",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexWrap: "wrap", gap: "12px",
        position: "relative",
      }}>
        {/* Left: title block */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{
            width: "40px", height: "40px",
            border: "2px solid #6ee7b7",
            borderRadius: "3px",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "20px",
            boxShadow: "0 0 16px rgba(110,231,183,0.3), inset 0 0 16px rgba(110,231,183,0.05)",
          }}>✈</div>
          <div>
            <div style={{
              fontSize: "18px", fontWeight: 700,
              letterSpacing: "4px", color: "#e2e8f0",
              textShadow: "0 0 20px rgba(226,232,240,0.3)",
              fontFamily: "'JetBrains Mono', monospace",
            }}>PRE-FLIGHT WX BRIEFING</div>
            <div style={{
              fontSize: "9px", color: "#334155",
              letterSpacing: "3px", fontFamily: "'JetBrains Mono', monospace",
              marginTop: "2px",
            }}>◈ WEATHER INTELLIGENCE DASHBOARD · OPERATIONAL USE ONLY</div>
          </div>
        </div>

        {/* Center: system status — リアルタイムヘルスチェック */}
        <SystemStatusIndicator sysStatus={sysStatus} />

        <Clock />

        {/* Preflight Cache Controls */}
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          {/* Online/Offline indicator */}
          {isOffline && (
            <div style={{
              display: "flex", alignItems: "center", gap: "4px",
              padding: "4px 10px",
              background: "rgba(251, 191, 36, 0.12)",
              border: "1px solid rgba(251, 191, 36, 0.4)",
              borderRadius: "3px",
            }}>
              <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#fbbf24", boxShadow: "0 0 6px #fbbf24" }} />
              <span style={{ fontSize: "9px", color: "#fbbf24", fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, letterSpacing: "1px" }}>OFFLINE</span>
              {cacheInfo && (
                <span style={{ fontSize: "8px", color: "#92702a", fontFamily: "'JetBrains Mono', monospace" }}>
                  {new Date(cacheInfo.ts).toISOString().slice(11,16)}z
                </span>
              )}
            </div>
          )}

          {/* Cache button */}
          <button
            onClick={doPreflightCache}
            disabled={cacheState === "caching" || isOffline}
            style={{
              padding: "5px 12px",
              background: cacheState === "done" ? "rgba(110,231,183,0.15)" : cacheState === "caching" ? "rgba(251,191,36,0.1)" : "rgba(110,231,183,0.06)",
              border: `1px solid ${cacheState === "done" ? "rgba(110,231,183,0.5)" : cacheState === "caching" ? "rgba(251,191,36,0.3)" : "rgba(110,231,183,0.2)"}`,
              borderRadius: "3px",
              color: cacheState === "done" ? "#6ee7b7" : cacheState === "caching" ? "#fbbf24" : "#64748b",
              fontSize: "9px", fontWeight: 700,
              fontFamily: "'JetBrains Mono', monospace",
              letterSpacing: "1px",
              cursor: cacheState === "caching" || isOffline ? "default" : "pointer",
              opacity: isOffline ? 0.4 : 1,
            }}
          >
            {cacheState === "caching" ? "📥 CACHING..." : cacheState === "done" ? `✓ CACHED ${cacheInfo?.cached || 0}` : "📥 PREFLIGHT"}
          </button>

          {/* Clear cache button (show only when cache exists) */}
          {cacheInfo && (
            <button
              onClick={doClearCache}
              style={{
                padding: "5px 8px",
                background: "rgba(239,68,68,0.06)",
                border: "1px solid rgba(239,68,68,0.2)",
                borderRadius: "3px",
                color: "#ef4444",
                fontSize: "9px", fontWeight: 700,
                fontFamily: "'JetBrains Mono', monospace",
                cursor: "pointer",
              }}
            >
              🗑️
            </button>
          )}
        </div>

        {/* Bottom border glow */}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: "1px", background: "linear-gradient(90deg, transparent, #6ee7b7, transparent)", opacity: 0.3 }} />
      </div>

      {/* ===== World Clock Bar ===== */}
      <WorldClockBar />
      {/* ===== InfoTicker ===== */}
      <InfoTicker now={now} />
      {/* ===== Weather Alert Banner — 気象警報モニター ===== */}
      <WeatherAlertBanner />
      {/* ===== AlmanacBar ===== */}
      <AlmanacBar now={now} />

      {/* Japan Overview + METAR Quick Status + Upper-Air Data */}
      <div style={{ padding: "16px 24px 0", maxWidth: "1400px", margin: "0 auto" }}>
        <TodayDutyBar />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: "8px", alignItems: "start" }}>
          <JapanOverview />
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <MetarQuickStatus />
            <UpperAirTable />
          </div>
        </div>
      </div>

      {/* ===== JMA気象概况ティッカー (メインモニター直下) ===== */}
      <JmaWeatherTicker />

      {/* ===== TAB BAR ===== */}
      <div style={{
        padding: "0 24px",
        borderBottom: "1px solid rgba(110, 231, 183, 0.15)",
        background: "rgba(3, 8, 16, 0.9)",
        backdropFilter: "blur(8px)",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{
          display: "flex", alignItems: "stretch",
          maxWidth: "1400px", margin: "0 auto",
          overflowX: "auto", WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}>
          {tabs.map((tab, i) => (
            <TabBtn
              key={tab.key}
              active={displayMode === "single" && activeTab === tab.key}
              onClick={() => { setActiveTab(tab.key); setDisplayMode("single"); }}
              icon={tab.icon}
              shortcut={i < 9 ? `${i + 1}` : i === 9 ? "0" : null}
            >
              {tab.label}
            </TabBtn>
          ))}

          {/* セパレーター */}
          <div style={{ width: "1px", margin: "8px 6px", background: "rgba(110,231,183,0.1)", flexShrink: 0 }} />

          {/* MULTI-DISPLAY モード切り替え */}
          <button onClick={() => setDisplayMode(displayMode === "multi" ? "single" : "multi")} style={{
            padding: "10px 16px",
            background: displayMode === "multi" ? "rgba(96,165,250,0.10)" : "transparent",
            border: "none",
            borderBottom: displayMode === "multi" ? "2px solid #60a5fa" : "2px solid transparent",
            color: displayMode === "multi" ? "#60a5fa" : "#64748b",
            fontSize: "12px", fontWeight: displayMode === "multi" ? 700 : 500,
            cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1.5px",
            textShadow: displayMode === "multi" ? "0 0 8px rgba(96,165,250,0.5)" : "none",
            display: "flex", alignItems: "center", gap: "8px",
            transition: "all 0.15s ease",
            flexShrink: 0,
          }}>
            <span style={{ display: "inline-grid", gridTemplateColumns: "1fr 1fr", gap: "2px" }}>
              {[0,1,2,3].map(i => (
                <span key={i} style={{
                  display: "block", width: "6px", height: "5px",
                  background: displayMode === "multi" ? "#60a5fa" : "#64748b",
                  borderRadius: "1px",
                  opacity: displayMode === "multi" ? 1 : 0.5,
                }} />
              ))}
            </span>
            MULTI
            <span style={{ fontSize: "8px", color: displayMode === "multi" ? "#60a5fa80" : "#334155", fontFamily: "'JetBrains Mono', monospace" }}>M</span>
          </button>
        </div>
      </div>

      {/* ===== TAB CONTENT ===== */}
      {displayMode === "single" ? (
        /* シングルモード — 従来の2カラムレイアウト */
        <div style={{ padding: "20px 24px", maxWidth: "1400px", margin: "0 auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "20px", alignItems: "start" }}>
            <div>
              {panelMap[activeTab]}
            </div>
            <div style={{ position: "sticky", top: "16px" }}>
              <AstroDetail now={now} />
            </div>
          </div>
        </div>
      ) : (
        /* マルチディスプレイモード — 2×2 グリッド + サイドバー */
        <div style={{ padding: "12px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: "8px", alignItems: "start" }}>
            {/* 左: 2×2 グリッド */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gridTemplateRows: "auto auto",
              gap: "8px",
            }}>
              {multiPanels.map((panelKey, idx) => {
                const tabInfo = tabs.find(t => t.key === panelKey) ?? tabs[0];
                return (
                  <div key={`slot-${idx}`} style={{
                    position: "relative",
                    background: "rgba(3, 8, 16, 0.6)",
                    border: "1px solid rgba(110, 231, 183, 0.12)",
                    borderRadius: "4px",
                    overflow: "hidden",
                    maxHeight: "600px",
                    overflowY: "auto",
                    scrollbarWidth: "thin",
                    scrollbarColor: "rgba(110,231,183,0.2) transparent",
                  }}>
                    {/* パネルヘッダー */}
                    <div style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "4px 10px",
                      background: "rgba(0,0,0,0.6)",
                      borderBottom: "1px solid rgba(110, 231, 183, 0.1)",
                      position: "sticky", top: 0, zIndex: 10,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{ fontSize: "8px", color: "#334155", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px" }}>MONITOR {idx + 1}</span>
                        <span style={{ color: "#475569", fontSize: "8px" }}>|</span>
                        <span style={{ fontSize: "10px" }}>{tabInfo.icon}</span>
                        <span style={{ fontSize: "9px", color: "#6ee7b7", fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px", fontWeight: 700 }}>{tabInfo.label}</span>
                      </div>
                      <button onClick={() => cycleMultiPanel(idx)} style={{
                        padding: "2px 8px",
                        background: "rgba(110,231,183,0.06)",
                        border: "1px solid rgba(110,231,183,0.15)",
                        borderRadius: "2px",
                        color: "#475569", fontSize: "8px", cursor: "pointer",
                        fontFamily: "'JetBrains Mono', monospace",
                        letterSpacing: "1px",
                      }}>SWITCH ▶</button>
                    </div>
                    {/* パネル本体 */}
                    <div style={{ padding: "10px" }}>
                      {panelMap[panelKey]}
                    </div>
                  </div>
                );
              })}
            </div>
            {/* 右: サイドバー（月齢等） */}
            <div style={{ position: "sticky", top: "16px" }}>
              <AstroDetail now={now} />
            </div>
          </div>
        </div>
      )}

      {/* ===== EVENT LOG — コンソール帯 ===== */}
      <EventLog />

      {/* Footer */}
      <div style={{
        padding: "12px 24px",
        borderTop: "1px solid rgba(110, 231, 183, 0.08)",
        textAlign: "center", color: "#1e293b", fontSize: "9px",
        fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px",
      }}>
        ◈ FOR REFERENCE ONLY — ALWAYS VERIFY WITH OFFICIAL SOURCES — NOT FOR OPERATIONAL USE WITHOUT CROSS-CHECK ◈
      </div>
    </div>
  );
}
