/* ============================================================
   SIG WX の各表示 — SIGMET（地図＋原文）、低高度悪天予想図、積乱雲情報、解説報
   （国内悪天予想図は ChartsGallery.jsx の SigwxProgCharts、台風・豪雨は WeatherBriefing.jsx）
   SIGMET は AWC の国際 SIGMET（Cloudflare Worker 経由）から福岡FIR分を表示
   ============================================================ */
import { useState, useEffect } from "react";
import { PanelFrame, ExtLink, Segmented, segWrapStyle, segBtnStyle } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import {
  TileMap, projectPct, BASEMAP, COASTLINE, CciView, ChartImg, Caption, WORKER_URL,
  sigmetUrl, cmntUrl, SIGMET_AREAS, CMNT_AREAS, LL_AREAS, LL_FTS, lowLevelUrl, pad,
} from "./DomesticWxPanel.jsx";
import { ChartFigure, ChartViewer, useDimPref, loadPref, savePref } from "./ChartsGallery.jsx";

const JMA = "https://www.jma.go.jp";
const JMA_DATA = "https://www.data.jma.go.jp";
const SAT = `${JMA}/bosai/himawari/data/satimg`;
const SAT_FD_TIMES = `${SAT}/targetTimes_fd.json`;
const SIG_PREF_KEY = "severe_sigmet_prefs";
const LL_PREF_KEY = "sigwx_lowlevel";
const AUTO_REFRESH_MS = 5 * 60e3;

// 現象ごとの表示（色・線種）
const HAZARDS = {
  TS: { label: "雷電", color: "#f87171", dash: "" },
  TSGR: { label: "雷電・ひょう", color: "#f87171", dash: "" },
  TURB: { label: "乱気流", color: "#f59e0b", dash: "6 4" },
  ICE: { label: "着氷", color: "#67e8f9", dash: "2 3" },
  MTW: { label: "山岳波", color: "#c084fc", dash: "6 4" },
  VA: { label: "火山灰", color: "#d6a77a", dash: "" },
  TC: { label: "台風", color: "#f472b6", dash: "" },
  DS: { label: "砂じん嵐", color: "#d6a77a", dash: "4 3" },
  SS: { label: "砂じん嵐", color: "#d6a77a", dash: "4 3" },
};
const hazardOf = (h) => HAZARDS[h] || { label: h || "その他", color: "#94a3b8", dash: "" };
const CHANGE = { INTSF: "発達", WKN: "衰弱", NC: "変化なし" };

const MAIN_FIR = "RJJJ";
const NEIGHBOR_FIRS = ["RKRR", "RCAA", "ZSHA", "ZJSA", "RPHI", "UHHH", "KZAK"];
const SIG_REGIONS = [
  { key: "fir", label: "福岡FIR", w: 115, e: 166, n: 50, s: 15, z: 4 },
  { key: "japan", label: "日本付近", w: 120, e: 150, n: 47, s: 22, z: 5 },
];

