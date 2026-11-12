/* ============================================================
   TERMINAL — 乗務の目的地の発着便（自分の到着の前後1時間）
   - 便は AeroDataBox（RapidAPI）を Worker 経由で取る（/flights/）。回数に上限があるので Worker の KV に保存して使い回す
   - 自分の到着便は、乗務の行程（前の空港 → この空港）と勤務時間から推定し、「便を変える」で選び直せる（端末に保存）
   - 便が多すぎる大空港（羽田・成田・関西・伊丹・新千歳・福岡・那覇・中部）には出さない
   - 時刻表で十分（利用者の判断）。到着便は、出発空港での遅れ・離陸がわかればそれも添える
   ============================================================ */
import { useState, useEffect, useMemo } from "react";
import { ExtLink, Segmented, actionBtnStyle } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import { WORKER_URL } from "./DomesticWxPanel.jsx";

const JST = 9 * 3600e3;
const MIN = 60e3;
const HALF = 60 * MIN;            // 自分の到着の前後1時間
const BIN = 15 * MIN;             // 発着の数を数える幅
const BINS = (2 * HALF) / BIN;
const MAX_WINDOW = 12 * 3600e3;   // AeroDataBox で1回に取れる幅
const CLIENT_CACHE_MS = 10 * MIN;
const LATE_MIN = 5;               // これ以上ずれたら見込み時刻を出す
const DELAY_MIN = 15;             // 遅延として数える
const SHOW_EACH_SIDE = 6;         // 一覧で、自分の到着の前と後にそれぞれ先に見せる便の数
const LAYOUT_KEY = "traffic_layout";
const AIRLINE_KEY = "traffic_airline";
const PICKS_KEY = "traffic_picks";
const SKY = "#7dd3fc", VIOLET = "#a5b4fc", AMBER = "#fcd34d", RED = "#fca5a5";
// 便が多すぎて一覧にしても役に立たない大空港（2026-11-12 利用者の判断）
const BUSY_AIRPORTS = new Set(["RJTT", "RJAA", "RJBB", "RJOO", "RJCC", "RJFF", "ROAH", "RJGG"]);

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (t) => { const d = new Date(t + JST); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const hhmmZ = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
const localStr = (t) => new Date(t + JST).toISOString().slice(0, 16);
const toMs = (iso) => (iso ? Date.parse(iso) : NaN);
const airlineOf = (number) => (number || "").split(" ")[0];
const load = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? def; } catch { return def; } };
const save = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても表示はする */ } };

// 機材名を短く（"Boeing 737-800" → "737-800"、"Embraer 170" → "E170" など）
const shortModel = (m) => (m || "")
  .replace(/^Boeing\s+/i, "")
  .replace(/^Airbus\s+/i, "")
  .replace(/\s*\(Sharklets\)/i, "")
  .replace(/\s+NEO$/i, "neo")
  .replace(/^Embraer\s+(\d+).*$/i, "E$1")
  .replace(/^(Bombardier|De Havilland).*(Q400|DHC-8-400).*$/i, "Q400")
  .replace(/^ATR\s+(\d+).*$/i, "ATR$1")
  .trim();

/* ---------- データ ---------- */
const flightsCache = new Map(); // URL → { at, promise }
function loadFlights(icao, from, to, fresh = false) {
  const base = `${WORKER_URL}/flights/?icao=${icao}&from=${localStr(from)}&to=${localStr(to)}`;
  const hit = flightsCache.get(base);
  if (hit && !fresh && Date.now() - hit.at < CLIENT_CACHE_MS) return hit.promise;
  const promise = fetch(fresh ? `${base}&fresh=1` : base).then(async (r) => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { code: d.error || `HTTP ${r.status}` });
    return d;
  });
  flightsCache.set(base, { at: Date.now(), promise });
  promise.catch(() => flightsCache.delete(base));
  return promise;
}

// 取る時間帯：勤務の始まりから、終わりの1時間後まで（12時間を超えるときは区間に近い側を残す）
function fetchWindow(leg) {
  const STEP = 30 * MIN;
  let from = Math.floor(leg.dutyStart / STEP) * STEP;
  let to = Math.ceil((leg.dutyEnd + HALF) / STEP) * STEP;
  if (to - from > MAX_WINDOW) {
    if (leg.k === leg.n) from = to - MAX_WINDOW; else to = from + MAX_WINDOW;
  }
  return { from, to };
}

