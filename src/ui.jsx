/* 共通UIパーツ（WeatherBriefing / DomesticWxPanel で共用） */

export function PanelFrame({ children, title, code, style = {} }) {
  return (
    <div style={{
      position: "relative",
      background: "rgba(5, 10, 20, 0.7)",
      border: "1px solid rgba(110, 231, 183, 0.15)",
      borderRadius: "4px",
      ...style,
    }}>
      {/* corner brackets */}
      {[[0, 0], [0, 1], [1, 0], [1, 1]].map(([t, l], i) => (
        <div key={i} style={{
          position: "absolute",
          top: t ? "auto" : "-1px", bottom: t ? "-1px" : "auto",
          left: l ? "auto" : "-1px", right: l ? "-1px" : "auto",
          width: "12px", height: "12px",
          borderTop: t ? "none" : "2px solid #6ee7b7",
          borderBottom: t ? "2px solid #6ee7b7" : "none",
          borderLeft: l ? "none" : "2px solid #6ee7b7",
          borderRight: l ? "2px solid #6ee7b7" : "none",
        }} />
      ))}
      {title && (
        <div style={{
          position: "absolute", top: "-11px", left: "16px",
          background: "#050a14",
          padding: "0 8px",
          color: "#6ee7b7", fontSize: "9px", fontWeight: 700,
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px",
          textShadow: "0 0 8px rgba(110,231,183,0.5)",
        }}>{title}</div>
      )}
      {code && (
        <div style={{
          position: "absolute", top: "-11px", right: "16px",
          background: "#050a14",
          padding: "0 8px",
          color: "#334155", fontSize: "9px",
          fontFamily: "'JetBrains Mono', monospace", letterSpacing: "2px",
        }}>{code}</div>
      )}
      {children}
    </div>
  );
}

export function ExtLink({ href, children, accent, amber }) {
  const c = amber ? { bg: "rgba(245, 158, 11, 0.12)", border: "rgba(245, 158, 11, 0.4)", color: "#f59e0b" }
    : accent ? { bg: "rgba(110, 231, 183, 0.07)", border: "rgba(110, 231, 183, 0.3)", color: "#6ee7b7" }
    : { bg: "rgba(15, 23, 42, 0.6)", border: "rgba(110, 231, 183, 0.08)", color: "#94a3b8" };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 14px",
      background: c.bg, border: `1px solid ${c.border}`, borderRadius: "2px", color: c.color,
      fontSize: "11px", textDecoration: "none", fontFamily: "'JetBrains Mono', monospace",
      transition: "all 0.15s ease", cursor: "pointer", letterSpacing: "0.5px",
    }}>
      {children}<span style={{ fontSize: "10px", opacity: 0.6 }}>↗</span>
    </a>
  );
}
