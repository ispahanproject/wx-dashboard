/* ============================================================
   国内解析 (DOMESTIC FLIGHT WX)
   天気図まとめ / ひまわりコマ送り / レーダー・雷ナウキャスト /
   低高度悪天予想図 / 毎時大気解析（断面図・平面図）
   データはすべて気象庁の公開ソースからブラウザで直接取得（CORS許可済み）
   ============================================================ */
import { useState, useEffect, useRef, useCallback } from "react";
import { PanelFrame, ExtLink } from "./ui.jsx";

const MONO = "'JetBrains Mono', monospace";
const GREEN = "#6ee7b7";

const JMA = "https://www.jma.go.jp";
const JMA_DATA = "https://www.data.jma.go.jp";
const WM_LIST = `${JMA}/bosai/weather_map/data/list.json`;
const WM_PNG = `${JMA}/bosai/weather_map/data/png/`;
const NWP_PDF = `${JMA}/bosai/numericmap/data/nwpmap/`;
const FBJP_URL = `${JMA_DATA}/airinfo/data/pict/fbjp/fbjp.png`;
const fbjp112Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fbjp112_${hh}.png`;
const himaUrl = (band, hhmm) => `${JMA_DATA}/mscweb/data/himawari/img/jpn/jpn_${band}_${hhmm}.jpg`;
const NOWC = `${JMA}/bosai/jmatile/data/nowc`;
const BASEMAP = (z, x, y) => `${JMA}/tile/gsi/pale/${z}/${x}/${y}.png`;
const lowLevelUrl = (area, ft) => `${JMA_DATA}/airinfo/data/pict/low-level_sigwx/${area}${ft}.png`;
const MAIJI_LIST = `${JMA_DATA}/airinfo/data/conf/list_maiji.js`;
const maijiCrossUrl = (code, ts) => `${JMA_DATA}/airinfo/data/pict/maiji/WANLC1${code}_RJTD_${ts}.PNG`;
const maijiPlaneUrl = (fl, ts) => `${JMA_DATA}/airinfo/data/pict/maiji/WANLF1${fl}_RJTD_${ts}.PNG`;

/* ---------- 時刻ユーティリティ ---------- */
const pad = (n) => String(n).padStart(2, "0");
// "YYYYMMDDHHmmss"(UTC) → Date
const parseTs = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
const fmtJst = (d) => {
  const j = new Date(d.getTime() + 9 * 3600e3);
  return `${pad(j.getUTCMonth() + 1)}/${pad(j.getUTCDate())} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())} JST`;
};
const fmtUtc = (d) => `${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
const fmtHttpDate = (s) => (s ? fmtJst(new Date(s)) : "");

/* ---------- 汎用UI ---------- */
function Seg({ options, value, onChange, color = GREEN, small }) {
  return (
    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button key={o.key} onClick={() => onChange(o.key)} title={o.title} style={{
            padding: small ? "3px 8px" : "5px 10px",
            background: active ? "rgba(110,231,183,0.14)" : "rgba(15,23,42,0.5)",
            border: `1px solid ${active ? color : "rgba(110,231,183,0.1)"}`,
            borderRadius: "2px",
            color: active ? color : "#64748b",
            fontSize: small ? "9px" : "10px", cursor: "pointer", fontFamily: MONO,
            letterSpacing: "0.5px", whiteSpace: "nowrap",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

const btnStyle = (on) => ({
  padding: "5px 10px", minWidth: "34px",
  background: on ? "rgba(110,231,183,0.18)" : "rgba(15,23,42,0.6)",
  border: `1px solid ${on ? GREEN : "rgba(110,231,183,0.15)"}`,
  borderRadius: "2px", color: on ? GREEN : "#94a3b8",
  fontSize: "11px", cursor: "pointer", fontFamily: MONO,
});

// コマ送りバー（◀ ▶・スライダー・再生）
function StepBar({ index, count, setIndex, label, sub, playing, setPlaying }) {
  if (count <= 0) return null;
  const go = (i) => setIndex(Math.max(0, Math.min(count - 1, i)));
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap",
      padding: "8px 12px", background: "rgba(0,0,0,0.45)",
      borderTop: "1px solid rgba(110,231,183,0.08)",
    }}>
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
        style={{ flex: "1 1 160px", accentColor: GREEN, minWidth: "120px" }}
      />
      <div style={{ fontFamily: MONO, minWidth: "150px", textAlign: "right" }}>
        <div style={{ color: GREEN, fontSize: "11px", fontWeight: 700 }}>{label}</div>
        {sub && <div style={{ color: "#475569", fontSize: "9px" }}>{sub}</div>}
      </div>
    </div>
  );
}

// 再生用フック：playing中は index を進め、最後で先頭に戻る
function usePlayer(count, playing, setIndex, ms = 600) {
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
        <span style={{ color: GREEN, fontSize: "11px" }}>{label}</span>
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
function ChartImg({ src, label, minHeight = 300, white = true }) {
  // 状態は src 単位で保持（キャッシュ済み画像で onLoad が先に発火しても取りこぼさない）
  const [loadedSrc, setLoadedSrc] = useState(null);
  const [errorSrc, setErrorSrc] = useState(null);
  const [zoom, setZoom] = useState(false);
  const state = src === loadedSrc ? "ok" : src === errorSrc ? "error" : "loading";
  const setState = (s) => (s === "ok" ? setLoadedSrc(src) : setErrorSrc(src));
  if (!src) return <Placeholder minHeight={minHeight} text="LOADING..." />;
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
          <span style={{ color: state === "error" ? "#f87171" : "#334155", fontSize: "11px", fontFamily: MONO, letterSpacing: "2px" }}>
            {state === "error" ? "NO DATA / 欠測" : "LOADING..."}
          </span>
        </div>
      )}
      {zoom && <Lightbox src={src} label={label} onClose={() => setZoom(false)} />}
    </div>
  );
}