/* ---------- 自分の便（選んだ便は端末に保存、推定した便はこの画面のあいだだけ） ----------
   後の区間の推定に、前の区間の到着時刻を使う */
const autoArr = new Map(); // legKey → 推定した到着時刻
const bus = new EventTarget();
const notify = () => bus.dispatchEvent(new Event("change"));
function usePicksVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const f = () => setV((x) => x + 1);
    bus.addEventListener("change", f);
    return () => bus.removeEventListener("change", f);
  }, []);
  return v;
}
const savedPick = (legKey) => (legKey ? load(PICKS_KEY, {})[legKey] || null : null);
function storePick(legKey, pick) {
  const all = load(PICKS_KEY, {});
  if (pick) all[legKey] = { ...pick, at: Date.now() }; else delete all[legKey];
  const keys = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
  while (keys.length > 30) delete all[keys.shift()];
  save(PICKS_KEY, all);
  notify();
}
const prevArrival = (leg) => {
  if (!leg.prevKey) return null;
  const p = savedPick(leg.prevKey);
  return p?.arr || autoArr.get(leg.prevKey) || null;
};

// 見込み時刻：この空港の見込み・実際の時刻 → なければ（到着便は）出発空港での遅れを足す
function enrich(f) {
  const schedMs = toMs(f.sched);
  const rev = toMs(f.revised);
  const otherSchedMs = toMs(f.otherSched);
  const otherRev = toMs(f.otherRevised);
  const originDelay = f.dir === "ARR" && Number.isFinite(otherSchedMs) && Number.isFinite(otherRev) ? Math.round((otherRev - otherSchedMs) / MIN) : null;
  const fromOrigin = !Number.isFinite(rev) && originDelay !== null && originDelay >= LATE_MIN;
  const expMs = Number.isFinite(rev) ? rev : fromOrigin ? schedMs + originDelay * MIN : schedMs;
  return {
    ...f, schedMs, expMs, otherSchedMs, originDelay, fromOrigin,
    lateMin: Math.round((expMs - schedMs) / MIN),
    canceled: /^Canceled/.test(f.status),
    diverted: f.status === "Diverted",
  };
}

// 自分の到着便の候補：前の空港から、勤務時間のあいだに着く便
function findCandidates(leg, flights) {
  const prev = prevArrival(leg);
  const lo = prev ? prev + 20 * MIN : leg.dutyStart - 10 * MIN;
  return flights
    .filter((f) => f.dir === "ARR" && !f.cargo && f.other === leg.from
      && (!Number.isFinite(f.otherSchedMs) || f.otherSchedMs >= lo) && f.schedMs <= leg.dutyEnd + 15 * MIN)
    .sort((a, b) => (a.otherSchedMs || a.schedMs) - (b.otherSchedMs || b.schedMs));
}
function guessOwn(leg, cands) {
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  // 最後の区間は勤務の終わりに近い便、それ以外は早い便
  return leg.k === leg.n ? cands.reduce((a, b) => (b.schedMs > a.schedMs ? b : a)) : cands[0];
}

/* ---------- 表示 ---------- */
// 狭い画面（スマホ）では一覧の機材の列を省く
const NARROW_QUERY = "(max-width: 600px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia?.(NARROW_QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia?.(NARROW_QUERY);
    if (!m) return;
    const f = () => setNarrow(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return narrow;
}
const TONE = {
  own: ["#052e22", C.accent], muted: [C.textSub, "rgba(148,163,184,0.12)"], live: [SKY, "rgba(125,211,252,0.12)"],
  done: [C.textMuted, "transparent"], warn: [AMBER, "rgba(251,191,36,0.14)"], bad: [RED, "rgba(248,113,113,0.16)"],
};
function statusOf(f, ownNumber) {
  if (ownNumber && f.number === ownNumber && f.dir === "ARR") return ["自分", "own"];
  if (f.canceled) return [f.status === "CanceledUncertain" ? "欠航?" : "欠航", "bad"];
  if (f.diverted) return ["ダイバート", "bad"];
  // 到着便は、出発空港での離陸・遅れがわかればそれを出す
  if (f.dir === "ARR") {
    if (Number.isFinite(toMs(f.otherRunway))) return [`${f.other} 離陸 ${hhmm(toMs(f.otherRunway))}`, "live"];
    if (f.originDelay !== null && f.originDelay >= LATE_MIN) return [`出発 +${f.originDelay}分`, "warn"];
  }
  return ["", "muted"];
}

