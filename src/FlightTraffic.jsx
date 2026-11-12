/* ============================================================
   TERMINAL — 乗務の目的地に着く便（自分の到着の前後1時間）
   - 到着便だけを出す。出発便は出さない（2026-11-13 利用者の判断）
   - 今日の乗務に加えて、明日の乗務の分も前の日から出す
   - 便は AeroDataBox（RapidAPI）を Worker 経由で取る（/flights/）。回数に上限があるので Worker の KV に保存して使い回す
   - 自分の到着便は、勤務予定（ICS の説明欄）の便名・出発空港・時刻で時刻表から探す。
     見つからないときだけ、便か時刻を選べる（端末に保存）
   - 便が多すぎる大空港（羽田・成田・関西・伊丹・新千歳・福岡・那覇・中部）には出さない
   - 時刻表で十分（利用者の判断）。到着便は、出発空港での遅れ・離陸がわかればそれも添える
   ============================================================ */
import { useState, useEffect, useMemo } from "react";
import { ExtLink, actionBtnStyle } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import { WORKER_URL } from "./DomesticWxPanel.jsx";

const JST = 9 * 3600e3;
const MIN = 60e3;
const HOUR = 60 * MIN;
const HALF = HOUR;                // 自分の到着の前後1時間
const BIN = 15 * MIN;             // 到着の数を数える幅
const BINS = (2 * HALF) / BIN;
const MAX_WINDOW = 12 * HOUR;     // AeroDataBox で1回に取れる幅
const STEP = 30 * MIN;            // 取る時間帯の区切り（Worker の保存の単位）
const MATCH_RANGE = 3 * HOUR;     // 勤務予定と時刻表の到着時刻のずれの許容（済んだ便は ICS の時刻が実績に変わるらしいので広め）
const CLIENT_CACHE_MS = 10 * MIN;
const LATE_MIN = 5;               // これ以上ずれたら見込み時刻を出す
const DELAY_MIN = 15;             // 遅延として数える
const SHOW_EACH_SIDE = 6;         // 一覧で、自分の到着の前と後にそれぞれ先に見せる便の数
const PICKS_KEY = "traffic_picks";
const SKY = "#7dd3fc", AMBER = "#fcd34d", RED = "#fca5a5";
// 便が多すぎて一覧にしても役に立たない大空港（2026-11-12 利用者の判断）
const BUSY_AIRPORTS = new Set(["RJTT", "RJAA", "RJBB", "RJOO", "RJCC", "RJFF", "ROAH", "RJGG"]);

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (t) => { const d = new Date(t + JST); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const hhmmZ = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
const localStr = (t) => new Date(t + JST).toISOString().slice(0, 16);
const toMs = (iso) => (iso ? Date.parse(iso) : NaN);
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

// 取る時間帯：勤務予定の到着の2時間前から3時間後まで（遅れても前後1時間が入るように）
function fetchWindow(arrs) {
  return {
    from: Math.floor((Math.min(...arrs) - 2 * HOUR) / STEP) * STEP,
    to: Math.ceil((Math.max(...arrs) + 3 * HOUR) / STEP) * STEP,
  };
}

/* ---------- 自分の便 ---------- */
// 選び直した便・時刻は、区間ごとに端末に保存する
const savedPick = (legKey) => load(PICKS_KEY, {})[legKey] || null;
function storePick(legKey, pick) {
  const all = load(PICKS_KEY, {});
  if (pick) all[legKey] = { ...pick, at: Date.now() }; else delete all[legKey];
  const keys = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
  while (keys.length > 30) delete all[keys.shift()];
  save(PICKS_KEY, all);
}

// 便名の数字（"JL 641" → "641"）。ICS の便名には会社コードがない
const flightDigits = (s) => (String(s || "").match(/\d+/)?.[0] || "").replace(/^0+/, "");

// 勤務予定の便：便名の数字と出発空港が同じで、到着時刻がいちばん近い便
function findOwn(leg, flights) {
  const no = flightDigits(leg.no);
  if (!no) return null;
  let best = null;
  for (const f of flights) {
    if (f.dir !== "ARR" || flightDigits(f.number) !== no || (f.other && f.other !== leg.from)) continue;
    const gap = Math.abs(f.schedMs - leg.arr);
    if (gap <= MATCH_RANGE && (!best || gap < Math.abs(best.schedMs - leg.arr))) best = f;
  }
  return best;
}

// 選び直すときの候補：同じ空港から、勤務予定の到着の前後3時間に着く便
const findCandidates = (leg, flights) => flights
  .filter((f) => f.dir === "ARR" && !f.cargo && f.other === leg.from && Math.abs(f.schedMs - leg.arr) <= MATCH_RANGE)
  .sort((a, b) => a.schedMs - b.schedMs);
const nearestTo = (t, list) => list.reduce((a, b) => (!a || Math.abs(b.schedMs - t) < Math.abs(a.schedMs - t) ? b : a), null);

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

function Row({ f, cols, showModel, ownNumber }) {
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

// 15分ごとの到着の数（緑の線が自分の到着）
function TrafficBars({ rows, start, center }) {
  const bins = Array(BINS).fill(0);
  for (const f of rows) {
    if (f.canceled) continue;
    const i = Math.floor((f.expMs - start) / BIN);
    if (i < 0 || i > BINS) continue;
    bins[Math.min(BINS - 1, i)]++;
  }
  const max = Math.max(1, ...bins);
  const H = 40;
  const pos = `${((center - start) / (2 * HALF)) * 100}%`;
  return (
    <figure aria-label="15分ごとの到着の数" style={{ margin: 0, width: "min(100%, 560px)", position: "relative" }}>
      <div style={{ display: "flex" }}>
        {bins.map((n, i) => (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: `${H + 12}px`, borderLeft: "1px solid rgba(148,163,184,0.10)" }}>
            {n > 0 && <span style={{ fontFamily: FONT.data, fontSize: "10px", color: C.textMuted, lineHeight: "12px" }}>{n}</span>}
            <span style={{ width: "60%", height: `${Math.round((H * n) / max)}px`, borderRadius: "2px", background: SKY }} />
          </div>
        ))}
      </div>
      <div style={{ height: "1px", background: "rgba(148,163,184,0.35)" }} />
      <div style={{ position: "absolute", left: pos, top: 0, height: `${H + 13}px`, borderLeft: `2px solid ${C.accent}` }} />
      <div style={{ position: "relative", height: "16px", fontFamily: FONT.data, fontSize: FS.xs, color: C.textMuted }}>
        <span style={{ position: "absolute", left: 0 }}>{hhmm(start)}</span>
        <span style={{ position: "absolute", left: pos, transform: "translateX(-50%)", color: C.accent, fontWeight: 700 }}>{hhmm(center)}</span>
        <span style={{ position: "absolute", right: 0 }}>{hhmm(start + 2 * HALF)}</span>
      </div>
    </figure>
  );
}

