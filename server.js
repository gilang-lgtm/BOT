import fs from "node:fs";
import http from "node:http";
import { runEngine } from "./engine.js";
import { runScalp } from "./scalp.js";
import { runHybrid } from "./hybrid.js";
import { fetchClosedBars, labelOf } from "./data.js";
import { makeExecutor } from "./executor.js";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PAIRS = "twelvedata:XAU/USD",
  STRATEGIES = "hybrid",
  SMC_TF = "15",
  SCALP_TF = "5",
  EXECUTION = "paper",
  SIGNAL_TTL_MIN = "10",
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-3.1-flash-lite-preview",
  AI_FILTER = "true",
  MAX_PER_DAY = "50",
  JOURNAL_FILE = "./journal.csv",
  STATE_FILE = "./state.json",
  PORT = "3000",
} = process.env;

for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
  if (!process.env[k]) {
    console.error(`Env ${k} belum diisi`);
    process.exit(1);
  }
}
if (AI_FILTER === "true" && !GEMINI_API_KEY) {
  console.error("AI_FILTER=true membutuhkan GEMINI_API_KEY dari Google AI Studio");
  process.exit(1);
}

let executor;
try {
  executor = makeExecutor(EXECUTION);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const STRATS = {
  smc:    { label: "SMC",              tf: Number(SMC_TF),   run: runEngine, hasZones: true },
  scalp:  { label: "FOREX SCALPING",   tf: Number(SCALP_TF), run: runScalp,  hasZones: false },
  hybrid: { label: "HYBRID LIQUIDITY", tf: Number(SCALP_TF), run: runHybrid, hasZones: false },
};
const tfName = (m) => (m === 60 ? "H1" : `M${m}`);
const ttlMs = Number(SIGNAL_TTL_MIN) * 60_000;
const jobs = [];

for (const spec of PAIRS.split(",").map((s) => s.trim()).filter(Boolean)) {
  for (const key of STRATEGIES.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!STRATS[key]) {
      console.error(`Strategi tidak dikenal: "${key}" (pakai hybrid / scalp / smc)`);
      process.exit(1);
    }
    jobs.push({ spec, key, pair: labelOf(spec), ...STRATS[key] });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) =>
  v == null || v === ""
    ? "-"
    : Number(v).toLocaleString("en-US", {
        minimumFractionDigits: Math.abs(v) < 20 ? 5 : 2,
        maximumFractionDigits: Math.abs(v) < 20 ? 5 : 2,
      });
const html = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Telegram API ----------
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    throw new Error(`Telegram ${method} ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j.result;
}
const sendTelegram = (text, extra = {}) =>
  tg("sendMessage", { chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 3900), ...extra });
const clearButtons = (messageId) =>
  messageId
    ? tg("editMessageReplyMarkup", {
        chat_id: TELEGRAM_CHAT_ID,
        message_id: Number(messageId),
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {})
    : Promise.resolve();

// ---------- Kontrol AI & Status Bot ----------
let dayKey = "";
let dayCount = 0;
let isPaused = false;

function aiBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  return dayCount < Number(MAX_PER_DAY);
}

// Kalkulasi indikator untuk dikirim sebagai evidence nyata ke Gemini
function calcIndicatorsForAI(bars) {
  const closes = bars.map((b) => b.c);
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    let cur = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < arr.length; i++) cur = arr[i] * k + cur * (1 - k);
    return cur;
  };
  let atrSum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    atrSum += tr;
  }
  return {
    ema20: ema(closes, 20).toFixed(2),
    ema50: ema(closes, 50).toFixed(2),
    atr14: (atrSum / 14).toFixed(2),
  };
}

async function analyzeWithGemini(job, signal, recentBars) {
  dayCount++;
  const wibTime = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  const ind = calcIndicatorsForAI(recentBars);

  const candlesSummary = recentBars
    .slice(-30)
    .map((b) => `${new Date(b.t).toISOString().slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c}`)
    .join("\n");

  const prompt = `
Kamu adalah Validator Setup Price Action & Likuiditas Institusional untuk ${job.pair}.
Fokus analisismu adalah Model Hybrid EMA20 + Likuiditas ICT/SMC.
Kamu bertindak sebagai evaluator yang skeptis, objektif, disiplin, dan berbasis bukti nyata (evidence).
WAJIB: Tulis seluruh isi reasons_for, reasons_against, warnings, dan summary dalam Bahasa Indonesia yang jelas, padat, dan natural untuk trader.

TUJUAN:
Evaluasi kandidat sinyal dari Strategy Engine.
Jangan mencari-cari alasan untuk membenarkan kandidat sinyal.
Cari bukti yang mendukung DAN bukti yang membantah sinyal tersebut.
Prioritaskan kualitas setup, struktur pasar, likuiditas, risiko, dan validitas titik entry.
Jangan memaksakan BUY atau SELL jika data belum cukup.

KONTEKS PASAR:
Waktu saat ini: ${wibTime} WIB
Pair: ${job.pair}
Timeframe: ${tfName(job.tf)}
Strategi: ${job.label}
Arah kandidat: ${signal.side}
Entry awal: ${signal.entry}
SL awal: ${signal.sl}
TP1 awal: ${signal.tp1}
Alasan teknikal awal: ${signal.reason}

INDIKATOR TEKNIKAL (Terhitung):
EMA 20: ${ind.ema20}
EMA 50: ${ind.ema50}
ATR (14): ${ind.atr14}

DATA HARGA:
30 candle terakhir (UTC):
${candlesSummary}

KERANGKA EVALUASI:

1. TREN & KONTEKS PASAR
- Evaluasi arah tren berdasarkan data yang tersedia.
- Periksa keselarasan EMA20 dan EMA50 yang tercantum di atas.
- Bedakan apakah pasar sedang trending, ranging (datar), choppy (acak), atau belum jelas.
- Jangan menyimpulkan bias timeframe tinggi (HTF) jika data HTF tidak tersedia.

2. ANALISA LIKUIDITAS
Cari bukti yang relevan:
- Equal Highs (EQH) / Equal Lows (EQL)
- Swing High / Swing Low
- Buy-side liquidity (BSL) / Sell-side liquidity (SSL)
- Liquidity sweep (sapuan likuiditas)
- Breakout asli vs sapuan likuiditas lalu balik arah (sweep/reclaim)
Liquidity sweep hanya boleh dinyatakan "Confirmed" jika terdapat level likuiditas yang jelas, harga sempat menembusnya, lalu terjadi penolakan/reclaim sesuai arah setup. Ekor panjang saja bukan bukti liquidity sweep.

3. DISPLACEMENT & STRUKTUR PASAR
Evaluasi:
- Dorongan momentum kuat (Bullish / Bearish displacement)
- Ukuran body candle dibandingkan candle sebelumnya dan nilai ATR (14)
- Pergeseran struktur pasar: MSS / CHoCH / BOS / patahan struktur internal
Jangan menyebut MSS/BOS terkonfirmasi jika level swing tidak terlihat jelas pada data. Sapuan likuiditas tanpa displacement dan konfirmasi struktur bukanlah konfirmasi entry.

4. LOKASI ENTRY & AREA POI
Evaluasi jika terlihat:
- Fair Value Gap (FVG) atau Order Block (OB)
- Area Premium / Discount
- Kualitas retracement dan pertemuan dengan EMA20
- Jarak harga saat ini dari titik entry (apakah sudah telat / mengejar harga)
Jangan mengarang FVG, OB, atau level likuiditas yang tidak bisa dibuktikan dari 30 candle di atas.

5. VALIDASI KANDIDAT SINYAL
- BUY harus didukung bukti bullish yang kuat; SELL harus didukung bukti bearish yang kuat.
- Bedakan apakah ini setup REVERSAL (pembalikan) atau CONTINUATION (lanjutan tren).
- Periksa apakah titik entry masih segar atau sudah terlambat.
- Periksa apakah posisi SL berada di titik invalidasi yang masuk akal dan rasio RR layak.

6. RISIKO & KONDISI PASAR
- Evaluasi volatilitas berdasarkan nilai ATR (14) dan rentang candle: Low / Normal / High.
- Evaluasi konteks sesi pasar berdasarkan waktu WIB saat ini (sesi Asia, Eropa/London, atau AS/New York).
- Jangan mengklaim berita (news) aman jika kalender berita tidak disediakan.

7. PENGECEKAN KONTRADIKSI (ALASAN MENOLAK)
Cari alasan kuat untuk menolak atau mewaspadai sinyal:
- Kandidat BUY tetapi muncul displacement bearish kuat (atau sebaliknya).
- Sweep belum terkonfirmasi atau tidak ada MSS / patahan struktur.
- Pasar sedang ranging/choppy, entry terlambat, SL tidak logis, atau RR tidak layak.

8. PENILAIAN SKOR (0-100)
Beri skor kualitas setup 0-100 berdasarkan bukti:
- Keselarasan tren (Trend alignment): 0-20
- Kualitas likuiditas (Liquidity quality): 0-20
- Konfirmasi struktur (Structure confirmation): 0-20
- Displacement / momentum: 0-15
- Lokasi entry / POI: 0-15
- Kualitas volatilitas & sesi waktu: 0-10
Skor ini adalah SKOR KUALITAS SETUP, bukan jaminan probabilitas menang. Bukti yang tidak tersedia harus mengurangi skor.

9. ATURAN KEPUTUSAN (DECISION)
- APPROVE: Skor >= 75, arah didukung bukti kuat, entry belum terlambat, tidak ada kontradiksi fatal.
- CAUTION: Skor 60-74, atau bukti masih campuran / konfirmasi belum lengkap / ada peringatan risiko.
- REJECT: Skor < 60, ada kontradiksi fatal, setup tidak valid, entry terlambat, atau risiko terlalu besar.
- WAIT_CONFIRMATION: Terlihat sapuan likuiditas awal tetapi displacement, MSS, atau pemicu entry belum terkonfirmasi.
- INSUFFICIENT_DATA: Data tidak cukup untuk memvalidasi setup secara objektif.

10. NILAI PARAMETER STANDAR (GUNAKAN KATA KUNCI BERIKUT AGAR TERBACA SISTEM)
- trend_alignment: "Strong" | "Valid" | "Weak" | "Unknown"
- pullback_quality: "Optimal" | "Good" | "Shallow" | "Late" | "Invalid" | "Unknown"
- volatility: "Low" | "Normal" | "High" | "Unknown"
- news_risk: "Low" | "Moderate" | "High" | "Unknown"

11. BATASAN PERAN AI
- Kamu adalah validator objektif, bukan peramal harga.
- Jangan mengarang angka harga atau level teknikal di luar data yang diberikan.
- Jangan mengklaim institusi pasti sedang membeli/menjual atau pasar bebas stop hunt.

12. FORMAT OUTPUT
Balas HANYA dengan JSON valid sesuai schema tanpa Markdown, tanpa code fence, dan tanpa teks tambahan di luar JSON. Pastikan seluruh teks di dalam reasons_for, reasons_against, warnings, dan summary menggunakan Bahasa Indonesia.
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payloadBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.15,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          decision: {
            type: "STRING",
            enum: ["APPROVE", "CAUTION", "REJECT", "WAIT_CONFIRMATION", "INSUFFICIENT_DATA"],
          },
          score: { type: "INTEGER" },
          setup_type: { type: "STRING", enum: ["REVERSAL", "CONTINUATION", "UNKNOWN"] },
          trend_alignment: { type: "STRING", enum: ["Strong", "Valid", "Weak", "Unknown"] },
          pullback_quality: {
            type: "STRING",
            enum: ["Optimal", "Good", "Shallow", "Late", "Invalid", "Unknown"],
          },
          volatility: { type: "STRING", enum: ["Low", "Normal", "High", "Unknown"] },
          news_risk: { type: "STRING", enum: ["Low", "Moderate", "High", "Unknown"] },
          liquidity_sweep: {
            type: "STRING",
            enum: ["Confirmed", "Possible", "Not_detected", "Unknown"],
          },
          displacement: { type: "STRING", enum: ["Bullish", "Bearish", "Weak", "None", "Unknown"] },
          structure_confirmation: {
            type: "STRING",
            enum: ["Bullish_MSS", "Bearish_MSS", "BOS", "None", "Unknown"],
          },
          poi_quality: { type: "STRING", enum: ["Strong", "Valid", "Weak", "None", "Unknown"] },
          entry_status: { type: "STRING", enum: ["Valid", "Early", "Late", "Invalid", "Unknown"] },
          rr_valid: { type: "BOOLEAN" },
          reasons_for: { type: "ARRAY", items: { type: "STRING" } },
          reasons_against: { type: "ARRAY", items: { type: "STRING" } },
          warnings: { type: "ARRAY", items: { type: "STRING" } },
          summary: { type: "STRING" },
        },
        required: [
          "decision",
          "score",
          "setup_type",
          "trend_alignment",
          "pullback_quality",
          "volatility",
          "news_risk",
          "liquidity_sweep",
          "displacement",
          "structure_confirmation",
          "poi_quality",
          "entry_status",
          "rr_valid",
          "reasons_for",
          "reasons_against",
          "warnings",
          "summary",
        ],
      },
    },
  };

  let res;
  for (let attempt = 1; attempt <= 2; attempt++) {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadBody),
    });
    if (res.status !== 503) break;
    await sleep(3000);
  }

  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Respon Gemini kosong");
  return JSON.parse(rawText);
}

