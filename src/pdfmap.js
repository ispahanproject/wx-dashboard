/* ============================================================
   天気図 PDF の地図の線（海岸線・経緯線・山岳域の破線）を、解析の線と見分けやすい色で描く
   どの線が地図の線かは図によって見分け方が違う（rule）:
   - "thinnest"（AUPQ35・AUPQ78）: 地図の線をいちばん細い黒線（0.28pt）で描き、
     等高線・等温線・矢羽などの解析の線はそれより太い（0.57pt〜）
   - "panels"（FXJP854）: 4枚の図それぞれの始めに、枠 → 経緯線と経緯度の数字（0.57pt）→ 海岸線（0.85pt）
     → 図の下の見出しの文字（0.28pt）の順に描く。そのあとが相当温位の線・数字・矢羽
   1. PDF の描画命令を先に読み、何本目の stroke が地図の線かを調べる
   2. 描くときに canvas の stroke() を数え、地図の線の番だけ色を差し替える（描く順番＝解析の線が上、は変わらない）
   PDF の作りが想定と違うときは null を返し、色を替えない（解析の線に色を付けない）
   ============================================================ */

// 1つにつき canvas の stroke() がちょうど1回呼ばれる命令
const STROKE_OPS = ["stroke", "closeStroke"];
// stroke() の数がずれるおそれのある命令（塗りと線を同時に描く・模様・文字の縁取りなど）。あれば色を替えない
const UNSAFE_OPS = ["fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke", "setStrokeColorN", "setTextRenderingMode"];

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const isBlack = (a) => (typeof a[0] === "string" ? /^#(0{6}|0{3})$/i.test(a[0]) : a[0] < 60 && a[1] < 60 && a[2] < 60);
const near = (v, target, tol) => Math.abs(v - target) <= tol;

// stroke() の数がずれるおそれのある命令があるか（あれば線の色を替えない）
export function hasUnsafeStrokeOps(opList, OPS) {
  const unsafe = new Set(UNSAFE_OPS.map((n) => OPS[n]).filter((v) => v !== undefined));
  return opList.fnArray.some((fn) => unsafe.has(fn));
}

// 線の範囲（PDF の座標）。constructPath の3つ目の引数（線の座標の最小・最大）から
function boxOf(path, ctm) {
  const mm = path?.[2];
  if (!mm || mm.length < 4) return null;
  const pts = [apply(ctm, mm[0], mm[1]), apply(ctm, mm[2], mm[3]), apply(ctm, mm[0], mm[3]), apply(ctm, mm[2], mm[1])];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const areaOf = (b) => (b ? (b.x1 - b.x0) * (b.y1 - b.y0) : 0);
const unionOf = (boxes) => boxes.filter(Boolean).reduce((u, b) => (u
  ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }
  : b), null);

// いちばん細い黒線のまとまりを地図の線とみなす。数が十分にあり、次に細い黒線と太さがはっきり違うときだけ
function thinnestFlags(list) {
  const blacks = list.filter((s) => s.black && s.w > 0);
  if (!blacks.length) return null;
  const minW = Math.min(...blacks.map((s) => s.w));
  const isMap = (s) => s.black && s.w > 0 && s.w < minW * 1.25;
  const others = blacks.filter((s) => !isMap(s));
  if (list.filter(isMap).length < 300 || !others.length || Math.min(...others.map((s) => s.w)) < minW * 1.6) return null;
  return list.map(isMap);
}

// 図ごとに「経緯線（0.57pt）→ 海岸線（0.85pt）→ 見出しの文字（0.28pt）」と続くところを探し、経緯線と海岸線を地図の線とする。
// 経緯線のまとまりの最初の線は図の枠（ほかの線をすべて囲む）なので、黒のまま
function panelFlags(list) {
  const kind = (s) => (!s.black ? "other" : near(s.w, 0.85, 0.08) ? "coast" : near(s.w, 0.567, 0.05) ? "grid" : s.w < 0.4 ? "thin" : "other");
  const runs = [];
  list.forEach((s, k) => {
    const c = kind(s);
    if (runs.length && runs[runs.length - 1].c === c) runs[runs.length - 1].end = k + 1;
    else runs.push({ c, start: k, end: k + 1 });
  });
  const flags = list.map(() => false);
  let panels = 0;
  runs.forEach((r, j) => {
    const grid = runs[j - 1];
    const next = runs[j + 1];
    if (r.c !== "coast" || r.end - r.start < 20 || grid?.c !== "grid" || grid.end - grid.start < 5 || next?.c !== "thin") return;
    let from = grid.start;
    const rest = unionOf(list.slice(from + 1, r.end).map((s) => s.box));
    if (areaOf(list[from].box) >= 0.9 * areaOf(unionOf([rest, list[from].box]))) from++; // 枠
    for (let k = from; k < r.end; k++) flags[k] = true;
    panels++;
  });
  return panels ? flags : null;
}

// stroke の番ごとに、地図の線なら true。地図の線と見分けられないときは null
export function mapStrokeFlags(opList, OPS, rule = "thinnest") {
  const strokeOps = new Set(STROKE_OPS.map((n) => OPS[n]));
  const unsafe = new Set(UNSAFE_OPS.map((n) => OPS[n]).filter((v) => v !== undefined));
  let st = { ctm: [1, 0, 0, 1, 0, 0], lw: 1, black: true };
  const stack = [];
  const list = [];
  let path = null;
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    if (unsafe.has(fn)) return null;
    if (fn === OPS.save) stack.push(st);
    else if (fn === OPS.restore) st = stack.pop() || st;
    else if (fn === OPS.transform) st = { ...st, ctm: mul(st.ctm, a) };
    else if (fn === OPS.setLineWidth) st = { ...st, lw: a[0] };
    else if (fn === OPS.setStrokeRGBColor) st = { ...st, black: isBlack(a) };
    else if (fn === OPS.setStrokeGray) st = { ...st, black: a[0] < 0.25 };
    else if (fn === OPS.constructPath) path = a;
    else if (strokeOps.has(fn)) {
      list.push({ w: st.lw * Math.hypot(st.ctm[0], st.ctm[1]), black: st.black, box: rule === "panels" ? boxOf(path, st.ctm) : null });
      path = null;
    }
  }
  return rule === "panels" ? panelFlags(list) : thinnestFlags(list);
}

// canvas の描画先をくるみ、stroke の番ごとに線の色（と太さ）を替える。styles[k]: null（そのまま）か
// { color, widthScale }（widthScale は線の太さの倍率）。count() で数えた stroke の数を返す
export function recolorStrokes(ctx, styles) {
  let k = 0;
  const proxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop === "stroke") {
        return (...args) => {
          const st = styles[k++];
          if (st) {
            const prev = target.strokeStyle, prevW = target.lineWidth;
            target.strokeStyle = st.color;
            if (st.widthScale) target.lineWidth = prevW * st.widthScale;
            target.stroke(...args);
            target.strokeStyle = prev;
            target.lineWidth = prevW;
          } else {
            target.stroke(...args);
          }
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: proxy, count: () => k };
}
