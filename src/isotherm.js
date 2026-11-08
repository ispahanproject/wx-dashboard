/* ============================================================
   高層天気図（AUPQ35・AUPQ78）の PDF から、指定した温度の等温線を探す
   PDF には「どの線が何℃か」という情報がなく、ラベルの数字も線で描かれている。
   そこで、
   1. 白いふち取り付きで描かれたラベルを、数字の形（気象庁の図の字形）で読み取る
   2. 等温線＝短い線を一定の間隔で並べた破線。描かれた順に並べると1本の線になる
   3. 目的の値のラベルで途切れている破線（ラベルの両側）を選び、端どうしが近い破線をつなぐ
   読み取れないときは空を返す（間違った線に色を付けない）。座標は PDF の座標（y は上向き）
   ============================================================ */

// 大きい縦字（等温線・等高線のラベル）の字形。点列は字の左端・ラベルの下端を原点に、字の高さを 1 とした座標
const GLYPHS = [
  ["0", "0,1 0,7 1,8 3,8 5,7 5,1 3,0 1,0"],
  ["1", "1,0 1,8 0,7"],
  ["2", "5,0 0,0 0,1 5,5 5,7 3,8 1,8 0,7"],
  ["3", "0,1 1,0 3,0 5,1 5,3 3,5 5,6 5,7 3,8 1,8 0,7"],
  ["4", "5,2 0,2 3,8 3,0"],
  ["5", "5,8 0,8 0,5 3,5 5,3 5,1 3,0 1,0 0,1"],
  ["6", "5,8 0,3 0,1 1,0 3,0 5,1 5,3 3,5 1,5"],
  ["7", "0,8 5,8 0,0"],
  ["8", "1,5 0,3 0,1 1,0 3,0 5,1 5,3 3,5 1,5 0,6 0,7 1,8 3,8 5,7"],
  ["9", "0,0 5,5 5,7 3,8 1,8 0,7 0,5 1,3 3,3"],
  ["-", "0,3 5,3"],
].map(([ch, s]) => ({ ch, pts: s.split(" ").map((p) => p.split(",").map((v) => +v / 8)) }));
// 1 は台、3 は中央の横棒、8 は右上の飾りが別の線になっている
const STROKES_PER_CHAR = { 1: 2, 3: 2, 8: 2 };

const near = (v, target, tol) => Math.abs(v - target) < tol;
const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const bboxOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
};
const lengthOf = (pts) => { let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return L; };
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// 描画命令から、線（座標・太さ・白かどうか）とクリップ範囲を取り出す
function collectStrokes(opList, OPS) {
  let st = { ctm: [1, 0, 0, 1, 0, 0], white: false, lw: 1 };
  const stack = [];
  const strokes = [];
  const clips = [];
  let path = null;
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    if (fn === OPS.save) stack.push({ ...st });
    else if (fn === OPS.restore) st = stack.pop() || st;
    else if (fn === OPS.transform) st = { ...st, ctm: mul(st.ctm, a) };
    else if (fn === OPS.setStrokeRGBColor) {
      st = { ...st, white: typeof a[0] === "string" ? a[0].toLowerCase() === "#ffffff" : a[0] > 200 && a[1] > 200 && a[2] > 200 };
    } else if (fn === OPS.setLineWidth) st = { ...st, lw: a[0] };
    else if (fn === OPS.constructPath) path = a;
    else if (fn === OPS.clip && path?.[2]) {
      const [mx0, my0, mx1, my1] = path[2];
      clips.push(bboxOf([apply(st.ctm, mx0, my0), apply(st.ctm, mx1, my1), apply(st.ctm, mx0, my1), apply(st.ctm, mx1, my0)]));
    } else if (fn === OPS.stroke && path?.[1]) {
      const coords = path[1];
      const pts = [];
      for (let k = 0; k + 1 < coords.length; k += 2) pts.push(apply(st.ctm, coords[k], coords[k + 1]));
      strokes.push({ idx: strokes.length, lw: st.lw * Math.hypot(st.ctm[0], st.ctm[1]), white: st.white, pts });
    }
  }
  return { strokes, clips };
}

// 下段の地図の範囲（AUPQ35 は 500hPa、AUPQ78 は 850hPa）。地図のクリップのうち、いちばん下にあるもの
function bottomPanel(clips, strokes) {
  const maps = clips.filter((c) => c.x1 - c.x0 > 300 && c.y1 - c.y0 > 300);
  if (maps.length) {
    const minTop = Math.min(...maps.map((c) => c.y1));
    const same = maps.filter((c) => near(c.y1, minTop, 2));
    return same.reduce((a, b) => (b.y0 > a.y0 ? b : a)); // 見出しを含まない、地図だけの範囲
  }
  const all = bboxOf(strokes.flatMap((s) => s.pts));
  return { x0: all.x0, x1: all.x1, y0: all.y0, y1: (all.y0 + all.y1) / 2 };
}

// 白いふち取り（太い白線）に続けて同じ数の黒い線で描かれたまとまり＝ラベル・観測値・矢羽など
function haloGroups(strokes) {
  const groups = [];
  for (let k = 0; k < strokes.length; k++) {
    if (!(strokes[k].white && near(strokes[k].lw, 1.7, 0.3))) continue;
    let j = k;
    while (j < strokes.length && strokes[j].white && near(strokes[j].lw, 1.7, 0.3)) j++;
    const n = j - k;
    const glyphs = strokes.slice(j, j + n);
    if (glyphs.length === n && glyphs.every((g) => !g.white && near(g.lw, 0.57, 0.1))) groups.push(glyphs);
    k = j + n - 1;
  }
  return groups;
}