function Placeholder({ minHeight = 300, text }) {
  return (
    <div style={{ minHeight, display: "flex", alignItems: "center", justifyContent: "center", background: "#050a14" }}>
      <span style={{ color: "#334155", fontSize: "11px", fontFamily: MONO, letterSpacing: "2px" }}>{text}</span>
    </div>
  );
}

function Toolbar({ children }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
      padding: "10px 12px", background: "rgba(0,0,0,0.4)",
      borderBottom: "1px solid rgba(110,231,183,0.08)",
    }}>{children}</div>
  );
}

function Caption({ children }) {
  return (
    <div style={{ padding: "8px 12px", color: "#64748b", fontSize: "10px", lineHeight: 1.6, fontFamily: MONO, background: "rgba(0,0,0,0.35)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
      {children}
    </div>
  );
}

function Links({ children }) {
  return (
    <div style={{ display: "flex", gap: "4px", padding: "8px 12px", flexWrap: "wrap", background: "rgba(0,0,0,0.4)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
      {children}
    </div>
  );
}

/* ============================================================
   PDF → 画像（AUPA25 / AXJP140 などはPDFのみ公開のため pdf.js で描画）
   ============================================================ */
const pdfCache = new Map(); // key: url|refresh → Promise<{src, modified}>

async function renderPdfToImage(url) {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const modified = res.headers.get("Last-Modified");
  const data = new Uint8Array(await res.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
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
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return { src: URL.createObjectURL(blob), modified };
  } finally {
    doc.destroy();
  }
}

function PdfChart({ url, label, refresh }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    setResult(null); setError(null);
    const key = `${url}|${refresh}`;
    if (!pdfCache.has(key)) pdfCache.set(key, renderPdfToImage(url));
    pdfCache.get(key)
      .then((r) => alive && setResult(r))
      .catch((e) => { pdfCache.delete(key); alive && setError(e.message); });
    return () => { alive = false; };
  }, [url, refresh]);
  if (error) return <Placeholder minHeight={360} text={`NO DATA / 欠測 (${error})`} />;
  if (!result) return <Placeholder minHeight={360} text="RENDERING PDF..." />;
  return (
    <>
      <ChartImg src={result.src} label={label} />
      <Caption>JMA 更新: {fmtHttpDate(result.modified) || "—"}　（PDFを画像化して表示）</Caption>
    </>
  );
}

/* ============================================================
   I. 天気図まとめ
   ============================================================ */
// 公開待ち時間(h)を考慮して既定の初期時刻(00/12)を選ぶ
const defaultInit = (lagH) => {
  const h = new Date().getUTCHours();
  if (h >= 12 + lagH) return "12";
  if (h >= lagH) return "00";
  return "12"; // まだ00Zが出ていない → 前日12Z
};

const CHARTS = [
  { key: "spas", label: "地上 実況", type: "wm", region: "near", kind: "now", desc: "地上天気図（日本付近・実況）。過去分をコマ送りできます。" },
  { key: "asas", label: "アジア 実況", type: "wm", region: "asia", kind: "now", desc: "アジア太平洋域の地上天気図（実況）。" },
  { key: "fsas24", label: "24h 予想", type: "wm", region: "near", kind: "ft24", desc: "24時間後の地上予想天気図。" },
  { key: "fsas48", label: "48h 予想", type: "wm", region: "near", kind: "ft48", desc: "48時間後の地上予想天気図。" },
  { key: "fbjp", label: "国内悪天 FBJP", type: "img", desc: "国内悪天予想図。乱気流・着氷・Cb域・ジェット軸・0℃高度。" },
  { key: "fbjp112", label: "FBJP 12h予想", type: "fbjp112", desc: "国内悪天12時間予想図（3時間毎の初期値）。" },
  { key: "aupa25", label: "250hPa 解析 AUPA25", type: "pdf", file: "aupa25", lag: 3, desc: "250hPa高層天気図（ジェット気流・等風速線）。" },
  { key: "fupa252", label: "250hPa 予想 FUPA252", type: "pdf", file: "fupa252", lag: 5, desc: "250hPa 風・気温の予想図。" },
  { key: "axjp140", label: "断面図 AXJP140", type: "pdf", file: "axjp140", lag: 3, desc: "140°E 沿いの高層断面解析（気温・風・圏界面）。" },
  { key: "fxjp854", label: "850hPa θe FXJP854", type: "pdf", file: "fxjp854", lag: 5, desc: "850hPa相当温位・風 / 700hPa鉛直流の予想図。" },
];

const extractWmTime = (fname) => {
  const m = fname?.match(/_(\d{14})_MET/);
  return m ? parseTs(m[1]) : null;
};

function ChartsSection({ refresh }) {
  const [chartKey, setChartKey] = useState("spas");
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState(false);
  const [wmIdx, setWmIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [init, setInit] = useState({});
  const [fbIdx, setFbIdx] = useState(7);

  const chart = CHARTS.find((c) => c.key === chartKey);

  useEffect(() => {
    let alive = true;
    setListErr(false);
    fetch(WM_LIST, { cache: "no-cache" })
      .then((r) => r.json())
      .then((d) => alive && setList(d))
      .catch(() => alive && setListErr(true));
    return () => { alive = false; };
  }, [refresh]);

  // 天気図ファイル一覧（古い順）
  const wmFiles = chart.type === "wm" ? (list?.[chart.region]?.[chart.kind] ?? []) : [];
  useEffect(() => { setWmIdx(Math.max(0, wmFiles.length - 1)); setPlaying(false); }, [chartKey, wmFiles.length]);
  usePlayer(wmFiles.length, playing, setWmIdx, 900);

  // FBJP112: 3時間毎の初期値（約2.5h後掲載）。直近8回分
  const fbBases = (() => {
    const h = new Date().getUTCHours();
    const latest = h >= 2 ? Math.floor((h - 2) / 3) * 3 : 21;
    return Array.from({ length: 8 }, (_, i) => (latest - (7 - i) * 3 + 24) % 24);
  })();
  const fbBase = fbBases[fbIdx];

  const pdfInit = chart.type === "pdf" ? (init[chart.key] ?? defaultInit(chart.lag)) : null;

  let body;
  if (chart.type === "wm") {
    const file = wmFiles[wmIdx];
    const t = extractWmTime(file);
    body = (
      <>
        {listErr ? <Placeholder text="天気図リストを取得できません" /> : <ChartImg src={file ? WM_PNG + file : null} label={`${chart.label} ${t ? fmtUtc(t) : ""}`} />}
        {wmFiles.length > 1 ? (
          <StepBar index={wmIdx} count={wmFiles.length} setIndex={setWmIdx} playing={playing} setPlaying={setPlaying}
            label={t ? fmtUtc(t) : "—"} sub={t ? fmtJst(t) : ""} />
        ) : t && <Caption>{chart.kind === "now" ? "解析" : "初期値"}: {fmtUtc(t)}（{fmtJst(t)}）</Caption>}
      </>
    );
  } else if (chart.type === "img") {
    body = <ChartImg src={FBJP_URL} label={chart.label} />;
  } else if (chart.type === "fbjp112") {
    body = (
      <>
        <ChartImg src={fbjp112Url(pad(fbBase))} label={`${chart.label} ${pad(fbBase)}Z`} />
        <StepBar index={fbIdx} count={fbBases.length} setIndex={setFbIdx}
          label={`初期値 ${pad(fbBase)}Z → ${pad((fbBase + 12) % 24)}Z`} sub="3時間毎・直近8回分" />
      </>
    );
  } else {
    body = <PdfChart url={`${NWP_PDF}${chart.file}_${pdfInit}.pdf`} label={`${chart.label} ${pdfInit}Z`} refresh={refresh} />;
  }

  return (
    <PanelFrame title="I. WEATHER CHARTS / 天気図" code="DOM-01" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={CHARTS.map((c) => ({ key: c.key, label: c.label }))} value={chartKey} onChange={setChartKey} />
        {chart.type === "pdf" && (
          <Seg small value={pdfInit} onChange={(v) => setInit((p) => ({ ...p, [chart.key]: v }))}
            options={[{ key: "00", label: "00Z 初期値" }, { key: "12", label: "12Z 初期値" }]} />
        )}
      </Toolbar>
      {body}
      <Caption>{chart.desc}</Caption>
      <Links>
        <ExtLink href={`${JMA}/bosai/weather_map/`} accent>気象庁 天気図</ExtLink>
        <ExtLink href={`${JMA}/bosai/numericmap/#type=upper`}>数値予報天気図</ExtLink>
        <ExtLink href={`${JMA_DATA}/airinfo/index.html`}>航空気象情報</ExtLink>
      </Links>
    </PanelFrame>
  );
}

/* ============================================================
   II. ひまわり コマ送り
   ============================================================ */
const HIMA_BANDS = [
  { key: "b13", label: "赤外 B13", desc: "雲頂温度。白いほど背が高く冷たい雲（Cb・上層雲）。昼夜問わず使用可。" },
  { key: "b03", label: "可視 B03", desc: "太陽光の反射。厚い雲ほど白い。霧・層雲の把握に有効。日中のみ。" },
  { key: "b08", label: "水蒸気 B08", desc: "上中層の水蒸気。暗域は乾燥（下降流）。ジェット・トラフ・乾燥貫入の把握に。" },
  { key: "b07", label: "短波赤外 B07", desc: "夜間の霧・下層雲の検出に有効。" },
  { key: "tre", label: "トゥルーカラー", desc: "人の目で見た色に近い再現画像。日中のみ。" },
  { key: "trm", label: "カラー (TRM)", desc: "トゥルーカラー再現画像（夜間は赤外で補完）。" },
  { key: "snd", label: "雲頂強調 (SND)", desc: "可視と赤外を合成し、対流雲の雲頂（発達中のCb）を強調。" },
];

const HIMA_HOURS = 11;

function HimawariSection({ refresh }) {
  const [band, setBand] = useState("b13");
  const [stepMin, setStepMin] = useState(30);
  const [latest, setLatest] = useState(null); // Date (UTC)
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(0);

  // 最新画像の時刻を探す（10分毎・最大90分遡り）
  useEffect(() => {
    let alive = true;
    setLatest(null);
    const base = new Date(Date.now() - 10 * 60e3);
    base.setUTCMinutes(Math.floor(base.getUTCMinutes() / 10) * 10, 0, 0);
    const tryAt = (n) => {
      if (n > 9) { alive && setLatest(base); return; }
      const d = new Date(base.getTime() - n * 10 * 60e3);
      const img = new Image();
      img.onload = () => alive && setLatest(d);
      img.onerror = () => tryAt(n + 1);
      img.src = himaUrl("b13", `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`);
    };
    tryAt(0);
    return () => { alive = false; };
  }, [refresh]);

  // フレーム（古い→新しい）
  const frameCount = Math.floor((HIMA_HOURS * 60) / stepMin) + 1;
  const frames = latest
    ? Array.from({ length: frameCount }, (_, i) =>
        new Date(latest.getTime() - (frameCount - 1 - i) * stepMin * 60e3))
    : [];
  const urls = frames.map((d) => himaUrl(band, `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`));
  const urlKey = urls.join(",");

  useEffect(() => { setIdx(Math.max(0, frames.length - 1)); }, [latest, stepMin]); // eslint-disable-line react-hooks/exhaustive-deps

  // 全フレームを先読み（アニメーションを滑らかに）
  useEffect(() => {
    let alive = true;
    setLoaded(0);
    urls.forEach((u) => {
      const img = new Image();
      img.onload = img.onerror = () => alive && setLoaded((n) => n + 1);
      img.src = u;
    });
    return () => { alive = false; };
  }, [urlKey]); // eslint-disable-line react-hooks/exhaustive-deps

  usePlayer(frames.length, playing, setIdx, 450);

  const cur = frames[idx];
  const bandInfo = HIMA_BANDS.find((b) => b.key === band);

  return (
    <PanelFrame title="II. HIMAWARI / ひまわり" code="DOM-02" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={HIMA_BANDS} value={band} onChange={setBand} />
        <Seg small value={String(stepMin)} onChange={(v) => setStepMin(+v)}
          options={[{ key: "10", label: "10分毎" }, { key: "30", label: "30分毎" }, { key: "60", label: "1時間毎" }]} />
      </Toolbar>
      {cur ? (
        <div style={{ position: "relative" }}>
          <ChartImg src={urls[idx]} label={`HIMAWARI ${bandInfo.label} ${fmtUtc(cur)}`} white={false} minHeight={420} />
          <div style={{
            position: "absolute", top: "8px", right: "10px", pointerEvents: "none",
            background: "rgba(0,0,0,0.7)", padding: "3px 8px", borderRadius: "2px",
            color: GREEN, fontSize: "10px", fontFamily: MONO,
          }}>{fmtJst(cur)}</div>
        </div>
      ) : <Placeholder minHeight={420} text="SEARCHING LATEST IMAGE..." />}
      <StepBar index={idx} count={frames.length} setIndex={setIdx} playing={playing} setPlaying={setPlaying}
        label={cur ? fmtUtc(cur) : "—"}
        sub={`過去${HIMA_HOURS}時間 · 先読み ${Math.min(loaded, frames.length)}/${frames.length}`} />
      <Caption>{bandInfo.desc}</Caption>
      <Links>
        <ExtLink href={`${JMA}/bosai/himawari/`} accent>気象庁 ひまわりビューア</ExtLink>
        <ExtLink href={`${JMA_DATA}/mscweb/data/himawari/sat_img.php?area=jpn`}>気象衛星センター</ExtLink>
      </Links>
    </PanelFrame>
  );
}

/* ============================================================
   VI/VII. レーダー・雷 ナウキャスト（気象庁タイルを地図に重ねる）
   ============================================================ */
const REGIONS = [
  { key: "honshu", label: "本州域", w: 128, e: 146, n: 46, s: 30, z: 6 },
  { key: "south", label: "南日本域", w: 122, e: 134, n: 34, s: 23.5, z: 6 },
  { key: "north", label: "北日本域", w: 137, e: 147, n: 46, s: 37.5, z: 7 },
];

const lon2px = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const lat2px = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z;
};

// layers: [{ id, url:(z,x,y)=>string, opacity?, hideMissing? }]（下から順に重ねる）
function TileMap({ region, layers, zoom, bg = "#cfd8dc" }) {
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
    </div>
  );
}

// データの無いタイルは404になるので非表示にする
function OverlayTile({ src, style }) {
  const [badSrc, setBadSrc] = useState(null);
  return <img src={src} alt="" style={{ ...style, visibility: src === badSrc ? "hidden" : "visible" }} onError={() => setBadSrc(src)} draggable={false} />;
}

const RADAR_LEGEND = [
  ["#F2F2FF", "<1"], ["#A0D2FF", "1"], ["#218CFF", "5"], ["#0041FF", "10"],
  ["#FAF500", "20"], ["#FF9900", "30"], ["#FF2800", "50"], ["#B40068", "80"],
];
const THUNDER_LEGEND = [
  ["#F7F55A", "1 雷可能性"], ["#FFAA00", "2 雷あり"], ["#FF2800", "3 やや激しい"], ["#C800FF", "4 激しい"],
];

function buildNowcFrames(mode, n1, n2, n3) {
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

function NowcastSection({ mode, refresh }) {
  const [regionKey, setRegionKey] = useState("honshu");
  const [lists, setLists] = useState(null);
  const [err, setErr] = useState(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr(false);
    const get = (n) => fetch(`${NOWC}/targetTimes_${n}.json`, { cache: "no-cache" }).then((r) => r.json());
    Promise.all([get("N1"), get("N2"), get("N3")])
      .then(([n1, n2, n3]) => alive && setLists({ n1, n2, n3 }))
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [refresh]);

  const built = lists ? buildNowcFrames(mode, lists.n1, lists.n2, lists.n3) : { frames: [], latestPastIdx: 0 };
  const { frames, element, latestPastIdx } = built;
  useEffect(() => { setIdx(Math.max(0, latestPastIdx)); setPlaying(false); }, [lists, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  usePlayer(frames.length, playing, setIdx, 700);

  const f = frames[idx];
  const region = REGIONS.find((r) => r.key === regionKey);
  const overlay = f ? (z, x, y) => `${NOWC}/${f.basetime}/none/${f.validtime}/surf/${element}/${z}/${x}/${y}.png` : null;
  const vt = f ? parseTs(f.validtime) : null;
  const leadMin = f && f.fc ? Math.round((parseTs(f.validtime) - parseTs(f.basetime)) / 60e3) : 0;
  const isRadar = mode === "radar";
  const legend = isRadar ? RADAR_LEGEND : THUNDER_LEGEND;

  // 次のフレームを先読み
  useEffect(() => {
    const nf = frames[idx + 1];
    if (!nf) return;
    const { w, e, n, s, z } = region;
    for (let tx = Math.floor(lon2px(w, z) / 256); tx <= Math.floor(lon2px(e, z) / 256); tx++) {
      for (let ty = Math.floor(lat2px(n, z) / 256); ty <= Math.floor(lat2px(s, z) / 256); ty++) {
        new Image().src = `${NOWC}/${nf.basetime}/none/${nf.validtime}/surf/${element}/${z}/${tx}/${ty}.png`;
      }
    }
  }, [idx, frames.length, regionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PanelFrame
      title={isRadar ? "VI. RADAR NOWCAST / レーダー" : "VII. THUNDER NOWCAST / 雷"}
      code={isRadar ? "DOM-06" : "DOM-07"} style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={REGIONS} value={regionKey} onChange={setRegionKey} />
        {f && (
          <span style={{
            padding: "3px 8px", borderRadius: "2px", fontSize: "10px", fontFamily: MONO,
            color: f.fc ? "#f59e0b" : GREEN,
            border: `1px solid ${f.fc ? "rgba(245,158,11,0.5)" : "rgba(110,231,183,0.4)"}`,
          }}>{f.fc ? `予想 +${leadMin}分` : "実況"}</span>
        )}
      </Toolbar>
      {err ? <Placeholder minHeight={360} text="ナウキャスト時刻リストを取得できません" />
        : <TileMap region={region} layers={[
          { id: "base", url: BASEMAP },
          overlay && { id: "nowc", url: overlay, opacity: 0.85 },
        ]} />}
      <StepBar index={idx} count={frames.length} setIndex={setIdx} playing={playing} setPlaying={setPlaying}
        label={vt ? fmtJst(vt) : "—"} sub={vt ? `${fmtUtc(vt)} · ${f.fc ? "予想" : "実況"}` : ""} />
      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", padding: "8px 12px", background: "rgba(0,0,0,0.45)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
        <span style={{ color: "#475569", fontSize: "9px", fontFamily: MONO, marginRight: "6px" }}>
          {isRadar ? "降水強度 mm/h" : "雷活動度"}
        </span>
        {legend.map(([c, t]) => (
          <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginRight: "6px" }}>
            <span style={{ width: "18px", height: "10px", background: c, borderRadius: "1px", display: "inline-block" }} />
            <span style={{ color: "#64748b", fontSize: "9px", fontFamily: MONO }}>{t}</span>
          </span>
        ))}
      </div>
      <Caption>
        {isRadar
          ? "高解像度降水ナウキャスト。直近60分の実況（10分毎）と60分先までの予想。"
          : "雷ナウキャスト（活動度）。直近60分の実況と60分先までの予想。雷の無い時間帯は地図のみ表示されます。"}
      </Caption>
      <Links>
        <ExtLink href={`${JMA}/bosai/nowc/#zoom:6/lat:36/lon:137/colordepth:normal/elements:${isRadar ? "hrpns&liden" : "thns&liden"}`} accent>
          気象庁 ナウキャスト
        </ExtLink>
        <ExtLink href={`${JMA}/bosai/amedas/`}>アメダス</ExtLink>
      </Links>
    </PanelFrame>
  );
}

/* ============================================================
   V. 悪天監視
   積乱雲情報（気象衛星センター）/ SIGMET図 / 国内航空路予想断面図 / 全国航空気象解説報
   ============================================================ */
const SATPROD = `${JMA_DATA}/tile/satprod`;
const CCI_TIMES = `${SATPROD}/targetTimes_cbi_jp.json`;
const COASTLINE = (z, x, y) => `${JMA_DATA}/omaad/const/COASTLINE/${z}/${x}/${y}.png`;
const sigmetUrl = (code) => `${JMA_DATA}/airinfo/data/pict/sigmet/${code}.png`;
const fxjp106Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fxjp106_${hh}.png`;
const cmntUrl = (code) => `${JMA_DATA}/airinfo/data/pict/ajpn_cmnt/${code}.png`;

const SIGMET_AREAS = [
  { key: "QGMA98", label: "福岡FIR 全体" },
  { key: "QGOA98", label: "本州付近" },
  { key: "QGPA98", label: "南西諸島" },
];
const CMNT_AREAS = [
  { key: "qyya82", label: "国内空域" },
  { key: "qyya83", label: "福岡FIR" },
];
const CCI_LEGEND = [
  ["rgba(255,0,0,0.75)", "積乱雲域"],
  ["rgba(0,255,0,0.75)", "積雲急発達域"],
  ["rgba(0,128,128,0.75)", "中下層雲不明域"],
];
const SEVERE_VIEWS = [
  { key: "cci", label: "積乱雲情報" },
  { key: "sigmet", label: "SIGMET" },
  { key: "fxjp106", label: "航空路予想断面 FXJP106" },
  { key: "cmnt", label: "航空気象解説報" },
];

// FXJP106: 3時間毎の初期値、約2時間15分後に掲載
const fxjp106Bases = () => {
  const now = new Date(Date.now() - 135 * 60e3);
  const latest = Math.floor(now.getUTCHours() / 3) * 3;
  return Array.from({ length: 8 }, (_, i) => (latest - (7 - i) * 3 + 24) % 24);
};

function CciView({ refresh }) {
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
        : <Placeholder minHeight={360} text="LOADING..." />}
      <StepBar index={idx} count={times.length} setIndex={setIdx} playing={playing} setPlaying={setPlaying}
        label={d ? fmtJst(d) : "—"} sub={d ? `${fmtUtc(d)} · 実況（10分毎・過去3時間）` : ""} />
      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", padding: "8px 12px", background: "rgba(0,0,0,0.45)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
        {CCI_LEGEND.map(([c, label]) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginRight: "10px" }}>
            <span style={{ width: "18px", height: "10px", background: c, border: "1px solid #000", display: "inline-block" }} />
            <span style={{ color: "#94a3b8", fontSize: "9px", fontFamily: MONO }}>{label}</span>
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

function SevereSection({ refresh }) {
  const [view, setView] = useState("cci");
  const [sigmet, setSigmet] = useState("QGMA98");
  const [cmnt, setCmnt] = useState("qyya82");
  const bases = fxjp106Bases();
  const [fxIdx, setFxIdx] = useState(bases.length - 1);
  const fxBase = bases[fxIdx];

  return (
    <PanelFrame title="V. SEVERE WX MONITOR / 悪天監視" code="DOM-05" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={SEVERE_VIEWS} value={view} onChange={setView} color="#f59e0b" />
      </Toolbar>

      {view === "cci" && <CciView refresh={refresh} />}

      {view === "sigmet" && (
        <>
          <Toolbar><Seg options={SIGMET_AREAS} value={sigmet} onChange={setSigmet} /></Toolbar>
          <ChartImg src={sigmetUrl(sigmet)} label={`SIGMET ${SIGMET_AREAS.find((a) => a.key === sigmet).label}`} minHeight={420} />
          <Caption>福岡FIRで有効なSIGMET（乱気流・着氷・積乱雲・火山灰など）の領域図。文字情報は METAR/TAF タブ等で確認してください。</Caption>
          <Links>
            <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_sigmet.html`} accent>気象庁 SIGMET</ExtLink>
          </Links>
        </>
      )}

      {view === "fxjp106" && (
        <>
          <ChartImg src={fxjp106Url(pad(fxBase))} label={`FXJP106 ${pad(fxBase)}Z`} minHeight={420} />
          <StepBar index={fxIdx} count={bases.length} setIndex={setFxIdx}
            label={`初期値 ${pad(fxBase)}Z`} sub="3時間毎・直近8回分" />
          <Caption>国内主要航空路に沿った6・12時間予想断面図（風・気温・湿数・乱気流の目安となる鉛直シアなど）。</Caption>
          <Links>
            <ExtLink href={`${JMA_DATA}/airinfo/awfo_fxjp106/awfo_fxjp106.html`} accent>気象庁 国内航空路予想断面図</ExtLink>
          </Links>
        </>
      )}

      {view === "cmnt" && (
        <>
          <Toolbar><Seg options={CMNT_AREAS} value={cmnt} onChange={setCmnt} /></Toolbar>
          <ChartImg src={cmntUrl(cmnt)} label={`全国航空気象解説報 ${CMNT_AREAS.find((a) => a.key === cmnt).label}`} minHeight={420} />
          <Caption>予報官による悪天の解説図（注目すべき悪天域とその見通し）。</Caption>
          <Links>
            <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_ajpn_cmnt_airspace.html`} accent>解説報（国内空域）</ExtLink>
            <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_ajpn_cmnt_fukuokafir.html`}>解説報（福岡FIR）</ExtLink>
            <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_ajpn_cmnt_aerodrome.html`}>解説報（飛行場）</ExtLink>
          </Links>
        </>
      )}
    </PanelFrame>
  );
}

/* ============================================================
   VIII. 低高度悪天予想図
   ============================================================ */
const LL_AREAS = [
  { key: "fbsp", label: "北海道" }, { key: "fbsn", label: "東北" }, { key: "fbtk", label: "東日本" },
  { key: "fbos", label: "西日本" }, { key: "fbkg", label: "奄美" }, { key: "fbok", label: "沖縄" },
];
const LL_FTS = [
  { key: "03", label: "FT03" }, { key: "06", label: "FT06" }, { key: "09", label: "FT09" }, { key: "39", label: "時系列" },
];

function LowLevelSection() {
  const [area, setArea] = useState("fbtk");
  const [ft, setFt] = useState("03");
  const areaLabel = LL_AREAS.find((a) => a.key === area).label;
  return (
    <PanelFrame title="VIII. LOW-LEVEL SIGWX / 低高度悪天" code="DOM-08" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={LL_AREAS} value={area} onChange={setArea} />
        <Seg options={LL_FTS} value={ft} onChange={setFt} color="#f59e0b" />
      </Toolbar>
      <ChartImg src={lowLevelUrl(area, ft)} label={`低高度悪天予想図 ${areaLabel} ${ft === "39" ? "時系列" : "FT" + ft}`} minHeight={420} />
      <Caption>低高度悪天予想図（地上〜FL150）。雲底・視程・乱気流・着氷・Cb域などを3/6/9時間先まで予想。</Caption>
      <Links>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_low-level_sigwx.html`} accent>低高度悪天予想図</ExtLink>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_low-level_detailed-sigwx.html`}>詳細版（府県別）</ExtLink>
      </Links>
    </PanelFrame>
  );
}

/* ============================================================
   III/IV. 毎時大気解析（断面図・平面図）
   ============================================================ */
const CROSS_OPTS = [
  ...["145.0", "142.5", "140.0", "137.5", "135.0", "132.5", "130.0", "127.5", "125.0", "122.5"]
    .map((lon, i) => ({ key: String(50 + i), label: `E${lon}°` })),
  { key: "99", label: "与那国-稚内" }, { key: "01", label: "福岡-釧路" }, { key: "02", label: "福岡-紋別" },
  { key: "03", label: "東京-稚内" }, { key: "04", label: "東京-女満別" }, { key: "05", label: "福岡-東京" },
  { key: "06", label: "鹿児島-東京" }, { key: "07", label: "石垣-東京" }, { key: "08", label: "与那国-高松" },
  { key: "09", label: "与那国-福岡" },
];
const PLANE_OPTS = ["45", "43", "41", "39", "37", "35", "33", "31", "29", "27", "25", "23", "21", "19", "17", "15", "13", "11", "09", "07", "05"]
  .map((fl) => ({ key: fl, label: `FL${fl}0` }));

async function fetchMaijiTimes() {
  const text = await fetch(MAIJI_LIST, { cache: "no-cache" }).then((r) => r.text());
  return [...text.matchAll(/"(\d{14})"/g)].map((m) => m[1]); // 新しい順
}

function MaijiSection({ refresh }) {
  const [mode, setMode] = useState("cross");
  const [cross, setCross] = useState("52");
  const [plane, setPlane] = useState("35");
  const [times, setTimes] = useState([]);
  const [err, setErr] = useState(false);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    setErr(false);
    fetchMaijiTimes()
      .then((t) => { if (alive) { setTimes([...t].reverse()); setIdx(Math.max(0, t.length - 1)); } })
      .catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [refresh]);
  usePlayer(times.length, playing, setIdx, 800);

  const ts = times[idx];
  const d = ts ? parseTs(ts) : null;
  const opts = mode === "cross" ? CROSS_OPTS : PLANE_OPTS;
  const sel = mode === "cross" ? cross : plane;
  const setSel = mode === "cross" ? setCross : setPlane;
  const label = opts.find((o) => o.key === sel)?.label;
  const src = ts ? (mode === "cross" ? maijiCrossUrl(sel, ts) : maijiPlaneUrl(sel, ts)) : null;

  return (
    <PanelFrame title="III/IV. HOURLY ANALYSIS / 毎時大気解析" code="DOM-03" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={[{ key: "cross", label: "断面図" }, { key: "plane", label: "平面図" }]} value={mode} onChange={setMode} color="#f59e0b" />
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{
          background: "#0b1220", color: GREEN, border: "1px solid rgba(110,231,183,0.3)",
          borderRadius: "2px", padding: "5px 8px", fontFamily: MONO, fontSize: "11px",
        }}>
          {opts.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <span style={{ display: "flex", gap: "4px" }}>
          <button style={btnStyle(false)} onClick={() => { const i = opts.findIndex((o) => o.key === sel); setSel(opts[Math.max(0, i - 1)].key); }}>
            {mode === "cross" ? "◀ 東" : "▲ 上"}
          </button>
          <button style={btnStyle(false)} onClick={() => { const i = opts.findIndex((o) => o.key === sel); setSel(opts[Math.min(opts.length - 1, i + 1)].key); }}>
            {mode === "cross" ? "西 ▶" : "▼ 下"}
          </button>
        </span>
      </Toolbar>
      {err ? <Placeholder minHeight={360} text="解析時刻リストを取得できません" />
        : <ChartImg src={src} label={`毎時大気解析 ${mode === "cross" ? "断面図" : "平面図"} ${label} ${d ? fmtUtc(d) : ""}`} minHeight={420} />}
      <StepBar index={idx} count={times.length} setIndex={setIdx} playing={playing} setPlaying={setPlaying}
        label={d ? fmtUtc(d) : "—"} sub={d ? fmtJst(d) : ""} />
      <Caption>
        {mode === "cross"
          ? "経度線・主要航空路に沿った鉛直断面（気温・風・湿数・圏界面など）。東経145°〜122.5°を2.5°毎に切替。"
          : "指定FLの平面解析（風・気温・鉛直シア）。FL050〜FL450を切替。"}
      </Caption>
      <Links>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_maiji.html`} accent>気象庁 毎時大気解析</ExtLink>
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
        <span style={{ color: "#f59e0b", fontSize: "10px", fontWeight: 600, letterSpacing: "2px", fontFamily: MONO, marginRight: "4px" }}>
          JMA {isFcst ? "時系列予報" : "時系列情報"}
        </span>
        {views.map((v) => {
          const on = v.key === view;
          const c = v.alert ? "#f87171" : "#f59e0b";
          return (
            <button key={v.key} onClick={() => setView(on ? null : v.key)} style={{
              padding: "3px 10px", borderRadius: "3px", cursor: "pointer", fontFamily: MONO, fontSize: "10px",
              background: on ? (v.alert ? "rgba(248,113,113,0.15)" : "rgba(245,158,11,0.15)") : "transparent",
              border: `1px solid ${on || v.alert ? c : "rgba(148,163,184,0.2)"}`,
              color: on || v.alert ? c : "#94a3b8",
            }}>{v.label}</button>
          );
        })}
        <span style={{ color: "#475569", fontSize: "9px", fontFamily: MONO }}>
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
   オフライン用まとめ取得（Service Worker の PREFLIGHT_CACHE を利用）
   ============================================================ */