const ERRORS = {
  "no-key": "AeroDataBox のキーが Worker に登録されていません。",
  "daily-limit": "今日の取得回数の上限（40回）に達しました。明日になると取り直せます。",
  quota: "AeroDataBox の今月の回数を使い切りました。",
  key: "AeroDataBox のキーが使えません（契約・キーを確かめてください）。",
};

function Row({ f, cols, showDir, showModel, ownNumber }) {
  const [label, tone] = statusOf(f, ownNumber);
  const own = tone === "own";
  const late = Math.abs(f.lateMin) >= LATE_MIN;
  return (
    <li style={{
      display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: "6px", minHeight: "30px", padding: "0 8px",
      borderRadius: "6px", background: own ? "rgba(110,231,183,0.10)" : "transparent",
      boxShadow: own ? `inset 3px 0 0 ${C.accent}` : "none", opacity: f.canceled ? 0.6 : 1,
    }}>
      <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: C.text }}>{hhmm(f.schedMs)}</span>
      <span style={{ fontFamily: FONT.data, fontSize: FS.xs, color: f.lateMin > 0 ? AMBER : SKY, whiteSpace: "nowrap" }}>
        {late && !f.canceled ? `→${hhmm(f.expMs)}${f.fromOrigin ? "頃" : ""}` : ""}
      </span>
      {showDir && (
        <span style={{ fontSize: FS.xs, fontWeight: 700, color: f.dir === "ARR" ? SKY : VIOLET }}>{f.dir === "ARR" ? "到着" : "出発"}</span>
      )}
      <span style={{ fontFamily: FONT.data, fontSize: FS.sm, fontWeight: 700, color: C.text, whiteSpace: "nowrap", textDecoration: f.canceled ? "line-through" : "none" }}>{f.number}</span>
      <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: C.textSub }}>{f.other}</span>
      {showModel && (
        <span style={{ fontSize: FS.xs, color: C.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={f.model}>
          {shortModel(f.model)}{f.cargo ? " 貨物" : ""}
        </span>
      )}
      <span style={{ justifySelf: "end", whiteSpace: "nowrap", minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>
        {label && (
          <span title={label} style={{ display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "middle", fontSize: FS.xs, fontWeight: 700, padding: "2px 8px", borderRadius: "4px", color: TONE[tone][0], background: TONE[tone][1] }}>{label}</span>
        )}
      </span>
    </li>
  );
}

function Divider({ t }) {
  return (
    <li aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: "8px", height: "18px", padding: "0 8px" }}>
      <span style={{ flex: 1, borderTop: "1px dashed rgba(110,231,183,0.6)" }} />
      <span style={{ fontFamily: FONT.data, fontSize: FS.xs, color: C.accent }}>{hhmm(t)} 自分の到着</span>
      <span style={{ flex: 1, borderTop: "1px dashed rgba(110,231,183,0.6)" }} />
    </li>
  );
}

