/* ============================================================
   WX CHARTS — 天気図一覧
   地上・上空・悪天の図をカードで一覧表示し、タップで全画面ビューア
   （←→キー／左右スワイプで次の図、夜間用の減光）。データは気象庁の公開ソース
   ============================================================ */
import { useState, useEffect, useRef, useCallback } from "react";
import { PanelFrame, ExtLink } from "./ui.jsx";
import { C, FS } from "./theme.js";
import { getPdfImage, defaultInit } from "./DomesticWxPanel.jsx";

const JMA = "https://www.jma.go.jp";
const JMA_DATA = "https://www.data.jma.go.jp";
const WM_LIST = `${JMA}/bosai/weather_map/data/list.json`;
const WM_PNG = `${JMA}/bosai/weather_map/data/png/`;
const NWP_PDF = `${JMA}/bosai/numericmap/data/nwpmap/`;
const FBJP_URL = `${JMA_DATA}/airinfo/data/pict/fbjp/fbjp.png`;
const fbjp112Url = (hh) => `${JMA_DATA}/airinfo/data/pict/nwp/fbjp112_${hh}.png`;
const DIM_KEY = "wxcharts_dim";
const FILTER_KEY = "wxcharts_filter";
const PDF_LAG_H = 4; // 数値予報天気図の PDF は初期時刻の約3.6時間後に公開
const AUTO_REFRESH_MS = 10 * 60e3;

const pad = (n) => String(n).padStart(2, "0");
const parseTs = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
const fmtZ = (d) => `${pad(d.getUTCDate())}日 ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
const ago = (d, nowMs) => {
  const m = Math.max(0, Math.round((nowMs - d.getTime()) / 60000));
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}前`;
  return `${Math.floor(m / 1440)}日前`;
};
// PDF の更新時刻から初期時刻（00Z/12Z）を逆算
const initFromModified = (modified) => {
  const t = new Date(modified.getTime() - 3 * 3600e3);
  t.setUTCMinutes(0, 0, 0);
  t.setUTCHours(t.getUTCHours() >= 12 ? 12 : 0);
  return t;
};
// FBJP 12時間予想：3時間毎の初期値、初期時刻の約2時間14分後に掲載 → 2時間20分前を基準に選ぶ
const fbjp112BaseDate = (stepsBack = 0) => {
  const d = new Date(Date.now() - 140 * 60e3);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(Math.floor(d.getUTCHours() / 3) * 3 - stepsBack * 3);
  return d;
};
const loadPref = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const savePref = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };

const CATS = [
  { key: "all", label: "すべて" },
  { key: "sfc", label: "地上" },
  { key: "upper", label: "上空" },
  { key: "sev", label: "悪天" },
];

const CHARTS = [
  { key: "spas", cat: "sfc", title: "地上 実況", code: "SPAS", kind: "wm", region: "near", sel: "now" },
  { key: "fsas24", cat: "sfc", title: "24時間 予想", code: "FSAS24", kind: "wm", region: "near", sel: "ft24" },
  { key: "fsas48", cat: "sfc", title: "48時間 予想", code: "FSAS48", kind: "wm", region: "near", sel: "ft48" },
  { key: "asas", cat: "sfc", title: "アジア 実況", code: "ASAS", kind: "wm", region: "asia", sel: "now" },
  { key: "fbjp", cat: "sev", title: "国内悪天予想図", code: "FBJP", kind: "png", url: FBJP_URL },
  { key: "fbjp112", cat: "sev", title: "国内悪天 12時間予想", code: "FBJP112", kind: "fbjp112" },
  { key: "aupq78", cat: "upper", title: "500/300hPa 解析", code: "AUPQ78", kind: "pdf", file: "aupq78" },
  { key: "aupq35", cat: "upper", title: "850/700hPa 解析", code: "AUPQ35", kind: "pdf", file: "aupq35" },
  { key: "aupa25", cat: "upper", title: "250hPa 解析", code: "AUPA25", kind: "pdf", file: "aupa25" },
  { key: "fxjp854", cat: "upper", title: "850hPa 相当温位 予想", code: "FXJP854", kind: "pdf", file: "fxjp854" },
];

