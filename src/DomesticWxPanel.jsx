/* ============================================================
   気象庁データの共通部品
   地図タイル（ナウキャスト・衛星プロダクト）、積乱雲情報、三十分大気解析・下層悪天の URL、
   PDF の画像化、エマグラム、JMA 飛行場時系列予報、オフライン保存用の URL 一覧
   データはすべて気象庁の公開ソースからブラウザで直接取得（CORS許可済み）
   ============================================================ */
import { useState, useEffect, useRef } from "react";
import { PanelFrame, ExtLink, Segmented, actionBtnStyle } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import { findIsotherm } from "./isotherm.js";

const MONO = FONT.ui;
const GREEN = "#6ee7b7";

const JMA = "https://www.jma.go.jp";
const JMA_DATA = "https://www.data.jma.go.jp";
const WM_LIST = `${JMA}/bosai/weather_map/data/list.json`;
const WM_PNG = `${JMA}/bosai/weather_map/data/png/`;
const NWP_PDF = `${JMA}/bosai/numericmap/data/nwpmap/`;
export const FBJP_URL = `${JMA_DATA}/airinfo/data/pict/fbjp/fbjp.png`;
const fbjp112Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fbjp112_${hh}.png`;
export const NOWC = `${JMA}/bosai/jmatile/data/nowc`;
export const BASEMAP = (z, x, y) => `${JMA}/tile/gsi/pale/${z}/${x}/${y}.png`;
export const lowLevelUrl = (area, ft) => `${JMA_DATA}/airinfo/data/pict/low-level_sigwx/${area}${ft}.png`;
const MAIJI_LIST = `${JMA_DATA}/airinfo/data/conf/list_maiji.js`;
export const maijiCrossUrl = (code, ts) => `${JMA_DATA}/airinfo/data/pict/maiji/WANLC1${code}_RJTD_${ts}.PNG`;
export const maijiPlaneUrl = (fl, ts) => `${JMA_DATA}/airinfo/data/pict/maiji/WANLF1${fl}_RJTD_${ts}.PNG`;

/* ---------- 時刻ユーティリティ ---------- */
export const pad = (n) => String(n).padStart(2, "0");
// "YYYYMMDDHHmmss"(UTC) → Date
export const parseTs = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
export const fmtJst = (d) => {
  const j = new Date(d.getTime() + 9 * 3600e3);
  return `${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())} JST`;
};
export const fmtUtc = (d) => `${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;

/* ---------- 汎用UI（見た目は ui.jsx の切替ボタン・操作ボタンにそろえる） ---------- */
function Seg({ options, value, onChange, small, label }) {
  return <Segmented options={options} value={value} onChange={onChange} label={label} height={small ? 36 : 40} />;
}

const btnStyle = (on) => (on
  ? { ...actionBtnStyle, background: "rgba(110,231,183,0.14)", border: "1px solid rgba(110,231,183,0.5)", color: C.accent }
  : actionBtnStyle);

// コマ送りバー（◀ ▶・スライダー・再生）
function StepBar({ index, count, setIndex, label, sub, playing, setPlaying }) {
  if (count <= 0) return null;
  const go = (i) => setIndex(Math.max(0, Math.min(count - 1, i)));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", padding: "10px 16px" }}>
      <button style={btnStyle(false)} onClick={() => go(0)} aria-label="最初">⏮</button>
      <button style={btnStyle(false)} onClick={() => go(index - 1)} aria-label="前">◀</button>
      {setPlaying && (
        <button style={btnStyle(playing)} onClick={() => setPlaying(!playing)} aria-label="再生">
          {playing ? "❚❚" : "▶"}
        </button>
      )}
      <button style={btnStyle(false)} onClick={() => go(index + 1)} aria-label="次">▶</button>
      <button style={btnStyle(false)} onClick={() => go(count - 1)} aria-label="最新">⏭</button>
      <input
        type="range" min={0} max={count - 1} value={index}
        onChange={(e) => go(+e.target.value)}
        style={{ flex: "1 1 160px", accentColor: GREEN, minWidth: "120px", height: "32px" }}
      />
      <div style={{ minWidth: "150px", textAlign: "right" }}>
        <div style={{ color: C.text, fontSize: FS.sm, fontWeight: 700, fontFamily: FONT.data }}>{label}</div>
        {sub && <div style={{ color: C.textMuted, fontSize: FS.xs }}>{sub}</div>}
      </div>
    </div>
  );
}

// 再生用フック：playing中は index を進め、最後で先頭に戻る
export function usePlayer(count, playing, setIndex, ms = 600) {
  useEffect(() => {
    if (!playing || count < 2) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % count), ms);
    return () => clearInterval(id);
  }, [playing, count, setIndex, ms]);
}

// 拡大表示モーダル
function Lightbox({ src, label, onClose }) {
  const [fit, setFit] = useState(true);
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.92)",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px",
        padding: "calc(8px + env(safe-area-inset-top, 0px)) 14px 8px", fontFamily: MONO,
      }}>
        <span style={{ color: GREEN, fontSize: FS.xs }}>{label}</span>
        <span style={{ display: "flex", gap: "6px" }}>
          <button style={btnStyle(!fit)} onClick={(e) => { e.stopPropagation(); setFit(!fit); }}>
            {fit ? "原寸" : "全体"}
          </button>
          <button style={btnStyle(false)} onClick={onClose}>✕</button>
        </span>
      </div>
      <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: fit ? "center" : "flex-start", justifyContent: fit ? "center" : "flex-start" }}>
        <img src={src} alt={label} onClick={(e) => e.stopPropagation()} style={
          fit ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "#fff" }
            : { maxWidth: "none", background: "#fff" }
        } />
      </div>
    </div>
  );
}

// 画像表示（読込中/欠測表示・タップで拡大）
export function ChartImg({ src, label, minHeight = 300, white = true }) {
  // 状態は src 単位で保持（キャッシュ済み画像で onLoad が先に発火しても取りこぼさない）
  const [loadedSrc, setLoadedSrc] = useState(null);
  const [errorSrc, setErrorSrc] = useState(null);
  const [zoom, setZoom] = useState(false);
  const state = src === loadedSrc ? "ok" : src === errorSrc ? "error" : "loading";
  const setState = (s) => (s === "ok" ? setLoadedSrc(src) : setErrorSrc(src));
  if (!src) return <Placeholder minHeight={minHeight} text="読み込み中…" />;
  return (
    <div style={{ position: "relative", background: white ? "#fff" : "#010408", minHeight: state === "ok" ? 0 : minHeight }}>
      <img
        src={src} alt={label}
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
        onClick={() => state === "ok" && setZoom(true)}
        style={{ width: "100%", display: state === "error" ? "none" : "block", cursor: "zoom-in" }}
      />
      {state !== "ok" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "#050a14" }}>
          <span style={{ color: state === "error" ? "#f87171" : C.textMuted, fontSize: FS.xs, fontFamily: MONO, letterSpacing: "1px" }}>
            {state === "error" ? "この図はありません（欠測）" : "読み込み中…"}
          </span>
        </div>
      )}
      {zoom && <Lightbox src={src} label={label} onClose={() => setZoom(false)} />}
    </div>
  );
}