// ---------- Jurnal CSV ----------
const COLS = [
  "id", "waktu", "ts", "strategi", "pair", "tf", "side",
  "entry", "sl", "tp1", "tp2", "rr1", "rr2", "status", "hasil_r", "aksi", "msg_id", "catatan",
];
const esc = (v) => String(v ?? "").replace(/[,\r\n]+/g, " ").trim();

function readJournal() {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const lines = fs.readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean);
  if (lines[0] !== COLS.join(",")) {
    fs.renameSync(JOURNAL_FILE, JOURNAL_FILE.replace(/\.csv$/, "") + `.lama-${Date.now()}.csv`);
    return [];
  }
  return lines.slice(1).map((l) => {
    const c = l.split(",");
    return Object.fromEntries(COLS.map((k, i) => [k, c[i] ?? ""]));
  });
}

function writeJournal(rows) {
  const out = [COLS.join(","), ...rows.map((r) => COLS.map((k) => esc(r[k])).join(","))].join("\n") + "\n";
  fs.writeFileSync(JOURNAL_FILE, out);
}

function updateRow(id, fn) {
  const rows = readJournal();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  fn(row);
  writeJournal(rows);
  return row;
}

function summarize(rows) {
  const closed = rows.filter((r) => r.status === "SL" || r.status === "TP1");
  const wins = closed.filter((r) => r.status === "TP1").length;
  return {
    closed: closed.length,
    wins,
    losses: closed.length - wins,
    open: rows.filter((r) => r.status === "OPEN").length,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    totalR: closed.reduce((s, r) => s + Number(r.hasil_r || 0), 0),
  };
}