function matchGlyph(norm) {
  let best = null;
  for (const t of GLYPHS) {
    if (t.pts.length !== norm.length) continue;
    let d = 0;
    for (let k = 0; k < norm.length; k++) d += Math.hypot(t.pts[k][0] - norm[k][0], t.pts[k][1] - norm[k][1]);
    d /= norm.length;
    if (!best || d < best.d) best = { ch: t.ch, d };
  }
  return best && best.d < 0.09 ? best.ch : null;
}

// ラベルを数値として読む（大きい縦字だけ。観測値の斜体の小さい字は対象外）
function readLabels(groups) {
  const labels = [];
  for (const glyphs of groups) {
    const parts = glyphs.map((g) => ({ pts: g.pts, b: bboxOf(g.pts) }));
    const H = Math.max(...parts.map((p) => p.b.y1 - p.b.y0));
    if (H < 6.5 || H > 10) continue;
    const base = Math.min(...parts.map((p) => p.b.y0));
    const chars = [];
    for (const p of [...parts].sort((a, b) => a.b.x0 - b.b.x0)) {
      const c = chars.find((c) => p.b.x0 <= c.x1 + 0.3 && p.b.x1 >= c.x0 - 0.3);
      if (c) { c.parts.push(p); c.x0 = Math.min(c.x0, p.b.x0); c.x1 = Math.max(c.x1, p.b.x1); } else chars.push({ x0: p.b.x0, x1: p.b.x1, parts: [p] });
    }
    chars.sort((a, b) => a.x0 - b.x0);
    let str = "";
    for (const c of chars) {
      const main = c.parts.reduce((a, b) => (b.pts.length > a.pts.length ? b : a));
      const ch = matchGlyph(main.pts.map(([x, y]) => [(x - main.b.x0) / H, (y - base) / H]));
      if (!ch || c.parts.length !== (STROKES_PER_CHAR[ch] || 1)) { str = null; break; }
      str += ch;
    }
    if (!str || !/^-?\d+$/.test(str)) continue;
    labels.push({ value: +str, x0: Math.min(...parts.map((p) => p.b.x0)), x1: Math.max(...parts.map((p) => p.b.x1)), y0: base, y1: base + H });
  }
  return labels;
}

// 等温線の破線を、描かれた順に1本ずつの線にまとめる（湿域の点描など、間隔の違うものは除く）
function dashedLines(strokes, groups, panel) {
  const inGroup = new Set(groups.flat().map((g) => g.idx));
  const inside = ([x, y]) => x >= panel.x0 - 1 && x <= panel.x1 + 1 && y >= panel.y0 - 1 && y <= panel.y1 + 1;
  const runs = [];
  let cur = null;
  for (const s of strokes) {
    const ok = !s.white && near(s.lw, 0.57, 0.1) && !inGroup.has(s.idx) && s.pts.length >= 2 && lengthOf(s.pts) < 15 && s.pts.every(inside);
    if (ok) { if (!cur) { cur = []; runs.push(cur); } cur.push(s); } else cur = null;
  }
  const lines = [];
  for (const run of runs) {
    if (run.length < 30) continue;
    const gaps = [];
    for (let k = 1; k < run.length; k++) {
      const a = run[k - 1].pts[run[k - 1].pts.length - 1], b = run[k].pts[0];
      gaps.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
    const mLen = median(run.map((s) => lengthOf(s.pts))), mGap = median(gaps);
    if (!(mLen > 2.5 && mLen < 4.5 && mGap > 2.5 && mGap < 4.5)) continue;
    let line = [run[0]];
    for (let k = 1; k < run.length; k++) {
      if (gaps[k - 1] > mGap * 1.5) { lines.push(line); line = []; }
      line.push(run[k]);
    }
    lines.push(line);
  }
  return lines.map((dashes) => dashes.flatMap((d) => d.pts));
}

// 目的の温度（例: -30）の等温線を、点列の配列で返す
export function findIsotherm(opList, OPS, target) {
  const { strokes, clips } = collectStrokes(opList, OPS);
  if (!strokes.length) return [];
  const panel = bottomPanel(clips, strokes);
  const groups = haloGroups(strokes);
  const labels = readLabels(groups).filter((l) => l.value === target && l.y1 > panel.y0 && l.y0 < panel.y1 && l.x1 > panel.x0 && l.x0 < panel.x1);
  if (!labels.length) return [];
  const lines = dashedLines(strokes, groups, panel);
  const ends = lines.map((pts) => [pts[0], pts[pts.length - 1]]);
  const atEdge = ([x, y]) => x - panel.x0 < 3 || panel.x1 - x < 3 || y - panel.y0 < 3 || panel.y1 - y < 3;
  const touches = (p, l) => p[0] > l.x0 - 6.5 && p[0] < l.x1 + 6.5 && p[1] > l.y0 - 6.5 && p[1] < l.y1 + 6.5;

  // ラベルの両側で途切れている線を起点に、端どうしが近い（＝同じ線の続き）ものをつなぐ
  const picked = new Set();
  const queue = [];
  lines.forEach((_, i) => { if (labels.some((l) => ends[i].some((p) => touches(p, l)))) { picked.add(i); queue.push(i); } });
  while (queue.length) {
    const i = queue.shift();
    for (const p of ends[i]) {
      if (atEdge(p)) continue;
      lines.forEach((_, j) => {
        if (picked.has(j)) return;
        if (ends[j].some((q) => !atEdge(q) && Math.hypot(p[0] - q[0], p[1] - q[1]) < 5)) { picked.add(j); queue.push(j); }
      });
    }
  }
  return [...picked].map((i) => lines[i]);
}