export function Placeholder({ minHeight = 300, text }) {
  return (
    <div style={{ minHeight, display: "flex", alignItems: "center", justifyContent: "center", background: "#050a14" }}>
      <span style={{ color: C.textMuted, fontSize: FS.xs, fontFamily: MONO, letterSpacing: "1px" }}>{text}</span>
    </div>
  );
}

function Toolbar({ children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "16px 16px 10px" }}>{children}</div>
  );
}

export function Caption({ children }) {
  return (
    <div style={{ padding: "10px 16px", color: C.textMuted, fontSize: FS.xs, lineHeight: 1.7 }}>
      {children}
    </div>
  );
}

function Links({ children }) {
  return (
    <div style={{ display: "flex", gap: "6px", padding: "4px 16px 16px", flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

/* ============================================================
   PDF → 画像（AUPA25 / AXJP140 などはPDFのみ公開のため pdf.js で描画）
   ============================================================ */
const pdfCache = new Map(); // key: url|refresh|等温線 → Promise<{src, modified, isotherm}>
const pdfDataCache = new Map(); // key: url|refresh → Promise<{bytes, modified}>（色付けの有無で取り直さない）

function fetchPdf(url, refresh) {
  const key = `${url}|${refresh}`;
  if (!pdfDataCache.has(key)) {
    for (const k of pdfDataCache.keys()) if (k.startsWith(`${url}|`)) pdfDataCache.delete(k); // 古い取得分は捨てる
    pdfDataCache.set(key, fetch(url, { cache: "no-cache" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { bytes: new Uint8Array(await res.arrayBuffer()), modified: res.headers.get("Last-Modified") };
      })
      .catch((e) => { pdfDataCache.delete(key); throw e; }));
  }
  return pdfDataCache.get(key);
}

// isotherm: { target: -30, color } を渡すと、その等温線に色を付ける（線の下に蛍光ペンのように引く）
async function renderPdfToImage(url, refresh, isotherm) {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const { bytes, modified } = await fetchPdf(url, refresh);
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise; // 渡したデータは worker に移るので写しを渡す
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 2400 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let lines = null; // null＝色付けしない／失敗、[]＝見つからない
    if (isotherm) {
      try { lines = findIsotherm(await page.getOperatorList(), pdfjs.OPS, isotherm.target); } catch { lines = null; }
    }
    if (lines?.length) {
      ctx.save();
      ctx.strokeStyle = isotherm.color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 3.5 * scale;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      for (const pts of lines) {
        ctx.beginPath();
        pts.forEach(([x, y], k) => { const [X, Y] = vp.convertToViewportPoint(x, y); if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
        ctx.stroke();
      }
      ctx.restore();
      // 図は透明の背景で別に描いて重ねる（黒い線が色の線の上に来る）
      const layer = document.createElement("canvas");
      layer.width = canvas.width;
      layer.height = canvas.height;
      await page.render({ canvasContext: layer.getContext("2d"), viewport: vp, background: "rgba(0,0,0,0)" }).promise;
      ctx.drawImage(layer, 0, 0);
    } else {
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return { src: URL.createObjectURL(blob), modified, isotherm: isotherm ? (lines ? lines.length : null) : undefined };
  } finally {
    doc.destroy();
  }
}

// PDF を画像化した結果（キャッシュ付き）。天気図一覧タブからも使う
export function getPdfImage(url, refresh = 0, isotherm = null) {
  const key = `${url}|${refresh}|${isotherm ? isotherm.target : ""}`;
  if (!pdfCache.has(key)) {
    pdfCache.set(key, renderPdfToImage(url, refresh, isotherm).catch((e) => { pdfCache.delete(key); throw e; }));
  }
  return pdfCache.get(key);
}

/* ============================================================
   数値予報天気図の初期時刻
   ============================================================ */
// 公開待ち時間(h)を考慮して既定の初期時刻(00/12)を選ぶ（数値予報天気図の PDF は初期時刻の約3.6時間後に公開）
export const defaultInit = (lagH) => {
  const h = new Date().getUTCHours();
  if (h >= 12 + lagH) return "12";
  if (h >= lagH) return "00";
  return "12"; // まだ00Zが出ていない → 前日12Z
};

/* ============================================================
   VI/VII. レーダー・雷 ナウキャスト（気象庁タイルを地図に重ねる）
   ============================================================ */
export const REGIONS = [
  { key: "honshu", label: "本州域", w: 128, e: 146, n: 46, s: 30, z: 6 },
  { key: "south", label: "南日本域", w: 122, e: 134, n: 34, s: 23.5, z: 6 },
  { key: "north", label: "北日本域", w: 137, e: 147, n: 46, s: 37.5, z: 7 },
];

export const lon2px = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
export const lat2px = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z;
};

// layers: [{ id, url:(z,x,y)=>string, opacity?, hideMissing? }]（下から順に重ねる）
export function TileMap({ region, layers, zoom, bg = "#cfd8dc", children }) {
  const { w, e, n, s } = region;
  const z = zoom ?? region.z;
  const x0 = lon2px(w, z), x1 = lon2px(e, z), y0 = lat2px(n, z), y1 = lat2px(s, z);
  const W = x1 - x0, H = y1 - y0;
  const tiles = [];
  for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) {
    for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) tiles.push([tx, ty]);
  }
  const pos = (tx, ty) => ({
    position: "absolute",
    left: `${((tx * 256 - x0) / W) * 100}%`, top: `${((ty * 256 - y0) / H) * 100}%`,
    width: `${(256 / W) * 100}%`, height: `${(256 / H) * 100}%`,
  });
  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: `${W} / ${H}`, overflow: "hidden", background: bg }}>
      {layers.filter(Boolean).map((L) => tiles.map(([tx, ty]) => (
        <OverlayTile key={`${L.id}-${tx}-${ty}`} src={L.url(z, tx, ty)}
          style={{ ...pos(tx, ty), opacity: L.opacity ?? 1, imageRendering: L.pixelated ? "pixelated" : "auto" }} />
      )))}
      {children}
    </div>
  );
}

// 地域内での経緯度 → 位置（%）。TileMap の上に印などを重ねるときに使う
export const projectPct = (region, zoom, lon, lat) => {
  const z = zoom ?? region.z;
  const x0 = lon2px(region.w, z), x1 = lon2px(region.e, z), y0 = lat2px(region.n, z), y1 = lat2px(region.s, z);
  return { x: ((lon2px(lon, z) - x0) / (x1 - x0)) * 100, y: ((lat2px(lat, z) - y0) / (y1 - y0)) * 100 };
};

// データの無いタイルは404になるので非表示にする
function OverlayTile({ src, style }) {
  const [badSrc, setBadSrc] = useState(null);
  return <img src={src} alt="" style={{ ...style, visibility: src === badSrc ? "hidden" : "visible" }} onError={() => setBadSrc(src)} draggable={false} />;
}

