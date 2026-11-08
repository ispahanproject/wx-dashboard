/* ============================================================
   図の一覧（カード）と全画面ビューア
   WX CHARTS（地上・上空）、SIG WX の国内悪天予想図、ENROUTE の断面図で共用。
   タップで全画面（←→キー／左右スワイプで次の図、夜間用の減光）。データは気象庁の公開ソース
   ============================================================ */
import { useState, useEffect, useRef, useCallback } from "react";
import { PanelFrame, ExtLink, Segmented, actionBtnStyle } from "./ui.jsx";
import { C, FS } from "./theme.js";
import { getPdfImage, defaultInit } from "./DomesticWxPanel.jsx";

const JMA = "https://www.jma.go.jp";
const JMA_DATA = "https://www.data.jma.go.jp";
const WM_LIST = `${JMA}/bosai/weather_map/data/list.json`;
const WM_PNG = `${JMA}/bosai/weather_map/data/png/`;
const NWP_PDF = `${JMA}/bosai/numericmap/data/nwpmap/`;
const FBJP_URL = `${JMA_DATA}/airinfo/data/pict/fbjp/fbjp.png`;
const fbjp112Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fbjp112_${hh}.png`;
const fxjp106Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fxjp106_${hh}.png`;
const DIM_KEY = "wxcharts_dim"; // 減光の設定は図を出すすべての画面で共有
const FILTER_KEY = "wxcharts_filter";
const PDF_LAG_H = 4; // 数値予報天気図の PDF は初期時刻の約3.6時間後に公開
const CYCLE_LAG_MIN = 140; // FBJP112・FXJP106：3時間毎の初期値、約2時間14分後に掲載
const AUTO_REFRESH_MS = 10 * 60e3;
export const DIM_FILTER = "brightness(0.68) contrast(1.05)";

const pad = (n) => String(n).padStart(2, "0");
const parseTs = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
const fmtZ = (d) => `${pad(d.getUTCDate())}日 ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
const ago = (d, nowMs) => {
  const m = Math.max(0, Math.round((nowMs - d.getTime()) / 60000));
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}前`;
  return `${Math.floor(m / 1440)}日前`;
};
// 取得した PDF（_00 / _12）の初期時刻：更新時刻より前で、いちばん近いその時刻
// （図によって掲載までの時間が違う：AXJP は約2時間、AUPQ などは約3.6時間）
const initFromModified = (modified, initHH) => {
  const t = new Date(modified.getTime());
  t.setUTCHours(+initHH, 0, 0, 0);
  if (t > modified) t.setUTCDate(t.getUTCDate() - 1);
  return t;
};
// 3時間毎の初期値の図：掲載までの時間を引いた時刻から、最新の初期時刻を選ぶ
const cycleBaseDate = (stepsBack = 0) => {
  const d = new Date(Date.now() - CYCLE_LAG_MIN * 60e3);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3 - stepsBack * 3);
  return d;
};
// 解析図は「解析」、予想図は「初期値 → 予想時刻」（予想時間が複数なら一覧）
const runLabel = (c, base) => {
  if (!c.ft) return `解析 ${fmtZ(base)}`;
  if (c.ft.length === 1) return `初期値 ${fmtZ(base)} → 予想 ${fmtZ(new Date(base.getTime() + c.ft[0] * 3600e3))}`;
  return `初期値 ${fmtZ(base)}（${c.ft.join("・")}時間予想）`;
};
export const loadPref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
export const savePref = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };

// 図の減光（夜間用）。図を出す画面どうしで設定を共有する
export function useDimPref() {
  const [dim, setDimState] = useState(() => loadPref(DIM_KEY, false) === true);
  const setDim = useCallback((v) => { setDimState(v); savePref(DIM_KEY, v); }, []);
  return [dim, setDim];
}

/* ---------- 図の定義 ----------
   kind: wm＝気象庁の天気図一覧（list.json）、png＝固定URLの画像、
         cycle3h＝3時間毎の初期値の画像（urlFor）、pdf＝数値予報天気図の PDF（画像化して表示）
   ft: 予想時間（無ければ解析図）、aspect: カードの縦横比 */
