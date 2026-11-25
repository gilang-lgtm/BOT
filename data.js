// Pengambil data candle dari sumber gratis. Semua mengembalikan array { t, o, h, l, c }
// terurut dari terlama ke terbaru, HANYA candle yang sudah close.
//
// Format SYMBOL di .env:  penyedia:simbol
//   yahoo:XAUUSD=X        (tanpa API key)
//   yahoo:EURUSD=X
//   twelvedata:EUR/USD    (butuh TWELVEDATA_API_KEY)
//   binance:PAXGUSDT      (tanpa API key; token emas, pengganti XAUUSD)

const UA = "Mozilla/5.0 (compatible; smc-agent/2.0)";

export const labelOf = (spec) =>
  spec.split(":").slice(1).join(":").replace(/=X$/i, "").replace(/[\/=\-]/g, "").toUpperCase();

const ivYahoo = (m) => (m === 60 ? "60m" : `${m}m`);
const ivTwelve = (m) => (m === 60 ? "1h" : `${m}min`);
const ivBinance = (m) => (m === 60 ? "1h" : `${m}m`);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dari ${new URL(url).host}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function yahoo(symbol, tfMin) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${ivYahoo(tfMin)}&range=30d`;
  const j = await getJson(url);
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo: ${j?.chart?.error?.description ?? "data kosong"} (${symbol})`);
  const q = r.indicators.quote[0];
  const out = [];
  r.timestamp.forEach((ts, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some((v) => v == null)) return;
    out.push({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] });
  });
  return out;
}

async function twelvedata(symbol, tfMin, apiKey) {
  if (!apiKey) throw new Error("TWELVEDATA_API_KEY belum diisi");
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${ivTwelve(tfMin)}&outputsize=600&timezone=UTC&apikey=${apiKey}`;
  const j = await getJson(url);
  if (j.status === "error" || !j.values) throw new Error(`Twelve Data: ${j.message ?? "data kosong"}`);
  return j.values
    .map((v) => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z"), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
    .reverse();
}

async function binance(symbol, tfMin) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${ivBinance(tfMin)}&limit=600`;
  const j = await getJson(url);
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

export async function fetchClosedBars(spec, tfMin, env = {}, keep = 500) {
  const [provider, ...rest] = spec.split(":");
  const symbol = rest.join(":");
  let bars;
  if (provider === "yahoo") bars = await yahoo(symbol, tfMin);
  else if (provider === "twelvedata") bars = await twelvedata(symbol, tfMin, env.TWELVEDATA_API_KEY);
  else if (provider === "binance") bars = await binance(symbol, tfMin);
  else throw new Error(`Penyedia data tidak dikenal: "${provider}" (pakai yahoo / twelvedata / binance)`);

  // buang candle yang masih berjalan (belum close)
  const tfMs = tfMin * 60_000;
  const now = Date.now();
  bars = bars.filter((b) => b.t + tfMs <= now);
  if (bars.length < 60) throw new Error(`Data terlalu sedikit (${bars.length} candle) untuk ${spec}`);
  return bars.slice(-keep);
}
