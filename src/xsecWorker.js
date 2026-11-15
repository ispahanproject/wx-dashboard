/* 断面図の色分け（xsecClassify.js）を画面の処理と別のスレッドで行う
   受け取る: { id, bytes }（PNG のデータ）→ 返す: { id, blob }（色分けした PNG）、{ id, plain: true }（色分けできない図）、
   { id, error }（この環境では使えない：OffscreenCanvas がないなど。画面側で処理し直す） */
import { classifyXsec, binaryFromRgba, paintXsec } from "./xsecClassify.js";

self.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const W = bmp.width, H = bmp.height;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const img = ctx.getImageData(0, 0, W, H);
    const labels = classifyXsec(binaryFromRgba(img.data, W, H), W, H);
    if (!labels) { self.postMessage({ id, plain: true }); return; }
    paintXsec(img.data, labels);
    ctx.putImageData(img, 0, 0);
    self.postMessage({ id, blob: await canvas.convertToBlob({ type: "image/png" }) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
