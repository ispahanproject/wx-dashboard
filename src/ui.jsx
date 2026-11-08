/* 共通UIパーツ（WeatherBriefing / DomesticWxPanel で共用） */
import { C, FS } from "./theme.js";

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
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "1px",
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
      fontSize: FS.xs, textDecoration: "none", fontFamily: "'JetBrains Mono', monospace",
      transition: "all 0.15s ease", cursor: "pointer", letterSpacing: "0.5px",
    }}>
      {children}<span style={{ fontSize: FS.xs, opacity: 0.6 }}>↗</span>
    </a>
  );
}
