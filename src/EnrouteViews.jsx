/* ============================================================
   ENROUTE — 毎時大気解析（断面図・平面図）
   経度4断面・4高度の一覧と、1枚ずつ（全経度・主要航空路・全FL）の表示を切り替える。
   時刻は1時間毎（気象庁 list_maiji.js）。図はタップで全画面、減光の設定は他の図と共有
   ============================================================ */
import { useState, useEffect } from "react";
import { PanelFrame, ExtLink, Segmented, actionBtnStyle } from "./ui.jsx";
import { C, FS, FONT } from "./theme.js";
import { CROSS_OPTS, PLANE_OPTS, fetchMaijiTimes, maijiCrossUrl, maijiPlaneUrl, parseTs, pad } from "./DomesticWxPanel.jsx";
import { ChartFigure, ChartViewer, useDimPref, loadPref, savePref } from "./ChartsGallery.jsx";

const JMA_DATA = "https://www.data.jma.go.jp";
const PREF_KEY = "enroute_maiji";
const AUTO_REFRESH_MS = 10 * 60e3;
const GRID_CROSS = ["50", "52", "54", "56"]; // E145・E140・E135・E130
const GRID_PLANE = ["45", "35", "25", "15"]; // FL450・FL350・FL250・FL150
const LON_OPTS = CROSS_OPTS.filter((o) => +o.key >= 50);
const ROUTE_OPTS = CROSS_OPTS.filter((o) => +o.key < 50);

const fmtZ = (d) => `${pad(d.getUTCDate())}日 ${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
const fmtJst = (d) => { const j = new Date(d.getTime() + 9 * 3600e3); return `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())} JST`; };
const ago = (d, nowMs) => {
  const m = Math.max(0, Math.round((nowMs - d.getTime()) / 60000));
  return m < 60 ? `${m}分前` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}前`;
};

const selectStyle = {
  height: "40px", padding: "0 12px", borderRadius: "8px", fontFamily: "inherit", fontSize: FS.sm,
  background: "rgba(10,16,28,0.9)", color: C.text, border: `1px solid ${C.border}`, cursor: "pointer", maxWidth: "100%",
};