const hhmmZ = (d) => `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
const dayHhmmZ = (d) => `${pad(d.getUTCDate())}日 ${hhmmZ(d)}`;
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
};
const fl = (ft) => `FL${String(Math.round(ft / 100)).padStart(3, "0")}`;
const loadJson = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v === null ? fallback : { ...fallback, ...JSON.parse(v) }; } catch { return fallback; }
};

// 多角形の配列にそろえる（AREA: [{lat,lon}...], AREAS: [[...], [...]]）
const polygonsOf = (coords) => {
  if (!Array.isArray(coords) || !coords.length) return [];
  return Array.isArray(coords[0]) ? coords : [coords];
};

function useSigmets(tick) {
  const [state, setState] = useState({ status: "loading", items: [], fetchedAt: null, error: null });
  useEffect(() => {
    let alive = true;
    fetch(`${WORKER_URL}/api/data/isigmet?format=json`, { cache: "no-cache" })
      .then(async (r) => {
        if (r.status === 204) return [];
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const t = await r.text();
        return t.trim() ? JSON.parse(t) : [];
      })
      .then((list) => alive && setState({ status: "ok", items: Array.isArray(list) ? list : [], fetchedAt: new Date(), error: null }))
      .catch((e) => alive && setState((p) => ({ ...p, status: "error", error: e.message })));
    return () => { alive = false; };
  }, [tick]);
  return state;
}

function useLatestIr(enabled) {
  const [t, setT] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch(SAT_FD_TIMES, { cache: "no-cache" })
      .then((r) => r.json())
      .then((list) => { if (alive && list.length) setT(list[list.length - 1]); })
      .catch(() => {});
    return () => { alive = false; };
  }, [enabled]);
  return t;
}

export function SigmetView() {
  const [prefs, setPrefs] = useState(() => loadJson(SIG_PREF_KEY, { region: "fir", bg: "map", neighbors: false, mode: "map" }));
  const setPref = (k, v) => setPrefs((p) => {
    const n = { ...p, [k]: v };
    try { localStorage.setItem(SIG_PREF_KEY, JSON.stringify(n)); } catch { /* ignore */ }
    return n;
  });
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [jmaArea, setJmaArea] = useState("QGMA98");
  const sig = useSigmets(tick);
  const ir = useLatestIr(prefs.bg === "ir");

  useEffect(() => {
    const a = setInterval(() => setTick((t) => t + 1), AUTO_REFRESH_MS);
    const b = setInterval(() => setNowMs(Date.now()), 60e3);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const firs = prefs.neighbors ? [MAIN_FIR, ...NEIGHBOR_FIRS] : [MAIN_FIR];
  // 有効期間内（または開始前）のもの。原文が同じもの（例: L02 と L02F）は1件にまとめる
  const seen = new Set();
  const items = sig.items
    .filter((s) => firs.includes(s.firId) && (s.validTimeTo || 0) * 1000 > nowMs)
    .filter((s) => { const k = (s.rawSigmet || "").trim(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.firId === MAIN_FIR ? 0 : 1) - (b.firId === MAIN_FIR ? 0 : 1) || (b.validTimeFrom || 0) - (a.validTimeFrom || 0));
  const mainCount = items.filter((s) => s.firId === MAIN_FIR).length;

  const region = SIG_REGIONS.find((r) => r.key === prefs.region) || SIG_REGIONS[0];
  const z = region.z;
  const layers = prefs.bg === "ir" && ir
    ? [
      { id: "ir", url: (zz, x, y) => `${SAT}/${ir.basetime}/fd/${ir.validtime}/B13/TBB/${zz}/${x}/${y}.jpg` },
      { id: "coast", url: COASTLINE, pixelated: true },
    ]
    : [{ id: "base", url: BASEMAP }];

  const seg = (on) => segBtnStyle(on);
  const segWrap = segWrapStyle;
  const vt = sig.fetchedAt;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <PanelFrame title={`SIGMET（${prefs.neighbors ? "福岡FIR・周辺" : "福岡FIR"}）`} style={{ padding: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "16px 16px 10px" }}>
          <div role="group" aria-label="表示" style={segWrap}>
            <button type="button" aria-pressed={prefs.mode === "map"} onClick={() => setPref("mode", "map")} style={seg(prefs.mode === "map")}>地図</button>
            <button type="button" aria-pressed={prefs.mode === "jma"} onClick={() => setPref("mode", "jma")} style={seg(prefs.mode === "jma")}>気象庁の図</button>
          </div>
          {prefs.mode === "map" ? (
            <>
              <div role="group" aria-label="範囲" style={segWrap}>
                {SIG_REGIONS.map((r) => (
                  <button key={r.key} type="button" aria-pressed={prefs.region === r.key} onClick={() => setPref("region", r.key)} style={seg(prefs.region === r.key)}>{r.label}</button>
                ))}
              </div>
              <div role="group" aria-label="背景" style={segWrap}>
                <button type="button" aria-pressed={prefs.bg === "map"} onClick={() => setPref("bg", "map")} style={seg(prefs.bg === "map")}>地図</button>
                <button type="button" aria-pressed={prefs.bg === "ir"} onClick={() => setPref("bg", "ir")} style={seg(prefs.bg === "ir")}>赤外</button>
              </div>
            </>
          ) : (
            <div role="group" aria-label="気象庁の図の範囲" style={segWrap}>
              {SIGMET_AREAS.map((a) => (
                <button key={a.key} type="button" aria-pressed={jmaArea === a.key} onClick={() => setJmaArea(a.key)} style={seg(jmaArea === a.key)}>{a.label}</button>
              ))}
            </div>
          )}
          <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "8px", minHeight: "44px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
            <input type="checkbox" checked={prefs.neighbors} onChange={(e) => setPref("neighbors", e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
            周辺FIRも表示
          </label>
        </div>

        {prefs.mode === "map" ? (
          <div style={{ position: "relative", margin: "0 16px 16px", borderRadius: "10px", overflow: "hidden", border: `1px solid ${C.border}` }}>
            <TileMap region={region} zoom={z} layers={layers} bg={prefs.bg === "ir" ? "#000" : "#cfd8dc"}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
                {items.flatMap((s, i) => polygonsOf(s.coords).map((poly, j) => {
                  const h = hazardOf(s.hazard);
                  const pts = poly.map((c) => { const p = projectPct(region, z, c.lon < 0 ? c.lon + 360 : c.lon, c.lat); return `${p.x.toFixed(2)},${p.y.toFixed(2)}`; }).join(" ");
                  return (
                    <polygon key={`${i}-${j}`} points={pts} fill={h.color} fillOpacity="0.16" stroke={h.color} strokeWidth="2"
                      strokeDasharray={h.dash || undefined} vectorEffect="non-scaling-stroke" />
                  );
                }))}
              </svg>
              {items.map((s, i) => {
                const poly = polygonsOf(s.coords)[0];
                if (!poly?.length) return null;
                const lon = poly.reduce((a, c) => a + (c.lon < 0 ? c.lon + 360 : c.lon), 0) / poly.length;
                const lat = poly.reduce((a, c) => a + c.lat, 0) / poly.length;
                const p = projectPct(region, z, lon, lat);
                if (p.x < 0 || p.x > 100 || p.y < 0 || p.y > 100) return null;
                const h = hazardOf(s.hazard);
                return (
                  <span key={`l${i}`} style={{
                    position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%,-50%)",
                    padding: "2px 6px", borderRadius: "4px", background: "rgba(3,8,16,0.85)", color: h.color,
                    fontSize: FS.xs, fontWeight: 700, whiteSpace: "nowrap", pointerEvents: "none",
                  }}>{(s.seriesId || "").replace(/F$/, "")} {h.label}</span>
                );
              })}
            </TileMap>
            <div style={{ position: "absolute", right: "10px", bottom: "10px", display: "flex", gap: "10px", flexWrap: "wrap", padding: "6px 10px", borderRadius: "6px", background: "rgba(3,8,16,0.85)" }}>
              {["TS", "TURB", "ICE", "MTW", "VA", "TC"].map((k) => {
                const h = hazardOf(k);
                return (
                  <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: FS.xs, color: C.textSub }}>
                    <svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke={h.color} strokeWidth="2" strokeDasharray={h.dash || undefined} /></svg>
                    {h.label}
                  </span>
                );
              })}
            </div>
            {prefs.bg === "ir" && ir && (
              <div style={{ position: "absolute", left: "10px", bottom: "10px", padding: "4px 8px", borderRadius: "6px", background: "rgba(3,8,16,0.85)", fontSize: FS.xs, color: C.textSub }}>
                赤外 {hhmmZ(new Date(Date.UTC(+ir.validtime.slice(0, 4), +ir.validtime.slice(4, 6) - 1, +ir.validtime.slice(6, 8), +ir.validtime.slice(8, 10), +ir.validtime.slice(10, 12))))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ margin: "0 16px 16px", borderRadius: "10px", overflow: "hidden", border: `1px solid ${C.border}` }}>
            <ChartImg src={sigmetUrl(jmaArea)} label={`SIGMET ${SIGMET_AREAS.find((a) => a.key === jmaArea)?.label}`} minHeight={360} />
          </div>
        )}
      </PanelFrame>

      {/* 原文の一覧 */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>
          有効な SIGMET {sig.status === "ok" ? `${items.length}件` : ""}
          {prefs.neighbors && sig.status === "ok" && <span style={{ fontWeight: 400, color: C.textSub }}>（福岡FIR {mainCount}件）</span>}
        </span>
        <span style={{ fontSize: FS.xs, color: sig.status === "error" ? "#fcd34d" : C.textMuted }}>
          {sig.status === "error" ? `取得できません（${sig.error}）${vt ? ` · 前回 ${hhmmZ(vt)}` : ""}` : vt ? `取得 ${hhmmZ(vt)}` : "取得中…"}
        </span>
        <button type="button" onClick={() => setTick((t) => t + 1)} style={{
          marginLeft: "auto", height: "40px", padding: "0 14px", borderRadius: "8px", cursor: "pointer", fontFamily: "inherit",
          background: "transparent", border: `1px solid ${sig.status === "error" ? "rgba(245,158,11,0.6)" : C.border}`,
          color: sig.status === "error" ? "#fcd34d" : C.textSub, fontSize: FS.sm,
        }}>{sig.status === "error" ? "再取得" : "更新"}</button>
      </div>

      {sig.status === "ok" && items.length === 0 && (
        <div style={{ padding: "14px 16px", borderRadius: "10px", background: "rgba(10,16,28,0.9)", border: `1px solid ${C.border}`, fontSize: FS.sm, color: C.textSub }}>
          {prefs.neighbors ? "福岡FIRと周辺FIRに" : "福岡FIRに"}有効な SIGMET はありません。
        </div>
      )}

      {items.map((s) => {
        const h = hazardOf(s.hazard);
        const from = new Date((s.validTimeFrom || 0) * 1000);
        const to = new Date((s.validTimeTo || 0) * 1000);
        const started = nowMs >= from.getTime();
        const extent = s.base && s.top ? `${fl(s.base)}–${fl(s.top)}` : s.top ? `TOP ${fl(s.top)}` : s.base ? `${fl(s.base)} 以上` : "";
        // 停滞（STNR）は方向 "-"・速度 0 で返るので、移動しているときだけ表示
        const move = /^[NSEW]{1,3}$/.test(s.dir || "") && +s.spd > 0 ? `MOV ${s.dir} ${s.spd}KT` : "";
        return (
          <article key={`${s.firId}-${s.seriesId}-${s.validTimeFrom}`} style={{
            background: "rgba(10,16,28,0.9)", border: `1px solid ${h.color}55`, borderRadius: "10px",
            padding: "12px 16px", display: "flex", flexDirection: "column", gap: "8px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={{ fontSize: FS.xs, fontWeight: 700, padding: "3px 8px", borderRadius: "4px", background: `${h.color}26`, color: h.color }}>
                {h.label} {s.hazard}
              </span>
              {s.qualifier && <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{s.qualifier}</span>}
              <span style={{ fontSize: FS.sm, color: C.textSub }}>{(s.seriesId || "").replace(/F$/, "")}</span>
              {s.firId !== MAIN_FIR && <span style={{ fontSize: FS.xs, color: C.textMuted }}>{s.firName || s.firId}</span>}
              <span style={{ fontSize: FS.sm, color: C.text }}>{dayHhmmZ(from)} – {hhmmZ(to)}</span>
              <span style={{ fontSize: FS.xs, color: started ? C.textSub : "#fcd34d" }}>
                {started ? `残り ${dur(to.getTime() - nowMs)}` : `開始まで ${dur(from.getTime() - nowMs)}`}
              </span>
              {extent && <span style={{ fontSize: FS.xs, color: C.textSub }}>{extent}</span>}
              {move && <span style={{ fontSize: FS.xs, color: C.textSub }}>{move}</span>}
              {s.chng && <span style={{ fontSize: FS.xs, color: C.textSub }}>{s.chng}{CHANGE[s.chng] ? `（${CHANGE[s.chng]}）` : ""}</span>}
            </div>
            <pre style={{ margin: 0, fontFamily: FONT.data, fontSize: FS.sm, lineHeight: 1.6, color: C.text, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {(s.rawSigmet || "").trim()}
            </pre>
          </article>
        );
      })}

      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_sigmet.html`} accent>気象庁 SIGMET</ExtLink>
      </div>
      <div style={{ fontSize: FS.xs, color: C.textMuted }}>
        出典: SIGMET の原文と範囲は AWC（米国航空気象センター）の国際 SIGMET。地図は国土地理院・気象庁。
      </div>
    </div>
  );
}

