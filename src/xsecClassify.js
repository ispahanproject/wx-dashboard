/* ============================================================
   国内航空路 予想断面図（FXJP106・FXJP112）の白黒画像を、線の種類ごとに色分けする
   気象庁の図（2048×2545 の白黒2値の PNG）は、線の種類を太さと破線で描き分けている:
     3px の破線＝VWS（WIND SHEAR）、3px の雲形＝T-Td<3℃（湿域）、2px の実線＝相当温位、
     2px の破線＝等風速線、1px の実線＝気温、1px の縦線・横の破線＝目盛り線。矢羽の旗は塗りつぶしの三角
   1. 画素ごとに線の太さ（3x3・2x2 の正方形が収まるか）を調べる
   2. 3px・2px の線をつながり（連結成分）に分け、形（長さ・幅・向き）と並び方で破線の片を見分ける
      破線の片＝端の先が空いていて、すき間をおいて同じ向きの片が続くもの（線の重なりで太い所や、矢羽の羽根を除く）
   3. 1px の線は、縦にまっすぐ長い線と横の破線の行を目盛り線、残りを気温とする
   4. 圏界面の印（✡）は、決まった列（モデルの格子の位置）の上で、六芒星の形の特徴から探す（findTropopause）
   見分けられない所は元の黒のまま。図の外（凡例・目盛りの数字・右上の地上図）は色を付けない（凡例の ✡ だけ色を付ける）
   画像の大きさや図の枠の位置が想定と違うときは null（色分けしない）
   ============================================================ */

// 画素ごとの種類
export const XS = { BG: 0, BLACK: 1, VWS: 2, MOIST: 3, ISOTACH: 4, TEMP: 5, GRID: 6, TROPO: 7 };
// 種類ごとの色（RGB）。背景は白、相当温位・矢羽・数字は黒のまま
export const XSEC_RGB = {
  [XS.BLACK]: [0, 0, 0],
  [XS.VWS]: [220, 38, 38],
  [XS.MOIST]: [22, 163, 74],
  [XS.ISOTACH]: [37, 99, 235],
  [XS.TEMP]: [217, 119, 6],
  [XS.GRID]: [170, 170, 170],
  [XS.TROPO]: [192, 38, 211],
};

// 図の範囲（上下2枚。右上の小さな地上図と見出しの箱、軸の目盛りを除く）と、あるはずの図の上下の線
const LAYOUT = {
  W: 2048, H: 2545,
  rects: [ // [x0, y0, x1, y1]（両端を含む）
    [256, 223, 1405, 1147], [1406, 347, 1830, 1147],
    [256, 1426, 1405, 2350], [1406, 1550, 1830, 2350],
  ],
  lines: [[221, 240, 1400], [1150, 240, 1850], [1424, 240, 1400], [2353, 240, 1850]], // [y, x0, x1]
  // 圏界面の印が描かれる列（x）と、探す行の範囲（上下2枚）。凡例の印の位置
  tropoX: Array.from({ length: 26 }, (_, k) => 300.3 + 59.36 * k),
  tropoRows: [[222, 1146], [1425, 2349]],
  tropoLegend: [[922, 201], [922, 1405]],
};

// 正方形 (2r+1)^2 が収まる中心（erode）
function erodeSquare(src, W, H, r) {
  const N = W * H, h = new Uint8Array(N), o = new Uint8Array(N), k = 2 * r + 1;
  for (let y = 0; y < H; y++) { let run = 0; const b = y * W; for (let x = 0; x < W; x++) { run = src[b + x] ? run + 1 : 0; if (run >= k) h[b + x - r] = 1; } }
  for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y < H; y++) { run = h[y * W + x] ? run + 1 : 0; if (run >= k) o[(y - r) * W + x] = 1; } }
  return o;
}

/* 圏界面の印（✡、六芒星。高さ・幅とも約19px、線の太さ3〜4px、真ん中に白い六角形の穴）を探す
   印は列ごとに1つ（決まった x の列の上）。中心に置いた見本の点で形を確かめる:
     穴（中心と半径2）が白・輪（半径5.5）が黒・6つの先端（半径8）が黒・先端の間のくぼみ（半径9.5）と先端の外（半径11.5）が白
   線が重なると一部が合わなくなるので、それぞれ少しの外れは許し、合計の点数・左右の対称さ・旗のような塗りつぶし
   （5x5 が収まる所）の少なさで選ぶ。形がよく合うもの（点数 4.25 以上）か、形は少し崩れていても左右がよくそろうもの
   （点数 3.9 以上・対称さ 0.86 以上）。間違って色を付けないよう、迷うものは選ばない
   E5: 5x5 が収まる中心（なければ作る）。戻り値: [{ x, y }]（凡例の印も含む） */