function recapText() {
  const rows = readJournal();
  const line = (title, s) =>
    `${title}: ${s.closed} selesai | menang ${s.wins} | kalah ${s.losses} | win rate ${s.winRate.toFixed(0)}% | total ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2)}R | terbuka ${s.open}`;
  return [
    line("Order dieksekusi", summarize(rows.filter((r) => r.aksi === "DIAMBIL"))),
    line("Semua sinyal", summarize(rows)),
  ].join("\n");
}

// ---------- Penanganan Sinyal Baru ----------
async function handleSignal(job, e, bars) {
  if (isPaused) {
    console.log(`[PAUSED] Sinyal ${e.id} dilewati karena bot sedang di-pause.`);
    return;
  }
  if (readJournal().some((r) => r.id === e.id)) return;
  const tf = tfName(job.tf);
  const stale = Date.now() - (e.time + job.tf * 60_000) > ttlMs;
  if (stale) return;

  const side = e.side;
  const entry = e.entry;
  const sl = e.sl;
  const tp = e.tp1;
  const rrText = `1:${e.rr1}`;
  const trendLabel = side === "BUY" ? "Trend bullish" : "Trend bearish";
  let reason = e.reason;
  let evalBlock = "";
  let aiDecisionTag = "";

  if (AI_FILTER === "true" && aiBudgetOk()) {
    try {
      const ai = await analyzeWithGemini(job, e, bars);
      reason = ai.summary || reason;
      aiDecisionTag = `[${ai.decision} ${ai.score}/100] `;

      const badgeIcon =
        ai.decision === "APPROVE" ? "🟢" :
        ai.decision === "CAUTION" ? "🟡" : "🔴";

      const evalRows = [
        ["Setup score", `${ai.score}/100`],
        ["Trend alignment", ai.trend_alignment],
        ["Pullback quality", ai.pullback_quality],
        ["Liquidity sweep", ai.liquidity_sweep],
        ["Structure", ai.structure_confirmation],
        ["Volatility", ai.volatility],
        ["News risk", ai.news_risk],
      ];
      const evalPre = evalRows.map(([k, v]) => k.padEnd(18) + String(v).padStart(12)).join("\n");

      const contraNote = ai.reasons_against?.length
        ? `\n⚠️ <i>Contra: ${html(ai.reasons_against[0])}</i>`
        : "";
      const warnNote = ai.warnings?.length
        ? `\n🚨 <i>Warning: ${html(ai.warnings[0])}</i>`
        : "";

      evalBlock = [
        "",
        `<b>AI SETUP EVALUATION</b>`,
        `${badgeIcon} <code>[${html(ai.decision)}]</code> • <i>${html(ai.setup_type)}</i>`,
        `<pre>${html(evalPre)}</pre>${contraNote}${warnNote}`,
      ].join("\n");
    } catch (err) {
      console.error("Gemini gagal, fallback ke sinyal teknikal murni:", err.message);
      evalBlock = `\n⚠️ <i>AI Evaluation sedang sibuk (menggunakan parameter teknikal murni).</i>`;
    }
  }

  const isBuy = side === "BUY";
  const tableRows = [
    ["Parameter", "Harga"],
    ["─────────────────────────", ""],
    ["Entry", fmt(entry)],
    ["Stop Loss", fmt(sl)],
    ["Take Profit", fmt(tp)],
    ["Risk Reward", rrText],
  ];
  const pre = tableRows.map(([k, v]) => (v ? k.padEnd(16) + v.padStart(10) : k)).join("\n");

  const text = [
    `${isBuy ? "🟢" : "🔴"} <b>${side} ${html(job.pair)}</b>`,
    `<i>${html(job.label)} • TIMEFRAME ${tf}</i>`,
    "",
    `<pre>${html(pre)}</pre>`,
    `${isBuy ? "🟢" : "🔴"} <b>${html(trendLabel)}</b>`,
    `<i>${html(reason)}</i>`,
    evalBlock || null,
    "",
    "<b>Konfirmasi transaksi:</b>",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const sent = await sendTelegram(text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "🟢 BUY", callback_data: `buy|${e.id}` },
        { text: "🔴 SELL", callback_data: `sell|${e.id}` },
        { text: "⚪ SKIP", callback_data: `skip|${e.id}` },
      ]],
    },
  });

  const rows = readJournal();
  rows.push({
    id: e.id,
    waktu: new Date(e.time + job.tf * 60_000).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }),
    ts: e.time + job.tf * 60_000,
    strategi: job.label,
    pair: job.pair,
    tf,
    side,
    entry: Number(entry).toFixed(Math.abs(entry) < 20 ? 5 : 2),
    sl: Number(sl).toFixed(Math.abs(sl) < 20 ? 5 : 2),
    tp1: Number(tp).toFixed(Math.abs(tp) < 20 ? 5 : 2),
    tp2: Number(tp).toFixed(Math.abs(tp) < 20 ? 5 : 2),
    rr1: rrText.replace("1:", ""),
    rr2: rrText.replace("1:", ""),
    status: "OPEN",
    hasil_r: "",
    aksi: "MENUNGGU",
    msg_id: sent?.message_id ?? "",
    catatan: `${aiDecisionTag}${reason}`,
  });
  writeJournal(rows);
  console.log("Sinyal terkirim:", e.id);
}

