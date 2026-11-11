/* ============================================================
   空港付近の火山（TERMINAL の METAR/TAF カードに表示）
   鹿児島（RJFK）・宮崎（RJFM）：桜島・霧島山（新燃岳）
   - 噴火警戒レベル：気象庁 warning.json
   - 降灰予報：気象庁 ashfall/{火山}.json の降灰範囲に空港が入る時間帯を判定
     （定時の予報は「その時間に噴火した場合」の範囲）
   - VAA：東京 VAAC（Worker 経由）、火山灰の SIGMET：AWC の国際 SIGMET
   ============================================================ */
import { useState, useEffect } from "react";
import { ExtLink } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import { WORKER_URL, pad } from "./DomesticWxPanel.jsx";

const VOLC = "https://www.jma.go.jp/bosai/volcano/data";
const WARNING_URL = `${VOLC}/warning.json`;
const ASH_INDEX_URL = `${VOLC}/ashfall/japan.json`;
const ashUrl = (code) => `${VOLC}/ashfall/${code}.json`;
const VAAC_URL = `${WORKER_URL}/vaac/?volcano=SAKURAJIMA,KIRISHIMA&hours=24`;
const SIGMET_URL = `${WORKER_URL}/api/data/isigmet?format=json`;
const REFRESH_MS = 5 * 60e3;

const VOLCANOES = {
  "506": { name: "桜島", vaac: "SAKURAJIMA", lat: 31.593, lon: 130.657 },
  "551": { name: "霧島山（新燃岳）", vaac: "KIRISHIMA", lat: 31.909, lon: 130.886 },
};
// 霧島山のほかの火口：警報が出ているときだけ表示
const EXTRA_WHEN_WARNED = { "551": [["550", "霧島山（御鉢）"], ["552", "霧島山（えびの高原（硫黄山）周辺）"], ["553", "霧島山（大幡池）"]] };

export const AIRPORT_VOLCANOES = {
  RJFK: { lat: 31.8034, lon: 130.7194, codes: ["506", "551"] },
  RJFM: { lat: 31.8772, lon: 131.4486, codes: ["551", "506"] },
};

// オフライン保存（PREFLIGHT）で一緒に取っておく URL
export const volcanoUrls = () => [WARNING_URL, ASH_INDEX_URL, ...Object.keys(VOLCANOES).map(ashUrl), VAAC_URL];

/* ---------- 取得（同じ URL は5分間使い回す） ---------- */
const store = new Map();
function getJson(url) {
  const hit = store.get(url);
  if (hit && Date.now() - hit.t < REFRESH_MS) return hit.p;
  const p = fetch(url, { cache: "no-cache" }).then(async (r) => {
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const t = await r.text();
    return t.trim() ? JSON.parse(t) : null;
  });
  store.set(url, { t: Date.now(), p });
  p.catch(() => store.delete(url));
  return p;
}

