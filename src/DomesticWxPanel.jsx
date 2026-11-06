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
   エマグラム（気象庁ラジオゾンデ観測 / University of Wyoming 経由）
   ============================================================ */
const WORKER_URL = import.meta.env.VITE_WORKER_URL || "https://wx-awc-proxy.trinity-funkyboy.workers.dev";
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
  const cell = { padding: "3px 8px", textAlign: "right", fontFamily: MONO, fontSize: "11px", color: "#cbd5e1", borderBottom: "1px solid rgba(148,163,184,0.08)" };

  return (
    <PanelFrame title="EMAGRAM / エマグラム（高層観測）" code="DOM-04" style={{ padding: 0 }}>
      <Toolbar>
        <Seg options={SONDE_STATIONS.map((s) => ({ key: s.id, label: s.name }))} value={station} onChange={setStation} small />
      </Toolbar>
      {state.status === "ok" ? <Emagram rows={rows} idx={ind} />
        : <Placeholder minHeight={420} text={state.status === "error" ? state.msg : "LOADING SOUNDING..."} />}
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
              <div style={{ color: "#475569", fontSize: "9px", fontFamily: MONO }}>{k}</div>
              <div style={{ color: c, fontSize: "12px", fontFamily: MONO, fontWeight: 700, marginTop: "2px" }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      {rows && (
        <div style={{ overflowX: "auto", background: "rgba(0,0,0,0.35)", borderTop: "1px solid rgba(110,231,183,0.06)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "460px" }}>
            <thead>
              <tr>{["気圧", "高度", "気温", "露点", "湿数", "風"].map((h) => <th key={h} style={{ ...cell, color: "#64748b", fontWeight: 500 }}>{h}</th>)}</tr>
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
  { key: "emagram", label: "エマグラム", icon: "🎈" },
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
      {section === "emagram" && <EmagramSection refresh={refresh} />}
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