// 15分ごとの発着の数（線の上が到着、下が出発。緑の線が自分の到着）
function TrafficBars({ rows, start, center }) {
  const bins = Array.from({ length: BINS }, () => ({ arr: 0, dep: 0 }));
  for (const f of rows) {
    if (f.canceled) continue;
    const i = Math.floor((f.expMs - start) / BIN);
    if (i < 0 || i > BINS) continue;
    bins[Math.min(BINS - 1, i)][f.dir === "ARR" ? "arr" : "dep"]++;
  }
  const max = Math.max(1, ...bins.map((b) => Math.max(b.arr, b.dep)));
  const H = 30;
  const bar = (n, color, up) => (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: up ? "flex-end" : "flex-start", alignItems: "center", height: `${H + 12}px`, borderLeft: "1px solid rgba(148,163,184,0.10)" }}>
      {up && n > 0 && <span style={{ fontFamily: FONT.data, fontSize: "10px", color: C.textMuted, lineHeight: "12px" }}>{n}</span>}
      <span style={{ width: "60%", height: `${Math.round((H * n) / max)}px`, borderRadius: "2px", background: color }} />
      {!up && n > 0 && <span style={{ fontFamily: FONT.data, fontSize: "10px", color: C.textMuted, lineHeight: "12px" }}>{n}</span>}
    </div>
  );
  const pos = `${((center - start) / (2 * HALF)) * 100}%`;
  return (
    <figure aria-label="15分ごとの発着の数" style={{ margin: 0, width: "min(100%, 560px)", position: "relative" }}>
      <div style={{ display: "flex" }}>{bins.map((b, i) => <div key={i} style={{ flex: 1, display: "flex" }}>{bar(b.arr, SKY, true)}</div>)}</div>
      <div style={{ height: "1px", background: "rgba(148,163,184,0.35)" }} />
      <div style={{ display: "flex" }}>{bins.map((b, i) => <div key={i} style={{ flex: 1, display: "flex" }}>{bar(b.dep, VIOLET, false)}</div>)}</div>
      <div style={{ position: "absolute", left: pos, top: 0, height: `${2 * (H + 12) + 1}px`, borderLeft: `2px solid ${C.accent}` }} />
      <div style={{ position: "relative", height: "16px", fontFamily: FONT.data, fontSize: FS.xs, color: C.textMuted }}>
        <span style={{ position: "absolute", left: 0 }}>{hhmm(start)}</span>
        <span style={{ position: "absolute", left: pos, transform: "translateX(-50%)", color: C.accent, fontWeight: 700 }}>{hhmm(center)}</span>
        <span style={{ position: "absolute", right: 0 }}>{hhmm(start + 2 * HALF)}</span>
      </div>
    </figure>
  );
}