// ---------- Hasil Sinyal ----------
async function handleResult(e) {
  const row = updateRow(e.id, (r) => {
    if (r.status !== "OPEN") return;
    r.status = e.outcome;
    r.hasil_r = e.outcome === "EXPIRED" ? "0" : String(e.r);
  });
  if (!row || row.status !== e.outcome || row.aksi !== "DIAMBIL") return;

  const title =
    e.outcome === "TP1" ? `✅ ${row.pair} ${row.tf} ${row.side}: Take Profit (+${e.r}R)` :
    e.outcome === "SL"  ? `❌ ${row.pair} ${row.tf} ${row.side}: Stop Loss (-1R)` :
                          `⌛ ${row.pair} ${row.tf} ${row.side}: Kedaluwarsa`;
  await sendTelegram(`${title}\n\n${recapText()}`);
}

// ---------- Handler Tombol BUY / SELL / SKIP ----------
async function onCallback(cb) {
  if (String(cb.message?.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const answer = (text, alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  const [action, id] = String(cb.data ?? "").split("|");
  const msgId = cb.message.message_id;
  const row = readJournal().find((r) => r.id === id);

  if (!row) {
    await answer("Sinyal tidak ditemukan", true);
    await clearButtons(msgId);
    return;
  }
  if (row.aksi !== "MENUNGGU") {
    await answer(`Sudah diproses (${row.aksi})`);
    await clearButtons(msgId);
    return;
  }

  if (action === "skip") {
    updateRow(id, (r) => { r.aksi = "SKIP"; });
    await answer("Sinyal di-SKIP");
    await clearButtons(msgId);
    await sendTelegram(`⚪ <b>SKIP:</b> ${row.pair} ${row.tf}`, { parse_mode: "HTML" });
    return;
  }

  if (action !== "buy" && action !== "sell") return;

  if (Date.now() - Number(row.ts) > ttlMs) {
    updateRow(id, (r) => { r.aksi = "TIDAK DIJAWAB"; });
    await answer("Sinyal kedaluwarsa!", true);
    await clearButtons(msgId);
    return;
  }

  const chosenSide = action.toUpperCase();

  try {
    await answer(`Mengirim order ${chosenSide} ke broker...`);
    const res = await executor.open(row, chosenSide);
    updateRow(id, (r) => {
      r.aksi = "DIAMBIL";
      r.side = chosenSide;
    });
    await clearButtons(msgId);
    await sendTelegram(
      `✅ <b>ORDER TERKIRIM (${chosenSide} ${row.pair})</b>\n` +
        `${html(res.note)}\n` +
        `Entry: ${row.entry} | SL: ${row.sl} | TP: ${row.tp1}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Eksekusi broker gagal:", err.message);
    await answer(`GAGAL: ${err.message.slice(0, 150)}`, true);
  }
}

// ---------- Perintah Telegram ----------
async function onMessage(m) {
  if (String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const cmd = String(m.text ?? "").trim().split(/[ @]/)[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(
      `🤖 <b>Gemini Trading Bot Menu</b>\n\n` +
        `📊 <b>Analisa & Sinyal</b>\n` +
        `/analisa — Minta Gemini analisa market M5 saat ini\n` +
        `/tes_sinyal — Simulasi kirim kartu sinyal\n\n` +
        `🛡️ <b>Kontrol & Risiko</b>\n` +
        `/pause — Hentikan sementara sinyal baru (mis. saat news)\n` +
        `/resume — Aktifkan kembali sinyal otomatis\n` +
        `/status — Cek status bot, posisi open & sisa kuota AI\n\n` +
        `📒 <b>Jurnal & Evaluasi</b>\n` +
        `/open — Lihat daftar posisi yang masih berjalan\n` +
        `/rekap — Ringkasan win rate & total R\n` +
        `/reset_jurnal — Arsipkan jurnal lama & mulai baru`,
      { parse_mode: "HTML" }
    );
  } else if (cmd === "/pause") {
    isPaused = true;
    await sendTelegram("⏸️ <b>Bot di-PAUSE.</b> Sinyal baru tidak akan dikirim sampai Anda mengetik /resume.", {
      parse_mode: "HTML",
    });
  } else if (cmd === "/resume") {
    isPaused = false;
    await sendTelegram("▶️ <b>Bot AKTIF kembali.</b> Pemantauan sinyal otomatis dilanjutkan.", { parse_mode: "HTML" });
  } else if (cmd === "/status") {
    const rows = readJournal();
    const openCount = rows.filter((r) => r.status === "OPEN").length;
    const wib = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
    await sendTelegram(
      `📡 <b>Status Bot (${wib} WIB)</b>\n` +
        `• Kondisi: <b>${isPaused ? "⏸️ PAUSED" : "🟢 AKTIF"}</b>\n` +
        `• Strategi: <b>${jobs.map((j) => j.label).join(", ")}</b>\n` +
        `• Mode Eksekusi: <b>${executor.name.toUpperCase()}</b>\n` +
        `• Model AI: <code>${GEMINI_MODEL}</code>\n` +
        `• Kuota AI Hari Ini: <b>${dayCount} / ${MAX_PER_DAY}</b> request\n` +
        `• Sinyal Open: <b>${openCount}</b>`,
      { parse_mode: "HTML" }
    );
  } else if (cmd === "/open") {
    const openRows = readJournal().filter((r) => r.status === "OPEN");
    if (!openRows.length) {
      await sendTelegram("📭 Tidak ada posisi/sinyal yang berstatus OPEN saat ini.");
      return;
    }
    const list = openRows
      .map(
        (r, i) =>
          `${i + 1}. <b>${r.side} ${r.pair}</b> (${r.tf}) [${r.aksi}]\n` +
          `   Entry: ${r.entry} | SL: ${r.sl} | TP: ${r.tp1}`
      )
      .join("\n\n");
    await sendTelegram(`📂 <b>Daftar Sinyal OPEN (${openRows.length}):</b>\n\n${list}`, { parse_mode: "HTML" });
  } else if (cmd === "/rekap") {
    await sendTelegram(recapText());
  } else if (cmd === "/reset_jurnal") {
    if (fs.existsSync(JOURNAL_FILE)) {
      const backupName = JOURNAL_FILE.replace(/\.csv$/, "") + `-arsip-${Date.now()}.csv`;
      fs.renameSync(JOURNAL_FILE, backupName);
    }
    writeJournal([]);
    await sendTelegram("🗑️ <b>Jurnal berhasil di-reset!</b> Data lama telah diarsipkan di server.", {
      parse_mode: "HTML",
    });
  } else if (cmd === "/analisa") {
    await sendTelegram("🔍 Sedang menarik data candle terkini & meminta pandangan Gemini...");
    try {
      const job = jobs[0];
      const bars = await fetchClosedBars(job.spec, job.tf, process.env);
      const last = bars[bars.length - 1];
      const ind = calcIndicatorsForAI(bars);
      const summary = bars
        .slice(-25)
        .map((b) => `${new Date(b.t).toISOString().slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c}`)
        .join("\n");

      const prompt = `Berikan analisa scalping singkat (maksimal 5 poin) untuk ${job.pair} Timeframe ${tfName(job.tf)} menggunakan model Hybrid EMA20 + Institutional Liquidity berdasarkan 25 candle terakhir (UTC) berikut.
Indikator: EMA20 = ${ind.ema20}, EMA50 = ${ind.ema50}, ATR14 = ${ind.atr14}, Harga terakhir = ${last.c}.
Sebutkan: 1) Arah tren & posisi terhadap EMA20, 2) Area Liquidity Sweep (BSL/SSL) terdekat, 3) Struktur MSS/BOS terkini, dan 4) Skenario entry & peringatan risiko. Gunakan bahasa Indonesia yang padat dan objektif tanpa tabel.\n\nData Candle:\n${summary}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      let res;
      for (let attempt = 1; attempt <= 2; attempt++) {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.25 } }),
        });
        if (res.status !== 503) break;
        await sleep(3000);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Tidak ada respon dari Gemini.";
      await sendTelegram(`🧠 <b>Analisa Market ${job.pair} (${tfName(job.tf)})</b>\n\n${html(reply)}`, {
        parse_mode: "HTML",
      });
    } catch (err) {
      await sendTelegram(`❌ Gagal melakukan analisa: ${html(err.message)}`, { parse_mode: "HTML" });
    }
  } else if (cmd === "/tes_sinyal") {
    await sendTelegram("⏳ Menarik data live & meminta evaluasi Gemini...");
    try {
      const job = jobs[0];
      const bars = await fetchClosedBars(job.spec, job.tf, process.env);
      const last = bars[bars.length - 1];
      const dummySignal = {
        id: `TEST-${Date.now()}`,
        time: last.t,
        side: "BUY",
        entry: last.c,
        sl: Number((last.c - 3.0).toFixed(2)),
        tp1: Number((last.c + 6.0).toFixed(2)),
        rr1: 2.0,
        reason: "Simulasi Bullish Liquidity Sweep + Displacement MSS di atas EMA20",
      };
      await handleSignal(job, dummySignal, bars);
    } catch (err) {
      await sendTelegram(`❌ Gagal menjalankan tes sinyal: ${html(err.message)}`, { parse_mode: "HTML" });
    }
  }
}

