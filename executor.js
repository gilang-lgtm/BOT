const paper = {
  name: "simulasi",
  async open(row, overrideSide = null) {
    const side = overrideSide || row.side;
    return { note: `Order SIMULASI ${side} dicatat (tanpa broker)` };
  },
};

const metaapi = {
  name: "metaapi-live",
  async open(row, overrideSide = null) {
    const token = process.env.METAAPI_TOKEN;
    const accountId = process.env.METAAPI_ACCOUNT_ID;
    const volume = Number(process.env.LOT_SIZE || "0.01");

    if (!token || !accountId) {
      throw new Error("METAAPI_TOKEN atau METAAPI_ACCOUNT_ID belum diisi di .env");
    }

    const side = overrideSide || row.side;
    const actionType = side === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL";

    // Jika user membalik arah tombol (misal sinyal BUY tapi klik SELL), SL & TP ditukar jaraknya
    let sl = Number(row.sl);
    let tp = Number(row.tp1);
    const entry = Number(row.entry);
    if (overrideSide && overrideSide !== row.side) {
      const risk = Math.abs(entry - sl);
      const reward = Math.abs(tp - entry);
      sl = side === "BUY" ? entry - risk : entry + risk;
      tp = side === "BUY" ? entry + reward : entry - reward;
    }

    // Sesuaikan nama symbol broker jika ada akhiran (misal XAUUSDm / XAUUSD.a)
    const symbol = process.env.BROKER_SYMBOL || row.pair;

    const url = `https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${accountId}/trade`;
    const payload = {
      actionType,
      symbol,
      volume,
      stopLoss: Number(sl.toFixed(2)),
      takeProfit: Number(tp.toFixed(2)),
      comment: `GeminiBot-${row.id.slice(-6)}`,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "auth-token": token,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.numericCode && data.numericCode !== 0 && data.stringCode !== "TRADE_RETCODE_DONE")) {
      throw new Error(`Broker menolak order: ${data.message || data.stringCode || res.status}`);
    }

    return {
      note: `Eksekusi ${side} ${symbol} (${volume} lot) sukses! Ticket: #${data.orderId || data.positionId || "OK"}`,
    };
  },
};

export function makeExecutor(mode) {
  if (mode === "paper") return paper;
  if (mode === "metaapi") return metaapi;
  throw new Error(`EXECUTION="${mode}" tidak dikenal. Gunakan "paper" atau "metaapi".`);
}