export const RADAR_LEGEND = [
  ["#F2F2FF", "<1"], ["#A0D2FF", "1"], ["#218CFF", "5"], ["#0041FF", "10"],
  ["#FAF500", "20"], ["#FF9900", "30"], ["#FF2800", "50"], ["#B40068", "80"],
];
export const THUNDER_LEGEND = [
  ["#F7F55A", "1 雷可能性"], ["#FFAA00", "2 雷あり"], ["#FF2800", "3 やや激しい"], ["#C800FF", "4 激しい"],
];

export function buildNowcFrames(mode, n1, n2, n3) {
  const tenMin = (t) => t.slice(10, 12) % 10 === 0;
  const latestAnalysis = (arr) => arr.filter((x) => x.basetime === x.validtime);
  let past, fcst, element;
  if (mode === "radar") {
    element = "hrpns";
    past = latestAnalysis(n1).filter((x) => tenMin(x.validtime));
    fcst = n2.filter((x) => x.validtime > x.basetime && tenMin(x.validtime));
  } else {
    element = "thns";
    const withTh = n3.filter((x) => x.elements.includes("thns"));
    past = latestAnalysis(withTh).filter((x) => tenMin(x.validtime));
    const base = past.length ? past.reduce((a, b) => (a.basetime > b.basetime ? a : b)).basetime : null;
    fcst = withTh.filter((x) => x.basetime === base && x.validtime > x.basetime);
  }
  past = [...past].sort((a, b) => a.validtime.localeCompare(b.validtime)).slice(-7); // 実況 直近60分
  fcst = [...fcst].sort((a, b) => a.validtime.localeCompare(b.validtime));
  const frames = [
    ...past.map((x) => ({ ...x, fc: false })),
    ...fcst.map((x) => ({ ...x, fc: true })),
  ];
  return { frames, element, latestPastIdx: past.length - 1 };
}

/* ============================================================
   悪天の図・積乱雲情報（SIG WX / IMAGERY で使用）
   積乱雲情報（気象衛星センター）/ SIGMET図 / 国内航空路予想断面図 / 全国航空気象解説報
   ============================================================ */