// ---------- Polling Telegram ----------
async function pollTelegram() {
  let offset = 0;
  const startTime = Date.now();
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["callback_query", "message"] });
      for (const u of updates ?? []) {
        offset = u.update_id + 1;
        try {
          if (u.callback_query) await onCallback(u.callback_query);
          else if (u.message) await onMessage(u.message);
        } catch (err) {
          console.error("Error update Telegram:", err.message);
        }
      }
    } catch (err) {
      if (err.message.includes("409") && Date.now() - startTime < 90_000) {
        await sleep(5000);
        continue;
      }
      console.error("Polling Telegram gagal:", err.message);
      await sleep(5000);
    }
  }
}

async function sweepExpired() {
  const now = Date.now();
  const expired = readJournal().filter((r) => r.aksi === "MENUNGGU" && now - Number(r.ts) > ttlMs);
  for (const r of expired) {
    updateRow(r.id, (x) => { x.aksi = "TIDAK DIJAWAB"; });
    await clearButtons(r.msg_id);
  }
}

// ---------- Pemrosesan Data & Jadwal ----------
const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

function marketClosed(d = new Date()) {
  const day = d.getUTCDay();
  const h = d.getUTCHours();
  return day === 6 || (day === 0 && h < 21) || (day === 5 && h >= 22);
}