export function MaijiView() {
  const [prefs, setPrefs] = useState(() => {
    const v = loadPref(PREF_KEY, {}) || {};
    return {
      mode: v.mode === "plane" ? "plane" : "cross",
      cross: v.cross === "grid" || CROSS_OPTS.some((o) => o.key === v.cross) ? v.cross : "grid",
      plane: v.plane === "grid" || PLANE_OPTS.some((o) => o.key === v.plane) ? v.plane : "35",
    };
  });
  const setPref = (k, val) => setPrefs((p) => { const n = { ...p, [k]: val }; savePref(PREF_KEY, n); return n; });
  const [dim, setDim] = useDimPref();
  const [times, setTimes] = useState({ status: "loading", list: [] }); // 新しい順
  const [idx, setIdx] = useState(0); // 0 = 最新
  const [tick, setTick] = useState(0);
  const [viewer, setViewer] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    fetchMaijiTimes()
      .then((list) => {
        if (!alive) return;
        setTimes({ status: list.length ? "ok" : "error", list });
        setIdx(0);
      })
      .catch(() => alive && setTimes((p) => ({ ...p, status: "error" })));
    return () => { alive = false; };
  }, [tick]);
  useEffect(() => {
    const a = setInterval(() => setTick((t) => t + 1), AUTO_REFRESH_MS);
    const b = setInterval(() => setNowMs(Date.now()), 60e3);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);

  const isCross = prefs.mode === "cross";
  const sel = isCross ? prefs.cross : prefs.plane;
  const setSel = (v) => setPref(isCross ? "cross" : "plane", v);
  const opts = isCross ? CROSS_OPTS : PLANE_OPTS;
  const labelOf = (code) => opts.find((o) => o.key === code)?.label || code;
  const ts = times.list[idx];
  const d = ts ? parseTs(ts) : null;
  const codes = sel === "grid" ? (isCross ? GRID_CROSS : GRID_PLANE) : [sel];
  const urlOf = (code) => (isCross ? maijiCrossUrl(code, ts) : maijiPlaneUrl(code, ts));
  const items = ts ? codes.map((code) => ({
    key: code,
    title: `${isCross ? "断面図" : "平面図"} ${labelOf(code)}`,
    code: "",
    src: urlOf(code), href: urlOf(code),
    meta: d ? `解析 ${fmtZ(d)}` : "",
  })) : [];

  // 1枚表示のときは、同じ並び（経度・航空路・高度）の隣へ送る
  const group = !isCross ? PLANE_OPTS : LON_OPTS.some((o) => o.key === sel) ? LON_OPTS : ROUTE_OPTS;
  const gi = group.findIndex((o) => o.key === sel);
  const stepSel = (dir) => { const n = group[gi + dir]; if (n) setSel(n.key); };
  const stepLabels = !isCross ? ["▲ 上の高度", "下の高度 ▼"] : group === LON_OPTS ? ["◀ 東", "西 ▶"] : ["◀ 前の航空路", "次の航空路 ▶"];

  const aspect = isCross ? "1000 / 580" : "780 / 580";
  const grid = sel === "grid";

  return (
    <PanelFrame title="毎時大気解析" style={{ padding: 0 }}>
      {/* 種類・断面/高度の選択 */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", padding: "16px 16px 10px" }}>
        <Segmented
          options={[{ key: "cross", label: "断面図" }, { key: "plane", label: "平面図" }]}
          value={prefs.mode} onChange={(v) => setPref("mode", v)} label="種類"
        />
        <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label={isCross ? "断面" : "高度"} style={selectStyle}>
          {isCross ? (
            <>
              <option value="grid">4断面（E145・E140・E135・E130）</option>
              <optgroup label="経度">{LON_OPTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</optgroup>
              <optgroup label="航空路">{ROUTE_OPTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</optgroup>
            </>
          ) : (
            <>
              <option value="grid">4高度（FL450・FL350・FL250・FL150）</option>
              <optgroup label="高度">{PLANE_OPTS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</optgroup>
            </>
          )}
        </select>
        {!grid && (
          <span style={{ display: "inline-flex", gap: "6px" }}>
            <button type="button" onClick={() => stepSel(-1)} disabled={gi <= 0} style={{ ...actionBtnStyle, opacity: gi <= 0 ? 0.4 : 1 }}>{stepLabels[0]}</button>
            <button type="button" onClick={() => stepSel(1)} disabled={gi >= group.length - 1} style={{ ...actionBtnStyle, opacity: gi >= group.length - 1 ? 0.4 : 1 }}>{stepLabels[1]}</button>
          </span>
        )}
        <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "8px", minHeight: "44px", fontSize: FS.sm, color: C.textSub, cursor: "pointer" }}>
          <input type="checkbox" checked={dim} onChange={(e) => setDim(e.target.checked)} style={{ width: "20px", height: "20px", accentColor: C.accent }} />
          図を減光（夜間用）
        </label>
      </div>

      {/* 時刻 */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", padding: "0 16px 12px" }}>
        <button type="button" onClick={() => setIdx((i) => Math.min(times.list.length - 1, i + 1))} disabled={idx >= times.list.length - 1}
          style={{ ...actionBtnStyle, opacity: idx >= times.list.length - 1 ? 0.4 : 1 }}>◀ 1時間前</button>
        <div style={{ minWidth: "190px", padding: "0 6px" }}>
          <div style={{ fontFamily: FONT.data, fontSize: FS.md, fontWeight: 700, color: C.text }}>{d ? `解析 ${fmtZ(d)}` : times.status === "error" ? "—" : "読み込み中…"}</div>
          <div style={{ fontSize: FS.xs, color: C.textMuted }}>{d ? `${fmtJst(d)} · ${ago(d, nowMs)}` : " "}</div>
        </div>
        <button type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx <= 0}
          style={{ ...actionBtnStyle, opacity: idx <= 0 ? 0.4 : 1 }}>1時間後 ▶</button>
        <button type="button" onClick={() => setIdx(0)} disabled={idx === 0} style={{ ...actionBtnStyle, opacity: idx === 0 ? 0.4 : 1 }}>最新</button>
        {times.list.length > 0 && <span style={{ fontSize: FS.xs, color: C.textMuted }}>{times.list.length - idx} / {times.list.length}</span>}
        <button type="button" onClick={() => setTick((t) => t + 1)} style={{ ...actionBtnStyle, marginLeft: "auto" }}>{times.status === "error" ? "再取得" : "更新"}</button>
      </div>

      {/* 図 */}
      {times.status === "error" && !ts ? (
        <div style={{ margin: "0 16px 16px", padding: "14px 16px", borderRadius: "10px", border: "1px solid rgba(245,158,11,0.5)", color: "#fcd34d", fontSize: FS.sm }}>
          解析時刻の一覧を取得できません。通信状態を確かめて「再取得」を押してください。
        </div>
      ) : (
        <div style={{
          display: "grid", gap: "12px", padding: "0 16px",
          gridTemplateColumns: grid ? "repeat(auto-fit, minmax(min(100%, 380px), 1fr))" : "1fr",
        }}>
          {(ts ? items : codes.map((code) => ({ key: code, title: labelOf(code), src: null }))).map((it, i) => (
            <div key={it.key} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {grid && (
                <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{labelOf(it.key)}</span>
              )}
              <ChartFigure
                src={it.src} alt={`毎時大気解析 ${it.title}${d ? ` ${fmtZ(d)}` : ""}`} dim={dim} aspect={aspect}
                missingText="この時刻の図はありません" onOpen={() => setViewer(i)}
              />
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: "12px 16px 4px", fontSize: FS.xs, color: C.textMuted, lineHeight: 1.7 }}>
        {isCross
          ? "経度線・主要航空路に沿った鉛直断面（気温・風・湿数・圏界面など）。1枚表示では東経145°〜122.5°（2.5°毎）と主要航空路を選べます。"
          : "指定した高度の平面解析（風・気温・鉛直シアなど）。1枚表示では FL050〜FL450 を選べます。"}
        {" "}図はタップで全画面になります。
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", padding: "8px 16px 16px" }}>
        <ExtLink href={`${JMA_DATA}/airinfo/data/awfo_maiji.html`} accent>気象庁 毎時大気解析</ExtLink>
      </div>

      {viewer !== null && items[viewer] && (
        <ChartViewer items={items} index={viewer} setIndex={setViewer} onClose={() => setViewer(null)} dim={dim} />
      )}
    </PanelFrame>
  );
}