export function findTropopause(B, W, H, E5 = erodeSquare(B, W, H, 2)) {
  if (W !== LAYOUT.W || H !== LAYOUT.H) return [];
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : B[y * W + x]);
  // 見本の点（中心からのずれ）を画素の番号のずれにしておく（探す中心は画像の端から 12px 以上離れている）
  const ring = (r, angs) => Int32Array.from(angs, (a) => Math.round(r * Math.sin(a * Math.PI / 180)) * W + Math.round(r * Math.cos(a * Math.PI / 180)));
  const HOLE = Int32Array.from([0, ...ring(2, [0, 45, 90, 135, 180, 225, 270, 315])]);
  const RING = ring(5.5, [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
  const POINT = ring(8, [90, 30, -30, -90, -150, 150]);
  const NOTCH = ring(9.5, [0, 60, 120, 180, 240, 300]);
  const TIP = ring(11.5, [90, 30, -30, -90, -150, 150]);
  const black = (offs, i) => { let n = 0; for (let k = 0; k < offs.length; k++) n += B[i + offs[k]]; return n; };
  // 形の点数（各見本の合う割合の合計、5点満点）。合う数が足りなければ null
  const score = (x, y) => {
    const i = y * W + x;
    if (B[i]) return null;
    const hole = HOLE.length - black(HOLE, i);
    if (hole < 5) return null;
    const rg = black(RING, i), pt = black(POINT, i);
    if (rg < 10 || pt < 5) return null;
    const notch = NOTCH.length - black(NOTCH, i), tip = TIP.length - black(TIP, i);
    if (notch < 2 || tip < 3) return null;
    return hole / 9 + rg / 12 + pt / 6 + notch / 6 + tip / 6;
  };
  // 左右の対称さ（半径7の内側。軸は半画素ずれも試す）
  const symmetry = (cx, cy) => {
    let best = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) for (const half of [0, 1]) {
      let same = 0, tot = 0;
      for (let dy = -7; dy <= 7; dy++) for (let dx = 1; dx <= 7; dx++) {
        if (dx * dx + dy * dy > 49) continue;
        tot++;
        if (at(cx + ox - dx + half, cy + oy + dy) === at(cx + ox + dx, cy + oy + dy)) same++;
      }
      best = Math.max(best, same / tot);
    }
    return best;
  };
  const filled = (cx, cy) => {
    let n = 0;
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) if (dx * dx + dy * dy <= 100 && E5[(cy + dy) * W + cx + dx]) n++;
    return n;
  };
  // 列（または凡例の位置）の近くで点数のいちばん高い所。y の近い当たりはまとめる
  const best = (cx, y0, y1, dxMax) => {
    const found = [];
    let cur = null;
    for (let y = y0; y <= y1; y++) {
      let row = null;
      for (let x = Math.round(cx) - dxMax; x <= Math.round(cx) + dxMax; x++) {
        const s = score(x, y);
        if (s !== null && (!row || s > row.s)) row = { x, y, s };
      }
      if (!row) continue;
      if (cur && y - cur.last <= 3) { if (row.s > cur.s) Object.assign(cur, row); cur.last = y; }
      else { cur = { ...row, last: y }; found.push(cur); }
    }
    return found.filter((c) => {
      if (c.s < 3.9) return false;
      const f = filled(c.x, c.y), sym = symmetry(c.x, c.y);
      return (c.s >= 4.25 && f <= 30 && sym >= 0.75) || (f <= 20 && sym >= 0.86);
    });
  };
  const stars = [];
  for (const [y0, y1] of LAYOUT.tropoRows) {
    for (const cx of LAYOUT.tropoX) {
      const c = best(cx, y0, y1, 2);
      if (c.length) stars.push(c.reduce((a, b) => (b.s > a.s ? b : a))); // 1つの列に印は1つ
    }
  }
  for (const [cx, cy] of LAYOUT.tropoLegend) stars.push(...best(cx, cy - 3, cy + 3, 3));
  return stars.map(({ x, y }) => ({ x, y }));
}

// 印の範囲（六芒星の形＋真ん中の円）に入る画素か。dx, dy は中心からのずれ
function inStar(dx, dy) {
  if (dx * dx + dy * dy <= 52) return true; // 半径約7.2（くぼみの角まで）
  const m = 5.25; // 外側の三角形（外接円の半径 10.5）の内接円の半径
  const up = dy <= m && 0.866 * dx - 0.5 * dy <= m && -0.866 * dx - 0.5 * dy <= m;
  const down = -dy <= m && 0.866 * dx + 0.5 * dy <= m && -0.866 * dx + 0.5 * dy <= m;
  return up || down;
}

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
  const erode = (src, r) => erodeSquare(src, W, H, r);
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
  const E5 = erode(B, 2);
  const flag = dilate(E5, 3);

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
  // 圏界面の印（凡例の印も）。印に重なった線の画素も印の色にする
  for (const { x, y } of findTropopause(B, W, H, E5)) {
    for (let dy = -11; dy <= 11; dy++) for (let dx = -11; dx <= 11; dx++) {
      const i = (y + dy) * W + x + dx;
      if (B[i] && inStar(dx, dy)) out[i] = XS.TROPO;
    }
  }
  return out;
}