async function collectOfflineUrls() {
  const urls = [FBJP_URL];
  const h = new Date().getUTCHours();
  const fbLatest = h >= 2 ? Math.floor((h - 2) / 3) * 3 : 21;
  urls.push(fbjp112Url(pad(fbLatest)));
  for (const c of CHARTS.filter((c) => c.type === "pdf")) urls.push(`${NWP_PDF}${c.file}_${defaultInit(c.lag)}.pdf`);
  try {
    const list = await fetch(WM_LIST, { cache: "no-cache" }).then((r) => r.json());
    const pick = [list.near?.now?.slice(-1)[0], list.asia?.now?.slice(-1)[0], list.near?.ft24?.[0], list.near?.ft48?.[0]];
    pick.filter(Boolean).forEach((f) => urls.push(WM_PNG + f));
  } catch { /* skip */ }
  // ひまわり B13 過去11時間（1時間毎）
  const base = new Date(Date.now() - 30 * 60e3);
  base.setUTCMinutes(Math.floor(base.getUTCMinutes() / 10) * 10, 0, 0);
  for (let i = 0; i <= HIMA_HOURS; i++) {
    const d = new Date(base.getTime() - i * 3600e3);
    urls.push(himaUrl("b13", `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`));
  }
  // 悪天監視: SIGMET図・解説報・FXJP106最新
  SIGMET_AREAS.forEach((a) => urls.push(sigmetUrl(a.key)));
  CMNT_AREAS.forEach((a) => urls.push(cmntUrl(a.key)));
  urls.push(fxjp106Url(pad(fxjp106Bases().slice(-1)[0])));
  // 低高度悪天 全地域×全FT
  for (const a of LL_AREAS) for (const f of LL_FTS) urls.push(lowLevelUrl(a.key, f.key));
  // 毎時大気解析 最新の全断面・全FL
  try {
    const [ts] = await fetchMaijiTimes();
    if (ts) {
      CROSS_OPTS.forEach((o) => urls.push(maijiCrossUrl(o.key, ts)));
      PLANE_OPTS.forEach((o) => urls.push(maijiPlaneUrl(o.key, ts)));
    }
  } catch { /* skip */ }
  return urls;
}