export const SATPROD = `${JMA_DATA}/tile/satprod`;
export const CCI_TIMES = `${SATPROD}/targetTimes_cbi_jp.json`;
export const COASTLINE = (z, x, y) => `${JMA_DATA}/omaad/const/COASTLINE/${z}/${x}/${y}.png`;
export const sigmetUrl = (code) => `${JMA_DATA}/airinfo/data/pict/sigmet/${code}.png`;
export const fxjp106Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fxjp106_${hh}.png`;
export const cmntUrl = (code) => `${JMA_DATA}/airinfo/data/pict/ajpn_cmnt/${code}.png`;

export const SIGMET_AREAS = [
  { key: "QGMA98", label: "福岡FIR 全体" },
  { key: "QGOA98", label: "本州付近" },
  { key: "QGPA98", label: "南西諸島" },
];
export const CMNT_AREAS = [
  { key: "qyya82", label: "国内空域" },
  { key: "qyya83", label: "福岡FIR" },
];
export const CCI_LEGEND = [
  ["rgba(255,0,0,0.75)", "積乱雲域"],
  ["rgba(0,255,0,0.75)", "積雲急発達域"],
  ["rgba(0,128,128,0.75)", "中下層雲不明域"],
];

export function CciView({ refresh }) {
  const [regionKey, setRegionKey] = useState("honshu");
  const [bgMode, setBgMode] = useState("tbb");
  const [times, setTimes] = useState([]);
  const [err, setErr] = useState(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr(false);
    fetch(CCI_TIMES, { cache: "no-cache" })
      .then((r) => r.json())
      .then((list) => {
        if (!alive) return;
        // 10分毎・直近3時間
        const t = list
          .filter((x) => x.validtime.slice(10, 12) % 10 === 0)
          .sort((a, b) => a.validtime.localeCompare(b.validtime))
          .slice(-19);
        setTimes(t);
        setIdx(Math.max(0, t.length - 1));
      })
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [refresh]);
  usePlayer(times.length, playing, setIdx, 700);

  const region = REGIONS.find((r) => r.key === regionKey);
  const t = times[idx];
  const d = t ? parseTs(t.validtime) : null;
  const sat = (prod) => (z, x, y) => `${SATPROD}/${t.basetime}/JP/${t.validtime}/${prod}/${z}/${x}/${y}.png`;
  const layers = t ? [
    bgMode === "tbb" ? { id: "tbb", url: sat("B13/TBB"), pixelated: true } : { id: "base", url: BASEMAP },
    { id: "coast", url: COASTLINE, pixelated: true },
    { id: "cci", url: sat("CCI/CCI"), opacity: 0.8, pixelated: true },
  ] : [];

  return (
    <>
      <Toolbar>
        <Seg options={REGIONS} value={regionKey} onChange={setRegionKey} />
        <Seg small value={bgMode} onChange={setBgMode}
          options={[{ key: "tbb", label: "背景: 赤外(雲頂温度)" }, { key: "map", label: "背景: 地図" }]} />
      </Toolbar>
      {err ? <Placeholder minHeight={360} text="積乱雲情報の時刻リストを取得できません" />
        : t ? <TileMap region={region} zoom={Math.min(region.z, 6)} layers={layers} bg="#000" />
        : <Placeholder minHeight={360} text="読み込み中…" />}
      <StepBar index={idx} count={times.length} setIndex={setIdx} playing={playing} setPlaying={setPlaying}
        label={d ? fmtJst(d) : "—"} sub={d ? `${fmtUtc(d)} · 実況（10分毎・過去3時間）` : ""} />
      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", padding: "8px 12px", background: "rgba(0,0,0,0.45)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
        {CCI_LEGEND.map(([c, label]) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginRight: "10px" }}>
            <span style={{ width: "18px", height: "10px", background: c, border: "1px solid #000", display: "inline-block" }} />
            <span style={{ color: "#94a3b8", fontSize: FS.xs, fontFamily: MONO }}>{label}</span>
          </span>
        ))}
      </div>
      <Caption>
        ひまわりの観測から解析した積乱雲域（赤）と、積雲が急に発達している域（緑：これから積乱雲になる可能性）。
        背景の赤外画像は白いほど雲頂温度が低い＝雲頂が高い。
      </Caption>
      <Links>
        <ExtLink href={`${JMA_DATA}/omaad/aviation/jp/cci/`} accent>気象庁 積乱雲情報</ExtLink>
      </Links>
    </>
  );
}

/* ============================================================
   下層悪天予想図（SIG WX）
   ============================================================ */
export const LL_AREAS = [
  { key: "fbsp", label: "北海道" }, { key: "fbsn", label: "東北" }, { key: "fbtk", label: "東日本" },
  { key: "fbos", label: "西日本" }, { key: "fbkg", label: "奄美" }, { key: "fbok", label: "沖縄" },
];
export const LL_FTS = [
  { key: "03", label: "FT03" }, { key: "06", label: "FT06" }, { key: "09", label: "FT09" }, { key: "39", label: "時系列" },
];

/* ============================================================
   三十分大気解析（断面図・平面図）（ENROUTE）
   ============================================================ */
export const CROSS_OPTS = [
  ...["145.0", "142.5", "140.0", "137.5", "135.0", "132.5", "130.0", "127.5", "125.0", "122.5"]
    .map((lon, i) => ({ key: String(50 + i), label: `E${lon}°` })),
  { key: "99", label: "与那国-稚内" }, { key: "01", label: "福岡-釧路" }, { key: "02", label: "福岡-紋別" },
  { key: "03", label: "東京-稚内" }, { key: "04", label: "東京-女満別" }, { key: "05", label: "福岡-東京" },
  { key: "06", label: "鹿児島-東京" }, { key: "07", label: "石垣-東京" }, { key: "08", label: "与那国-高松" },
  { key: "09", label: "与那国-福岡" },
];
export const PLANE_OPTS = ["45", "43", "41", "39", "37", "35", "33", "31", "29", "27", "25", "23", "21", "19", "17", "15", "13", "11", "09", "07", "05"]
  .map((fl) => ({ key: fl, label: `FL${fl}0` }));

export async function fetchMaijiTimes() {
  const text = await fetch(MAIJI_LIST, { cache: "no-cache" }).then((r) => r.text());
  return [...text.matchAll(/"(\d{14})"/g)].map((m) => m[1]); // 新しい順
}

/* ============================================================
   エマグラム（気象庁ラジオゾンデ観測 / University of Wyoming 経由）
   ============================================================ */
export const WORKER_URL = import.meta.env.VITE_WORKER_URL || "https://wx-awc-proxy.trinity-funkyboy.workers.dev";
const SONDE_STATIONS = [
  { id: "47401", name: "稚内" }, { id: "47412", name: "札幌" }, { id: "47418", name: "釧路" },
  { id: "47582", name: "秋田" }, { id: "47600", name: "輪島" }, { id: "47646", name: "館野" },
  { id: "47678", name: "八丈島" }, { id: "47741", name: "松江" }, { id: "47778", name: "潮岬" },
  { id: "47807", name: "福岡" }, { id: "47827", name: "鹿児島" }, { id: "47909", name: "名瀬" },
  { id: "47945", name: "南大東島" }, { id: "47918", name: "石垣島" }, { id: "47971", name: "父島" },
  { id: "47991", name: "南鳥島" },
];
const SONDE_STORE = "domwx_sonde";

// 熱力学
const RD = 287.04, CP = 1005.7, LV = 2.501e6, EPS = 0.622, KAPPA = RD / CP;
const K0 = 273.15;
const esat = (tc) => 6.112 * Math.exp((17.67 * tc) / (tc + 243.5)); // hPa
const mixr = (tc, p) => { const e = esat(tc); return (EPS * e) / (p - e); }; // kg/kg
const tdFromMix = (w, p) => { // w: g/kg → 露点(℃)
  const e = ((w / 1000) * p) / (EPS + w / 1000);
  const l = Math.log(e / 6.112);
  return (243.5 * l) / (17.67 - l);
};
const dryT = (thetaK, p) => thetaK * Math.pow(p / 1000, KAPPA) - K0;
// 湿潤断熱減率 dT/dp（K/hPa）
const moistLapse = (tK, p) => {
  const rs = mixr(tK - K0, p);
  return ((RD * tK + LV * rs) / (CP + (LV * LV * rs * EPS) / (RD * tK * tK))) / p;
};
// p0 から p1 まで湿潤断熱で持ち上げた気温（℃）
const moistLift = (tc, p0, p1, step = 5) => {
  let t = tc + K0, p = p0;
  const dir = p1 < p0 ? -1 : 1;
  while ((dir < 0 && p > p1) || (dir > 0 && p < p1)) {
    const dp = dir * Math.min(step, Math.abs(p1 - p));
    const k1 = moistLapse(t, p);
    const k2 = moistLapse(t + k1 * dp, p + dp);
    t += ((k1 + k2) / 2) * dp;
    p += dp;
  }
  return t - K0;
};
// 持ち上げ凝結高度（Bolton 1980）
const lclOf = (tc, tdc, p) => {
  const T = tc + K0, Td = tdc + K0;
  const tl = 1 / (1 / (Td - 56) + Math.log(T / Td) / 800) + 56;
  return { p: p * Math.pow(tl / T, 1 / KAPPA), t: tl - K0 };
};
// 気塊温度（p0 から p へ：LCL までは乾燥断熱、以降は湿潤断熱）
const parcelT = (tc, tdc, p0, p) => {
  const lcl = lclOf(tc, tdc, p0);
  if (p >= lcl.p) return dryT((tc + K0) * Math.pow(1000 / p0, KAPPA), p);
  return moistLift(lcl.t, lcl.p, p);
};

function parseSondeCsv(text) {
  const lines = text.trim().split("\n");
  const head = lines[0].split(",");
  const col = (name) => head.findIndex((h) => h.startsWith(name));
  const ip = col("pressure"), iz = col("geopotential"), it = col("temperature"), itd = col("dew point"),
    iwd = col("wind direction"), iws = col("wind speed");
  const num = (s) => (s === undefined || s.trim() === "" ? NaN : +s);
  const rows = lines.slice(1).map((l) => {
    const c = l.split(",");
    return { p: num(c[ip]), z: num(c[iz]), t: num(c[it]), td: num(c[itd]), wd: num(c[iwd]), ws: num(c[iws]) * 1.94384 };
  }).filter((r) => r.p > 0 && !isNaN(r.z));
  rows.sort((a, b) => b.p - a.p);
  return rows;
}

// ln p で線形補間
function interpAtP(rows, p, key) {
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.p >= p && b.p <= p && !isNaN(a[key]) && !isNaN(b[key])) {
      const f = (Math.log(a.p) - Math.log(p)) / (Math.log(a.p) - Math.log(b.p));
      return a[key] + (b[key] - a[key]) * f;
    }
  }
  return NaN;
}
// 気温が target を下回る最初の高度（m）
function heightOfIsotherm(rows, target) {
  const r = rows.filter((x) => !isNaN(x.t));
  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i], b = r[i + 1];
    if (a.t >= target && b.t < target) return a.z + ((b.z - a.z) * (a.t - target)) / (a.t - b.t);
  }
  return NaN;
}
const m2ft = (m) => m * 3.28084;
const ftLabel = (m) => (isNaN(m) ? "—" : `${Math.round(m2ft(m) / 100) * 100}ft (FL${String(Math.round(m2ft(m) / 100)).padStart(3, "0")})`);

function sondeIndices(rows) {
  const sfc = rows.find((r) => !isNaN(r.t) && !isNaN(r.td));
  if (!sfc) return null;
  const at = (p, k) => interpAtP(rows, p, k);
  const lcl = lclOf(sfc.t, sfc.td, sfc.p);
  const lclZ = interpAtP(rows, lcl.p, "z");
  const t850 = at(850, "t"), td850 = at(850, "td"), t700 = at(700, "t"), td700 = at(700, "td"), t500 = at(500, "t");
  const ssi = t500 - parcelT(t850, td850, 850, 500);
  const ki = t850 - t500 + td850 - (t700 - td700);
  // 地上気塊の CAPE / CIN（仮温度補正なしの概算）
  // CIN は LFC（浮力が初めて正になる高さ）より下の負の部分のみ。CAPE が無ければ CIN は定義しない
  let cape = 0, below = 0, cin = NaN, above = false;
  const levels = rows.filter((r) => !isNaN(r.t) && r.p <= sfc.p && r.p >= 100);
  for (let i = 0; i < levels.length - 1; i++) {
    const a = levels[i], b = levels[i + 1];
    const ba = parcelT(sfc.t, sfc.td, sfc.p, a.p) - a.t, bb = parcelT(sfc.t, sfc.td, sfc.p, b.p) - b.t;
    const e = RD * ((ba + bb) / 2) * Math.log(a.p / b.p);
    if (e > 0) { if (!above) { above = true; cin = below; } cape += e; }
    else if (!above) below += e;
  }
  return {
    sfc, lcl, lclZ, ssi, ki, cape, cin,
    z0: heightOfIsotherm(rows, 0), z10: heightOfIsotherm(rows, -10), z20: heightOfIsotherm(rows, -20),
  };
}

// 着氷に注意する層（0〜-20℃ かつ 湿数 3℃以下）
function icingLayers(rows) {
  const out = [];
  let cur = null;
  rows.forEach((r) => {
    const hit = !isNaN(r.t) && !isNaN(r.td) && r.t <= 0 && r.t >= -20 && r.t - r.td <= 3;
    if (hit) { if (!cur) cur = { pBot: r.p, zBot: r.z }; cur.pTop = r.p; cur.zTop = r.z; }
    else if (cur) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out;
}

function WindBarb({ x, y, dir, kt }) {
  if (isNaN(dir) || isNaN(kt)) return null;
  const L = 22;
  let rest = Math.round(kt / 5) * 5;
  const parts = [];
  let pos = L;
  while (rest >= 50) { parts.push(<polygon key={`p${pos}`} points={`0,${-pos} 9,${-pos + 3} 0,${-pos + 6}`} fill="#cbd5e1" />); pos -= 7; rest -= 50; }
  while (rest >= 10) { parts.push(<line key={`l${pos}`} x1="0" y1={-pos} x2="10" y2={-pos - 4} stroke="#cbd5e1" strokeWidth="1.3" />); pos -= 4; rest -= 10; }
  if (rest >= 5) { if (pos === L) pos -= 4; parts.push(<line key={`h${pos}`} x1="0" y1={-pos} x2="5" y2={-pos - 2} stroke="#cbd5e1" strokeWidth="1.3" />); }
  if (kt < 2.5) return <circle cx={x} cy={y} r="3" fill="none" stroke="#cbd5e1" />;
  return (
    <g transform={`translate(${x},${y}) rotate(${dir})`}>
      <line x1="0" y1="0" x2="0" y2={-L} stroke="#cbd5e1" strokeWidth="1.3" />
      {parts}
    </g>
  );
}

const EMA = { W: 760, H: 640, x0: 56, x1: 640, y0: 14, y1: 600, pTop: 100, pBot: 1050, tMin: -80, tMax: 40 };
const ex = (t) => EMA.x0 + ((t - EMA.tMin) / (EMA.tMax - EMA.tMin)) * (EMA.x1 - EMA.x0);
// 気圧軸：上が低気圧（pTop）、下が高気圧（pBot）
const ey = (p) => EMA.y0 + ((Math.log(p) - Math.log(EMA.pTop)) / (Math.log(EMA.pBot) - Math.log(EMA.pTop))) * (EMA.y1 - EMA.y0);
const pFromY = (y) => Math.exp(Math.log(EMA.pTop) + ((y - EMA.y0) / (EMA.y1 - EMA.y0)) * (Math.log(EMA.pBot) - Math.log(EMA.pTop)));
const path = (pts) => pts.filter((p) => isFinite(p[0]) && isFinite(p[1])).map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
const clipT = (t) => Math.max(EMA.tMin - 5, Math.min(EMA.tMax + 5, t));

// 背景（断熱線・等混合比線など）は観測に依存しないので一度だけ計算
const EMA_BG = (() => {
  const ps = []; for (let p = EMA.pBot; p >= EMA.pTop; p -= 10) ps.push(p);
  const dry = []; for (let th = 240; th <= 460; th += 10) dry.push(path(ps.map((p) => [ex(clipT(dryT(th, p))), ey(p)])));
  const moist = [];
  for (let t0 = -16; t0 <= 36; t0 += 4) {
    const pts = []; let t = t0;
    for (let p = 1050; p >= 200; p -= 10) { pts.push([ex(clipT(t)), ey(p)]); t = moistLift(t, p, p - 10, 5); }
    moist.push(path(pts));
  }
  const mix = [0.4, 1, 2, 4, 7, 10, 16, 24].map((w) => ({
    w, d: path([1050, 1000, 900, 800, 700, 600].map((p) => [ex(tdFromMix(w, p)), ey(p)])),
  }));
  return { dry, moist, mix };
})();

function Emagram({ rows, idx }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const tPts = rows.filter((r) => !isNaN(r.t) && r.p >= EMA.pTop).map((r) => [ex(r.t), ey(r.p)]);
  const tdPts = rows.filter((r) => !isNaN(r.td) && r.p >= EMA.pTop).map((r) => [ex(Math.max(EMA.tMin, r.td)), ey(r.p)]);
  const parcel = idx ? (() => {
    const pts = [];
    for (let p = idx.sfc.p; p >= 200; p -= 10) pts.push([ex(clipT(parcelT(idx.sfc.t, idx.sfc.td, idx.sfc.p, p))), ey(p)]);
    return path(pts);
  })() : "";
  const isobars = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100];
  // 風：約25hPa毎に間引き
  const barbs = [];
  let lastY = -999;
  rows.forEach((r) => {
    const y = ey(r.p);
    if (r.p >= EMA.pTop && r.p <= EMA.pBot && !isNaN(r.wd) && Math.abs(y - lastY) >= 18) { barbs.push({ y, r }); lastY = y; }
  });
  const ice = icingLayers(rows);

  const onMove = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    if (loc.y < EMA.y0 || loc.y > EMA.y1) { setHover(null); return; }
    const p = pFromY(loc.y);
    setHover({ y: loc.y, p, z: interpAtP(rows, p, "z"), t: interpAtP(rows, p, "t"), td: interpAtP(rows, p, "td"), wd: interpAtP(rows, p, "wd"), ws: interpAtP(rows, p, "ws") });
  };

  return (
    <svg ref={svgRef} viewBox={`0 0 ${EMA.W} ${EMA.H}`} style={{ width: "100%", display: "block", background: "#050a14", touchAction: "pan-y" }}
      onPointerMove={onMove} onPointerLeave={() => setHover(null)} fontFamily="JetBrains Mono, monospace">
      <defs><clipPath id="emaClip"><rect x={EMA.x0} y={EMA.y0} width={EMA.x1 - EMA.x0} height={EMA.y1 - EMA.y0} /></clipPath></defs>
      <rect x={EMA.x0} y={EMA.y0} width={EMA.x1 - EMA.x0} height={EMA.y1 - EMA.y0} fill="#070d1a" stroke="#1e293b" />
      <g clipPath="url(#emaClip)">
        {/* 着氷注意層 */}
        {ice.map((l, i) => (
          <rect key={i} x={EMA.x0} y={ey(l.pTop)} width={EMA.x1 - EMA.x0} height={Math.max(2, ey(l.pBot) - ey(l.pTop))} fill="rgba(56,189,248,0.10)" />
        ))}
        {EMA_BG.dry.map((d, i) => <path key={`d${i}`} d={d} stroke="#7c2d12" strokeWidth="0.8" fill="none" opacity="0.7" />)}
        {EMA_BG.moist.map((d, i) => <path key={`m${i}`} d={d} stroke="#166534" strokeWidth="0.8" fill="none" strokeDasharray="5 3" opacity="0.8" />)}
        {EMA_BG.mix.map((m) => <path key={`w${m.w}`} d={m.d} stroke="#7e22ce" strokeWidth="0.8" fill="none" strokeDasharray="2 3" opacity="0.8" />)}
        {Array.from({ length: 13 }, (_, i) => EMA.tMin + i * 10).map((t) => (
          <line key={`t${t}`} x1={ex(t)} x2={ex(t)} y1={EMA.y0} y2={EMA.y1}
            stroke={t === 0 ? "#38bdf8" : t === -20 ? "#0ea5e9" : "#1e293b"} strokeWidth={t === 0 ? 1.4 : 1} strokeDasharray={t === -20 ? "6 4" : undefined} />
        ))}
        {isobars.map((p) => <line key={`p${p}`} x1={EMA.x0} x2={EMA.x1} y1={ey(p)} y2={ey(p)} stroke="#334155" strokeWidth="0.8" />)}
        {parcel && <path d={parcel} stroke="#fbbf24" strokeWidth="1.4" fill="none" strokeDasharray="6 4" />}
        <path d={path(tdPts)} stroke="#34d399" strokeWidth="2.2" fill="none" />
        <path d={path(tPts)} stroke="#f87171" strokeWidth="2.4" fill="none" />
        {idx && <line x1={EMA.x0} x2={EMA.x1} y1={ey(idx.lcl.p)} y2={ey(idx.lcl.p)} stroke="#fbbf24" strokeWidth="0.8" strokeDasharray="2 2" />}
      </g>
      {/* 混合比ラベル */}
      {EMA_BG.mix.map((m) => (
        <text key={`wl${m.w}`} x={ex(tdFromMix(m.w, 1050))} y={EMA.y1 - 4} fill="#a855f7" fontSize="9" textAnchor="middle">{m.w}</text>
      ))}
      {/* 軸ラベル */}
      {isobars.map((p) => {
        const z = interpAtP(rows, p, "z");
        return (
          <g key={`pl${p}`}>
            <text x={EMA.x0 - 4} y={ey(p) + 3} fill="#94a3b8" fontSize="10" textAnchor="end">{p}</text>
            {!isNaN(z) && <text x={EMA.x0 + 3} y={ey(p) - 3} fill="#64748b" fontSize="9">{Math.round(m2ft(z) / 100) * 100}ft</text>}
          </g>
        );
      })}
      {Array.from({ length: 13 }, (_, i) => EMA.tMin + i * 10).map((t) => (
        <text key={`tl${t}`} x={ex(t)} y={EMA.y1 + 14} fill={t === 0 ? "#38bdf8" : "#64748b"} fontSize="10" textAnchor="middle">{t}</text>
      ))}
      <text x={EMA.x1} y={EMA.y1 + 30} fill="#64748b" fontSize="10" textAnchor="end">気温 ℃</text>
      <text x={8} y={EMA.y0 + 8} fill="#64748b" fontSize="10">hPa</text>
      {/* 風 */}
      <text x={(EMA.x1 + EMA.W) / 2} y={EMA.y0 + 8} fill="#64748b" fontSize="10" textAnchor="middle">風 kt</text>
      {barbs.map(({ y, r }, i) => <WindBarb key={i} x={(EMA.x1 + EMA.W) / 2 + 6} y={y} dir={r.wd} kt={r.ws} />)}
      {/* ホバー読み取り */}
      {hover && (
        <g pointerEvents="none">
          <line x1={EMA.x0} x2={EMA.x1} y1={hover.y} y2={hover.y} stroke="#e2e8f0" strokeWidth="0.6" strokeDasharray="3 3" />
          <rect x={EMA.x0 + 6} y={hover.y > EMA.y1 - 40 ? hover.y - 26 : hover.y + 6} width="300" height="20" rx="2" fill="rgba(0,0,0,0.8)" />
          <text x={EMA.x0 + 12} y={hover.y > EMA.y1 - 40 ? hover.y - 12 : hover.y + 20} fill="#e2e8f0" fontSize="11">
            {`${Math.round(hover.p)}hPa ${isNaN(hover.z) ? "" : Math.round(m2ft(hover.z) / 100) * 100 + "ft"} T${isNaN(hover.t) ? "—" : hover.t.toFixed(1)} Td${isNaN(hover.td) ? "—" : hover.td.toFixed(1)} ${isNaN(hover.wd) ? "" : `${Math.round(hover.wd)}°/${Math.round(hover.ws)}kt`}`}
          </text>
        </g>
      )}
    </svg>
  );
}

// 直近の観測時刻（00Z/12Z、観測後2時間で利用可能とみなす）から遡って n 回分
const sondeCycles = (n = 8) => {
  const d = new Date(Date.now() - 2 * 3600e3);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() >= 12 ? 12 : 0);
  return Array.from({ length: n }, (_, i) => new Date(d.getTime() - (n - 1 - i) * 12 * 3600e3));
};
const cycleKey = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`;
const sondeCache = new Map();