const WX_CATS = [
  { key: "all", label: "すべて" },
  { key: "sfc", label: "地上" },
  { key: "upper", label: "上空" },
];

const WX_CHARTS = [
  { key: "spas", cat: "sfc", title: "地上 実況", code: "SPAS", kind: "wm", region: "near", sel: "now" },
  { key: "fsas24", cat: "sfc", title: "24時間 予想", code: "FSAS24", kind: "wm", region: "near", sel: "ft24" },
  { key: "fsas48", cat: "sfc", title: "48時間 予想", code: "FSAS48", kind: "wm", region: "near", sel: "ft48" },
  { key: "asas", cat: "sfc", title: "アジア 実況", code: "ASAS", kind: "wm", region: "asia", sel: "now" },
  { key: "aupq78", cat: "upper", title: "500/300hPa 解析", code: "AUPQ78", kind: "pdf", file: "aupq78" },
  { key: "aupq35", cat: "upper", title: "850/700hPa 解析", code: "AUPQ35", kind: "pdf", file: "aupq35" },
  { key: "aupa25", cat: "upper", title: "250hPa 解析", code: "AUPA25", kind: "pdf", file: "aupa25" },
  { key: "fupa252", cat: "upper", title: "250hPa 24時間予想", code: "FUPA252", kind: "pdf", file: "fupa252", ft: [24] },
  { key: "fxjp854", cat: "upper", title: "850hPa 相当温位 予想", code: "FXJP854", kind: "pdf", file: "fxjp854", ft: [12, 24, 36, 48] },
];

const WX_LINKS = [
  { title: "天気図", links: [
    { label: "気象庁 天気図", href: `${JMA}/bosai/weather_map/` },
    { label: "数値予報天気図一覧", href: `${JMA}/bosai/numericmap/` },
  ]},
  { title: "上空・風", links: [
    { label: "ウィンドプロファイラ", href: `${JMA}/bosai/windprofiler/` },
    { label: "Windy 250hPa 風", href: "https://www.windy.com/-Wind-250hPa-wind250h?wind250h,36,137,5" },
    { label: "Windy 850hPa 気温", href: "https://www.windy.com/-Temperature-temp?temp,36,137,5" },
  ]},
];

// SIG WX：国内悪天予想図
const PROG_CHARTS = [
  { key: "fbjp", title: "国内悪天予想図", code: "FBJP", kind: "png", url: FBJP_URL },
  { key: "fbjp112", title: "国内悪天 12時間予想", code: "FBJP112", kind: "cycle3h", urlFor: fbjp112Url, ft: [12] },
];
const PROG_LINKS = [
  { title: "悪天", links: [
    { label: "FBJP 12時間予想（全初期値）", href: `${JMA_DATA}/airinfo/awfo_fbjp112/awfo_fbjp112.html` },
    { label: "AWC SIGWX", href: "https://aviationweather.gov/gfa/#area=other" },
    { label: "AWC 乱気流", href: "https://aviationweather.gov/gfa/#obs=turb" },
    { label: "AWC 着氷", href: "https://aviationweather.gov/gfa/#obs=ice" },
  ]},
  { title: "火山灰", links: [
    { label: "東京 VAAC", href: "https://ds.data.jma.go.jp/svd/vaac/data/" },
    { label: "降灰予報", href: `${JMA}/bosai/ashfall/` },
  ]},
];

// ENROUTE：断面図（縦長の図）
const XSEC_CHARTS = [
  { key: "fxjp106", title: "航空路 予想断面図", code: "FXJP106", kind: "cycle3h", urlFor: fxjp106Url, ft: [6, 12], aspect: "4 / 5" },
  { key: "axjp140", title: "高層断面図 130°E・140°E", code: "AXJP130/140", kind: "pdf", file: "axjp140", aspect: "3 / 4" },
];
const XSEC_LINKS = [
  { title: "断面図", links: [
    { label: "気象庁 国内航空路予想断面図", href: `${JMA_DATA}/airinfo/awfo_fxjp106/awfo_fxjp106.html` },
    { label: "数値予報天気図一覧", href: `${JMA}/bosai/numericmap/` },
  ]},
];

