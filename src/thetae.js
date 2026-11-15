/* ============================================================
   850hPa 相当温位の予想図（FXJP854）の PDF から、指定した値（例: 300K・345K）の等相当温位線を探す
   気象庁の図は、等相当温位線を 3K ごとに描き、15K ごと（…285・300・315・330・345…）を太線にしている。
   各図（4枚）で、線は低い値から順に描かれる（太線のまとまりと、その間の細線 4本分が交互に並ぶ）。
   数字のラベルは 6K ごと（…300・306…342・348）なので、345K の線には数字がない。そこで、
   1. 図ごとに、見出しの文字のすぐ後に続く細線・太線の並びを取り出し、太線のまとまりを描かれた順に数える
   2. 数字のラベル（白いふち取り付き）を読み、ラベルで途切れている線が何番目のまとまりの太線・細線かから、
      「最初の太線の値」を票で決める（例: 3番目の太線に 300 のラベル → 最初の太線は 270K）
   3. 目的の値の太線のまとまり（例: 270K から数えて 345K は 6番目）を選ぶ
   票がそろわないときは選ばない（間違った線に色を付けない）。stroke の番号は canvas の stroke() の順（pdfmap.js と同じ）
   ============================================================ */
import { readHaloLabels } from "./isotherm.js";
import { hasUnsafeStrokeOps } from "./pdfmap.js";

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const near = (v, target, tol) => Math.abs(v - target) <= tol;
const isWhiteColor = (a) => (typeof a[0] === "string" ? /^#f{6}$/i.test(a[0]) : a[0] > 200 && a[1] > 200 && a[2] > 200);
const isBlackColor = (a) => (typeof a[0] === "string" ? /^#(0{6}|0{3})$/i.test(a[0]) : a[0] < 60 && a[1] < 60 && a[2] < 60);

const STEP = 15; // 太線の間隔（K）
const THIN = 0.567, THICK = 1.134; // 細線・太線の太さ（pt）

// 描画命令から、線（番号・太さ・色・座標）を取り出す
function collect(opList, OPS) {
  let st = { ctm: [1, 0, 0, 1, 0, 0], lw: 1, white: false, black: true };
  const stack = [];
  const strokes = [];
  let path = null;
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    if (fn === OPS.save) stack.push(st);
    else if (fn === OPS.restore) st = stack.pop() || st;
    else if (fn === OPS.transform) st = { ...st, ctm: mul(st.ctm, a) };
    else if (fn === OPS.setLineWidth) st = { ...st, lw: a[0] };
    else if (fn === OPS.setStrokeRGBColor) st = { ...st, white: isWhiteColor(a), black: isBlackColor(a) };
    else if (fn === OPS.constructPath) path = a;
    else if (fn === OPS.stroke || fn === OPS.closeStroke) {
      const coords = path?.[1] || [];
      const pts = [];
      for (let k = 0; k + 1 < coords.length; k += 2) pts.push(apply(st.ctm, coords[k], coords[k + 1]));
      strokes.push({ idx: strokes.length, lw: st.lw * Math.hypot(st.ctm[0], st.ctm[1]), white: st.white, black: st.black, pts });
      path = null;
    }
  }
  return strokes;
}

// targets: [{ value: 300, color }]。戻り値: { colors（stroke の番号ごとの色。対象外は null）, panels（図の数）,
// read（最初の太線の値が決まった図の数）, found（値ごとに、その線が見つかった図の数）}。読めない PDF は null
export function findThetaE(opList, OPS, targets) {
  if (hasUnsafeStrokeOps(opList, OPS)) return null;
  const strokes = collect(opList, OPS);
  const labels = readHaloLabels(strokes, 6, 7).filter((l) => l.value >= 240 && l.value <= 380 && l.value % 3 === 0);
  const isThin = (s) => s.black && near(s.lw, THIN, 0.05);
  const isThick = (s) => s.black && near(s.lw, THICK, 0.1);
  const isCaption = (s) => s.black && s.lw < 0.4;

  // 図ごとの等値線の並び：見出しの文字（細い黒線）のすぐ後に続く、細線・太線だけの並び
  const sections = [];
  for (let k = 1; k < strokes.length; k++) {
    if (!(isThin(strokes[k]) || isThick(strokes[k])) || !isCaption(strokes[k - 1])) continue;
    let j = k;
    while (j < strokes.length && (isThin(strokes[j]) || isThick(strokes[j]))) j++;
    const sec = strokes.slice(k, j);
    if (sec.filter(isThick).length >= 2) sections.push(sec);
    k = j - 1;
  }

  const colors = new Array(strokes.length).fill(null);
  const found = Object.fromEntries(targets.map((t) => [t.value, 0]));
  let read = 0;
  const gapTo = ([x, y], l) => Math.hypot(Math.max(l.x0 - x, 0, x - l.x1), Math.max(l.y0 - y, 0, y - l.y1));
  for (const sec of sections) {
    // 太線のまとまり（描かれた順）。細線は「何番目の太線の後か」（-1 は最初の太線の前）
    const groups = [];
    const level = new Map();
    let inThick = false;
    for (const s of sec) {
      if (isThick(s)) {
        if (!inThick) { groups.push([]); inThick = true; }
        groups[groups.length - 1].push(s);
        level.set(s.idx, { thick: groups.length - 1 });
      } else {
        inThick = false;
        level.set(s.idx, { thin: groups.length - 1 });
      }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sec) for (const [x, y] of s.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const ls = labels.filter((l) => l.x1 > x0 && l.x0 < x1 && l.y1 > y0 && l.y0 < y1);

    // 線の端にいちばん近いラベル（9pt 以内）を、その線の値として票にする
    const votes = new Map();
    for (const s of sec) {
      if (s.pts.length < 2) continue;
      for (const p of [s.pts[0], s.pts[s.pts.length - 1]]) {
        let best = null;
        for (const l of ls) { const d = gapTo(p, l); if (!best || d < best.d) best = { d, l }; }
        if (!best || best.d > 9) continue;
        const v = best.l.value, lv = level.get(s.idx);
        let v0 = null;
        if (lv.thick !== undefined) { if (v % STEP === 0) v0 = v - STEP * lv.thick; }
        else if (v % STEP !== 0) v0 = lv.thin >= 0 ? v - (v % STEP) - STEP * lv.thin : v + (STEP - (v % STEP));
        if (v0 !== null) votes.set(v0, (votes.get(v0) || 0) + 1);
      }
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    // 3票以上で、2番目の3倍以上のときだけ決める
    if (!ranked.length || ranked[0][1] < 3 || (ranked[1] && ranked[1][1] * 3 > ranked[0][1])) continue;
    read++;
    const v0 = ranked[0][0];
    for (const t of targets) {
      const gi = (t.value - v0) / STEP;
      if (!Number.isInteger(gi) || gi < 0 || gi >= groups.length) continue;
      for (const s of groups[gi]) colors[s.idx] = t.color;
      found[t.value]++;
    }
  }
  return { colors, panels: sections.length, read, found };
}
