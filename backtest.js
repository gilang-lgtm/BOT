// Backtest cepat pada data historis:
//   node --env-file=.env backtest.js yahoo:XAUUSD=X smc
//   node --env-file=.env backtest.js yahoo:XAUUSD=X scalp
// Menjalankan strategi pada semua candle yang tersedia dan merangkum hasilnya.
import { runEngine } from "./engine.js";
import { runScalp } from "./scalp.js";
import { fetchClosedBars, labelOf } from "./data.js";

const [spec, strat = "smc"] = process.argv.slice(2);
if (!spec) { console.error("Contoh: node --env-file=.env backtest.js yahoo:XAUUSD=X scalp"); process.exit(1); }
const S = { smc: { run: runEngine, tf: Number(process.env.SMC_TF ?? 15) }, scalp: { run: runScalp, tf: Number(process.env.SCALP_TF ?? 5) } }[strat];
if (!S) { console.error('Strategi harus "smc" atau "scalp"'); process.exit(1); }

const bars = await fetchClosedBars(spec, S.tf, process.env, Infinity);
console.log(`${labelOf(spec)} ${strat} M${S.tf}: ${bars.length} candle (${new Date(bars[0].t).toISOString().slice(0, 10)} s/d ${new Date(bars.at(-1).t).toISOString().slice(0, 10)})`);

const ev = S.run(bars);
const sigs = ev.filter((e) => e.type === "signal");
const res = new Map(ev.filter((e) => e.type === "result").map((r) => [r.id, r]));
let wins = 0, losses = 0, exp = 0, totalR = 0;
for (const s of sigs) {
  const r = res.get(s.id);
  const status = r ? r.outcome : "OPEN";
  if (status === "TP1") { wins++; totalR += r.r; }
  else if (status === "SL") { losses++; totalR -= 1; }
  else if (status === "EXPIRED") exp++;
  console.log(`${new Date(s.time).toISOString().slice(0, 16)}  ${s.side.padEnd(4)}  entry ${s.entry.toFixed(4)}  SL ${s.sl.toFixed(4)}  TP1 ${s.tp1.toFixed(4)}  RR ${s.rr2}  -> ${status}${r ? ` (${r.r}R)` : ""}`);
}
const done = wins + losses;
console.log(`\nSinyal: ${sigs.length} | selesai: ${done} | menang: ${wins} | kalah: ${losses} | kedaluwarsa: ${exp}`);
console.log(`Win rate: ${done ? ((wins / done) * 100).toFixed(0) : 0}% | total: ${totalR.toFixed(2)}R`);
console.log("Catatan: sampel kecil (belum 30 sinyal selesai) tidak cukup untuk menyimpulkan apa pun, dan backtest tidak menghitung spread/slippage.");
