/* ============================================================
   画像ビューア — 衛星・レーダー・雷・積乱雲情報を1つの地図ビューアで
   すべて気象庁の地図タイルで表示するので、海岸線や雷の観測位置を正しく重ねられる
   ============================================================ */
import { useState, useEffect, useRef, useCallback } from "react";
import { PanelFrame, ExtLink } from "./ui.jsx";
import { C, FS } from "./theme.js";
import {
  TileMap, projectPct, REGIONS, buildNowcFrames, NOWC, BASEMAP, SATPROD, CCI_TIMES, COASTLINE,
  RADAR_LEGEND, THUNDER_LEGEND, CCI_LEGEND, parseTs, pad, usePlayer, lon2px, lat2px,
} from "./DomesticWxPanel.jsx";

const JMA = "https://www.jma.go.jp";
const SAT = `${JMA}/bosai/himawari/data/satimg`;
const SAT_TIMES = `${SAT}/targetTimes_jp.json`;   // 日本域：2.5分毎・ズーム6まで（範囲外は白）
const SAT_FD_TIMES = `${SAT}/targetTimes_fd.json`; // 全球：10分毎・ズーム5まで
const SAT_HOURS = 11;
const PREF_KEY = "imagery_prefs";
const AUTO_REFRESH_MS = 5 * 60e3;

const VIEW_REGIONS = [
  { key: "japan", label: "日本全域", w: 120, e: 150, n: 47, s: 22, z: 5 },
  ...REGIONS,
];
const THUMB_REGION = { key: "thumb", w: 122, e: 148, n: 46, s: 24, z: 4 };

const SOURCES = [
  { key: "sat", label: "衛星", maxZoom: 6 },
  { key: "radar", label: "レーダー", maxZoom: 7 },
  { key: "thunder", label: "雷", maxZoom: 7 },
  { key: "cci", label: "積乱雲情報", maxZoom: 6 },
];
const BANDS = [
  { key: "B13/TBB", label: "赤外 B13", swatch: "#9aa6b8", desc: "雲頂温度。白いほど雲頂が高く冷たい雲（積乱雲・上層雲）。昼夜を問わず使えます。" },
  { key: "B03/ALBD", label: "可視", swatch: "#d6dbe3", desc: "太陽光の反射。厚い雲ほど白く写ります。霧・層雲の把握に有効。日中のみ。" },
  { key: "B08/TBB", label: "水蒸気", swatch: "#6b7fa8", desc: "上中層の水蒸気。暗い所は乾燥（下降流）。ジェット気流・トラフ・乾燥貫入の把握に。" },
  { key: "REP/ETC", label: "トゥルーカラー", swatch: "#7c9a6a", desc: "人の目で見た色に近い再現画像。日中のみ。" },
  { key: "SND/ETC", label: "雲頂強調", swatch: "#c9a227", desc: "可視と赤外を合成し、発達した対流雲の雲頂を強調した画像。日中のみ。" },
];
const SOURCE_INFO = {
  radar: { title: "高解像度降水ナウキャスト", desc: "降水の強さ。直近60分の実況（10分毎）と、60分先までの予想。", legend: RADAR_LEGEND, legendTitle: "降水強度 mm/h" },
  thunder: { title: "雷ナウキャスト", desc: "雷の活動度。直近60分の実況と、60分先までの予想。雷の無い時間帯は地図だけが表示されます。", legend: THUNDER_LEGEND, legendTitle: "雷活動度" },
  cci: { title: "積乱雲情報", desc: "ひまわりの観測から解析した積乱雲域と、積雲が急に発達している域。背景は赤外（白いほど雲頂が高い）。", legend: CCI_LEGEND, legendTitle: "積乱雲情報" },
};
const LINKS = [
  { label: "気象庁 気象衛星ひまわり", href: "https://www.jma.go.jp/bosai/map.html#5/34.5/137/&elem=ir&contents=himawari" },
  { label: "気象庁 ナウキャスト", href: `${JMA}/bosai/nowc/` },
  { label: "気象庁 積乱雲情報", href: "https://www.data.jma.go.jp/omaad/aviation/jp/cci/" },
];

const DEFAULT_PREFS = { source: "sat", band: "B13/TBB", region: "japan", step: 30, lightning: true, coast: true, dim: false };
const loadPrefs = () => {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}) }; } catch { return DEFAULT_PREFS; }
};

