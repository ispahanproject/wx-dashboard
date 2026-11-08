/* デザイントークン — 色と文字サイズはここで一括管理する
   背景 #030810 に対するコントラスト比: text 15:1 / textSub 7.8:1 / textMuted 5.6:1 */
export const C = {
  bg: "#030810",
  text: "#e2e8f0",      // 本文・主要な値・大きめの見出し
  textSub: "#94a3b8",   // 補足・小さな見出しラベル
  textMuted: "#7a889d", // 注記・時刻など（以前の #334155 / #475569 / #64748b 等の置き換え）
  accent: "#6ee7b7",    // 選択中・操作できる要素
  ok: "#6ee7b7",
  caution: "#fbbf24",
  danger: "#f87171",
  border: "rgba(148,163,184,0.16)",
};

// 文字サイズは5段（11 / 13 / 15 / 20 / 28px）
export const FS = { xs: "11px", sm: "13px", md: "15px", lg: "20px", xl: "28px" };