// 各図の取得状態 { status, src, href, timeLabel, ageFrom, error }
// charts はモジュール直下の定数を渡す（参照が変わると取り直しになる）
function useChartSources(charts, manualRefresh, autoTick) {
  const [data, setData] = useState({});
  const patch = useCallback((key, v) => setData((p) => ({ ...p, [key]: { ...(p[key] || {}), ...v } })), []);

  // 画像の図（軽いので自動更新でも取り直す）
  useEffect(() => {
    let alive = true;
    const upd = (k, v) => alive && patch(k, v);
    const wm = charts.filter((c) => c.kind === "wm");
    if (wm.length) fetch(WM_LIST, { cache: "no-cache" })
      .then((r) => r.json())
      .then((list) => {
        wm.forEach((c) => {
          const arr = list?.[c.region]?.[c.sel] ?? [];
          const file = c.sel === "now" ? arr[arr.length - 1] : arr[0];
          if (!file) { upd(c.key, { status: "error", error: "データがありません" }); return; }
          const m = file.match(/_(\d{14})_MET/);
          const t = m ? parseTs(m[1]) : null;
          upd(c.key, {
            status: "ok", src: WM_PNG + file, href: WM_PNG + file, error: null,
            timeLabel: t ? `${c.sel === "now" ? "解析" : "初期値"} ${fmtZ(t)}` : "",
            ageFrom: c.sel === "now" ? t : null,
          });
        });
      })
      .catch(() => wm.forEach((c) => upd(c.key, { status: "error", error: "天気図の一覧を取得できません" })));

    const lastModified = (url) => fetch(url, { method: "HEAD", cache: "no-cache" })
      .then((r) => (r.ok ? r.headers.get("Last-Modified") : null))
      .then((s) => (s ? new Date(s) : null))
      .catch(() => null);
    charts.filter((c) => c.kind === "png").forEach((c) => {
      upd(c.key, { status: "ok", src: c.url, href: c.url, error: null });
      lastModified(c.url).then((lm) => { if (lm) upd(c.key, { timeLabel: `更新 ${fmtZ(lm)}`, ageFrom: lm }); });
    });
    // 3時間毎の初期値の図：ファイル名が初期時刻の「時」だけなので、更新時刻で新しさを確かめる
    charts.filter((c) => c.kind === "cycle3h").forEach(async (c) => {
      const urlOf = (base) => c.urlFor(pad(base.getUTCHours()));
      const show = (base, lm) => {
        const url = urlOf(base);
        upd(c.key, { status: "ok", src: url, href: url, error: null, timeLabel: runLabel(c, base), ageFrom: lm || null });
      };
      const base = cycleBaseDate(0);
      const lm = await lastModified(urlOf(base));
      // 更新時刻が6時間より古い＝まだ今回分が掲載されていない → 1つ前の初期値
      if (lm && Date.now() - lm.getTime() > 6 * 3600e3) {
        const prev = cycleBaseDate(1);
        show(prev, await lastModified(urlOf(prev)));
      } else {
        show(base, lm);
      }
    });
    return () => { alive = false; };
  }, [charts, manualRefresh, autoTick, patch]);

  // 数値予報天気図（PDF → 画像）。重いので初期時刻が変わったときと手動更新のときだけ
  const init = defaultInit(PDF_LAG_H);
  useEffect(() => {
    let alive = true;
    charts.filter((c) => c.kind === "pdf").forEach((c) => {
      const url = `${NWP_PDF}${c.file}_${init}.pdf`;
      patch(c.key, { href: url });
      setData((p) => (p[c.key]?.src ? p : { ...p, [c.key]: { ...(p[c.key] || {}), status: "loading" } }));
      getPdfImage(url, manualRefresh)
        .then((r) => {
          if (!alive) return;
          const modified = r.modified ? new Date(r.modified) : null;
          const base = modified ? initFromModified(modified, init) : null;
          patch(c.key, { status: "ok", src: r.src, error: null, timeLabel: base ? runLabel(c, base) : `${c.ft ? "初期値" : "解析"} ${init}Z`, ageFrom: null });
        })
        .catch((e) => alive && patch(c.key, { status: "error", error: `PDF を取得できません（${e.message}）` }));
    });
    return () => { alive = false; };
  }, [charts, init, manualRefresh, patch]);

  return data;
}