/* ============================================================
   メインパネル
   ============================================================ */
const SECTIONS = [
  { key: "charts", label: "天気図", icon: "🗺️" },
  { key: "himawari", label: "ひまわり", icon: "🛰️" },
  { key: "maiji", label: "断面・平面", icon: "📐" },
  { key: "severe", label: "悪天監視", icon: "⛈️" },
  { key: "radar", label: "レーダー", icon: "🌧️" },
  { key: "thunder", label: "雷", icon: "⚡" },
  { key: "lowlevel", label: "低高度", icon: "🛩️" },
];
const SECTION_STORE = "domwx_section";

export default function DomesticWxPanel() {
  const [section, setSectionState] = useState(() => {
    try { return localStorage.getItem(SECTION_STORE) || "charts"; } catch { return "charts"; }
  });
  const setSection = (k) => {
    setSectionState(k);
    try { localStorage.setItem(SECTION_STORE, k); } catch { /* ignore */ }
  };
  const [refresh, setRefresh] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const [cacheMsg, setCacheMsg] = useState("");
  const busy = useRef(false);

  const doRefresh = () => { setRefresh((r) => r + 1); setUpdatedAt(new Date()); };

  // 5分毎に自動更新
  useEffect(() => {
    const id = setInterval(doRefresh, 5 * 60e3);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type === "PREFLIGHT_CACHE_DONE") {
        busy.current = false;
        setCacheMsg(`保存完了 ${e.data.cached}/${e.data.total}${e.data.failed ? `（失敗 ${e.data.failed}）` : ""}`);
      }
    };
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, []);

  const doOfflineCache = useCallback(async () => {
    if (busy.current) return;
    const ctrl = navigator.serviceWorker?.controller;
    if (!ctrl) { setCacheMsg("Service Worker 未起動（本番環境で利用できます）"); return; }
    busy.current = true;
    setCacheMsg("取得中…");
    const urls = await collectOfflineUrls();
    setCacheMsg(`取得中… (${urls.length}件)`);
    ctrl.postMessage({ type: "PREFLIGHT_CACHE", urls });
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* サブナビ */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap",
        padding: "8px 10px", background: "rgba(5,10,20,0.7)", border: "1px solid rgba(110,231,183,0.12)", borderRadius: "4px",
      }}>
        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {SECTIONS.map((s) => {
            const on = s.key === section;
            return (
              <button key={s.key} onClick={() => setSection(s.key)} style={{
                padding: "7px 12px", cursor: "pointer", fontFamily: MONO, fontSize: "11px",
                background: on ? "rgba(110,231,183,0.14)" : "transparent",
                border: `1px solid ${on ? GREEN : "rgba(110,231,183,0.08)"}`, borderRadius: "2px",
                color: on ? GREEN : "#64748b", fontWeight: on ? 700 : 500,
              }}>{s.icon} {s.label}</button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ color: "#475569", fontSize: "9px", fontFamily: MONO }}>更新 {fmtJst(updatedAt)}</span>
          <button onClick={doRefresh} style={btnStyle(false)}>⟳ 最新に更新</button>
          <button onClick={doOfflineCache} style={btnStyle(false)} title="主要な図をまとめて端末に保存（機内などオフラインで閲覧）">⬇ オフライン保存</button>
          {cacheMsg && <span style={{ color: "#f59e0b", fontSize: "9px", fontFamily: MONO }}>{cacheMsg}</span>}
        </div>
      </div>

      {section === "charts" && <ChartsSection refresh={refresh} />}
      {section === "himawari" && <HimawariSection refresh={refresh} />}
      {section === "maiji" && <MaijiSection refresh={refresh} />}
      {section === "severe" && <SevereSection refresh={refresh} />}
      {section === "radar" && <NowcastSection key="radar" mode="radar" refresh={refresh} />}
      {section === "thunder" && <NowcastSection key="thunder" mode="thunder" refresh={refresh} />}
      {section === "lowlevel" && <LowLevelSection />}

      <div style={{ color: "#334155", fontSize: "9px", fontFamily: MONO, textAlign: "right" }}>
        出典: 気象庁（天気図・数値予報天気図・航空気象情報・気象衛星センター・ナウキャスト）／ 地図: 国土地理院
      </div>
    </div>
  );
}
