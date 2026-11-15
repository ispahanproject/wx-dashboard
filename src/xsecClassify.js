/* ============================================================
   国内航空路 予想断面図（FXJP106・FXJP112）の白黒画像を、線の種類ごとに色分けする
   気象庁の図（2048×2545 の白黒2値の PNG）は、線の種類を太さと破線で描き分けている:
     3px の破線＝VWS（WIND SHEAR）、3px の雲形＝T-Td<3℃（湿域）、2px の実線＝相当温位、
     2px の破線＝等風速線、1px の実線＝気温、1px の縦線・横の破線＝目盛り線。矢羽の旗は塗りつぶしの三角
   1. 画素ごとに線の太さ（3x3・2x2 の正方形が収まるか）を調べる
   2. 3px・2px の線をつながり（連結成分）に分け、形（長さ・幅・向き）と並び方で破線の片を見分ける
      破線の片＝端の先が空いていて、すき間をおいて同じ向きの片が続くもの（線の重なりで太い所や、矢羽の羽根を除く）
   3. 1px の線は、縦にまっすぐ長い線と横の破線の行を目盛り線、残りを気温とする
   見分けられない所は元の黒のまま。図の外（凡例・目盛りの数字・右上の地上図）は色を付けない
   画像の大きさや図の枠の位置が想定と違うときは null（色分けしない）
   ============================================================ */

// 画素ごとの種類
export const XS = { BG: 0, BLACK: 1, VWS: 2, MOIST: 3, ISOTACH: 4, TEMP: 5, GRID: 6 };
// 種類ごとの色（RGB）。背景は白、相当温位・矢羽・数字は黒のまま
export const XSEC_RGB = {
  [XS.BLACK]: [0, 0, 0],
  [XS.VWS]: [220, 38, 38],
  [XS.MOIST]: [22, 163, 74],
  [XS.ISOTACH]: [37, 99, 235],
  [XS.TEMP]: [217, 119, 6],
  [XS.GRID]: [170, 170, 170],
};

// 図の範囲（上下2枚。右上の小さな地上図と見出しの箱、軸の目盛りを除く）と、あるはずの図の上下の線
const LAYOUT = {
  W: 2048, H: 2545,
  rects: [ // [x0, y0, x1, y1]（両端を含む）
    [256, 223, 1405, 1147], [1406, 347, 1830, 1147],
    [256, 1426, 1405, 2350], [1406, 1550, 1830, 2350],
  ],
  lines: [[221, 240, 1400], [1150, 240, 1850], [1424, 240, 1400], [2353, 240, 1850]], // [y, x0, x1]
};

// RGBA の画素から、黒い画素を 1 にした配列
export function binaryFromRgba(data, W, H) {
  const B = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < B.length; i++, j += 4) B[i] = data[j] < 128 ? 1 : 0;
  return B;
}

// 種類ごとの色で塗る（data は RGBA。背景は白にする）
export function paintXsec(data, labels) {
  for (let i = 0, j = 0; i < labels.length; i++, j += 4) {
    const c = XSEC_RGB[labels[i]];
    if (c) { data[j] = c[0]; data[j + 1] = c[1]; data[j + 2] = c[2]; } else { data[j] = data[j + 1] = data[j + 2] = 255; }
    data[j + 3] = 255;
  }
}