const LINK_GROUPS = [
  { title: "悪天", links: [
    { label: "下層悪天予想図", href: `${JMA_DATA}/airinfo/data/awfo_low-level_sigwx.html` },
    { label: "下層悪天 詳細版", href: `${JMA_DATA}/airinfo/data/awfo_low-level_detailed-sigwx.html` },
    { label: "FBJP 12時間予想（全初期値）", href: `${JMA_DATA}/airinfo/awfo_fbjp112/awfo_fbjp112.html` },
    { label: "AWC SIGWX", href: "https://aviationweather.gov/gfa/#area=other" },
    { label: "AWC 乱気流", href: "https://aviationweather.gov/gfa/#obs=turb" },
    { label: "AWC 着氷", href: "https://aviationweather.gov/gfa/#obs=ice" },
  ]},
  { title: "上空・風", links: [
    { label: "数値予報天気図一覧", href: `${JMA}/bosai/numericmap/` },
    { label: "ウィンドプロファイラ", href: `${JMA}/bosai/windprofiler/` },
    { label: "Windy 250hPa 風", href: "https://www.windy.com/-Wind-250hPa-wind250h?wind250h,36,137,5" },
    { label: "Windy 850hPa 気温", href: "https://www.windy.com/-Temperature-temp?temp,36,137,5" },
  ]},
  { title: "火山灰", links: [
    { label: "東京 VAAC", href: "https://ds.data.jma.go.jp/svd/vaac/data/" },
    { label: "降灰予報", href: `${JMA}/bosai/ashfall/` },
  ]},
];