function Chooser({ leg, cands, guess, ownNumber, onDone }) {
  const pref = load(AIRLINE_KEY, null);
  const [sel, setSel] = useState(ownNumber || guess?.number || cands[0]?.number || "");
  const selAirline = airlineOf(sel);
  // 一覧は、覚えている会社があればその会社の便だけ（「ほかの会社の便も表示」で全部）
  const prefCands = pref ? cands.filter((c) => airlineOf(c.number) === pref) : [];
  const [showAll, setShowAll] = useState(!prefCands.length);
  const list = showAll ? cands : prefCands;
  const [remember, setRemember] = useState(true);
  const [manual, setManual] = useState("");

  const confirm = () => {
    const f = cands.find((c) => c.number === sel);
    if (!f) return;
    storePick(leg.key, { number: f.number, arr: f.schedMs });
    save(AIRLINE_KEY, remember ? airlineOf(f.number) : null);
    onDone();
  };
  const confirmManual = () => {
    const m = manual.match(/^(\d{2}):(\d{2})$/);
    if (!m) return;
    // 勤務の始まりより後で、いちばん近いその時刻（JST）
    const day = Math.floor((leg.dutyStart + JST) / 86400e3) * 86400e3 - JST;
    let t = day + (+m[1] * 60 + +m[2]) * MIN;
    if (t < leg.dutyStart - 2 * 3600e3) t += 86400e3;
    storePick(leg.key, { manual: manual, arr: t });
    onDone();
  };
  const reset = () => { storePick(leg.key, null); onDone(); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>自分の到着便を選んでください</div>
        <div style={{ fontSize: FS.sm, color: C.textSub, marginTop: "2px" }}>
          乗務の行程 {leg.from} → {leg.to} と勤務時間 {hhmm(leg.dutyStart)}–{hhmm(leg.dutyEnd)} JST から、候補を出しています。
        </div>
      </div>
      {cands.length > 0 ? (
        <div role="radiogroup" aria-label="到着便の候補" style={{ display: "flex", flexDirection: "column", gap: "6px", maxWidth: "680px" }}>
          {list.map((c) => {
            const on = c.number === sel;
            return (
              <button key={`${c.number}-${c.schedMs}`} type="button" role="radio" aria-checked={on} onClick={() => setSel(c.number)} style={{
                display: "grid", gridTemplateColumns: "20px 76px minmax(0,1fr) auto", alignItems: "center", gap: "10px",
                minHeight: "44px", padding: "0 12px", borderRadius: "8px", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: C.text,
                background: on ? "rgba(110,231,183,0.10)" : "rgba(15,23,42,0.6)", border: `1px solid ${on ? "rgba(110,231,183,0.55)" : C.border}`,
              }}>
                <span style={{ width: "16px", height: "16px", boxSizing: "border-box", borderRadius: "50%", border: `2px solid ${on ? C.accent : "#475569"}`, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  {on && <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: C.accent }} />}
                </span>
                <span style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700 }}>{c.number}</span>
                <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: C.textSub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {leg.from} {Number.isFinite(c.otherSchedMs) ? hhmm(c.otherSchedMs) : "--:--"} → {leg.to} <b style={{ color: C.text }}>{hhmm(c.schedMs)}</b>
                  <span style={{ fontFamily: FONT.ui, fontSize: FS.xs, color: C.textMuted, marginLeft: "8px" }}>{shortModel(c.model)}</span>
                </span>
                <span style={{ fontSize: FS.xs, color: C.textSub, whiteSpace: "nowrap" }}>{guess && c.number === guess.number ? "勤務から推定" : ""}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: FS.sm, color: C.textSub }}>{leg.from} から {leg.to} に着く便が見つかりません。</div>
      )}
      {!showAll && (
        <button type="button" onClick={() => setShowAll(true)} style={{ ...actionBtnStyle, alignSelf: "flex-start", height: "36px", fontSize: FS.xs }}>
          ほかの会社の便も表示（{cands.length - prefCands.length}便）
        </button>
      )}
      {cands.length > 0 && selAirline && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: "10px", minHeight: "40px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
          次から {selAirline} の便だけを候補にする
        </label>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        {cands.length > 0 && (
          <button type="button" onClick={confirm} disabled={!sel} style={{ ...actionBtnStyle, background: C.accent, border: "none", color: "#052e22", fontWeight: 700 }}>この便で表示</button>
        )}
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: FS.sm, color: C.textSub }}>{cands.length > 0 ? "候補にないとき：到着時刻" : "到着時刻"}</span>
          <input type="time" value={manual} onChange={(e) => setManual(e.target.value)} aria-label="到着時刻（JST）" style={{
            height: "40px", padding: "0 10px", borderRadius: "8px", fontFamily: FONT.data, fontSize: FS.md,
            background: "rgba(10,16,28,0.9)", color: C.text, border: `1px solid ${C.border}`, colorScheme: "dark",
          }} />
          <span style={{ fontSize: FS.sm, color: C.textSub }}>JST</span>
          <button type="button" onClick={confirmManual} disabled={!manual} style={{ ...actionBtnStyle, opacity: manual ? 1 : 0.5 }}>この時刻で表示</button>
        </span>
        {savedPick(leg.key) && <button type="button" onClick={reset} style={actionBtnStyle}>推定に戻す</button>}
        <button type="button" onClick={onDone} style={actionBtnStyle}>やめる</button>
      </div>
      <div style={{ fontSize: FS.xs, color: C.textMuted }}>選んだ便は端末に保存し、この勤務のあいだ使います。</div>
    </div>
  );
}