async function processJob(job, attempt = 1) {
  const tfMs = job.tf * 60_000;
  const bars = await fetchClosedBars(job.spec, job.tf, process.env);
  const lastBar = bars[bars.length - 1].t;
  const stateKey = `${job.spec}|${job.key}`;
  const state = loadState();

  const expected = Math.floor(Date.now() / tfMs) * tfMs - tfMs;
  if (lastBar < expected && attempt === 1 && !marketClosed()) {
    await sleep(25_000);
    return processJob(job, 2);
  }

  if (state[stateKey] == null) {
    state[stateKey] = lastBar;
    saveState(state);
    console.log(`[${job.pair} ${job.label}] baseline di ${new Date(lastBar).toISOString()}`);
    return;
  }

  const prefix = `${job.pair}-${job.key}-${job.tf}`;
  const events = job
    .run(bars)
    .map((e) => ({ ...e, id: e.id.replace("{PAIR}", prefix) }))
    .filter((e) => e.time > state[stateKey])
    .sort((a, b) => a.time - b.time);

  for (const e of events) {
    if (e.type === "signal") await handleSignal(job, e, bars);
    else await handleResult(e);
  }

  state[stateKey] = lastBar;
  saveState(state);
  const wib = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  console.log(`[${wib} WIB] Cek ${job.pair} ${job.label} | Candle: ${new Date(lastBar).toISOString()} | Event baru: ${events.length}`);
}