// 勤務予定の便が時刻表に見つからないときなどに、自分の到着便か到着時刻を選ぶ
function Chooser({ leg, cands, matched, ownNumber, onDone }) {
  const near = matched || nearestTo(leg.arr, cands);
  const [sel, setSel] = useState(ownNumber || near?.number || "");
  const [manual, setManual] = useState("");
  const saved = savedPick(leg.key);

  const confirm = () => {
    const f = cands.find((c) => c.number === sel);
    if (!f) return;
    storePick(leg.key, { number: f.number, arr: f.schedMs });
    onDone();
  };
  const confirmManual = () => {
    const m = manual.match(/^(\d{2}):(\d{2})$/);
    if (!m) return;
    // 勤務予定の到着にいちばん近いその時刻（JST）
    let t = Math.floor((leg.arr + JST) / 86400e3) * 86400e3 - JST + (+m[1] * 60 + +m[2]) * MIN;
    if (t - leg.arr > 12 * HOUR) t -= 86400e3; else if (leg.arr - t > 12 * HOUR) t += 86400e3;
    storePick(leg.key, { manual, arr: t });
    onDone();
  };
  const reset = () => { storePick(leg.key, null); onDone(); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>自分の到着便を選んでください</div>
        <div style={{ fontSize: FS.sm, color: C.textSub, marginTop: "2px" }}>
          勤務予定では {leg.no}便 {leg.from} {hhmm(leg.dep)} → {leg.to} {hhmm(leg.arr)} JST です。
          {matched ? "" : "時刻表にこの便名が見つからないので、"}{leg.from} から前後3時間に着く便を出しています。
        </div>
      </div>
      {cands.length > 0 ? (
        <div role="radiogroup" aria-label="到着便の候補" style={{ display: "flex", flexDirection: "column", gap: "6px", maxWidth: "680px" }}>
          {cands.map((c) => {
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
                <span style={{ fontSize: FS.xs, color: C.textSub, whiteSpace: "nowrap" }}>
                  {near && c.number === near.number ? (matched ? "勤務予定の便" : "勤務予定に近い") : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: FS.sm, color: C.textSub }}>{leg.from} から {leg.to} に着く便が見つかりません。</div>
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
        {saved && <button type="button" onClick={reset} style={actionBtnStyle}>勤務予定の便に戻す</button>}
        <button type="button" onClick={onDone} style={actionBtnStyle}>やめる</button>
      </div>
      <div style={{ fontSize: FS.xs, color: C.textMuted }}>選んだ便・時刻は端末に保存し、この区間で使います。</div>
    </div>
  );
}

function LegTraffic({ icao, leg, win }) {
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [tick, setTick] = useState({ n: 0, fresh: false });
  const [choosing, setChoosing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const narrow = useNarrow();

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, status: s.data ? "refreshing" : "loading" }));
    loadFlights(icao, win.from, win.to, tick.fresh)
      .then((data) => alive && setState({ status: "ok", data, error: null }))
      .catch((e) => alive && setState((s) => ({ status: "error", data: s.data, error: e.code || e.message })));
    return () => { alive = false; };
  }, [icao, win.from, win.to, tick]);

  const flights = useMemo(() => (state.data?.flights || []).map(enrich), [state.data]);
  const matched = useMemo(() => findOwn(leg, flights), [leg, flights]);
  const saved = savedPick(leg.key);
  const own = saved?.number ? flights.find((f) => f.dir === "ARR" && f.number === saved.number && f.other === leg.from) || null
    : saved?.manual ? null : matched;
  // 自分の便が時刻表にないとき（時刻を指定したときも）は、保存した時刻か勤務予定の到着時刻を使う
  const center = own ? own.expMs : saved?.arr || leg.arr;

  const refresh = () => setTick((t) => ({ n: t.n + 1, fresh: true }));

  // 到着便だけ（出発便は出さない）
  const start = center - HALF;
  const rows = flights
    .filter((f) => f.dir === "ARR" && ((f.expMs >= start && f.expMs <= center + HALF) || (f.schedMs >= start && f.schedMs <= center + HALF)))
    .sort((a, b) => a.expMs - b.expMs || a.schedMs - b.schedMs);
  const delayed = rows.filter((f) => !f.canceled && (f.status === "Delayed" || f.lateMin >= DELAY_MIN)).length;
  const canceled = rows.filter((f) => f.canceled).length;
  const diverted = rows.filter((f) => f.diverted).length;
  const ownNumber = own?.number || null;
  const cols = narrow ? "40px 56px 62px 32px minmax(0,1fr)" : "42px 64px 68px 34px minmax(0,1fr) auto";
  // 便が多い空港は、自分の到着に近い便だけを先に見せる
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
      out.push(<Row key={`${f.dir}-${f.number}-${f.schedMs}`} f={f} cols={cols} showModel={!narrow} ownNumber={ownNumber} />);
    }
    if (!placed) out.push(<Divider key="divider" t={center} />);
    return out;
  };
  const { shown, hidden } = trim(rows);

  const chip = (bg, border, color) => ({ fontSize: FS.xs, padding: "4px 10px", borderRadius: "6px", background: bg, border: `1px solid ${border}`, color });
  // 自分の便の出どころ（勤務予定の便名で見つけた／選び直した／見つからない）
  const [badge, badgeColor, badgeBg] = saved?.number ? ["選んだ便", C.text, "rgba(148,163,184,0.16)"]
    : saved?.manual ? ["時刻を指定", C.text, "rgba(148,163,184,0.16)"]
    : own ? ["勤務予定の便", C.text, "rgba(148,163,184,0.16)"]
    : ["時刻表に見つかりません", ...TONE.warn];
  const data = state.data;

  return (
    <section aria-label={`${icao} 自分の到着の前後の到着便`} style={{
      marginTop: "12px", padding: "10px 12px", borderRadius: "8px",
      background: "rgba(125,211,252,0.05)", border: "1px solid rgba(125,211,252,0.28)", display: "flex", flexDirection: "column", gap: "10px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: FS.xs, fontWeight: 700, letterSpacing: "1px", color: SKY }}>到着便</span>
        {leg.when && (
          <span style={{ fontSize: FS.xs, fontWeight: 700, padding: "2px 8px", borderRadius: "4px", color: SKY, background: "rgba(125,211,252,0.14)" }}>{leg.when}</span>
        )}
        <span style={{ fontSize: FS.xs, color: C.textMuted }}>
          {hhmm(start)}–{hhmm(center + HALF)} JST（自分の到着の前後1時間） · AeroDataBox
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
        <Chooser leg={leg} cands={findCandidates(leg, flights)} matched={matched} ownNumber={ownNumber} onDone={() => setChoosing(false)} />
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
            ) : (
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap", padding: "7px 12px", borderRadius: "8px", background: "rgba(15,23,42,0.6)", border: `1px solid ${C.border}` }}>
                <span style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700 }}>{saved?.manual ? "到着" : saved?.number || `${leg.no}便`}</span>
                {!saved?.manual && <span style={{ fontFamily: FONT.data, fontSize: FS.sm, color: C.textSub }}>{leg.from} {saved?.number ? "" : hhmm(leg.dep)} → {leg.to}</span>}
                <span style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700, color: C.accent }}>{hhmm(center)}</span>
                <span style={{ fontSize: FS.xs, color: C.textSub }}>JST（{hhmmZ(center)}）</span>
              </span>
            )}
            <span style={{ fontSize: FS.xs, fontWeight: 700, padding: "3px 8px", borderRadius: "4px", background: badgeBg, color: badgeColor }}>{badge}</span>
            {(saved || !own) && (
              <button type="button" onClick={() => setChoosing(true)} style={{ ...actionBtnStyle, height: "36px", fontSize: FS.xs }}>{saved ? "便を変える" : "便・時刻を指定"}</button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: "20px", flexWrap: "wrap" }}>
            <TrafficBars rows={rows} start={start} center={center} />
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingBottom: "18px" }}>
              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: FS.xs, color: C.textSub }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "10px", height: "8px", borderRadius: "2px", background: SKY }} />15分ごとの到着の数</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}><span style={{ width: "2px", height: "10px", background: C.accent }} />自分の到着</span>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <span style={chip("rgba(15,23,42,0.6)", C.border, C.text)}>到着 <b style={{ fontFamily: FONT.data }}>{rows.length}</b></span>
                {delayed > 0 && <span style={chip("rgba(251,191,36,0.10)", "rgba(251,191,36,0.35)", AMBER)}>遅れ <b style={{ fontFamily: FONT.data }}>{delayed}</b></span>}
                {canceled > 0 && <span style={chip("rgba(248,113,113,0.10)", "rgba(248,113,113,0.35)", RED)}>欠航 <b style={{ fontFamily: FONT.data }}>{canceled}</b></span>}
                {diverted > 0 && <span style={chip("rgba(248,113,113,0.10)", "rgba(248,113,113,0.35)", RED)}>ダイバート <b style={{ fontFamily: FONT.data }}>{diverted}</b></span>}
              </div>
              <span style={{ fontSize: FS.xs, color: C.textMuted }}>欠航は数えず、遅れている便は見込み時刻で数えます</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, maxWidth: "720px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minHeight: "22px", padding: "0 8px", borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>到着 {rows.length}便</span>
              <span style={{ fontSize: FS.xs, color: C.textMuted }}>時刻順（遅れは見込み時刻）</span>
            </div>
            <ol aria-label="到着便" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
              {shown.length ? renderList(shown, !ownNumber) : <li style={{ fontSize: FS.xs, color: C.textMuted, padding: "6px 8px" }}>なし</li>}
            </ol>
            {hidden > 0 && (
              <span style={{ fontSize: FS.xs, color: C.textMuted, padding: "4px 8px" }}>自分の到着に近い {shown.length}便を表示（ほか {hidden}便）</span>
            )}
          </div>
          {(hidden > 0 || expanded) && (
            <button type="button" onClick={() => setExpanded((v) => !v)} style={{ ...actionBtnStyle, alignSelf: "flex-start", height: "36px", fontSize: FS.xs }}>
              {expanded ? "近い便だけ表示" : `すべて表示（${rows.length}便）`}
            </button>
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

// legs：この空港に着く今日と明日の乗務の区間（WeatherBriefing の getDutyArrivalLegs。便名・時刻は勤務予定の ICS の説明欄のもの。
// 明日の区間には when に日付が入る）
export default function FlightTraffic({ icao, legs }) {
  if (!legs?.length || BUSY_AIRPORTS.has(icao)) return null;
  // 同じ空港に何度か着く日は、12時間に収まれば1回でまとめて取る（同じ URL になるので保存も共有）
  const all = fetchWindow(legs.map((l) => l.arr));
  return legs.map((leg) => (
    <LegTraffic key={leg.key} icao={icao} leg={leg} win={all.to - all.from <= MAX_WINDOW ? all : fetchWindow([leg.arr])} />
  ));
}