// B: 黒い画素を 1 にした配列。戻り値: 画素ごとの種類（XS）。色分けできない図は null
export function classifyXsec(B, W, H) {
  if (W !== LAYOUT.W || H !== LAYOUT.H) return null;
  for (const [y, x0, x1] of LAYOUT.lines) {
    let n = 0;
    for (let x = x0; x <= x1; x++) n += B[y * W + x];
    if (n < (x1 - x0 + 1) * 0.97) return null; // 図の作りが違う
  }
  const N = W * H;
  const inside = new Uint8Array(N);
  for (const [x0, y0, x1, y1] of LAYOUT.rects) for (let y = y0; y <= y1; y++) inside.fill(1, y * W + x0, y * W + x1 + 1);

  // 正方形 (2r+1)^2 が収まる中心（erode）と、そこから r だけ広げた範囲（dilate）
  const erode = (src, r) => {
    const h = new Uint8Array(N), o = new Uint8Array(N), k = 2 * r + 1;
    for (let y = 0; y < H; y++) { let run = 0; const b = y * W; for (let x = 0; x < W; x++) { run = src[b + x] ? run + 1 : 0; if (run >= k) h[b + x - r] = 1; } }
    for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y < H; y++) { run = h[y * W + x] ? run + 1 : 0; if (run >= k) o[(y - r) * W + x] = 1; } }
    return o;
  };
  const dilate = (src, r) => {
    const h = new Uint8Array(N), o = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const b = y * W;
      let last = -1e9; for (let x = 0; x < W; x++) { if (src[b + x]) last = x; if (x - last <= r) h[b + x] = 1; }
      last = 1e9; for (let x = W - 1; x >= 0; x--) { if (src[b + x]) last = x; if (last - x <= r) h[b + x] = 1; }
    }
    for (let x = 0; x < W; x++) {
      let last = -1e9; for (let y = 0; y < H; y++) { if (h[y * W + x]) last = y; if (y - last <= r) o[y * W + x] = 1; }
      last = 1e9; for (let y = H - 1; y >= 0; y--) { if (h[y * W + x]) last = y; if (last - y <= r) o[y * W + x] = 1; }
    }
    return o;
  };

  // 線の太さ: 3＝3x3 が収まる、2＝2x2 が収まる、1＝1px
  const thick = new Uint8Array(N);
  for (let i = 0; i < N - W - 1; i++) {
    if (B[i] && B[i + 1] && B[i + W] && B[i + W + 1]) thick[i] = thick[i + 1] = thick[i + W] = thick[i + W + 1] = 2;
  }
  const o3 = dilate(erode(B, 1), 1);
  for (let i = 0; i < N; i++) if (B[i]) thick[i] = o3[i] ? 3 : thick[i] || 1;
  // 矢羽の旗（5x5 が収まる塗りつぶし）のまわり。湿域の雲形に旗がくっついたとき、旗を黒のままにする
  const flag = dilate(erode(B, 2), 3);

  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (B[i]) out[i] = XS.BLACK;

  // 8近傍の連結成分（lab に成分の番号）。画素数・範囲・主軸の向き・長さと、主軸に沿った実際の両端
  const lab = new Int32Array(N);
  const stack = new Int32Array(N);
  const components = (want) => {
    lab.fill(-1);
    const comps = [];
    for (let s = 0; s < N; s++) {
      if (lab[s] !== -1 || !want(s)) continue;
      const id = comps.length;
      let sp = 0; stack[sp++] = s; lab[s] = id;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
      while (sp) {
        const i = stack[--sp];
        const x = i % W, y = (i - x) / W;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const j = yy * W + xx;
            if (lab[j] === -1 && want(j)) { lab[j] = id; stack[sp++] = j; }
          }
        }
      }
      const mx = sx / n, my = sy / n;
      const cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
      const tr = cxx + cyy, d = Math.sqrt(Math.max(0, tr * tr / 4 - (cxx * cyy - cxy * cxy)));
      const l1 = tr / 2 + d, l2 = Math.max(0.05, tr / 2 - d);
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      comps.push({ n, mx, my, x0, y0, x1, y1, len: Math.sqrt(12 * l1), ratio: l1 / l2, ux: Math.cos(ang), uy: Math.sin(ang), tmin: 0, tmax: 0 });
    }
    for (let i = 0; i < N; i++) {
      const id = lab[i];
      if (id < 0) continue;
      const c = comps[id], x = i % W, y = (i - x) / W;
      const t = (x - c.mx) * c.ux + (y - c.my) * c.uy;
      if (t < c.tmin) c.tmin = t;
      if (t > c.tmax) c.tmax = t;
    }
    for (const c of comps) c.ends = [[c.mx + c.ux * c.tmin, c.my + c.uy * c.tmin], [c.mx + c.ux * c.tmax, c.my + c.uy * c.tmax]];
    return comps;
  };

  // 片の端の先（線の向きに 2〜5px）に白い所があるか。破線の片なら先はすき間、線の重なりで太い所なら線が続いている
  const isWhite = (x, y) => {
    const X = Math.round(x), Y = Math.round(y);
    return X < 0 || Y < 0 || X >= W || Y >= H || !B[Y * W + X];
  };
  const openEnds = (c) => {
    let n = 0;
    for (const s of [-1, 1]) {
      const [ex, ey] = c.ends[s < 0 ? 0 : 1], ux = c.ux * s, uy = c.uy * s;
      if ([2, 3, 4, 5].some((k) => isWhite(ex + ux * k, ey + uy * k))) n++;
    }
    return n;
  };
  const endGap = (c, d) => {
    let best = Infinity;
    for (const p of c.ends) for (const q of d.ends) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
    return best;
  };
  // 破線の片：端の先が空いていて、すき間（gapMin〜gapMax）をおいて同じ向きの片が続くもの（seed を満たす片から探す）。
  // alone を満たす片は、隣が見つからなくても破線の片とする。
  // spread: 見つけた片の端の近く（gapMax 以内）にある片も、向きを問わず同じ破線とする（破線の曲がり角）
  const dashed = (cands, { gapMin, gapMax, spread = false, seed = () => true, alone = () => false, par = 0.6, lin = 0.8 }) => {
    const cell = 32, grid = new Map();
    const near = (c) => {
      const gx = Math.floor(c.mx / cell), gy = Math.floor(c.my / cell), list = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const d of grid.get(`${gx + a},${gy + b}`) || []) if (d !== c) list.push(d);
      return list;
    };
    const open = cands.filter((c) => openEnds(c) >= 1);
    for (const c of open) {
      const k = `${Math.floor(c.mx / cell)},${Math.floor(c.my / cell)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(c);
    }
    const ok = new Set();
    for (const c of open) {
      if (!seed(c)) continue;
      if (alone(c)) { ok.add(c); continue; }
      for (const d of near(c)) {
        if (Math.abs(c.ux * d.ux + c.uy * d.uy) < par) continue; // 向きが違う
        const vx = d.mx - c.mx, vy = d.my - c.my, vl = Math.hypot(vx, vy) || 1;
        if (Math.abs(c.ux * vx + c.uy * vy) / vl < lin) continue; // 横に並んでいる（矢羽の羽根など）
        const g = endGap(c, d);
        if (g >= gapMin && g <= gapMax) { ok.add(c); break; }
      }
    }
    if (spread) {
      const queue = [...ok];
      while (queue.length) {
        const c = queue.pop();
        for (const d of near(c)) if (!ok.has(d) && endGap(c, d) <= gapMax) { ok.add(d); queue.push(d); }
      }
    }
    return ok;
  };

  // 3px：小さいもの（2px の線の交わり）は 2px に戻す。大きいもの＝湿域の雲形。破線の片＝VWS。旗・数字・圏界面の印は黒のまま
  const c3 = components((i) => thick[i] === 3 && inside[i]);
  const vwsCand = [];
  const kind3 = c3.map((c) => {
    if (c.n <= 16) return "thin";
    if (Math.hypot(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1) > 34) return "moist";
    // 破線の片（曲がり角で折れた片も含む）。旗（塗りつぶしの三角）や数字は太さ（画素数÷長さ）が大きい
    if (c.n >= 20 && c.n <= 140 && c.n / c.len <= 5.6) { vwsCand.push(c); return "cand"; }
    return "black";
  });
  const straightDash = (c) => c.len >= 7 && c.len <= 20 && c.ratio >= 3 && c.n / c.len >= 2.6 && c.n / c.len <= 5.2;
  // 両端が空いた VWS の破線らしい片（ほかの線にくっついて、隣の片が見つからないことがある）
  const cleanDash = (c) => c.len >= 8 && c.len <= 16 && c.ratio >= 5 && c.n / c.len >= 3.2 && c.n / c.len <= 5 && openEnds(c) === 2;
  const vwsOk = dashed(vwsCand, { gapMin: 1.5, gapMax: 10, spread: true, seed: straightDash, alone: cleanDash, par: 0.5, lin: 0.7 });
  for (let i = 0; i < N; i++) {
    const id = lab[i];
    if (id < 0) continue;
    const k = kind3[id];
    if (k === "thin") thick[i] = 2;
    else if (k === "moist") { if (!flag[i]) out[i] = XS.MOIST; }
    else if (k === "cand" && vwsOk.has(c3[id])) out[i] = XS.VWS;
  }

  // 2px：短く細長い片が並んでいるもの＝等風速線の破線
  const c2 = components((i) => thick[i] === 2 && inside[i]);
  const isoCand = c2.filter((c) => c.len >= 5 && c.len <= 12 && c.ratio >= 5 && c.n / c.len >= 1.6 && c.n / c.len <= 3);
  const isoOk = dashed(isoCand, { gapMin: 2.5, gapMax: 9 });
  for (let i = 0; i < N; i++) {
    const id = lab[i];
    if (id >= 0 && isoOk.has(c2[id])) out[i] = XS.ISOTACH;
  }

  // 1px：縦にまっすぐ長い線・短い横線がたくさん並ぶ行（横の破線）＝目盛り線。残り＝気温
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && B[y * W + x]) run++;
      else {
        if (run >= 200) for (let k = y - run; k < y; k++) if (thick[k * W + x] === 1) out[k * W + x] = XS.GRID;
        run = 0;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    const b = y * W;
    let flat = 0, run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && thick[b + x] === 1) run++;
      else { if (run >= 8 && run <= 40) flat += run; run = 0; }
    }
    const gridRow = flat >= 400;
    run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && thick[b + x] === 1) run++;
      else {
        if (gridRow && run >= 6) for (let k = x - run; k < x; k++) out[b + k] = XS.GRID;
        run = 0;
      }
    }
    for (let x = 0; x < W; x++) if (thick[b + x] === 1 && out[b + x] === XS.BLACK && inside[b + x]) out[b + x] = XS.TEMP;
  }

  // 1px の小さなかけら（2px・3px の線の端の段差など）は、となりの線と同じ種類に
  const c1 = components((i) => thick[i] === 1 && inside[i] && out[i] === XS.TEMP);
  for (let i = 0; i < N; i++) {
    const id = lab[i];
    if (id < 0 || c1[id].n > 4) continue;
    const x = i % W, y = (i - x) / W;
    let to = -1;
    for (let dy = -1; dy <= 1 && to < 0; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = (y + dy) * W + x + dx;
        if (thick[j] >= 2) { to = out[j]; break; }
      }
    }
    if (to >= 0) out[i] = to;
  }
  // 図の外はそのまま黒
  for (let i = 0; i < N; i++) if (B[i] && !inside[i]) out[i] = XS.BLACK;
  return out;
}