let queue = Promise.resolve();
function cycle(tf) {
  queue = queue.then(async () => {
    await sweepExpired().catch(() => {});
    if (marketClosed()) return;
    for (const job of jobs.filter((j) => j.tf === tf)) {
      try {
        await processJob(job);
      } catch (e) {
        console.error(`[${job.pair} ${job.label}] gagal: ${e.message}`);
      }
      await sleep(8000);
    }
  });
  return queue;
}

function scheduleNext(tf) {
  const tfMs = tf * 60_000;
  const now = Date.now();
  const next = Math.floor(now / tfMs) * tfMs + tfMs + 10_000;
  setTimeout(async () => {
    await cycle(tf);
    scheduleNext(tf);
  }, next - now);
}

// ---------- Main ----------
if (process.argv.includes("--test")) {
  await sendTelegram("✅ Tes Gemini Trading Bot: koneksi Telegram berhasil.");
  process.exit(0);
}

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`Bot Aktif | Status: ${isPaused ? "PAUSED" : "RUNNING"}`);
  })
  .listen(Number(PORT), () => console.log(`Keep-alive server berjalan di port ${PORT}`));

const tfs = [...new Set(jobs.map((j) => j.tf))];
console.log(`Gemini Trading Bot aktif (mode ${executor.name}). Strategi: ${jobs.map((j) => j.label).join(", ")}`);
await sendTelegram(`✅ <b>Bot Aktif</b> (Strategi: ${jobs.map((j) => j.label).join(", ")})`, { parse_mode: "HTML" }).catch(() => {});

pollTelegram();
setInterval(() => sweepExpired().catch(() => {}), 60_000);
for (const tf of tfs) {
  await cycle(tf);
  scheduleNext(tf);
}
