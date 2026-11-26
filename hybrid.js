// Strategi Hybrid: EMA 20 Trend Filter + Institutional Liquidity (Sweep + Displacement + MSS)
export const HYBRID_DEFAULTS = {
  emaPeriod: 20,
  swingLookback: 15,      // Diturunkan dari 20 agar swing likuiditas jangka pendek cepat terbaca
  sweepWindow: 6,         // Dinaikkan dari 5 agar jendela pantulan setelah sweep lebih luas
  dispAtrMult: 0.85,      // Diturunkan dari 1.3 agar dorongan momentum normal M5 tetap lolos
  slBufAtr: 0.15,
  minRiskAtr: 0.3,        // Diturunkan dari 0.4 agar SL scalping ketat tetap valid
  maxRiskAtr: 4.0,
  rr: 1.5,                // Diturunkan dari 2.0 ke 1.5 agar TP lebih cepat tercapai & slot sinyal cepat terbuka
  cooldown: 2,            // Diturunkan dari 4 (jeda antar sinyal cukup 10 menit)
  holdMax: 24,            // Diturunkan dari 48 (maksimal 2 jam pantau per sinyal)
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
    if (act && i > act.bar) {
      const hitSl = act.side === 1 ? L[i] <= act.sl : H[i] >= act.sl;
      const hitTp = act.side === 1 ? H[i] >= act.tp : L[i] <= act.tp;
      const outcome = hitSl ? "SL" : hitTp ? "TP1" : i - act.bar > P.holdMax ? "EXPIRED" : "";
      if (outcome) {
        const r = outcome === "SL" ? -1 : outcome === "TP1" ? act.rr : 0;
        events.push({ type: "result", time: bars[i].t, id: act.id, outcome, r: r2(r) });
        act = null;
      }
    }

    if (act || i - lastSig < P.cooldown) continue;

    const a = atr[i];
    const emaNow = e20[i];
    const emaPrev = e20[i - 3];
    if ([a, emaNow, emaPrev].some(Number.isNaN)) continue;

    const body = Math.abs(C[i] - O[i]);
    const range = H[i] - L[i];
    const isDisplacement = body >= P.dispAtrMult * a && range > 0 && body / range >= 0.6;
    if (!isDisplacement) continue;

    const bullCandle = C[i] > O[i];
    const bearCandle = C[i] < O[i];

    // Skenario BUY: Sweep Low -> Displacement + MSS tembus High -> Close di atas EMA20
    if (bullCandle && C[i] > emaNow && emaNow >= emaPrev) {
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
            act = { side: 1, sl, tp, rr: P.rr, bar: i, id };
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

    // Skenario SELL: Sweep High -> Displacement + MSS tembus Low -> Close di bawah EMA20
    if (!act && bearCandle && C[i] < emaNow && emaNow <= emaPrev) {
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
            act = { side: -1, sl, tp, rr: P.rr, bar: i, id };
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