const hhmmZ = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
const hhmmJst = (d) => { const j = new Date(d.getTime() + 9 * 3600e3); return `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`; };
const ago = (d, nowMs) => {
  const m = Math.max(0, Math.round((nowMs - d.getTime()) / 60000));
  return m < 60 ? `${m}分前` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}前`;
};

// 時刻リスト（衛星・ナウキャスト・積乱雲情報）
function useTimeLists(tick) {
  const [lists, setLists] = useState({});
  useEffect(() => {
    let alive = true;
    const get = (url) => fetch(url, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    Promise.allSettled([get(SAT_TIMES), get(SAT_FD_TIMES), get(`${NOWC}/targetTimes_N1.json`), get(`${NOWC}/targetTimes_N2.json`), get(`${NOWC}/targetTimes_N3.json`), get(CCI_TIMES)])
      .then(([sat, satFd, n1, n2, n3, cci]) => {
        if (!alive) return;
        const v = (r) => (r.status === "fulfilled" ? r.value : null);
        setLists({ sat: v(sat), satFd: v(satFd), n1: v(n1), n2: v(n2), n3: v(n3), cci: v(cci), fetchedAt: new Date() });
      });
    return () => { alive = false; };
  }, [tick]);
  return lists;
}

// コマの一覧（古い→新しい）。fc=予想
function buildFrames(source, lists, step, area) {
  if (source === "sat") {
    const list = area === "fd" ? lists.satFd : lists.sat;
    if (!list) return null;
    const arr = list
      .filter((x) => x.validtime.slice(12, 14) === "00" && +x.validtime.slice(10, 12) % step === 0)
      .sort((a, b) => a.validtime.localeCompare(b.validtime));
    if (!arr.length) return { frames: [], latestIdx: 0 };
    const latest = parseTs(arr[arr.length - 1].validtime).getTime();
    const frames = arr.filter((x) => parseTs(x.validtime).getTime() >= latest - SAT_HOURS * 3600e3)
      .map((x) => ({ bt: x.basetime, vt: x.validtime, fc: false }));
    return { frames, latestIdx: frames.length - 1 };
  }
  if (source === "radar" || source === "thunder") {
    if (!lists.n1 || !lists.n2 || !lists.n3) return null;
    const { frames, latestPastIdx } = buildNowcFrames(source, lists.n1, lists.n2, lists.n3);
    return { frames: frames.map((f) => ({ bt: f.basetime, vt: f.validtime, fc: f.fc })), latestIdx: Math.max(0, latestPastIdx) };
  }
  if (!lists.cci) return null;
  const frames = lists.cci
    .filter((x) => x.validtime.slice(10, 12) % 10 === 0)
    .sort((a, b) => a.validtime.localeCompare(b.validtime))
    .slice(-19)
    .map((x) => ({ bt: x.basetime, vt: x.validtime, fc: false }));
  return { frames, latestIdx: frames.length - 1 };
}

// 表示するタイルの重なり（下から）
function layersFor(source, band, f, coast, area = "jp") {
  if (!f) return [];
  if (source === "sat") return [
    { id: "sat", url: (z, x, y) => `${SAT}/${f.bt}/${area}/${f.vt}/${band}/${z}/${x}/${y}.jpg` },
    coast && { id: "coast", url: COASTLINE, pixelated: true },
  ];
  if (source === "radar" || source === "thunder") return [
    { id: "base", url: BASEMAP },
    { id: "nowc", url: (z, x, y) => `${NOWC}/${f.bt}/none/${f.vt}/surf/${source === "radar" ? "hrpns" : "thns"}/${z}/${x}/${y}.png`, opacity: 0.85 },
  ];
  return [
    { id: "tbb", url: (z, x, y) => `${SATPROD}/${f.bt}/JP/${f.vt}/B13/TBB/${z}/${x}/${y}.png`, pixelated: true },
    coast && { id: "coast", url: COASTLINE, pixelated: true },
    { id: "cci", url: (z, x, y) => `${SATPROD}/${f.bt}/JP/${f.vt}/CCI/CCI/${z}/${x}/${y}.png`, opacity: 0.8, pixelated: true },
  ];
}

const tilesOf = (region, z) => {
  const out = [];
  for (let tx = Math.floor(lon2px(region.w, z) / 256); tx <= Math.floor(lon2px(region.e, z) / 256); tx++) {
    for (let ty = Math.floor(lat2px(region.n, z) / 256); ty <= Math.floor(lat2px(region.s, z) / 256); ty++) out.push([tx, ty]);
  }
  return out;
};

// 雷の観測（落雷位置）。コマの時刻までの10分間
const lidenCache = new Map();
function useLightning(enabled, n3, frame) {
  const [state, setState] = useState({ points: [], note: "" });
  useEffect(() => {
    if (!enabled || !frame || !n3) { setState({ points: [], note: "" }); return; }
    let alive = true;
    const vt = parseTs(frame.vt).getTime();
    const entries = n3.filter((x) => x.elements.includes("liden"));
    const oldest = entries.reduce((m, x) => Math.min(m, parseTs(x.validtime).getTime()), Infinity);
    if (frame.fc) { setState({ points: [], note: "予想の時刻には雷の観測はありません" }); return; }
    if (vt < oldest) { setState({ points: [], note: "雷の観測は直近3時間分のみ表示できます" }); return; }
    const use = entries.filter((x) => { const t = parseTs(x.validtime).getTime(); return t <= vt && t > vt - 10 * 60e3; });
    Promise.all(use.map((x) => {
      const url = `${NOWC}/${x.basetime}/none/${x.validtime}/surf/liden/data.geojson`;
      if (!lidenCache.has(url)) {
        lidenCache.set(url, fetch(url).then((r) => (r.ok ? r.json() : { features: [] })).catch(() => { lidenCache.delete(url); return { features: [] }; }));
      }
      return lidenCache.get(url);
    })).then((gjs) => {
      if (!alive) return;
      const points = gjs.flatMap((g) => (g.features || []))
        .filter((ft) => ft.geometry?.type === "Point")
        .map((ft) => ({ lon: ft.geometry.coordinates[0], lat: ft.geometry.coordinates[1] }));
      setState({ points, note: points.length ? "" : "この時刻の前10分間に落雷の観測はありません" });
    });
    return () => { alive = false; };
  }, [enabled, n3, frame?.bt, frame?.vt, frame?.fc]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const Icon = ({ d }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.map((p) => <path key={p} d={p} />)}
  </svg>
);

export default function ImageryViewer() {
  const [prefs, setPrefsState] = useState(loadPrefs);
  const setPref = (k, v) => setPrefsState((p) => {
    const next = { ...p, [k]: v };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });
  const { source, band, region: regionKey, step, lightning, coast, dim } = prefs;
  const [tick, setTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const lists = useTimeLists(tick);
  // 日本域画像は撮影範囲の外が白く塗られる（本州域では南東の隅にかかる）ため、
  // 日本全域・本州域は全球画像、範囲内に収まる南日本域・北日本域は高解像度の日本域画像を使う
  const satArea = regionKey === "south" || regionKey === "north" ? "jp" : "fd";
  const built = buildFrames(source, lists, step, satArea);
  const frames = built?.frames || [];
  const latestIdx = built?.latestIdx ?? 0;
  const [idx, setIdx] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const follow = useRef(true);
  const prevKey = useRef("");

  useEffect(() => {
    const a = setInterval(() => setTick((t) => t + 1), AUTO_REFRESH_MS);
    const b = setInterval(() => setNowMs(Date.now()), 60e3);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  // コマ一覧が変わったとき：最新を見ていたなら新しい最新へ、そうでなければ同じ時刻を保つ
  const framesKey = `${source}|${step}|${satArea}|${frames.map((f) => `${f.bt}${f.vt}`).join(",")}`;
  useEffect(() => {
    if (!frames.length) return;
    const prev = prevKey.current;
    prevKey.current = framesKey;
    setIdx((cur) => {
      if (follow.current || cur < 0 || !prev) return latestIdx;
      return Math.min(cur, frames.length - 1);
    });
  }, [framesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const setIndex = useCallback((v) => {
    setIdx((cur) => {
      const n = typeof v === "function" ? v(cur) : v;
      return n;
    });
  }, []);
  useEffect(() => { follow.current = idx === latestIdx; }, [idx, latestIdx]);
  usePlayer(frames.length, playing, setIndex, 700);

  const changeSource = (s) => { setPlaying(false); follow.current = true; prevKey.current = ""; setPref("source", s); };
  const srcDef = SOURCES.find((s) => s.key === source) || SOURCES[0];
  const region = VIEW_REGIONS.find((r) => r.key === regionKey) || VIEW_REGIONS[0];
  const zoom = Math.min(region.z, srcDef.maxZoom, source === "sat" && satArea === "fd" ? 5 : 99);
  const cur = frames[Math.max(0, Math.min(idx, frames.length - 1))];
  const vtDate = cur ? parseTs(cur.vt) : null;
  const leadMin = cur?.fc ? Math.round((parseTs(cur.vt) - parseTs(cur.bt)) / 60000) : 0;
  const showCoast = source === "sat" || source === "cci";
  const lit = useLightning(lightning, lists.n3, cur);

  // 次のコマのタイルを先読み
  useEffect(() => {
    const nf = frames[(idx + 1) % (frames.length || 1)];
    if (!nf) return;
    const ls = layersFor(source, band, nf, false, satArea).filter(Boolean).filter((l) => l.id !== "base");
    tilesOf(region, zoom).forEach(([x, y]) => ls.forEach((l) => { new Image().src = l.url(zoom, x, y); }));
  }, [idx, framesKey, band, regionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // サムネイル：最大8コマを均等に
  const thumbIdx = frames.length <= 8 ? frames.map((_, i) => i)
    : [...new Set(Array.from({ length: 8 }, (_, k) => Math.round((k * (frames.length - 1)) / 7)))];
  // スライダーの目盛り：5つ
  const ticks = frames.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((r) => frames[Math.round(r * (frames.length - 1))]) : [];

  const info = source === "sat"
    ? { title: `ひまわり ${BANDS.find((b) => b.key === band)?.label}`, desc: BANDS.find((b) => b.key === band)?.desc, coverage: `過去${SAT_HOURS}時間 · ${step === 60 ? "1時間" : `${step}分`}毎` }
    : { ...SOURCE_INFO[source], coverage: source === "cci" ? "過去3時間 · 10分毎" : "実況60分 ＋ 予想60分 · 10分毎" };
  const listMissing = source === "sat" ? !(satArea === "fd" ? lists.satFd : lists.sat) : source === "cci" ? !lists.cci : !(lists.n1 && lists.n2 && lists.n3);

  const seg = (on) => ({
    height: "40px", padding: "0 14px", borderRadius: "8px", border: "none", cursor: "pointer", fontFamily: "inherit",
    background: on ? "rgba(110,231,183,0.14)" : "transparent", color: on ? C.accent : C.textSub,
    fontWeight: on ? 700 : 400, fontSize: FS.sm,
  });
  const chip = (on) => ({
    height: "40px", padding: "0 12px", borderRadius: "8px", cursor: "pointer", fontFamily: "inherit",
    background: "rgba(15,23,42,0.7)", border: `1px solid ${on ? C.accent : C.border}`,
    color: on ? C.text : C.textSub, fontSize: FS.sm, display: "inline-flex", alignItems: "center", gap: "8px",
  });
  const ctrl = {
    width: "44px", height: "44px", borderRadius: "8px", cursor: "pointer", fontFamily: "inherit",
    background: "rgba(15,23,42,0.7)", border: `1px solid ${C.border}`, color: C.text,
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const overlayBtn = (on) => ({
    height: "36px", padding: "0 12px", borderRadius: "8px", cursor: "pointer", fontFamily: "inherit",
    background: "rgba(3,8,16,0.85)", border: `1px solid ${on ? C.accent : "#2c3a52"}`,
    color: on ? C.text : C.textSub, fontSize: FS.xs,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <PanelFrame title="衛星・レーダー・雷・積乱雲情報" style={{ padding: 0 }}>
        {/* 種類・バンド・地域 */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "16px 16px 10px" }}>
          <div role="group" aria-label="種類" style={{ display: "inline-flex", padding: "3px", borderRadius: "10px", background: "rgba(10,16,28,0.9)", border: `1px solid ${C.border}` }}>
            {SOURCES.map((s) => (
              <button key={s.key} type="button" aria-pressed={source === s.key} onClick={() => changeSource(s.key)} style={seg(source === s.key)}>{s.label}</button>
            ))}
          </div>
          <div role="group" aria-label="地域" style={{ display: "inline-flex", padding: "3px", borderRadius: "10px", background: "rgba(10,16,28,0.9)", border: `1px solid ${C.border}`, marginLeft: "auto" }}>
            {VIEW_REGIONS.map((r) => (
              <button key={r.key} type="button" aria-pressed={regionKey === r.key} onClick={() => setPref("region", r.key)} style={seg(regionKey === r.key)}>{r.label}</button>
            ))}
          </div>
        </div>
        {source === "sat" && (
          <div role="group" aria-label="バンド" style={{ display: "flex", gap: "6px", flexWrap: "wrap", padding: "0 16px 10px" }}>
            {BANDS.map((b) => (
              <button key={b.key} type="button" aria-pressed={band === b.key} onClick={() => setPref("band", b.key)} style={chip(band === b.key)}>
                <span style={{ width: "14px", height: "14px", borderRadius: "3px", background: b.swatch }} />{b.label}
              </button>
            ))}
          </div>
        )}

        {/* 地図 */}
        <div style={{ position: "relative", margin: "0 16px", borderRadius: "10px", overflow: "hidden", border: `1px solid ${C.border}`, background: "#0b1220" }}>
          {cur ? (
            <div style={{ filter: dim ? "brightness(0.72)" : "none" }}>
              <TileMap region={region} zoom={zoom} layers={layersFor(source, band, cur, showCoast && coast, satArea)} bg={source === "radar" || source === "thunder" ? "#cfd8dc" : "#000"}>
                {lightning && lit.points.map((p, i) => {
                  const pos = projectPct(region, zoom, p.lon, p.lat);
                  if (pos.x < 0 || pos.x > 100 || pos.y < 0 || pos.y > 100) return null;
                  return (
                    <span key={i} aria-hidden="true" style={{
                      position: "absolute", left: `${pos.x}%`, top: `${pos.y}%`, transform: "translate(-50%,-50%)",
                      color: "#fde047", fontSize: FS.sm, fontWeight: 700, lineHeight: 1, textShadow: "0 0 2px #000, 0 0 2px #000",
                    }}>+</span>
                  );
                })}
              </TileMap>
            </div>
          ) : (
            <div style={{ aspectRatio: "16 / 10", display: "flex", alignItems: "center", justifyContent: "center", color: C.textMuted, fontSize: FS.sm }}>
              {listMissing && lists.fetchedAt ? "時刻リストを取得できません（通信状況を確認してください）" : "読み込み中…"}
            </div>
          )}
          {/* 重ねて表示 */}
          <div role="group" aria-label="重ねて表示" style={{ position: "absolute", top: "10px", right: "10px", display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button type="button" aria-pressed={lightning} onClick={() => setPref("lightning", !lightning)} style={overlayBtn(lightning)}>雷（観測）</button>
            {showCoast && <button type="button" aria-pressed={coast} onClick={() => setPref("coast", !coast)} style={overlayBtn(coast)}>海岸線</button>}
          </div>
          {/* 時刻 */}
          {vtDate && (
            <div style={{ position: "absolute", left: "10px", bottom: "10px", padding: "6px 10px", borderRadius: "6px", background: "rgba(3,8,16,0.85)", fontSize: FS.sm, color: C.text }}>
              {cur.fc && <span style={{ color: "#fcd34d", fontWeight: 700, marginRight: "8px" }}>予想 +{leadMin}分</span>}
              <span style={{ fontWeight: 700 }}>{hhmmZ(vtDate)}</span>
              <span style={{ color: C.textSub }}> · {hhmmJst(vtDate)} JST{!cur.fc && ` · ${ago(vtDate, nowMs)}`}</span>
            </div>
          )}
          {lightning && lit.note && (
            <div style={{ position: "absolute", left: "10px", top: "10px", maxWidth: "calc(100% - 210px)", padding: "4px 8px", borderRadius: "6px", background: "rgba(3,8,16,0.85)", fontSize: FS.xs, color: C.textSub }}>{lit.note}</div>
          )}
        </div>

        {/* コマ送り */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 16px 6px" }}>
          <button type="button" aria-label="前のコマ" onClick={() => { setPlaying(false); setIndex((i) => Math.max(0, i - 1)); }} style={ctrl}><Icon d={["M15 6l-6 6 6 6"]} /></button>
          <button type="button" aria-label={playing ? "停止" : "再生"} aria-pressed={playing} onClick={() => setPlaying((p) => !p)} style={{ ...ctrl, borderColor: playing ? C.accent : C.border }}>
            {playing ? <Icon d={["M8 5v14", "M16 5v14"]} /> : <Icon d={["M7 5l12 7-12 7V5z"]} />}
          </button>
          <button type="button" aria-label="次のコマ" onClick={() => { setPlaying(false); setIndex((i) => Math.min(frames.length - 1, i + 1)); }} style={ctrl}><Icon d={["M9 6l6 6-6 6"]} /></button>
          <button type="button" aria-label="最新のコマ" onClick={() => { setPlaying(false); setIndex(latestIdx); }} style={ctrl}><Icon d={["M7 6l6 6-6 6", "M17 6v12"]} /></button>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
            <input
              type="range" min={0} max={Math.max(0, frames.length - 1)} value={Math.max(0, idx)}
              onChange={(e) => { setPlaying(false); setIndex(+e.target.value); }}
              aria-label="時刻" style={{ width: "100%", accentColor: C.accent }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: FS.xs, color: C.textMuted }}>
              {ticks.map((f, i) => <span key={i}>{f.fc ? `+${Math.round((parseTs(f.vt) - parseTs(f.bt)) / 60000)}分` : hhmmZ(parseTs(f.vt))}</span>)}
            </div>
          </div>
        </div>

        {/* サムネイル */}
        {frames.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${thumbIdx.length}, minmax(0, 1fr))`, gap: "6px", padding: "6px 16px 16px" }}>
            {thumbIdx.map((i) => {
              const f = frames[i];
              const on = i === idx;
              return (
                <button key={`${f.bt}${f.vt}`} type="button" onClick={() => { setPlaying(false); setIndex(i); }} aria-label={`${hhmmZ(parseTs(f.vt))} のコマ`} aria-pressed={on} style={{
                  padding: 0, cursor: "pointer", borderRadius: "6px", overflow: "hidden", background: "#0b1220",
                  border: `${on ? 2 : 1}px solid ${on ? C.accent : C.border}`, display: "flex", flexDirection: "column", fontFamily: "inherit",
                }}>
                  <div style={{ width: "100%", pointerEvents: "none" }}>
                    <TileMap region={THUMB_REGION} zoom={4} layers={layersFor(source, band, f, false, "fd")} bg={source === "radar" || source === "thunder" ? "#cfd8dc" : "#000"} />
                  </div>
                  <span style={{ fontSize: FS.xs, color: on ? C.text : C.textMuted, padding: "3px 0" }}>
                    {f.fc ? `+${Math.round((parseTs(f.vt) - parseTs(f.bt)) / 60000)}分` : hhmmZ(parseTs(f.vt))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PanelFrame>

      {/* 表示中・設定 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: "14px" }}>
        <PanelFrame title="表示中" style={{ padding: "18px 16px 14px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{info.title}</span>
            <span style={{ fontSize: FS.sm, color: C.textSub, lineHeight: 1.6 }}>{info.desc}</span>
            <span style={{ fontSize: FS.xs, color: C.textMuted }}>{info.coverage}</span>
            {info.legend && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                <span style={{ fontSize: FS.xs, color: C.textMuted, marginRight: "4px" }}>{info.legendTitle}</span>
                {info.legend.map(([c, t]) => (
                  <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginRight: "6px" }}>
                    <span style={{ width: "16px", height: "10px", background: c, borderRadius: "2px", display: "inline-block" }} />
                    <span style={{ fontSize: FS.xs, color: C.textSub }}>{t}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </PanelFrame>
        <PanelFrame title="表示の設定" style={{ padding: "18px 16px 14px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {source === "sat" && (
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: "44px", fontSize: FS.sm, color: C.textSub }}>
                コマの間隔
                <select value={step} onChange={(e) => { follow.current = true; setPref("step", +e.target.value); }} style={{
                  height: "36px", borderRadius: "8px", background: "rgba(15,23,42,0.9)", border: `1px solid ${C.border}`,
                  color: C.text, fontFamily: "inherit", fontSize: FS.sm, padding: "0 8px",
                }}>
                  <option value={10}>10分毎</option>
                  <option value={30}>30分毎</option>
                  <option value={60}>1時間毎</option>
                </select>
              </label>
            )}
            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: "44px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
              地図を減光（夜間用）
              <input type="checkbox" checked={dim} onChange={(e) => setPref("dim", e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
            </label>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: "44px", fontSize: FS.sm, color: C.textSub }}>
              <span>時刻リスト取得 {lists.fetchedAt ? hhmmZ(lists.fetchedAt) : "—"}</span>
              <button type="button" onClick={() => setTick((t) => t + 1)} style={{
                height: "36px", padding: "0 14px", borderRadius: "8px", cursor: "pointer", fontFamily: "inherit",
                background: "transparent", border: `1px solid ${C.border}`, color: C.textSub, fontSize: FS.sm,
              }}>更新</button>
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", paddingTop: "4px" }}>
              {LINKS.map((l) => <ExtLink key={l.href} href={l.href}>{l.label}</ExtLink>)}
            </div>
          </div>
        </PanelFrame>
      </div>
    </div>
  );
}
