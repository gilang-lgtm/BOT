// Strategi Hybrid: EMA 20 + Institutional Liquidity (Sweep + Displacement + MSS) + Trailing Stop
export const HYBRID_DEFAULTS = {
  emaPeriod: 20,
  swingLookback: 10,      // Swing likuiditas jangka pendek lebih cepat terbaca
  sweepWindow: 7,         // Jendela pantulan lebih lebar setelah sweep
  dispAtrMult: 0.45,      // Lebih sensitif menangkap dorongan momentum M5
  slBufAtr: 0.15,         // Buffer SL di luar ekor sweep
  minRiskAtr: 0.2,        // SL ketat scalping M5 tetap valid
  maxRiskAtr: 4.5,
  rr: 1.5,                // Target TP 1:1.5
  trailStartR: 0.6,       // Geser SL ke Break-Even saat profit menyentuh +0.6R
  trailStepR: 0.5,        // Jarak trailing SL di belakang harga puncak (0.5R)
  cooldown: 0,            // Tanpa jeda paksa antar sinyal
  holdMax: 24,            // Maksimal pantau 24 bar M5 (2 jam)
};

function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let cur = NaN, sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      sum += values[i];
      if (i === period - 1) { cur = sum / period; out[i] = cur; }
    } else {
      cur = values[i] * k + cur * (1 - k);
      out[i] = cur;
    }
  }
  return out;
}

function atr14(H, L, C) {
  const n = H.length, out = new Array(n).fill(NaN);
  let sum = 0, cur = NaN;
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    if (i < 14) { sum += tr; if (i === 13) cur = sum / 14; }
    else cur = (cur * 13 + tr) / 14;
    if (i >= 13) out[i] = cur;
  }
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;

