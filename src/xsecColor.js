/* ============================================================
   断面図（FXJP106）を線の種類ごとに色分けした画像を作る（キャッシュ付き）
   重い処理（数百ミリ秒〜）なので Web Worker で行う。Worker が使えない環境では画面のスレッドで行う
   色分けできない図（大きさ・枠の位置が想定と違う）は元の画像をそのまま返す
   ============================================================ */
import { classifyXsec, binaryFromRgba, paintXsec } from "./xsecClassify.js";

const cache = new Map(); // key: url|版 → Promise<{ src, colored }>
const MAX_CACHE = 6;

let worker = null; // null＝まだ作っていない、false＝使えない
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker === null) {
    try {
      worker = new Worker(new URL("./xsecWorker.js", import.meta.url), { type: "module" });
      worker.onmessage = (e) => {
        const p = pending.get(e.data.id);
        if (p) { pending.delete(e.data.id); p(e.data); }
      };
      worker.onerror = () => {
        worker = false;
        for (const [id, p] of pending) { pending.delete(id); p({ id, error: "worker" }); }
      };
    } catch {
      worker = false;
    }
  }
  return worker || null;
}

function inWorker(bytes) {
  const w = getWorker();
  if (!w) return Promise.resolve({ error: "no worker" });
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, bytes }, [bytes.buffer]);
  });
}

// Worker が使えないとき：画面のスレッドで色分けする
async function onMainThread(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const labels = classifyXsec(binaryFromRgba(img.data, canvas.width, canvas.height), canvas.width, canvas.height);
  if (!labels) return null;
  paintXsec(img.data, labels);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function colorize(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const r = await inWorker(new Uint8Array(await blob.arrayBuffer()));
  let out = r.blob || null;
  if (r.error) out = await onMainThread(blob);
  if (!out) return { src: url, colored: false };
  return { src: URL.createObjectURL(out), colored: true };
}

// version: 図が更新されたら変わる値（更新時刻など）。同じ url と version なら作り直さない
export function getXsecImage(url, version = "") {
  const key = `${url}|${version}`;
  if (!cache.has(key)) {
    cache.set(key, colorize(url).catch((e) => { cache.delete(key); throw e; }));
    // 古いものから捨てる（作った画像の URL も解放）
    while (cache.size > MAX_CACHE) {
      const [oldKey, p] = cache.entries().next().value;
      cache.delete(oldKey);
      p.then((r) => { if (r.colored) URL.revokeObjectURL(r.src); }).catch(() => {});
    }
  }
  return cache.get(key);
}
