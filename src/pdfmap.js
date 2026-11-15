/* ============================================================
   天気図 PDF の地図の線（海岸線・経緯線・山岳域の破線）を、解析の線と見分けやすい色で描く
   気象庁の AUPQ35・AUPQ78 は、地図の線をいちばん細い黒線（0.28pt）で描き、
   等高線・等温線・矢羽などの解析の線はそれより太い（0.57pt〜）。
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
const isBlack = (a) => (typeof a[0] === "string" ? /^#(0{6}|0{3})$/i.test(a[0]) : a[0] < 60 && a[1] < 60 && a[2] < 60);

// stroke の番ごとに、地図の線なら true。地図の線と見分けられないときは null
export function mapStrokeFlags(opList, OPS) {
  const strokeOps = new Set(STROKE_OPS.map((n) => OPS[n]));
  const unsafe = new Set(UNSAFE_OPS.map((n) => OPS[n]).filter((v) => v !== undefined));
  let st = { ctm: [1, 0, 0, 1, 0, 0], lw: 1, black: true };
  const stack = [];
  const list = [];
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
    else if (strokeOps.has(fn)) list.push({ w: st.lw * Math.hypot(st.ctm[0], st.ctm[1]), black: st.black });
  }
  // いちばん細い黒線のまとまりを地図の線とみなす。数が十分にあり、次に細い黒線と太さがはっきり違うときだけ
  const blacks = list.filter((s) => s.black && s.w > 0);
  if (!blacks.length) return null;
  const minW = Math.min(...blacks.map((s) => s.w));
  const isMap = (s) => s.black && s.w > 0 && s.w < minW * 1.25;
  const others = blacks.filter((s) => !isMap(s));
  if (list.filter(isMap).length < 300 || !others.length || Math.min(...others.map((s) => s.w)) < minW * 1.6) return null;
  return list.map(isMap);
}

// canvas の描画先をくるみ、地図の線の番だけ線の色を color にする。count() で数えた stroke の数を返す
export function recolorStrokes(ctx, flags, color) {
  let k = 0;
  const proxy = new Proxy(ctx, {
    get(target, prop) {
      if (prop === "stroke") {
        return (...args) => {
          if (flags[k++]) {
            const prev = target.strokeStyle;
            target.strokeStyle = color;
            target.stroke(...args);
            target.strokeStyle = prev;
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