export function CmntView() {
  const [area, setArea] = useState(CMNT_AREAS[0].key);
  return (
    <PanelFrame title="全国航空気象解説報" style={{ padding: 0 }}>
      <div style={{ padding: "16px 16px 10px" }}>
        <Segmented options={CMNT_AREAS} value={area} onChange={setArea} label="範囲" />
      </div>
      <div style={{ padding: "0 16px" }}><ChartImg src={cmntUrl(area)} label={`全国航空気象解説報 ${area}`} minHeight={360} /></div>
      <Caption>予報官による悪天の解説図（注目すべき悪天域とその見通し）。</Caption>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", padding: "0 16px 16px" }}>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_ajpn_cmnt_airspace.html`} accent>解説報（国内空域）</ExtLink>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_ajpn_cmnt_fukuokafir.html`}>解説報（福岡FIR）</ExtLink>
      </div>
    </PanelFrame>
  );
}

// 積乱雲情報（地図・コマ送り）
export function CciPanel() {
  return <PanelFrame title="積乱雲情報" style={{ padding: 0 }}><CciView refresh={0} /></PanelFrame>;
}

// 低高度悪天予想図（地上〜FL150）。タップで全画面、全画面では FT03→06→09→時系列 を左右で切替
export function LowLevelView() {
  const [prefs, setPrefs] = useState(() => {
    const v = loadPref(LL_PREF_KEY, {});
    return {
      area: LL_AREAS.some((a) => a.key === v?.area) ? v.area : "fbtk",
      ft: LL_FTS.some((f) => f.key === v?.ft) ? v.ft : "03",
    };
  });
  const setPref = (k, v) => setPrefs((p) => { const n = { ...p, [k]: v }; savePref(LL_PREF_KEY, n); return n; });
  const [dim, setDim] = useDimPref();
  const [viewer, setViewer] = useState(null);
  const [modified, setModified] = useState(null);
  const area = LL_AREAS.find((a) => a.key === prefs.area);
  const ftLabel = (f) => (f.key === "39" ? "時系列" : `${+f.key}時間後`);
  const src = lowLevelUrl(prefs.area, prefs.ft);

  // 更新時刻（図そのものには掲載時刻がないので Last-Modified で表示）
  useEffect(() => {
    let alive = true;
    setModified(null);
    fetch(src, { method: "HEAD", cache: "no-cache" })
      .then((r) => (r.ok ? r.headers.get("Last-Modified") : null))
      .then((lm) => alive && lm && setModified(new Date(lm)))
      .catch(() => {});
    return () => { alive = false; };
  }, [src]);

  const items = LL_FTS.map((f) => ({
    key: f.key, title: `低高度悪天予想図 ${area.label}`, code: f.key === "39" ? "時系列" : f.label,
    src: lowLevelUrl(prefs.area, f.key), href: lowLevelUrl(prefs.area, f.key), meta: "",
  }));

  return (
    <PanelFrame title="低高度悪天予想図" style={{ padding: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "16px 16px 10px" }}>
        <Segmented options={LL_AREAS} value={prefs.area} onChange={(v) => setPref("area", v)} label="地域" />
        <Segmented options={LL_FTS.map((f) => ({ key: f.key, label: ftLabel(f) }))} value={prefs.ft} onChange={(v) => setPref("ft", v)} label="予想時間" />
        <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "8px", minHeight: "44px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={dim} onChange={(e) => setDim(e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
          図を減光（夜間用）
        </label>
      </div>
      <div style={{ padding: "0 16px" }}>
        <ChartFigure
          src={src} alt={`低高度悪天予想図 ${area.label} ${prefs.ft === "39" ? "時系列" : `FT${prefs.ft}`}`} dim={dim} aspect="1000 / 734"
          onOpen={() => setViewer(LL_FTS.findIndex((f) => f.key === prefs.ft))}
        />
      </div>
      <div style={{ padding: "10px 16px 0", fontSize: FS.xs, color: C.textSub }}>
        {modified ? `更新 ${pad(modified.getUTCDate())}日 ${hhmmZ(modified)}` : " "}
      </div>
      <Caption>地上〜FL150 の雲底・視程・乱気流・着氷・積乱雲域などを、3・6・9時間先まで予想した図。タップで全画面、全画面では左右で予想時間を切り替えられます。</Caption>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", padding: "0 16px 16px" }}>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_low-level_sigwx.html`} accent>気象庁 低高度悪天予想図</ExtLink>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_low-level_detailed-sigwx.html`}>詳細版（府県別）</ExtLink>
      </div>
      {viewer !== null && (
        <ChartViewer items={items} index={viewer} setIndex={setViewer} onClose={() => setViewer(null)} dim={dim} />
      )}
    </PanelFrame>
  );
}