export function EmagramSection({ refresh = 0 }) {
  const [station, setStationState] = useState(() => {
    try { return localStorage.getItem(SONDE_STORE) || "47646"; } catch { return "47646"; }
  });
  const setStation = (s) => { setStationState(s); try { localStorage.setItem(SONDE_STORE, s); } catch { /* ignore */ } };
  const cycles = sondeCycles();
  const [idx, setIdx] = useState(cycles.length - 1);
  const [state, setState] = useState({ status: "loading" });
  const fellBack = useRef(false);
  const cyc = cycles[idx];
  const key = `${station}|${cycleKey(cyc)}`;

  useEffect(() => { fellBack.current = false; setIdx(cycles.length - 1); }, [station, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    if (!sondeCache.has(key)) {
      sondeCache.set(key, fetch(`${WORKER_URL}/upper-air/?id=${station}&dt=${cycleKey(cyc)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(r.status === 503 ? "データ提供元が混雑中です。少し待って再試行してください" : "観測データがありません（未入電・欠測）");
          const rows = parseSondeCsv(await r.text());
          if (rows.length < 5) throw new Error("観測データが不十分です");
          return rows;
        }));
    }
    sondeCache.get(key)
      .then((rows) => alive && setState({ status: "ok", rows }))
      .catch((e) => {
        sondeCache.delete(key);
        if (!alive) return;
        // 最新回がまだ無ければ1回前へ自動で戻る
        if (idx === cycles.length - 1 && !fellBack.current) { fellBack.current = true; setIdx(idx - 1); return; }
        setState({ status: "error", msg: e.message });
      });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = state.rows;
  const ind = rows ? sondeIndices(rows) : null;
  const ice = rows ? icingLayers(rows) : [];
  const stName = SONDE_STATIONS.find((s) => s.id === station)?.name;
  const stdLevels = [1000, 925, 850, 700, 500, 400, 300, 250, 200];
  const cell = { padding: "3px 8px", textAlign: "right", fontFamily: FONT.data, fontSize: FS.xs, color: "#cbd5e1", borderBottom: "1px solid rgba(148,163,184,0.08)" };

  return (
    <PanelFrame title="エマグラム（高層観測）" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={SONDE_STATIONS.map((s) => ({ key: s.id, label: s.name }))} value={station} onChange={setStation} small />
      </Toolbar>
      {state.status === "ok" ? <Emagram rows={rows} idx={ind} />
        : <Placeholder minHeight={420} text={state.status === "error" ? state.msg : "読み込み中…"} />}
      <StepBar index={idx} count={cycles.length} setIndex={(i) => { fellBack.current = true; setIdx(typeof i === "function" ? i(idx) : i); }}
        label={`${stName} ${pad(cyc.getUTCDate())}日 ${pad(cyc.getUTCHours())}Z`} sub={`${fmtJst(cyc)} 観測 · 12時間毎`} />
      {ind && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1px", background: "rgba(110,231,183,0.08)", borderTop: "1px solid rgba(110,231,183,0.08)" }}>
          {[
            ["0℃高度", ftLabel(ind.z0), "#38bdf8"],
            ["-10℃高度", ftLabel(ind.z10), "#38bdf8"],
            ["-20℃高度", ftLabel(ind.z20), "#38bdf8"],
            ["持ち上げ凝結高度 LCL（地上気塊）",`${Math.round(ind.lcl.p)}hPa / ${isNaN(ind.lclZ) ? "—" : Math.round(m2ft(ind.lclZ) / 100) * 100 + "ft"}`, "#fbbf24"],
            ["SSI（ショワルター）", isNaN(ind.ssi) ? "—" : `${ind.ssi.toFixed(1)}${ind.ssi <= 0 ? "  雷雨の可能性" : ind.ssi <= 3 ? "  やや不安定" : ""}`, ind.ssi <= 0 ? "#f87171" : ind.ssi <= 3 ? "#fbbf24" : "#6ee7b7"],
            ["K指数", isNaN(ind.ki) ? "—" : `${ind.ki.toFixed(0)}${ind.ki >= 30 ? "  雷雨の可能性大" : ind.ki >= 20 ? "  雷雨の可能性" : ""}`, ind.ki >= 30 ? "#f87171" : ind.ki >= 20 ? "#fbbf24" : "#6ee7b7"],
            ["CAPE / CIN（地上・概算）", `${Math.round(ind.cape)} / ${isNaN(ind.cin) ? "—" : Math.round(ind.cin)} J/kg`,ind.cape >= 1000 ? "#f87171" : ind.cape >= 250 ? "#fbbf24" : "#6ee7b7"],
            ["着氷注意層（0〜-20℃・湿数≦3）", ice.length ? ice.map((l) => `${Math.round(m2ft(l.zBot) / 100)}-${Math.round(m2ft(l.zTop) / 100)}`).join(", ") + " (×100ft)" : "なし", ice.length ? "#38bdf8" : "#6ee7b7"],
          ].map(([k, v, c]) => (
            <div key={k} style={{ padding: "8px 12px", background: "#050a14" }}>
              <div style={{ color: C.textMuted, fontSize: FS.xs, fontFamily: MONO }}>{k}</div>
              <div style={{ color: c, fontSize: FS.sm, fontFamily: MONO, fontWeight: 700, marginTop: "2px" }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      {rows && (
        <div style={{ overflowX: "auto", background: "rgba(0,0,0,0.35)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "460px" }}>
            <thead>
              <tr>{["気圧", "高度", "気温", "露点", "湿数", "風"].map((h) => <th key={h} style={{ ...cell, color: C.textMuted, fontWeight: 500 }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {stdLevels.map((p) => {
                const z = interpAtP(rows, p, "z"), t = interpAtP(rows, p, "t"), td = interpAtP(rows, p, "td");
                const wd = interpAtP(rows, p, "wd"), ws = interpAtP(rows, p, "ws");
                if (isNaN(z)) return null;
                const dep = t - td;
                return (
                  <tr key={p}>
                    <td style={cell}>{p}hPa</td>
                    <td style={cell}>{Math.round(m2ft(z) / 100) * 100}ft</td>
                    <td style={{ ...cell, color: "#f87171" }}>{isNaN(t) ? "—" : t.toFixed(1)}</td>
                    <td style={{ ...cell, color: "#34d399" }}>{isNaN(td) ? "—" : td.toFixed(1)}</td>
                    <td style={{ ...cell, color: dep <= 3 ? "#38bdf8" : "#cbd5e1" }}>{isNaN(dep) ? "—" : dep.toFixed(1)}</td>
                    <td style={cell}>{isNaN(wd) ? "—" : `${String(Math.round(wd / 10) * 10).padStart(3, "0")}°/${Math.round(ws)}kt`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Caption>
        赤＝気温、緑＝露点、黄破線＝地上気塊の上昇経路（LCLで乾燥→湿潤断熱）。茶線＝乾燥断熱線、緑破線＝湿潤断熱線、紫点線＝等飽和混合比線(g/kg)。
        青の帯＝着氷に注意する層。図をなぞるとその高さの値を表示します。指標は簡易計算のため目安です。
      </Caption>
      <Links>
        <ExtLink href={`https://weather.uwyo.edu/wsgi/sounding?datetime=${encodeURIComponent(`${cyc.toISOString().slice(0, 10)} ${pad(cyc.getUTCHours())}:00:00`)}&id=${station}&type=TEXT:LIST&src=UNKNOWN`} accent>
          元データ（Univ. of Wyoming）
        </ExtLink>
        <ExtLink href="https://www.data.jma.go.jp/stats/etrn/upper/index.php">気象庁 高層観測データ</ExtLink>
      </Links>
    </PanelFrame>
  );
}

/* ============================================================
   空港別：飛行場時系列予報/情報・飛行場気象解説情報（METAR/TAF タブ用）
   ============================================================ */
const AIRINFO = `${JMA_DATA}/airinfo/data`;
export const jmaTafChartUrl = (icao, part) => `${AIRINFO}/pict/taf/${part === 2 ? "QMCJ98" : "QMCD98"}_${icao}.png`;
export const jmaCommentUrl = (icao, rinji) => `${AIRINFO}/pict/comment/${rinji ? "ADJH02" : "ADJH01"}_${icao}.png`;

let jmaAirportsPromise = null;
// 気象庁の対象空港一覧 { ICAO: { type: "fcst"|"info", name } }
export function getJmaAirports() {
  if (!jmaAirportsPromise) {
    jmaAirportsPromise = fetch(`${AIRINFO}/conf/airport_options.txt`)
      .then((r) => r.text())
      .then((text) => {
        const map = {};
        text.split("\n").forEach((line) => {
          const [type, , icao, name] = line.split(",").map((s) => s.trim());
          if (icao && /^[A-Z]{4}$/.test(icao)) map[icao] = { type, name };
        });
        return map;
      })
      .catch(() => { jmaAirportsPromise = null; return {}; });
  }
  return jmaAirportsPromise;
}

// 画像が存在するか（404なら false）
function useImageExists(src) {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    if (!src) return;
    let alive = true;
    setExists(false);
    const img = new Image();
    img.onload = () => alive && setExists(true);
    img.onerror = () => alive && setExists(false);
    img.src = src;
    return () => { alive = false; };
  }, [src]);
  return exists;
}

export function JmaAirportCharts({ icao }) {
  const [info, setInfo] = useState(null);
  const [view, setView] = useState(null); // null | "p1" | "p2" | "c1" | "c2"
  useEffect(() => {
    let alive = true;
    getJmaAirports().then((m) => alive && setInfo(m[icao] || null));
    return () => { alive = false; };
  }, [icao]);
  const hasComment = useImageExists(info ? jmaCommentUrl(icao, false) : null);
  const hasRinji = useImageExists(info ? jmaCommentUrl(icao, true) : null);
  if (!info) return null;

  const isFcst = info.type === "fcst";
  const views = [
    { key: "p1", label: "Part1", src: jmaTafChartUrl(icao, 1) },
    { key: "p2", label: "Part2", src: jmaTafChartUrl(icao, 2) },
    hasComment && { key: "c1", label: "解説情報", src: jmaCommentUrl(icao, false) },
    hasRinji && { key: "c2", label: "⚠ 臨時解説", src: jmaCommentUrl(icao, true), alert: true },
  ].filter(Boolean);
  const cur = views.find((v) => v.key === view);

  return (
    <div style={{ marginTop: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
        <span style={{ color: "#f59e0b", fontSize: FS.xs, fontWeight: 600, letterSpacing: "1px", fontFamily: MONO, marginRight: "4px" }}>
          JMA {isFcst ? "時系列予報" : "時系列情報"}
        </span>
        {views.map((v) => {
          const on = v.key === view;
          const c = v.alert ? "#f87171" : "#f59e0b";
          return (
            <button key={v.key} onClick={() => setView(on ? null : v.key)} style={{
              padding: "3px 10px", borderRadius: "3px", cursor: "pointer", fontFamily: MONO, fontSize: FS.xs,
              background: on ? (v.alert ? "rgba(248,113,113,0.15)" : "rgba(245,158,11,0.15)") : "transparent",
              border: `1px solid ${on || v.alert ? c : "rgba(148,163,184,0.2)"}`,
              color: on || v.alert ? c : "#94a3b8",
            }}>{v.label}</button>
          );
        })}
        <span style={{ color: C.textMuted, fontSize: FS.xs, fontFamily: MONO }}>
          {isFcst ? "1時間毎の風・横風・視程・シーリング・天気・TS確率" : "1時間毎の風・視程・シーリング等"}
        </span>
      </div>
      {cur && (
        <div style={{ marginTop: "8px", borderRadius: "6px", overflow: "hidden", border: "1px solid rgba(245,158,11,0.25)" }}>
          <ChartImg src={cur.src} label={`${icao} ${cur.label}`} minHeight={240} />
          <div style={{ display: "flex", gap: "4px", padding: "6px 10px", flexWrap: "wrap", background: "rgba(0,0,0,0.4)" }}>
            <ExtLink href={`${AIRINFO}/awfo_taf.html?${icao}#contents_area2`}>気象庁 時系列予報</ExtLink>
            {hasComment && <ExtLink href={`${AIRINFO}/awfo_comment.html?${icao}#contents_area2`}>気象庁 解説情報</ExtLink>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   オフライン用：図の URL をまとめる（ヘッダーの PREFLIGHT ボタンから Service Worker に渡す）
   ============================================================ */
export async function collectChartUrls() {
  const urls = [FBJP_URL];
  // 3時間毎の図（FBJP112・FXJP106）：最新と1つ前の初期値（約2時間14分後に掲載）
  const latest = Math.floor(new Date(Date.now() - 140 * 60e3).getUTCHours() / 3) * 3;
  for (const hh of [latest, (latest + 21) % 24]) urls.push(fbjp112Url(pad(hh)), fxjp106Url(pad(hh)));
  // 数値予報天気図（PDF）
  const init = defaultInit(4);
  for (const f of ["aupq78", "aupq35", "aupa25", "fupa252", "fxjp854", "axjp140"]) urls.push(`${NWP_PDF}${f}_${init}.pdf`);
  // 地上天気図（一覧から最新）
  try {
    const list = await fetch(WM_LIST, { cache: "no-cache" }).then((r) => r.json());
    const pick = [list.near?.now?.slice(-1)[0], list.asia?.now?.slice(-1)[0], list.near?.ft24?.[0], list.near?.ft48?.[0]];
    pick.filter(Boolean).forEach((f) => urls.push(WM_PNG + f));
  } catch { /* skip */ }
  // SIG WX：SIGMET（原文・図）・解説報・下層悪天 全地域×全FT
  urls.push(`${WORKER_URL}/api/data/isigmet?format=json`);
  SIGMET_AREAS.forEach((a) => urls.push(sigmetUrl(a.key)));
  CMNT_AREAS.forEach((a) => urls.push(cmntUrl(a.key)));
  for (const a of LL_AREAS) for (const f of LL_FTS) urls.push(lowLevelUrl(a.key, f.key));
  // ENROUTE：三十分大気解析 最新の全断面・全FL
  try {
    const [ts] = await fetchMaijiTimes();
    if (ts) {
      CROSS_OPTS.forEach((o) => urls.push(maijiCrossUrl(o.key, ts)));
      PLANE_OPTS.forEach((o) => urls.push(maijiPlaneUrl(o.key, ts)));
    }
  } catch { /* skip */ }
  return urls;
}