// 各図の取得状態 { status, src, href, timeLabel, ageFrom, error }
function useChartSources(manualRefresh, autoTick) {
  const [data, setData] = useState({});
  const patch = useCallback((key, v) => setData((p) => ({ ...p, [key]: { ...(p[key] || {}), ...v } })), []);

  // 地上天気図・FBJP（軽いので自動更新でも取り直す）
  useEffect(() => {
    let alive = true;
    const upd = (k, v) => alive && patch(k, v);
    fetch(WM_LIST, { cache: "no-cache" })
      .then((r) => r.json())
      .then((list) => {
        CHARTS.filter((c) => c.kind === "wm").forEach((c) => {
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
      .catch(() => CHARTS.filter((c) => c.kind === "wm").forEach((c) => upd(c.key, { status: "error", error: "天気図の一覧を取得できません" })));

    const lastModified = (url) => fetch(url, { method: "HEAD", cache: "no-cache" })
      .then((r) => (r.ok ? r.headers.get("Last-Modified") : null))
      .then((s) => (s ? new Date(s) : null))
      .catch(() => null);
    CHARTS.filter((c) => c.kind === "png").forEach((c) => {
      upd(c.key, { status: "ok", src: c.url, href: c.url, error: null });
      lastModified(c.url).then((lm) => { if (lm) upd(c.key, { timeLabel: `更新 ${fmtZ(lm)}`, ageFrom: lm }); });
    });
    // FBJP 12時間予想：ファイル名が初期時刻の「時」だけなので、更新時刻で新しさを確かめる
    CHARTS.filter((c) => c.kind === "fbjp112").forEach(async (c) => {
      const show = (base, lm) => {
        const url = fbjp112Url(pad(base.getUTCHours()));
        const vt = new Date(base.getTime() + 12 * 3600e3);
        upd(c.key, { status: "ok", src: url, href: url, error: null, timeLabel: `初期値 ${fmtZ(base)} → 予想 ${fmtZ(vt)}`, ageFrom: lm || null });
      };
      const base = fbjp112BaseDate(0);
      const lm = await lastModified(fbjp112Url(pad(base.getUTCHours())));
      // 更新時刻が6時間より古い＝まだ今回分が掲載されていない → 1つ前の初期値
      if (lm && Date.now() - lm.getTime() > 6 * 3600e3) {
        const prev = fbjp112BaseDate(1);
        show(prev, await lastModified(fbjp112Url(pad(prev.getUTCHours()))));
      } else {
        show(base, lm);
      }
    });
    return () => { alive = false; };
  }, [manualRefresh, autoTick, patch]);

  // 数値予報天気図（PDF → 画像）。重いので初期時刻が変わったときと手動更新のときだけ
  const init = defaultInit(PDF_LAG_H);
  useEffect(() => {
    let alive = true;
    CHARTS.filter((c) => c.kind === "pdf").forEach((c) => {
      const url = `${NWP_PDF}${c.file}_${init}.pdf`;
      patch(c.key, { href: url });
      setData((p) => (p[c.key]?.src ? p : { ...p, [c.key]: { ...(p[c.key] || {}), status: "loading" } }));
      getPdfImage(url, manualRefresh)
        .then((r) => {
          if (!alive) return;
          const modified = r.modified ? new Date(r.modified) : null;
          const base = modified ? initFromModified(modified) : null;
          patch(c.key, { status: "ok", src: r.src, error: null, timeLabel: base ? `初期値 ${fmtZ(base)}` : `初期値 ${init}Z`, ageFrom: null });
        })
        .catch((e) => alive && patch(c.key, { status: "error", error: `PDF を取得できません（${e.message}）` }));
    });
    return () => { alive = false; };
  }, [init, manualRefresh, patch]);

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
        position: "relative", width: "calc(100% - 20px)", margin: "0 10px 10px", aspectRatio: "4 / 3",
        background: "#ffffff", borderRadius: "6px", overflow: "hidden",
        filter: dim ? "brightness(0.68) contrast(1.05)" : "none",
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

// 全画面ビューア
function ChartViewer({ items, index, setIndex, onClose, dim }) {
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
              filter: dim ? "brightness(0.68) contrast(1.05)" : "none",
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

export default function WxChartsGallery() {
  const [filter, setFilterState] = useState(() => loadPref(FILTER_KEY, "all"));
  const [dim, setDimState] = useState(() => loadPref(DIM_KEY, false));
  const [manualRefresh, setManualRefresh] = useState(0);
  const [autoTick, setAutoTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [viewer, setViewer] = useState(null); // 表示中の図のインデックス（visible 内）
  const data = useChartSources(manualRefresh, autoTick);

  const setFilter = (v) => { setFilterState(v); savePref(FILTER_KEY, v); };
  const setDim = (v) => { setDimState(v); savePref(DIM_KEY, v); };

  useEffect(() => {
    const auto = setInterval(() => setAutoTick((t) => t + 1), AUTO_REFRESH_MS);
    const clock = setInterval(() => setNowMs(Date.now()), 60e3);
    return () => { clearInterval(auto); clearInterval(clock); };
  }, []);

  const visible = CHARTS.filter((c) => filter === "all" || c.cat === filter);
  const items = visible.map((c) => {
    const d = data[c.key] || {};
    return {
      key: c.key, title: c.title, code: c.code, src: d.status === "ok" ? d.src : null, href: d.href,
      meta: [d.timeLabel, d.ageFrom ? ago(d.ageFrom, nowMs) : null].filter(Boolean).join(" · "),
    };
  });

  const segBtn = (on) => ({
    height: "40px", padding: "0 14px", borderRadius: "8px", border: "none", cursor: "pointer",
    background: on ? "rgba(110,231,183,0.14)" : "transparent",
    color: on ? C.accent : C.textSub, fontWeight: on ? 700 : 400, fontSize: FS.sm, fontFamily: "inherit",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <style>{`
        .wxc-card { transition: border-color .15s ease; }
        .wxc-card:hover { border-color: rgba(110,231,183,0.45) !important; }
        .wxc-card:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
      `}</style>

      <PanelFrame title="WX CHARTS / 天気図" style={{ padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", padding: "16px 16px 4px" }}>
          <div role="group" aria-label="分類" style={{ display: "inline-flex", padding: "3px", borderRadius: "10px", background: "rgba(10,16,28,0.9)", border: `1px solid ${C.border}` }}>
            {CATS.map((c) => (
              <button key={c.key} type="button" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)} style={segBtn(filter === c.key)}>{c.label}</button>
            ))}
          </div>
          <span style={{ fontSize: FS.xs, color: C.textMuted }}>タップで全画面、左右スワイプで次の図へ</span>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: "8px", minHeight: "44px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
              <input type="checkbox" checked={dim} onChange={(e) => setDim(e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
              図を減光（夜間用）
            </label>
            <button type="button" onClick={() => setManualRefresh((n) => n + 1)} style={{
              height: "40px", padding: "0 14px", borderRadius: "8px", cursor: "pointer",
              background: "transparent", border: `1px solid ${C.border}`, color: C.textSub, fontSize: FS.sm, fontFamily: "inherit",
            }}>更新</button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: "14px", padding: "12px 16px 16px" }}>
          {visible.map((c, i) => (
            <ChartCard
              key={c.key} chart={c} d={data[c.key]} dim={dim} nowMs={nowMs}
              onOpen={() => setViewer(i)}
              onRetry={() => setManualRefresh((n) => n + 1)}
            />
          ))}
        </div>
        <div style={{ padding: "0 16px 14px", fontSize: FS.xs, color: C.textMuted }}>
          出典: 気象庁（天気図・数値予報天気図・航空気象情報）。数値予報天気図は PDF を画像化して表示
        </div>
      </PanelFrame>

      <PanelFrame title="関連リンク" style={{ padding: "18px 16px 14px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))", gap: "14px" }}>
          {LINK_GROUPS.map((g) => (
            <div key={g.title} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.textSub, letterSpacing: "1px" }}>{g.title}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {g.links.map((l) => <ExtLink key={l.href} href={l.href}>{l.label}</ExtLink>)}
              </div>
            </div>
          ))}
        </div>
      </PanelFrame>

      {viewer !== null && items[viewer] && (
        <ChartViewer items={items} index={viewer} setIndex={setViewer} onClose={() => setViewer(null)} dim={dim} />
      )}
    </div>
  );
}