/* ---------- 計算 ---------- */
const toRad = (d) => (d * Math.PI) / 180;
function distanceBearing(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.sqrt(h));
  const y = Math.sin(dLon) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const dirs = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];
  return { km: Math.round(km), dir: dirs[Math.round(deg / 22.5) % 16] };
}
// "+31.7517+130.4600/+31.7400+130.4764/…" → [[lat, lon], …]
const parsePolygon = (s) => [...s.matchAll(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/g)].map((m) => [+m[1], +m[2]]);
function inside([lat, lon], poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// 降灰予報の各時間帯で、空港が範囲に入る項目（降灰・小さな噴石・少量など）
function ashForecasts(data, ap) {
  if (!data) return [];
  return Object.values(data).filter((f) => f && Array.isArray(f.ashinfos)).map((f) => ({
    title: (f.headTitle || "").replace(/^火山名[\s　]*\S+[\s　]*/, "") || "降灰予報",
    scheduled: f.type === "scheduled" || /定時/.test(f.headTitle || ""),
    report: f.reportDatetime, valid: f.validDatetime,
    periods: f.ashinfos.map((a) => ({
      start: a.startTime, end: a.endTime,
      hits: (a.items || []).filter((it) => (it.polygons || []).some((p) => inside([ap.lat, ap.lon], parsePolygon(p)))).map((it) => it.name),
    })),
  }));
}
// 噴火警報・予報（対象火山）→ { 火山コード: { name, level, time } }
function warningMap(list) {
  const map = {};
  for (const e of list || []) {
    for (const vi of e.volcanoInfos || []) {
      if (vi.type !== "噴火警報・予報（対象火山）") continue;
      for (const it of vi.items || []) {
        const code = +it.code;
        for (const a of it.areas || []) map[a.code] = { name: it.name, level: code >= 11 && code <= 15 ? code - 10 : null, time: e.reportDatetime };
      }
    }
  }
  return map;
}

/* ---------- 表示 ---------- */
const jst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3);
const dayHourJst = (iso) => { const d = jst(iso); return `${d.getUTCDate()}日 ${pad(d.getUTCHours())}時`; };
function periodLabel(start, end) {
  const s = new Date(start), e = new Date(end), sj = jst(start), ej = jst(end);
  return `${sj.getUTCDate()}日 ${pad(sj.getUTCHours())}–${pad(ej.getUTCHours())}時 JST（${pad(s.getUTCHours())}–${pad(e.getUTCHours())}Z）`;
}
const dayHhmmZ = (iso) => { const d = new Date(iso); return `${pad(d.getUTCDate())}日 ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
const LEVEL_COLOR = { 1: "#94a3b8", 2: "#facc15", 3: "#fb923c", 4: "#f87171", 5: "#c084fc" };

function LevelBadge({ w }) {
  if (!w) return <span style={{ fontSize: FS.xs, color: C.textMuted }}>噴火警報なし</span>;
  const color = LEVEL_COLOR[w.level] || "#fb923c";
  return (
    <span style={{ fontSize: FS.xs, fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: `${color}22`, border: `1px solid ${color}88`, color }}>
      {w.name.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))}
    </span>
  );
}

function RawToggle({ label, text }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} style={{
        height: "28px", padding: "0 10px", borderRadius: "6px", cursor: "pointer", fontFamily: "inherit", fontSize: FS.xs,
        background: open ? "rgba(110,231,183,0.12)" : "transparent", border: `1px solid ${open ? "rgba(110,231,183,0.5)" : C.border}`,
        color: open ? C.accent : C.textSub,
      }}>{label}</button>
      {open && (
        <pre style={{ flexBasis: "100%", margin: "4px 0 0", padding: "8px 10px", borderRadius: "6px", background: "rgba(0,0,0,0.35)", fontFamily: FONT.data, fontSize: FS.xs, lineHeight: 1.6, color: C.text, whiteSpace: "pre-wrap" }}>{text}</pre>
      )}
    </>
  );
}

export default function VolcanoInfo({ icao }) {
  const ap = AIRPORT_VOLCANOES[icao];
  const [tick, setTick] = useState(0);
  const [st, setSt] = useState({ warnings: null, ash: {}, vaac: null, sigmets: null, errors: [] });

  useEffect(() => {
    if (!ap) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [ap]);

  useEffect(() => {
    if (!ap) return undefined;
    let alive = true;
    const errors = [];
    const fail = (what) => () => { errors.push(what); return null; };
    (async () => {
      const [warn, index, vaac, sig] = await Promise.all([
        getJson(WARNING_URL).catch(fail("噴火警報")),
        getJson(ASH_INDEX_URL).catch(fail("降灰予報")),
        getJson(VAAC_URL).catch(fail("VAA")),
        getJson(SIGMET_URL).catch(fail("SIGMET")),
      ]);
      const ash = {};
      await Promise.all(ap.codes.filter((c) => index && index[c]).map((c) => getJson(ashUrl(c)).then((d) => { ash[c] = d; }).catch(fail("降灰予報"))));
      if (alive) setSt({ warnings: warningMap(warn), ash, vaac, sigmets: Array.isArray(sig) ? sig : [], index, errors: [...new Set(errors)] });
    })();
    return () => { alive = false; };
  }, [ap, tick]);

  if (!ap) return null;
  const vaSigmets = (st.sigmets || []).filter((s) => s.hazard === "VA" && ap.codes.some((c) => (s.rawSigmet || "").toUpperCase().includes(VOLCANOES[c].vaac)));

  return (
    <section aria-label={`${icao} 付近の火山`} style={{
      marginTop: "12px", padding: "10px 12px", borderRadius: "8px",
      background: "rgba(251,146,60,0.05)", border: "1px solid rgba(251,146,60,0.28)", display: "flex", flexDirection: "column", gap: "10px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: FS.xs, fontWeight: 700, letterSpacing: "1px", color: "#fdba74" }}>火山</span>
        <span style={{ fontSize: FS.xs, color: C.textMuted }}>噴火警戒レベル・降灰予報・VAA・火山灰の SIGMET</span>
        {st.errors.length > 0 && <span style={{ fontSize: FS.xs, color: "#fcd34d" }}>取得できません：{st.errors.join("・")}</span>}
      </div>

      {ap.codes.map((code) => {
        const v = VOLCANOES[code];
        const db = distanceBearing(ap, v);
        const w = st.warnings?.[code];
        const extras = (EXTRA_WHEN_WARNED[code] || []).filter(([c]) => st.warnings?.[c]);
        const forecasts = ashForecasts(st.ash[code], ap);
        const vaas = (st.vaac?.items || []).filter((it) => it.volcano.toUpperCase().includes(v.vaac));
        const latest = st.vaac?.latest?.[v.vaac] || null;
        return (
          <div key={code} style={{ display: "flex", flexDirection: "column", gap: "6px", paddingTop: "8px", borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{v.name}</span>
              {st.warnings ? <LevelBadge w={w} /> : <span style={{ fontSize: FS.xs, color: C.textMuted }}>読み込み中…</span>}
              {extras.map(([c, name]) => (
                <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontSize: FS.xs, color: C.textSub }}>{name}</span><LevelBadge w={st.warnings[c]} />
                </span>
              ))}
              <span style={{ fontSize: FS.xs, color: C.textMuted }}>空港から{db.dir} {db.km}km</span>
            </div>

            {/* 降灰予報 */}
            {st.index && !st.index[code] && <div style={{ fontSize: FS.xs, color: C.textSub }}>降灰予報：発表なし</div>}
            {forecasts.map((f) => {
              const now = Date.now();
              // 終わった時間帯は出さない。有効期間を過ぎた予報はその旨を添える
              const hits = f.periods.filter((p) => p.hits.length && new Date(p.end).getTime() > now);
              const expired = f.valid && new Date(f.valid).getTime() < now;
              const title = f.scheduled ? f.title.replace(/）$/, "・噴火した場合）") : f.title;
              return (
                <div key={f.title} style={{ display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap", fontSize: FS.xs }}>
                  <span style={{ color: C.textSub, minWidth: "8em" }}>{title}</span>
                  {hits.length ? hits.map((p) => (
                    <span key={p.start} style={{ fontWeight: 700, color: "#fdba74", fontFamily: FONT.data }}>
                      {periodLabel(p.start, p.end)} {icao} {p.hits.join("・")}
                    </span>
                  )) : (
                    <span style={{ color: C.text }}>{f.valid ? `${dayHourJst(f.valid)} JST まで、${icao} は降灰の予想範囲外` : `${icao} は降灰の予想範囲外`}</span>
                  )}
                  <span style={{ color: expired ? "#fcd34d" : C.textMuted }}>発表 {dayHourJst(f.report)}{expired ? "・有効期間を過ぎています" : ""}</span>
                </div>
              );
            })}

            {/* VAA */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: FS.xs }}>
              <span style={{ color: C.textSub, minWidth: "8em" }}>VAA（東京 VAAC）</span>
              {st.vaac === null && <span style={{ color: C.textMuted }}>{st.errors.includes("VAA") ? "—" : "読み込み中…"}</span>}
              {st.vaac && vaas.length === 0 && (
                <span style={{ color: C.text }}>直近24時間なし{latest ? <span style={{ color: C.textMuted }}>（最新 {dayHhmmZ(latest.time)}・{latest.number}）</span> : null}</span>
              )}
            </div>
            {vaas.map((it) => {
              const detail = (it.text || "").split("\n").find((l) => l.startsWith("ERUPTION DETAILS:"));
              return (
                <div key={it.number} style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: FS.xs, paddingLeft: "8px" }}>
                  <span style={{ fontFamily: FONT.data, fontWeight: 700, color: "#fdba74" }}>{dayHhmmZ(it.time)}</span>
                  <span style={{ fontFamily: FONT.data, color: C.textSub }}>{it.number}</span>
                  {detail && <span style={{ fontFamily: FONT.data, color: C.text }}>{detail.replace("ERUPTION DETAILS: ", "")}</span>}
                  {it.text && <RawToggle label="原文" text={it.text} />}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* 火山灰の SIGMET */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", fontSize: FS.xs, paddingTop: "8px", borderTop: `1px solid ${C.border}` }}>
        <span style={{ color: C.textSub, minWidth: "8em" }}>火山灰の SIGMET</span>
        {st.sigmets === null ? <span style={{ color: C.textMuted }}>{st.errors.includes("SIGMET") ? "—" : "読み込み中…"}</span>
          : vaSigmets.length === 0 ? <span style={{ color: C.text }}>なし</span>
          : vaSigmets.map((s) => (
            <pre key={`${s.seriesId}-${s.validTimeFrom}`} style={{ flexBasis: "100%", margin: 0, padding: "8px 10px", borderRadius: "6px", background: "rgba(0,0,0,0.35)", fontFamily: FONT.data, fontSize: FS.xs, lineHeight: 1.6, color: C.text, whiteSpace: "pre-wrap" }}>
              {(s.rawSigmet || "").trim()}
            </pre>
          ))}
      </div>

      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        <ExtLink href="https://www.jma.go.jp/bosai/map.html#9/31.75/130.75/&contents=ashfall">気象庁 降灰予報</ExtLink>
        <ExtLink href="https://www.jma.go.jp/bosai/map.html#9/31.75/130.75/&contents=volcano">気象庁 噴火警報</ExtLink>
        <ExtLink href="https://ds.data.jma.go.jp/svd/vaac/data/vaac_list.html">東京 VAAC</ExtLink>
      </div>
    </section>
  );
}