// 一覧のカード
function ChartCard({ chart, d, dim, nowMs, onOpen, onRetry }) {
  const src = d?.src;
  const [loadedSrc, setLoadedSrc] = useState(null);
  const [errorSrc, setErrorSrc] = useState(null);
  const failed = d?.status === "error" || (src && src === errorSrc);
  const ready = src && src === loadedSrc;
  const meta = [d?.timeLabel, d?.ageFrom ? ago(d.ageFrom, nowMs) : null].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className="wxc-card"
      onClick={failed ? onRetry : onOpen}
      aria-label={failed ? `${chart.title}を再取得` : `${chart.title}（${chart.code}）を全画面で開く`}
      style={{
        display: "flex", flexDirection: "column", textAlign: "left", padding: 0, cursor: "pointer",
        background: "rgba(10,16,28,0.9)", border: `1px solid ${C.border}`, borderRadius: "10px",
        overflow: "hidden", color: C.text, fontFamily: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "8px", padding: "10px 12px", width: "100%", boxSizing: "border-box", flexWrap: "wrap" }}>
        <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{chart.title}</span>
        <span style={{ fontSize: FS.xs, color: C.textMuted }}>{chart.code}</span>
        <span style={{ marginLeft: "auto", fontSize: FS.xs, color: C.textSub }}>{meta || " "}</span>
      </div>
      <div style={{
        position: "relative", width: "calc(100% - 20px)", margin: "0 10px 10px", aspectRatio: chart.aspect || "4 / 3",
        background: "#ffffff", borderRadius: "6px", overflow: "hidden",
        filter: dim ? DIM_FILTER : "none",
      }}>
        {src && !failed && (
          <img
            src={src} alt="" loading="lazy" draggable={false}
            onLoad={() => setLoadedSrc(src)} onError={() => setErrorSrc(src)}
            style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
          />
        )}
        {!ready && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            background: "#0b1220", padding: "12px", textAlign: "center",
            color: failed ? "#fca5a5" : C.textMuted, fontSize: FS.sm,
          }}>
            {failed ? `${d?.error || "読み込めませんでした"} · タップで再試行` : chart.kind === "pdf" ? "PDF を画像化中…" : "読み込み中…"}
          </div>
        )}
      </div>
    </button>
  );
}

