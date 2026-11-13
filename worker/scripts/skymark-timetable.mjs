// Skymark の時刻表（公式サイトの PDF）から、直行便の定刻を worker/src/skymark-timetable.js に書き出す。
// Skymark は IATA に入っておらず、FlightAware などの時刻表データに抜けや誤りがある（例：BC 635 中部→鹿児島）ので、
// Worker の到着便（/flights/fa）はこの時刻表で Skymark の便の定刻を直し、足りない便を足す。
//
// 使い方（ダイヤが変わるたびに。PDF は https://www.skymark.co.jp/ja/timetabeleandfares/ の「時刻表」）:
//   node worker/scripts/skymark-timetable.mjs <PDF の URL またはファイル>
// 読み取りには、アプリが使っている pdfjs-dist（ルートの node_modules）を使う。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pdfjs = await import(pathToFileURL(path.join(here, "../../node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
const OUT = path.join(here, "../src/skymark-timetable.js");

// 時刻表の空港名 → [IATA, ICAO]
const AIRPORTS = {
  "羽田": ["HND", "RJTT"], "札幌(新千歳)": ["CTS", "RJCC"], "仙台": ["SDJ", "RJSS"], "茨城": ["IBR", "RJAH"],
  "名古屋(中部)": ["NGO", "RJGG"], "神戸": ["UKB", "RJBE"], "福岡": ["FUK", "RJFF"], "長崎": ["NGS", "RJFU"],
  "鹿児島": ["KOJ", "RJFK"], "那覇": ["OKA", "ROAH"], "奄美大島": ["ASJ", "RJKA"], "宮古(下地島)": ["SHI", "RORS"],
};

const src = process.argv[2];
if (!src) { console.error("PDF の URL かファイルを指定してください"); process.exit(1); }
const bytes = /^https?:/.test(src) ? new Uint8Array(await (await fetch(src)).arrayBuffer()) : new Uint8Array(fs.readFileSync(src));
const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;

const MID = 290; // これより左が左の路線、右が右の路線
const hhmm = (s) => { const m = s.match(/^(\d{1,2}):(\d{2})$/); return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null; };
let period = null;
const flights = [];
const notes = {}; // 注記の番号 → { off: [月日] }（運休日）／{ only: [月日] }（この日だけ）／{ dow: [曜日] }（この曜日だけ）
const DOW = "日月火水木金土";

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const rows = new Map();
  for (const it of (await page.getTextContent()).items) {
    const s = it.str.trim();
    if (!s) continue;
    const y = Math.round(it.transform[5]);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x: Math.round(it.transform[4]), s });
  }
  const route = { L: null, R: null };
  const marker = { L: null, R: null }; // 便の行の上にある「※1」などの印
  for (const y of [...rows.keys()].sort((a, b) => b - a)) {
    const items = rows.get(y).sort((a, b) => a.x - b.x);
    const text = items.map((i) => i.s).join("");
    const pm = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日～(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (pm && !period) period = pm.slice(1).map(Number);
    const sides = { L: items.filter((i) => i.x < MID), R: items.filter((i) => i.x >= MID) };
    for (const side of ["L", "R"]) {
      const its = sides[side];
      const t = its.map((i) => i.s).join("");
      const ts = its.map((i) => i.s).join(" "); // 注記の番号と月の数字がくっつかないように
      if (!its.length) continue;
      if (t.includes("→")) { // 路線の見出し（乗継は除く）
        const m = t.match(/^(.+?)→(.+?)$/);
        route[side] = !t.includes("[") && m && AIRPORTS[m[1]] && AIRPORTS[m[2]] ? [m[1], m[2]] : null;
        marker[side] = null;
        continue;
      }
      if (t.startsWith("※") && /運休日|のみ運航|曜日のみ/.test(t)) { // 注記の中身（1行に何件か並ぶこともある）
        for (const chunk of ts.split("※").slice(1)) {
          const m = chunk.match(/^\s*(\d+)\s+(.*)$/);
          if (!m) continue;
          const body = m[2].replace(/\s+/g, "");
          if (/曜日のみ/.test(body)) {
            notes[m[1]] = { dow: body.replace(/曜日のみ.*$/, "").split("・").map((c) => DOW.indexOf(c)).filter((n) => n >= 0) };
            continue;
          }
          const dates = [];
          let month = null;
          for (const d of m[2].matchAll(/(\d+)\s*月|(\d+)/g)) {
            if (d[1]) month = +d[1];
            else if (month) dates.push([month, +d[2]]);
          }
          notes[m[1]] = body.includes("運休日") ? { off: dates } : { only: dates };
        }
        continue;
      }
      if (/^(※\s*\d+\s*)+$/.test(ts)) { marker[side] = (ts.match(/※\s*(\d+)/g) || []).map((s) => s.replace(/\D/g, "")); continue; }
      const no = its.find((i) => /^SKY\d+$/.test(i.s));
      const times = its.map((i) => hhmm(i.s)).filter(Boolean);
      if (no && times.length >= 2 && route[side]) {
        const [from, to] = route[side];
        flights.push({ no: no.s.slice(3), from: AIRPORTS[from][0], to: AIRPORTS[to][0], toIcao: AIRPORTS[to][1], dep: times[0], arr: times[1], note: marker[side] });
      }
      marker[side] = null;
    }
  }
}
if (!period) { console.error("ダイヤの期間が読み取れません"); process.exit(1); }

// 月日に年を付ける（期間の初めの年の月より前の月は、次の年）
const [y0, m0, d0, y1, m1, d1] = period;
const iso = ([m, d]) => `${m >= m0 ? y0 : y1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const seen = new Map();
for (const f of flights) {
  const key = `${f.no}|${f.from}|${f.to}|${f.dep}|${f.arr}`;
  const out = seen.get(key) || { no: f.no, from: f.from, to: f.to, toIcao: f.toIcao, dep: f.dep, arr: f.arr };
  for (const id of f.note || []) {
    const n = notes[id];
    if (!n) { console.warn(`注記 ※${id} の中身が見つかりません（SKY${f.no}）`); continue; }
    if (n.off) out.off = n.off.map(iso);
    if (n.only) out.only = n.only.map(iso);
    if (n.dow) out.dow = n.dow;
  }
  seen.set(key, out);
}
const list = [...seen.values()].sort((a, b) => a.toIcao.localeCompare(b.toIcao) || a.arr.localeCompare(b.arr));
const valid = [`${y0}-${String(m0).padStart(2, "0")}-${String(d0).padStart(2, "0")}`, `${y1}-${String(m1).padStart(2, "0")}-${String(d1).padStart(2, "0")}`];
const body = `// スカイマーク時刻表（${valid[0]}〜${valid[1]}）の直行便。worker/scripts/skymark-timetable.mjs で作成（手で直さない）
// 元の PDF: ${/^https?:/.test(src) ? src : path.basename(src)}
// off：運休日、only：この日だけ運航、dow：この曜日だけ運航（0＝日曜）。どれも日本時間の出発日
export const SKYMARK = {
  valid: ${JSON.stringify(valid)},
  flights: [
${list.map((f) => `    ${JSON.stringify(f)},`).join("\n")}
  ],
};
`;
fs.writeFileSync(OUT, body);
console.log(`${list.length} 便（期間 ${valid.join("〜")}、注記 ${Object.keys(notes).length} 件）→ ${path.relative(process.cwd(), OUT)}`);