function LegTraffic({ icao, leg }) {
  const win = useMemo(() => fetchWindow(leg), [leg.dutyStart, leg.dutyEnd, leg.k, leg.n]);
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [tick, setTick] = useState({ n: 0, fresh: false });
  const [choosing, setChoosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const narrow = useNarrow();
  const [layout, setLayout] = useState(() => (load(LAYOUT_KEY, "dir") === "time" ? "time" : "dir"));
  const picksVersion = usePicksVersion();

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: s.data ? "refreshing" : "loading" }));
    loadFlights(icao, win.from, win.to, tick.fresh)
      .then((data) => alive && setState({ status: "ok", data, error: null }))
      .catch((e) => alive && setState((s) => ({ status: "error", data: s.data, error: e.code || e.message })));
    return () => { alive = false; };
  }, [icao, win.from, win.to, tick]);

  const flights = useMemo(() => (state.data?.flights || []).map(enrich), [state.data]);
  const pref = load(AIRLINE_KEY, null);
  // picksVersion：前の区間の便が決まったら推定し直す
  const allCands = useMemo(() => findCandidates(leg, flights), [leg, flights, picksVersion]);
  const cands = pref && allCands.some((c) => airlineOf(c.number) === pref) ? allCands.filter((c) => airlineOf(c.number) === pref) : allCands;
  const guess = guessOwn(leg, cands);
  const saved = savedPick(leg.key);
  const own = saved?.number ? flights.find((f) => f.dir === "ARR" && f.number === saved.number && f.other === leg.from) || null
    : saved?.manual ? null : guess;
  // 選んだ便がデータにないとき（時刻を指定したときも）は、保存した到着時刻を使う
  const center = own ? own.expMs : saved?.arr || null;

  // 後の区間の推定のために、推定した便の定刻の到着時刻を知らせる（遅れていても次の便は同じ機材で遅れて出るため）
  const chainArr = own ? own.schedMs : null;
  useEffect(() => {
    if (saved || !chainArr) return;
    if (autoArr.get(leg.key) !== chainArr) { autoArr.set(leg.key, chainArr); notify(); }
  }, [leg.key, chainArr, saved]);

  const setLayoutSaved = (v) => { setLayout(v); save(LAYOUT_KEY, v); };
  const refresh = () => setTick((t) => ({ n: t.n + 1, fresh: true }));

  const start = center ? center - HALF : null;
  const rows = center ? flights
    .filter((f) => (f.expMs >= start && f.expMs <= center + HALF) || (f.schedMs >= start && f.schedMs <= center + HALF))
    .sort((a, b) => a.expMs - b.expMs || a.schedMs - b.schedMs) : [];
  const arr = rows.filter((f) => f.dir === "ARR");
  const dep = rows.filter((f) => f.dir === "DEP");
  const delayed = rows.filter((f) => !f.canceled && (f.status === "Delayed" || f.lateMin >= DELAY_MIN)).length;
  const canceled = rows.filter((f) => f.canceled).length;
  const diverted = rows.filter((f) => f.diverted).length;
  const ownNumber = own?.number || null;

  // 並べ方：到着と出発で分ける／自分の到着の前と後で分ける
  const timeMode = layout === "time";
  const cols = narrow
    ? (timeMode ? "40px 56px 26px 62px 32px minmax(0,1fr)" : "40px 56px 62px 32px minmax(0,1fr)")
    : (timeMode ? "42px 64px 28px 68px 34px minmax(0,1fr) auto" : "42px 64px 68px 34px minmax(0,1fr) auto");
  let left = [], right = [], leftHead, rightHead;
  if (center) {
    if (timeMode) {
      left = rows.filter((f) => f.expMs < center);
      right = rows.filter((f) => f.expMs >= center);
      leftHead = ["到着の前の1時間", `${hhmm(start)}–${hhmm(center)} · ${left.length}便`];
      rightHead = ["到着の後の1時間", `${hhmm(center)}–${hhmm(center + HALF)} · ${right.length}便`];
    } else {
      left = arr;
      right = dep;
      leftHead = [`到着 ${arr.length}便`, "時刻順（遅れは見込み時刻）"];
      rightHead = [`出発 ${dep.length}便`, "点線が自分の到着"];
    }
  }
  // 便が多い空港（羽田など）は、自分の到着に近い便だけを先に見せる
  const trim = (list) => {
    if (expanded) return { shown: list, hidden: 0 };
    const before = list.filter((f) => f.expMs < center);
    const after = list.filter((f) => f.expMs >= center);
    const shown = [...before.slice(-SHOW_EACH_SIDE), ...after.slice(0, SHOW_EACH_SIDE)];
    return { shown, hidden: list.length - shown.length };
  };
  const renderList = (list, withDivider) => {
    const out = [];
    let placed = !withDivider;
    for (const f of list) {
      if (!placed && f.expMs >= center) { out.push(<Divider key="divider" t={center} />); placed = true; }
      out.push(<Row key={`${f.dir}-${f.number}-${f.schedMs}`} f={f} cols={cols} showDir={timeMode} showModel={!narrow} ownNumber={ownNumber} />);
    }
    if (!placed) out.push(<Divider key="divider" t={center} />);
    return out;
  };

  const chip = (bg, border, color) => ({ fontSize: FS.xs, padding: "4px 10px", borderRadius: "6px", background: bg, border: `1px solid ${border}`, color });
  const badge = saved?.number ? "選んだ便" : saved?.manual ? "時刻を指定" : cands.length > 1 ? `勤務から推定（候補 ${cands.length}便）` : "勤務から推定";
  const data = state.data;

  return (
    <section aria-label={`${icao} 到着前後の発着便`} style={{
      marginTop: "12px", padding: "10px 12px", borderRadius: "8px",
      background: "rgba(125,211,252,0.05)", border: "1px solid rgba(125,211,252,0.28)", display: "flex", flexDirection: "column", gap: "10px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: FS.xs, fontWeight: 700, letterSpacing: "1px", color: SKY }}>発着便</span>
        <span style={{ fontSize: FS.xs, color: C.textMuted }}>
          {center ? `${hhmm(start)}–${hhmm(center + HALF)} JST（自分の到着の前後1時間）` : "自分の到着の前後1時間"} · AeroDataBox
        </span>
        <span style={{ marginLeft: "auto", fontSize: FS.xs, color: C.textMuted }}>
          {state.status === "loading" ? "読み込み中…" : state.status === "refreshing" ? "更新中…" : data ? `取得 ${hhmm(toMs(data.fetchedAt))}${data.usedToday ? ` · 今日の取得 ${data.usedToday}回` : ""}` : ""}
        </span>
        <button type="button" onClick={refresh} disabled={state.status === "loading" || state.status === "refreshing"} style={{ ...actionBtnStyle, height: "32px", fontSize: FS.xs }}>更新</button>
      </div>

      {state.status === "error" && (
        <div style={{ fontSize: FS.xs, color: AMBER }}>
          {ERRORS[state.error] || "便のデータを取得できません。通信状態を確かめて「更新」を押してください。"}
        </div>
      )}

      {data && (choosing ? (
        <Chooser leg={leg} cands={allCands} guess={guess} ownNumber={ownNumber} onDone={() => setChoosing(false)} />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ fontSize: FS.xs, color: C.textSub }}>自分の便</span>
            {own ? (
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", padding: "7px 12px", borderRadius: "8px", background: "rgba(110,231,183,0.10)", border: "1px solid rgba(110,231,183,0.45)" }}>
                <span style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700 }}>{own.number}</span>
                <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: C.textSub }}>{leg.from} {Number.isFinite(own.otherSchedMs) ? hhmm(own.otherSchedMs) : ""} → {leg.to}</span>
                <span style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700, color: C.accent }}>{hhmm(own.schedMs)}</span>
                {Math.abs(own.lateMin) >= LATE_MIN && <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: own.lateMin > 0 ? AMBER : SKY }}>見込み {hhmm(own.expMs)}{own.fromOrigin ? "頃" : ""}</span>}
                <span style={{ fontSize: FS.xs, color: C.textSub }}>JST（{hhmmZ(own.schedMs)}）{own.model ? ` · ${shortModel(own.model)}` : ""}</span>
              </span>
            ) : center ? (
              <span style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700, color: C.accent }}>{hhmm(center)} <span style={{ fontFamily: FONT.ui, fontSize: FS.xs, color: C.textSub, fontWeight: 400 }}>JST（{hhmmZ(center)}）</span></span>
            ) : (
              <span style={{ fontSize: FS.sm, color: C.textSub }}>{leg.from} から {leg.to} に着く便が見つかりません</span>
            )}
            {center && <span style={{ fontSize: FS.xs, fontWeight: 700, padding: "3px 8px", borderRadius: "4px", background: "rgba(148,163,184,0.16)", color: C.text }}>{badge}</span>}
            <button type="button" onClick={() => setChoosing(true)} style={{ ...actionBtnStyle, height: "36px", fontSize: FS.xs }}>{center ? "便を変える" : "便・時刻を指定"}</button>
            {center && (
              <Segmented
                options={[{ key: "dir", label: "到着と出発で分ける" }, { key: "time", label: "到着の前と後で分ける" }]}
                value={layout} onChange={setLayoutSaved} label="並べ方" height={36} style={{ marginLeft: "auto" }}
              />
            )}
          </div>

          {center && (
            <>
              <div style={{ display: "flex", alignItems: "flex-end", gap: "20px", flexWrap: "wrap" }}>
                <TrafficBars rows={rows} start={start} center={center} />
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingBottom: "18px" }}>
                  <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: FS.xs, color: C.textSub }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "10px", height: "8px", borderRadius: "2px", background: SKY }} />到着（線の上）</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "10px", height: "8px", borderRadius: "2px", background: VIOLET }} />出発（線の下）</span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "2px", height: "10px", background: C.accent }} />自分の到着</span>
                  </div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    <span style={chip("rgba(15,23,42,0.6)", C.border, C.text)}>到着 <b style={{ fontFamily: FONT.data }}>{arr.length}</b> · 出発 <b style={{ fontFamily: FONT.data }}>{dep.length}</b></span>
                    {delayed > 0 && <span style={chip("rgba(251,191,36,0.10)", "rgba(251,191,36,0.35)", AMBER)}>遅れ <b style={{ fontFamily: FONT.data }}>{delayed}</b></span>}
                    {canceled > 0 && <span style={chip("rgba(248,113,113,0.10)", "rgba(248,113,113,0.35)", RED)}>欠航 <b style={{ fontFamily: FONT.data }}>{canceled}</b></span>}
                    {diverted > 0 && <span style={chip("rgba(248,113,113,0.10)", "rgba(248,113,113,0.35)", RED)}>ダイバート <b style={{ fontFamily: FONT.data }}>{diverted}</b></span>}
                  </div>
                  <span style={{ fontSize: FS.xs, color: C.textMuted }}>15分ごとの数。欠航は数えず、遅れている便は見込み時刻で数えます</span>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: "14px" }}>
                {[[leftHead, left, !timeMode && !ownNumber], [rightHead, right, !timeMode]].map(([head, list, divider], i) => {
                  const { shown, hidden } = trim(list);
                  return (
                    <div key={i} style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minHeight: "22px", padding: "0 8px", borderBottom: `1px solid ${C.border}` }}>
                        <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{head[0]}</span>
                        <span style={{ fontSize: FS.xs, color: C.textMuted }}>{head[1]}</span>
                      </div>
                      <ol aria-label={head[0]} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
                        {shown.length ? renderList(shown, divider) : <li style={{ fontSize: FS.xs, color: C.textMuted, padding: "6px 8px" }}>なし</li>}
                      </ol>
                      {hidden > 0 && (
                        <span style={{ fontSize: FS.xs, color: C.textMuted, padding: "4px 8px" }}>自分の到着に近い {shown.length}便を表示（ほか {hidden}便）</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {(trim(left).hidden > 0 || trim(right).hidden > 0 || expanded) && (
                <button type="button" onClick={() => setExpanded((v) => !v)} style={{ ...actionBtnStyle, alignSelf: "flex-start", height: "36px", fontSize: FS.xs }}>
                  {expanded ? "近い便だけ表示" : `すべて表示（${rows.length}便）`}
                </button>
              )}
            </>
          )}
        </>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", fontSize: FS.xs, color: C.textMuted }}>
        <span>時刻は JST。「→」は見込み時刻、「頃」は出発空港での遅れから出した目安です（参考）。</span>
        <span style={{ marginLeft: "auto" }}><ExtLink href={`https://www.flightaware.com/live/airport/${icao}`}>FlightAware {icao}</ExtLink></span>
      </div>
    </section>
  );
}

// legs：この空港に着く本日の乗務の区間（WeatherBriefing の getDutyArrivalLegs）
export default function FlightTraffic({ icao, legs }) {
  if (!legs?.length || BUSY_AIRPORTS.has(icao)) return null;
  return legs.map((leg) => <LegTraffic key={leg.key} icao={icao} leg={leg} />);
}
