export const SCALP_DEFAULTS = {
  fast: 20,
  slow: 50,
  minGapAtr: 0.3,    // jarak EMA20-EMA50 minimal (x ATR), menyaring pasar sideways
  pullbackBars: 3,   // pullback boleh terjadi di candle ini atau 3 candle sebelumnya
  slLookback: 5,     // SL di luar low/high N candle terakhir
  slBufAtr: 0.3,
  minRiskAtr: 0.5,   // jarak SL minimal (x ATR), terlalu sempit = mudah kena noise
  maxRiskAtr: 2.5,   // jarak SL maksimal (x ATR), terlalu lebar = bukan scalping
  rr: 1.5,
  cooldown: 6,       // minimal jeda antar sinyal (bar)
  holdMax: 36,       // maksimal durasi pantau hasil (36 bar M5 = 3 jam)
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

export function runScalp(bars, cfg = {}) {
  const P = { ...SCALP_DEFAULTS, ...cfg };
  const n = bars.length;
  const O = bars.map((b) => b.o), H = bars.map((b) => b.h), L = bars.map((b) => b.l), C = bars.map((b) => b.c);
  const eF = ema(C, P.fast), eS = ema(C, P.slow), atr = atr14(H, L, C);
  const events = [];
  let act = null, lastSig = -1e9;

  for (let i = 0; i < n; i++) {
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
    const a = atr[i], f = eF[i], s = eS[i];
    if ([a, f, s].some(Number.isNaN)) continue;

    const up = f > s && f - s > P.minGapAtr * a && C[i] > s;
    const down = f < s && s - f > P.minGapAtr * a && C[i] < s;
    if (!up && !down) continue;

    let touched = false;
    for (let k = 0; k <= P.pullbackBars && i - k >= 0; k++) {
      const fk = eF[i - k];
      if (Number.isNaN(fk)) continue;
      if (up ? L[i - k] <= fk : H[i - k] >= fk) { touched = true; break; }
    }
    const confirm = up ? C[i] > f && C[i] > O[i] : C[i] < f && C[i] < O[i];
    if (!touched || !confirm) continue;

    const from = Math.max(0, i - P.slLookback + 1);
    const entry = C[i];
    let sl, risk;
    if (up) {
      sl = Math.min(...L.slice(from, i + 1)) - P.slBufAtr * a;
      risk = entry - sl;
    } else {
      sl = Math.max(...H.slice(from, i + 1)) + P.slBufAtr * a;
      risk = sl - entry;
    }
    if (!(risk >= P.minRiskAtr * a && risk <= P.maxRiskAtr * a)) continue;

    const tp = up ? entry + risk * P.rr : entry - risk * P.rr;
    const id = `{PAIR}-${bars[i].t}`;
    act = { side: up ? 1 : -1, sl, tp, rr: P.rr, bar: i, id };
    lastSig = i;
    events.push({
      type: "signal", time: bars[i].t, id, side: up ? "BUY" : "SELL",
      top: entry, bot: entry, entry, sl, tp1: tp, tp2: tp, rr1: P.rr, rr2: P.rr,
      bias: up ? "Bullish" : "Bearish",
      reason: up
        ? "Tren naik (EMA20 di atas EMA50), pullback ke EMA20, candle konfirmasi naik"
        : "Tren turun (EMA20 di bawah EMA50), pullback ke EMA20, candle konfirmasi turun",
    });
  }
  return events;
}
