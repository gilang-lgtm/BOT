const UA = "Mozilla/5.0 (compatible; smc-agent/3.0)";

export const labelOf = (spec) =>
  spec.split(":").slice(1).join(":").replace(/[\/=\-]/g, "").toUpperCase();

const ivTwelve = (m) => (m === 60 ? "1h" : `${m}min`);
const ivBinance = (m) => (m === 60 ? "1h" : `${m}m`);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "user-agent": UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} dari ${new URL(url).host}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function twelvedata(symbol, tfMin, apiKey) {
  if (!apiKey) throw new Error("TWELVEDATA_API_KEY belum diisi di .env");
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${ivTwelve(tfMin)}&outputsize=300&timezone=UTC&apikey=${apiKey}`;
  const j = await getJson(url);
  if (j.status === "error" || !j.values) throw new Error(`Twelve Data: ${j.message ?? "data kosong"}`);
  return j.values
    .map((v) => ({ t: Date.parse(v.datetime.replace(" ", "T") + "Z"), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
    .reverse();
}

async function binance(symbol, tfMin) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${ivBinance(tfMin)}&limit=300`;
  const j = await getJson(url);
  return j.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
}

export async function fetchClosedBars(spec, tfMin, env = {}, keep = 250) {
  const [provider, ...rest] = spec.split(":");
  const symbol = rest.join(":");
  let bars;
  if (provider === "twelvedata") bars = await twelvedata(symbol, tfMin, env.TWELVEDATA_API_KEY);
  else if (provider === "binance") bars = await binance(symbol, tfMin);
  else throw new Error(`Penyedia data "${provider}" tidak didukung. Gunakan "twelvedata" (contoh: twelvedata:XAU/USD)`);

  const tfMs = tfMin * 60_000;
  const now = Date.now();
  bars = bars.filter((b) => b.t + tfMs <= now);
  if (bars.length < 60) throw new Error(`Data terlalu sedikit (${bars.length} candle) untuk ${spec}`);
  return bars.slice(-keep);
}