export function runHybrid(bars, cfg = {}) {
  const P = { ...HYBRID_DEFAULTS, ...cfg };
  const n = bars.length;
  const O = bars.map((b) => b.o);
  const H = bars.map((b) => b.h);
  const L = bars.map((b) => b.l);
  const C = bars.map((b) => b.c);

  const e20 = ema(C, P.emaPeriod);
  const atr = atr14(H, L, C);
  const events = [];
  let act = null;
  let lastSig = -1e9;

  for (let i = P.swingLookback + P.sweepWindow; i < n; i++) {
    // 1. Pantau posisi aktif beserta logika Trailing Stop
    if (act && i > act.bar) {
      const hitSl = act.side === 1 ? L[i] <= act.sl : H[i] >= act.sl;
      const hitTp = act.side === 1 ? H[i] >= act.tp : L[i] <= act.tp;

      if (hitSl) {
        const lockedR = act.side === 1
          ? (act.sl - act.entry) / act.risk
          : (act.entry - act.sl) / act.risk;
        const outcome = lockedR > 0.05 ? "TP1" : lockedR >= -0.05 ? "EXPIRED" : "SL";
        events.push({
          type: "result",
          time: bars[i].t,
          id: act.id,
          outcome,
          r: r2(lockedR),
          note: lockedR >= 0 ? `Trailing Stop terkunci di ${r2(act.sl)} (${lockedR >= 0 ? "+" : ""}${r2(lockedR)}R)` : "",
        });
        act = null;
      } else if (hitTp) {
        events.push({ type: "result", time: bars[i].t, id: act.id, outcome: "TP1", r: r2(act.rr), note: "Target TP penuh tercapai" });
        act = null;
      } else if (i - act.bar > P.holdMax) {
        const currentR = act.side === 1 ? (C[i] - act.entry) / act.risk : (act.entry - C[i]) / act.risk;
        const outcome = currentR > 0.1 ? "TP1" : "EXPIRED";
        events.push({ type: "result", time: bars[i].t, id: act.id, outcome, r: r2(currentR), note: "Batas waktu maksimal" });
        act = null;
      } else {
        // Update Trailing Stop jika harga bergerak menguntungkan
        if (act.side === 1) {
          act.peak = Math.max(act.peak, H[i]);
          const maxR = (act.peak - act.entry) / act.risk;
          if (maxR >= P.trailStartR) {
            const candidateSl = Math.max(act.entry, act.peak - P.trailStepR * act.risk);
            if (candidateSl > act.sl) act.sl = candidateSl;
          }
        } else {
          act.peak = Math.min(act.peak, L[i]);
          const maxR = (act.entry - act.peak) / act.risk;
          if (maxR >= P.trailStartR) {
            const candidateSl = Math.min(act.entry, act.peak + P.trailStepR * act.risk);
            if (candidateSl < act.sl) act.sl = candidateSl;
          }
        }
      }
    }

    if (act || i - lastSig < P.cooldown) continue;

    const a = atr[i];
    const emaNow = e20[i];
    if ([a, emaNow].some(Number.isNaN)) continue;

    // 2. Cek Displacement (lebih sensitif agar sering menangkap momentum M5)
    const body = Math.abs(C[i] - O[i]);
    const range = H[i] - L[i];
    const isDisplacement = body >= P.dispAtrMult * a && range > 0 && body / range >= 0.35;
    if (!isDisplacement) continue;

    const bullCandle = C[i] > O[i];
    const bearCandle = C[i] < O[i];

    // 3. Skenario BUY
    if (bullCandle && C[i] > emaNow) {
      const sweepStart = i - P.sweepWindow;
      const poolStart = sweepStart - P.swingLookback;
      const liquidityLow = Math.min(...L.slice(poolStart, sweepStart));

      let sweepLow = Infinity;
      let sweepBar = -1;
      for (let k = sweepStart; k <= i; k++) {
        if (L[k] < liquidityLow && C[k] > liquidityLow && L[k] < sweepLow) {
          sweepLow = L[k];
          sweepBar = k;
        }
      }

      if (sweepBar !== -1 && sweepBar < i) {
        const mssLevel = Math.max(...H.slice(sweepBar, i));
        if (C[i] > mssLevel) {
          const entry = C[i];
          const sl = sweepLow - P.slBufAtr * a;
          const risk = entry - sl;

          if (risk >= P.minRiskAtr * a && risk <= P.maxRiskAtr * a) {
            const tp = entry + risk * P.rr;
            const id = `{PAIR}-${bars[i].t}`;
            act = { side: 1, entry, sl, tp, risk, peak: H[i], rr: P.rr, bar: i, id };
            lastSig = i;
            events.push({
              type: "signal",
              time: bars[i].t,
              id,
              side: "BUY",
              top: entry,
              bot: entry,
              entry,
              sl,
              tp1: tp,
              tp2: tp,
              rr1: P.rr,
              rr2: P.rr,
              bias: "Bullish",
              reason: `Bullish Liquidity Sweep (${r2(liquidityLow)}) + Displacement MSS tembus ${r2(mssLevel)} di atas EMA20`,
            });
          }
        }
      }
    }

    // 4. Skenario SELL
    if (!act && bearCandle && C[i] < emaNow) {
      const sweepStart = i - P.sweepWindow;
      const poolStart = sweepStart - P.swingLookback;
      const liquidityHigh = Math.max(...H.slice(poolStart, sweepStart));

      let sweepHigh = -Infinity;
      let sweepBar = -1;
      for (let k = sweepStart; k <= i; k++) {
        if (H[k] > liquidityHigh && C[k] < liquidityHigh && H[k] > sweepHigh) {
          sweepHigh = H[k];
          sweepBar = k;
        }
      }

      if (sweepBar !== -1 && sweepBar < i) {
        const mssLevel = Math.min(...L.slice(sweepBar, i));
        if (C[i] < mssLevel) {
          const entry = C[i];
          const sl = sweepHigh + P.slBufAtr * a;
          const risk = sl - entry;

          if (risk >= P.minRiskAtr * a && risk <= P.maxRiskAtr * a) {
            const tp = entry - risk * P.rr;
            const id = `{PAIR}-${bars[i].t}`;
            act = { side: -1, entry, sl, tp, risk, peak: L[i], rr: P.rr, bar: i, id };
            lastSig = i;
            events.push({
              type: "signal",
              time: bars[i].t,
              id,
              side: "SELL",
              top: entry,
              bot: entry,
              entry,
              sl,
              tp1: tp,
              tp2: tp,
              rr1: P.rr,
              rr2: P.rr,
              bias: "Bearish",
              reason: `Bearish Liquidity Sweep (${r2(liquidityHigh)}) + Displacement MSS tembus ${r2(mssLevel)} di bawah EMA20`,
            });
          }
        }
      }
    }
  }

  return events;
}
