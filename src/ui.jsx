/* 共通UIパーツ（各メニューで共用） */
import { useState } from "react";
import { C, FS, FONT } from "./theme.js";

// パネルの枠。見出しは枠線の上に重ねて表示する（四隅の装飾・セクション番号は廃止）
// `code` は互換のため受け取るが表示しない
export function PanelFrame({ children, title, style = {} }) {
  return (
    <div style={{
      position: "relative",
      background: "rgba(10, 16, 28, 0.72)",
      border: `1px solid ${C.border}`,
      borderRadius: "8px",
      ...style,
    }}>
      {title && (
        <div style={{
          position: "absolute", top: "-9px", left: "12px",
          maxWidth: "calc(100% - 24px)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          background: C.bg,
          padding: "0 8px",
          color: C.textSub, fontSize: FS.xs, fontWeight: 700,
          fontFamily: FONT.ui, letterSpacing: "1px",
          lineHeight: "18px",
        }}>{title}</div>
      )}
      {children}
    </div>
  );
}

export function ExtLink({ href, children, accent, amber }) {
  const c = amber ? { bg: "rgba(245, 158, 11, 0.12)", border: "rgba(245, 158, 11, 0.4)", color: "#f59e0b" }
    : accent ? { bg: "rgba(110, 231, 183, 0.07)", border: "rgba(110, 231, 183, 0.3)", color: C.accent }
    : { bg: "rgba(15, 23, 42, 0.6)", border: C.border, color: C.textSub };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 14px",
      background: c.bg, border: `1px solid ${c.border}`, borderRadius: "6px", color: c.color,
      fontSize: FS.xs, textDecoration: "none", fontFamily: FONT.ui,
      transition: "all 0.15s ease", cursor: "pointer", letterSpacing: "0.5px",
    }}>
      {children}<span style={{ fontSize: FS.xs, opacity: 0.6 }}>↗</span>
    </a>
  );
}

/* ---------- 切替ボタン（セグメント） ---------- */
export const segWrapStyle = {
  display: "inline-flex", flexWrap: "wrap", padding: "3px", borderRadius: "10px",
  background: "rgba(10,16,28,0.9)", border: `1px solid ${C.border}`,
};
export const segBtnStyle = (on, height = 40) => ({
  height: `${height}px`, padding: height >= 44 ? "0 16px" : "0 12px", borderRadius: "8px", border: "none",
  cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
  background: on ? "rgba(110,231,183,0.14)" : "transparent", color: on ? C.accent : C.textSub,
  fontWeight: on ? 700 : 400, fontSize: FS.sm,
});

export function Segmented({ options, value, onChange, label, height = 40, style }) {
  return (
    <div role="group" aria-label={label} style={{ ...segWrapStyle, ...style }}>
      {options.map((o) => (
        <button key={o.key} type="button" title={o.title} aria-pressed={value === o.key} onClick={() => onChange(o.key)} style={segBtnStyle(value === o.key, height)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// 操作ボタン（更新・前後の切替など）
export const actionBtnStyle = {
  height: "40px", minWidth: "40px", padding: "0 14px", borderRadius: "8px", cursor: "pointer", fontFamily: "inherit",
  background: "transparent", border: `1px solid ${C.border}`, color: C.textSub, fontSize: FS.sm,
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px",
};

/* ---------- メニューの枠：見出し＋サブ表示の切替 ----------
   views: [{ key, label, render: () => JSX }]。選んだサブ表示は端末に保存する */
export function MenuShell({ id, title, views }) {
  const storeKey = `menu_${id}`;
  const [view, setViewState] = useState(() => {
    try {
      const v = localStorage.getItem(storeKey);
      return views.some((x) => x.key === v) ? v : views[0].key;
    } catch { return views[0].key; }
  });
  const setView = (v) => {
    setViewState(v);
    try { localStorage.setItem(storeKey, v); } catch { /* ignore */ }
  };
  const cur = views.find((v) => v.key === view) || views[0];
  return (
    <section aria-label={title} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: FS.lg, fontWeight: 700, color: C.text, letterSpacing: "1px" }}>{title}</h2>
        {views.length > 1 && (
          <Segmented options={views} value={cur.key} onChange={setView} label={`${title} の表示`} height={44} />
        )}
      </div>
      {cur.render()}
    </section>
  );
}