// 全画面ビューア。items: [{ key, title, code, meta, src, href }]
export function ChartViewer({ items, index, setIndex, onClose, dim }) {
  const item = items[index];
  const [fit, setFit] = useState(true);
  const closeRef = useRef(null);
  const swipe = useRef(null);
  const count = items.length;
  const go = useCallback((dir) => setIndex((i) => (i + dir + count) % count), [setIndex, count]);

  useEffect(() => {
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => { document.body.style.overflow = prevOverflow; prevFocus?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose]);

  // 前後の図を先読み
  useEffect(() => {
    [items[(index + 1) % count], items[(index - 1 + count) % count]].forEach((it) => {
      if (it?.src) { const img = new Image(); img.src = it.src; }
    });
  }, [index, items, count]);

  const onPointerDown = (e) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = (e) => {
    const s = swipe.current; swipe.current = null;
    if (!s || !fit) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 60) go(dx < 0 ? 1 : -1);
  };

  const iconBtn = {
    width: "44px", height: "44px", borderRadius: "8px", border: `1px solid ${C.border}`,
    background: "rgba(15,23,42,0.9)", color: C.text, fontSize: FS.md, cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit",
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={`${item.title} 全画面表示`} style={{
      position: "fixed", inset: 0, zIndex: 10000, background: "rgba(3,8,16,0.97)",
      display: "flex", flexDirection: "column",
      paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 16px", flexWrap: "wrap" }}>
        <span style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>{item.title}</span>
        <span style={{ fontSize: FS.xs, color: C.textMuted }}>{item.code}</span>
        <span style={{ fontSize: FS.sm, color: C.textSub }}>{item.meta}</span>
        <span style={{ marginLeft: "auto", fontSize: FS.sm, color: C.textSub }}>{index + 1} / {count}</span>
        <button type="button" onClick={() => setFit((f) => !f)} style={{ ...iconBtn, width: "auto", padding: "0 14px", fontSize: FS.sm }}>
          {fit ? "原寸" : "全体"}
        </button>
        {item.href && <ExtLink href={item.href}>気象庁</ExtLink>}
        <button ref={closeRef} type="button" onClick={onClose} aria-label="閉じる" style={iconBtn}>✕</button>
      </div>

      <div
        onPointerDown={onPointerDown} onPointerUp={onPointerUp}
        style={{
          flex: 1, minHeight: 0, position: "relative", overflow: fit ? "hidden" : "auto",
          display: "flex", alignItems: fit ? "center" : "flex-start", justifyContent: fit ? "center" : "flex-start",
          padding: "0 64px 12px", touchAction: fit ? "pan-y" : "auto",
        }}
      >
        {item.src ? (
          <img
            src={item.src} alt={item.title} draggable={false}
            style={{
              background: "#ffffff", borderRadius: "6px",
              filter: dim ? DIM_FILTER : "none",
              ...(fit ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" } : { maxWidth: "none" }),
            }}
          />
        ) : (
          <span style={{ color: C.textMuted, fontSize: FS.sm }}>読み込み中…</span>
        )}
        {count > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label="前の図" style={{ ...iconBtn, position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)" }}>‹</button>
            <button type="button" onClick={() => go(1)} aria-label="次の図" style={{ ...iconBtn, position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)" }}>›</button>
          </>
        )}
      </div>
      <div style={{ textAlign: "center", padding: "0 16px 10px", fontSize: FS.xs, color: C.textMuted }}>
        ← → キー・左右スワイプで切替 · Esc で閉じる
      </div>
    </div>
  );
}

// 画面内に1枚の図を出す（読込中・欠測の表示、タップで全画面）
export function ChartFigure({ src, alt, dim, onOpen, aspect, minHeight = 240, missingText = "この図はありません" }) {
  const [loadedSrc, setLoadedSrc] = useState(null);
  const [errorSrc, setErrorSrc] = useState(null);
  const failed = !!src && src === errorSrc;
  const ready = !!src && src === loadedSrc;
  return (
    <button
      type="button" className="wxc-card" onClick={ready ? onOpen : undefined}
      aria-label={ready ? `${alt}を全画面で開く` : alt}
      style={{
        position: "relative", display: "block", width: "100%", padding: 0, border: "none", borderRadius: "6px",
        overflow: "hidden", background: "#ffffff", cursor: ready ? "zoom-in" : "default", fontFamily: "inherit",
        aspectRatio: aspect, minHeight: ready || aspect ? 0 : minHeight,
        filter: dim ? DIM_FILTER : "none",
      }}
    >
      {src && !failed && (
        <img
          src={src} alt={alt} draggable={false}
          onLoad={() => setLoadedSrc(src)} onError={() => setErrorSrc(src)}
          style={{ width: "100%", height: aspect ? "100%" : "auto", objectFit: "contain", display: "block" }}
        />
      )}
      {!ready && (
        <span style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
          background: "#0b1220", padding: "12px", textAlign: "center",
          color: failed ? "#fca5a5" : C.textMuted, fontSize: FS.sm,
        }}>
          {failed ? missingText : "読み込み中…"}
        </span>
      )}
    </button>
  );
}

// 図の一覧（カード）。cats を渡すと分類の切替を出す
export function ChartGallery({ title, charts, cats, filterKey, links, note, minCard = 300 }) {
  const [filter, setFilterState] = useState(() => {
    const v = cats && filterKey ? loadPref(filterKey, "all") : "all";
    return cats?.some((c) => c.key === v) ? v : "all"; // 以前の「悪天」など、なくなった分類は「すべて」に戻す
  });
  const [dim, setDim] = useDimPref();
  const [manualRefresh, setManualRefresh] = useState(0);
  const [autoTick, setAutoTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [viewer, setViewer] = useState(null); // 表示中の図のインデックス（visible 内）
  const data = useChartSources(charts, manualRefresh, autoTick);

  const setFilter = (v) => { setFilterState(v); if (filterKey) savePref(filterKey, v); };

  useEffect(() => {
    const auto = setInterval(() => setAutoTick((t) => t + 1), AUTO_REFRESH_MS);
    const clock = setInterval(() => setNowMs(Date.now()), 60e3);
    return () => { clearInterval(auto); clearInterval(clock); };
  }, []);

  const visible = charts.filter((c) => filter === "all" || c.cat === filter);
  const items = visible.map((c) => {
    const d = data[c.key] || {};
    return {
      key: c.key, title: c.title, code: c.code, src: d.status === "ok" ? d.src : null, href: d.href,
      meta: [d.timeLabel, d.ageFrom ? ago(d.ageFrom, nowMs) : null].filter(Boolean).join(" · "),
    };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <style>{`
        .wxc-card { transition: border-color .15s ease; }
        .wxc-card:hover { border-color: rgba(110,231,183,0.45) !important; }
        .wxc-card:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
      `}</style>

      <PanelFrame title={title} style={{ padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", padding: "16px 16px 4px" }}>
          {cats && <Segmented options={cats} value={filter} onChange={setFilter} label="分類" />}
          <span style={{ fontSize: FS.xs, color: C.textMuted }}>タップで全画面{charts.length > 1 ? "、左右スワイプで次の図へ" : ""}</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", minHeight: "44px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
              <input type="checkbox" checked={dim} onChange={(e) => setDim(e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
              図を減光（夜間用）
            </label>
            <button type="button" onClick={() => setManualRefresh((n) => n + 1)} style={actionBtnStyle}>更新</button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minCard}px), 1fr))`, alignItems: "start", gap: "14px", padding: "12px 16px 16px" }}>
          {visible.map((c, i) => (
            <ChartCard
              key={c.key} chart={c} d={data[c.key]} dim={dim} nowMs={nowMs}
              onOpen={() => setViewer(i)}
              onRetry={() => setManualRefresh((n) => n + 1)}
            />
          ))}
        </div>
        {note && <div style={{ padding: "0 16px 14px", fontSize: FS.xs, color: C.textMuted }}>{note}</div>}
      </PanelFrame>

      {links?.length > 0 && (
        <PanelFrame title="関連リンク" style={{ padding: "18px 16px 14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: "14px" }}>
            {links.map((g) => (
              <div key={g.title} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px" }}>{g.title}</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {g.links.map((l) => <ExtLink key={l.href} href={l.href}>{l.label}</ExtLink>)}
                </div>
              </div>
            ))}
          </div>
        </PanelFrame>
      )}

      {viewer !== null && items[viewer] && (
        <ChartViewer items={items} index={viewer} setIndex={setViewer} onClose={() => setViewer(null)} dim={dim} />
      )}
    </div>
  );
}

// WX CHARTS：地上・上空の天気図
export default function WxChartsGallery() {
  return (
    <ChartGallery
      title="天気図一覧" charts={WX_CHARTS} cats={WX_CATS} filterKey={FILTER_KEY} links={WX_LINKS}
      note="出典: 気象庁（天気図・数値予報天気図）。数値予報天気図は PDF を画像化して表示"
    />
  );
}

// SIG WX：国内悪天予想図（FBJP・FBJP112）
export function SigwxProgCharts() {
  return (
    <ChartGallery
      title="国内悪天予想図" charts={PROG_CHARTS} links={PROG_LINKS} minCard={420}
      note="乱気流・着氷・積乱雲域・ジェット軸・0℃高度の予想。出典: 気象庁 航空気象情報"
    />
  );
}

// ENROUTE：断面図（FXJP106・AXJP130/140）
export function CrossSectionCharts() {
  return (
    <ChartGallery
      title="断面図" charts={XSEC_CHARTS} links={XSEC_LINKS} minCard={360}
      note="FXJP106 は国内主要航空路に沿った6・12時間予想、AXJP130/140 は東経130°・140°に沿った解析（00Z・12Z）。出典: 気象庁"
    />
  );
}
