// Tes mesin SMC dengan data tiruan (tidak butuh internet): node test.js
import { runEngine } from "./engine.js";
import { runScalp } from "./scalp.js";

// pembangkit acak deterministik
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

// harga bergelombang (dua siklus tren + noise) agar muncul swing, sweep, MSS, dan FVG
function makeBars(n) {
  const bars = [];
  let p = 2600, t = Date.UTC(2026, 0, 5);
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 40) * 1.2 + Math.sin(i / 148) * 1.8;
    const o = p;
    const c = o + drift + (rnd() - 0.5) * 8;
    const h = Math.max(o, c) + rnd() * 4;
    const l = Math.min(o, c) - rnd() * 4;
    bars.push({ t, o, h, l, c });
    p = c; t += 15 * 60_000;
  }
  return bars;
}

let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.error("GAGAL:", msg); } };

const bars = makeBars(30000);
// Aturan asli sangat ketat (jarang lolos di data acak), jadi logika level/hasil diuji dengan filter dilonggarkan.
const CFG = { minRR: 1.0, reqZone: false };
const ev = runEngine(bars, CFG);
const sigs = ev.filter((e) => e.type === "signal");
const res = ev.filter((e) => e.type === "result");
console.log(`Candle: ${bars.length} | sinyal: ${sigs.length} | hasil: ${res.length}`);
ok(sigs.length > 0, "tidak ada sinyal sama sekali pada data tiruan");

for (const s of sigs) {
  if (s.side === "BUY") {
    ok(s.sl < s.entry && s.entry < s.tp1 && s.tp1 < s.tp2, `urutan level BUY salah: ${JSON.stringify(s)}`);
  } else {
    ok(s.sl > s.entry && s.entry > s.tp1 && s.tp1 > s.tp2, `urutan level SELL salah: ${JSON.stringify(s)}`);
  }
  ok(s.rr2 >= CFG.minRR, `RR TP2 di bawah minimum: ${s.rr2}`);
  ok(s.rr1 > 0, "RR1 harus positif");
}

// tiap hasil harus menunjuk sinyal yang ada, muncul setelah sinyalnya, dan tidak ganda
const byId = new Map(sigs.map((s) => [s.id, s]));
const seen = new Set();
for (const r of res) {
  const s = byId.get(r.id);
  ok(!!s, `hasil tanpa sinyal: ${r.id}`);
  ok(s && r.time > s.time, `hasil sebelum sinyal: ${r.id}`);
  ok(!seen.has(r.id), `hasil ganda: ${r.id}`);
  seen.add(r.id);
  if (r.outcome === "SL") ok(r.r === -1, "SL harus -1R");
  if (r.outcome === "TP1") ok(r.r > 0, "TP1 harus positif");
}

// hanya satu sinyal aktif: sinyal berikutnya harus setelah hasil sinyal sebelumnya
const sorted = ev.filter((e) => e.type === "signal" || e.type === "result").sort((a, b) => a.time - b.time);
let active = 0;
for (const e of sorted) {
  if (e.type === "signal") { active++; ok(active <= 1, `dua sinyal aktif bersamaan di ${new Date(e.time).toISOString()}`); }
  else active--;
}

// deterministik: dua kali jalan = hasil sama
ok(JSON.stringify(runEngine(bars, CFG)) === JSON.stringify(ev), "hasil tidak deterministik");

// aturan asli: sinyal tidak boleh lebih banyak daripada versi longgar, dan tidak boleh error
const strict = runEngine(bars).filter((e) => e.type === "signal").length;
console.log(`Sinyal dengan aturan asli (RR>=1.5, zona wajib): ${strict}`);
ok(strict <= sigs.length, "aturan ketat menghasilkan lebih banyak sinyal daripada aturan longgar");

// jendela 500 candle terakhir tidak boleh error
ok(Array.isArray(runEngine(bars.slice(-500), CFG)), "gagal pada jendela 500 candle");

const closed = res.filter((r) => r.outcome !== "EXPIRED");
const totalR = closed.reduce((s, r) => s + r.r, 0);
console.log(`Selesai: ${closed.length} | menang: ${closed.filter((r) => r.outcome === "TP1").length} | total R (data acak, tidak bermakna): ${totalR.toFixed(2)}`);
// ===== strategi scalping =====
{
  const sev = runScalp(bars);
  const ss = sev.filter((e) => e.type === "signal");
  const sr = sev.filter((e) => e.type === "result");
  console.log(`\nScalping: sinyal ${ss.length} | hasil ${sr.length}`);
  ok(ss.length > 5, "scalping seharusnya menghasilkan cukup banyak sinyal pada 30000 candle");
  for (const s of ss) {
    if (s.side === "BUY") ok(s.sl < s.entry && s.entry < s.tp1, `level BUY scalping salah ${JSON.stringify(s)}`);
    else ok(s.sl > s.entry && s.entry > s.tp1, `level SELL scalping salah ${JSON.stringify(s)}`);
    const risk = Math.abs(s.entry - s.sl), reward = Math.abs(s.tp1 - s.entry);
    ok(Math.abs(reward / risk - 1.5) < 1e-6, `RR scalping bukan 1.5: ${reward / risk}`);
  }
  const ids = new Map(ss.map((s) => [s.id, s]));
  const done = new Set();
  for (const r of sr) {
    ok(ids.has(r.id) && r.time > ids.get(r.id).time, `hasil scalping tidak valid ${r.id}`);
    ok(!done.has(r.id), "hasil scalping ganda"); done.add(r.id);
    if (r.outcome === "SL") ok(r.r === -1, "SL scalping harus -1R");
    if (r.outcome === "TP1") ok(r.r === 1.5, "TP scalping harus +1.5R");
  }
  let act = 0;
  for (const e of sev.sort((a, b) => a.time - b.time)) {
    if (e.type === "signal") { act++; ok(act <= 1, "dua sinyal scalping aktif bersamaan"); } else act--;
  }
  ok(JSON.stringify(runScalp(bars)) === JSON.stringify(runScalp(bars)), "scalping tidak deterministik");
  const sig = ss.filter((e) => true);
  for (let i = 1; i < sig.length; i++) ok(sig[i].time - sig[i - 1].time >= 6 * 15 * 60_000, "cooldown scalping dilanggar");
}

console.log(fail ? `${fail} pemeriksaan GAGAL` : "Semua pemeriksaan lulus");
process.exit(fail ? 1 : 0);
