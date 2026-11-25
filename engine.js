// Mesin SMC: port dari smc_pro.pine (struktur BOS/MSS, liquidity sweep, FVG, Premium/Discount,
// mesin sinyal BUY/SELL, dan pelacak hasil SL/TP1/EXPIRED).
// Fungsi murni: terima array candle (terlama -> terbaru), kembalikan daftar event.
// Candle: { t (ms, waktu buka), o, h, l, c }  -- hanya candle yang sudah CLOSE.

export const DEFAULTS = {
  swingLen: 5,     // "Panjang swing struktur"
  liqLen: 8,       // "Panjang swing liquidity"
  maxLiq: 6,       // maksimal level BSL/SSL aktif per sisi
  fvgMin: 0.2,     // ukuran minimum FVG (x ATR)
  sigExpire: 40,   // setup kedaluwarsa (bar)
  slBuf: 0.2,      // buffer SL (x ATR)
  minRR: 1.5,      // minimal RR ke TP2
  reqZone: true,   // entry wajib di Discount (BUY) / Premium (SELL)
  holdMax: 150,    // maks durasi pantau hasil (bar)
};

const isNa = (v) => v === null || v === undefined || Number.isNaN(v);

export function runEngine(bars, cfg = {}) {
  const P = { ...DEFAULTS, ...cfg };
  const n = bars.length;
  const H = bars.map((b) => b.h), L = bars.map((b) => b.l), C = bars.map((b) => b.c);
  const events = [];
  const dbg = cfg.debug ?? {};
  const cnt = (k) => { dbg[k] = (dbg[k] ?? 0) + 1; };

  // ---- ATR(14) gaya Pine (RMA dari True Range, bar pertama = high-low)
  const atr = new Array(n).fill(NaN);
  {
    let sum = 0, cur = NaN;
    for (let i = 0; i < n; i++) {
      const tr = i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      if (i < 14) {
        sum += tr;
        if (i === 13) cur = sum / 14;
      } else {
        cur = (cur * 13 + tr) / 14;
      }
      if (i >= 13) atr[i] = cur;
    }
  }

  // ---- pivot: titik p = i - len dianggap pivot jika lebih tinggi/rendah dari len bar kiri & kanan
  const pivotHigh = (i, len) => {
    const p = i - len;
    if (p - len < 0) return null;
    const v = H[p];
    for (let k = 1; k <= len; k++) if (H[p - k] > v || H[p + k] >= v) return null;
    return v;
  };
  const pivotLow = (i, len) => {
    const p = i - len;
    if (p - len < 0) return null;
    const v = L[p];
    for (let k = 1; k <= len; k++) if (L[p - k] < v || L[p + k] <= v) return null;
    return v;
  };

  // ---- state struktur & range
  let swHi = null, swHiLive = false, swLo = null, swLoLive = false, trend = 0;
  let rHi = null, rLo = null;
  const bsl = [], ssl = [];

  // ---- state mesin sinyal
  let buyStage = 0, buySweepLow = null, buyLow = null, buyStageBar = 0, buyTop = null, buyBot = null, buyFvgBar = 0;
  let sellStage = 0, sellSweepHigh = null, sellHigh = null, sellStageBar = 0, sellTop = null, sellBot = null, sellFvgBar = 0;
  let act = null; // sinyal aktif: { side, sl, tp1, rr1, bar, id }

  const biasTxt = () => (trend === 1 ? "Bullish" : trend === -1 ? "Bearish" : "Netral");

  // proses level liquidity aktif: kena wick tanpa close menembus = SWEEP; close menembus = level dibuang
  const processLiq = (arr, isHigh, i) => {
    let swept = false;
    for (let k = arr.length - 1; k >= 0; k--) {
      const price = arr[k];
      const wick = isHigh ? H[i] > price : L[i] < price;
      if (!wick) continue;
      const brokeClose = isHigh ? C[i] > price : C[i] < price;
      if (!brokeClose) swept = true;
      arr.splice(k, 1);
    }
    return swept;
  };

  for (let i = 0; i < n; i++) {
    const a = atr[i];

    // --- swing & range
    const ph = pivotHigh(i, P.swingLen);
    const pl = pivotLow(i, P.swingLen);
    const phL = pivotHigh(i, P.liqLen);
    const plL = pivotLow(i, P.liqLen);

    if (ph !== null) { swHi = ph; swHiLive = true; rHi = ph; }
    if (pl !== null) { swLo = pl; swLoLive = true; rLo = pl; }
    if (rHi !== null && H[i] > rHi) rHi = H[i];
    if (rLo !== null && L[i] < rLo) rLo = L[i];

    // --- BOS / MSS
    const bullBreak = swHiLive && C[i] > swHi;
    const bearBreak = swLoLive && C[i] < swLo && !bullBreak;
    let mssBull = false, mssBear = false;
    if (bullBreak) {
      if (trend === -1) mssBull = true;
      trend = 1;
      swHiLive = false;
    }
    if (bearBreak) {
      if (trend === 1) mssBear = true;
      trend = -1;
      swLoLive = false;
    }

    // --- liquidity & sweep
    const sweepBsl = processLiq(bsl, true, i);
    const sweepSsl = processLiq(ssl, false, i);
    if (sweepBsl) cnt('sweepBsl');
    if (sweepSsl) cnt('sweepSsl');
    if (mssBull) cnt('mssBull');
    if (mssBear) cnt('mssBear');
    if (phL !== null) { bsl.push(phL); if (bsl.length > P.maxLiq) bsl.shift(); }
    if (plL !== null) { ssl.push(plL); if (ssl.length > P.maxLiq) ssl.shift(); }

    // --- equilibrium
    const eq = rHi !== null && rLo !== null && rHi > rLo ? (rHi + rLo) / 2 : null;

    // --- FVG
    const bullFvg = i >= 2 && !isNaN(a) && L[i] > H[i - 2] && L[i] - H[i - 2] > a * P.fvgMin;
    const bearFvg = i >= 2 && !isNaN(a) && H[i] < L[i - 2] && L[i - 2] - H[i] > a * P.fvgMin;

    // --- pelacak hasil sinyal aktif
    if (act && i > act.bar) {
      const hitSl = act.side === 1 ? L[i] <= act.sl : H[i] >= act.sl;
      const hitTp = act.side === 1 ? H[i] >= act.tp1 : L[i] <= act.tp1;
      const outcome = hitSl ? "SL" : hitTp ? "TP1" : i - act.bar > P.holdMax ? "EXPIRED" : "";
      if (outcome) {
        const r = outcome === "SL" ? -1 : outcome === "TP1" ? act.rr1 : 0;
        events.push({ type: "result", time: bars[i].t, id: act.id, outcome, r: Math.round(r * 100) / 100 });
        act = null;
      }
    }

    // --- mesin sinyal BUY: sweep SSL -> MSS Bullish -> retrace ke FVG
    if (sweepSsl) {
      buyStage = 1; buySweepLow = L[i]; buyLow = L[i]; buyStageBar = i; buyTop = null; buyBot = null;
    } else if (buyStage > 0) {
      buyLow = Math.min(buyLow, L[i]);
      if (i - buyStageBar > P.sigExpire || C[i] < buySweepLow) {
        buyStage = 0;
      } else {
        if (buyStage === 1 && mssBull) { buyStage = 2; cnt('buyStage2'); }
        if (bullFvg) {
          buyTop = L[i]; buyBot = H[i - 2]; buyFvgBar = i;
        } else if (buyBot !== null && C[i] < buyBot) {
          buyTop = null; buyBot = null;
        }
        if (buyStage === 2 && buyTop !== null && i > buyFvgBar && L[i] <= buyTop && C[i] > buyBot) {
          const en = buyTop;
          const sl = Math.min(buyLow, buyBot) - a * P.slBuf;
          const risk = en - sl;
          const tp1 = Math.max(isNa(eq) ? en + risk : eq, en + risk);
          const tp2 = rHi;
          const zoneOk = !P.reqZone || (eq !== null && en <= eq);
          const ok = risk > 0 && !isNa(tp2) && tp1 < tp2 && zoneOk && (tp2 - en) / risk >= P.minRR;
          cnt('buyTouch'); if (!zoneOk) cnt('buyGagalZona'); else if (!(tp1 < tp2)) cnt('buyGagalTp1'); else if (!((tp2 - en) / risk >= P.minRR)) cnt('buyGagalRR');
          if (ok && !act) {
            const rr1 = (tp1 - en) / risk, rr2 = (tp2 - en) / risk;
            const id = `{PAIR}-${bars[i].t}`;
            act = { side: 1, sl, tp1, rr1, bar: i, id };
            events.push({
              type: "signal", time: bars[i].t, id, side: "BUY",
              top: buyTop, bot: buyBot, entry: en, sl, tp1, tp2,
              rr1: Math.round(rr1 * 100) / 100, rr2: Math.round(rr2 * 100) / 100,
              bias: biasTxt(), reason: "SSL sweep - MSS Bullish - retrace ke FVG di Discount",
            });
          }
          buyStage = 0;
        }
      }
    }

    // --- mesin sinyal SELL: sweep BSL -> MSS Bearish -> retrace ke FVG
    if (sweepBsl) {
      sellStage = 1; sellSweepHigh = H[i]; sellHigh = H[i]; sellStageBar = i; sellTop = null; sellBot = null;
    } else if (sellStage > 0) {
      sellHigh = Math.max(sellHigh, H[i]);
      if (i - sellStageBar > P.sigExpire || C[i] > sellSweepHigh) {
        sellStage = 0;
      } else {
        if (sellStage === 1 && mssBear) { sellStage = 2; cnt('sellStage2'); }
        if (bearFvg) {
          sellTop = L[i - 2]; sellBot = H[i]; sellFvgBar = i;
        } else if (sellTop !== null && C[i] > sellTop) {
          sellTop = null; sellBot = null;
        }
        if (sellStage === 2 && sellBot !== null && i > sellFvgBar && H[i] >= sellBot && C[i] < sellTop) {
          const en = sellBot;
          const sl = Math.max(sellHigh, sellTop) + a * P.slBuf;
          const risk = sl - en;
          const tp1 = Math.min(isNa(eq) ? en - risk : eq, en - risk);
          const tp2 = rLo;
          const zoneOk = !P.reqZone || (eq !== null && en >= eq);
          const ok = risk > 0 && !isNa(tp2) && tp1 > tp2 && zoneOk && (en - tp2) / risk >= P.minRR;
          cnt('sellTouch'); if (!zoneOk) cnt('sellGagalZona'); else if (!(tp1 > tp2)) cnt('sellGagalTp1'); else if (!((en - tp2) / risk >= P.minRR)) cnt('sellGagalRR');
          if (ok && !act) {
            const rr1 = (en - tp1) / risk, rr2 = (en - tp2) / risk;
            const id = `{PAIR}-${bars[i].t}`;
            act = { side: -1, sl, tp1, rr1, bar: i, id };
            events.push({
              type: "signal", time: bars[i].t, id, side: "SELL",
              top: sellTop, bot: sellBot, entry: en, sl, tp1, tp2,
              rr1: Math.round(rr1 * 100) / 100, rr2: Math.round(rr2 * 100) / 100,
              bias: biasTxt(), reason: "BSL sweep - MSS Bearish - retrace ke FVG di Premium",
            });
          }
          sellStage = 0;
        }
      }
    }
  }

  return events;
}
