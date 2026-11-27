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
  STRATEGIES = "hybrid,scalp",
  SMC_TF = "15",
  SCALP_TF = "5",
  EXECUTION = "paper",
  AUTO_EXECUTE = "true",      // AI langsung mengeksekusi jika skor >= MIN_AI_SCORE
  MIN_AI_SCORE = "50",        // Ambang skor diturunkan agar AI lebih sering transaksi
  SIGNAL_TTL_MIN = "10",
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-3.1-flash-lite-preview",
  AI_FILTER = "true",
  MAX_PER_DAY = "200",
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
let isAutoExec = AUTO_EXECUTE === "true";

function aiBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  return dayCount < Number(MAX_PER_DAY);
}

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
Kamu bertindak sebagai evaluator yang objektif, disiplin, dan berbasis bukti nyata (evidence).
WAJIB: Tulis seluruh isi reasons_for, reasons_against, warnings, dan summary dalam Bahasa Indonesia yang jelas, padat, dan natural untuk trader.

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
1. TREN & KONTEKS PASAR: Evaluasi arah tren berdasarkan EMA20 (${ind.ema20}), EMA50 (${ind.ema50}), dan 30 candle terakhir.
2. ANALISA LIKUIDITAS: Cari Equal Highs/Lows, Swing High/Low, BSL/SSL, dan konfirmasi Liquidity Sweep / Reclaim.
3. DISPLACEMENT & STRUKTUR PASAR: Evaluasi dorongan candle terhadap ATR14 (${ind.atr14}) serta konfirmasi MSS / CHoCH / BOS.
4. LOKASI ENTRY & RISIKO: Periksa apakah entry segar, SL logis, dan tidak melawan momentum besar.
5. PENILAIAN SKOR (0-100):
   - Trend alignment (0-20), Liquidity quality (0-20), Structure confirmation (0-20), Displacement (0-15), Entry location (0-15), Volatility & session (0-10).
6. ATURAN KEPUTUSAN:
   - APPROVE: Skor >= 75, arah didukung bukti kuat.
   - CAUTION: Skor 50-74, setup layak dengan catatan risiko terukur.
   - REJECT: Skor < 50, ada kontradiksi fatal atau setup lemah.
   - WAIT_CONFIRMATION: Sinyal awal terlihat tapi struktur belum lengkap.
   - INSUFFICIENT_DATA: Data tidak cukup.

NILAI PARAMETER STANDAR:
- trend_alignment: "Strong" | "Valid" | "Weak" | "Unknown"
- pullback_quality: "Optimal" | "Good" | "Shallow" | "Late" | "Invalid" | "Unknown"
- volatility: "Low" | "Normal" | "High" | "Unknown"
- news_risk: "Low" | "Moderate" | "High" | "Unknown"

Balas HANYA dengan JSON valid sesuai schema tanpa Markdown.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payloadBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
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
          "decision", "score", "setup_type", "trend_alignment", "pullback_quality",
          "volatility", "news_risk", "liquidity_sweep", "displacement",
          "structure_confirmation", "poi_quality", "entry_status", "rr_valid",
          "reasons_for", "reasons_against", "warnings", "summary",
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

// Konversi selisih harga ke pips (XAU/USD: 1 pip = 0.10 | Forex mayor: 1 pip = 0.0001)
function calcPips(pair, priceA, priceB) {
  const diff = Math.abs(Number(priceA) - Number(priceB));
  if (Number.isNaN(diff)) return 0;
  const p = String(pair).toUpperCase();
  const mult = p.includes("XAU") || p.includes("GOLD") ? 10 : p.includes("JPY") ? 100 : 10000;
  return Math.round(diff * mult * 10) / 10;
}

function recapText() {
  const rows = readJournal();
  const line = (title, s) =>
    `${title}: ${s.closed} selesai | menang ${s.wins} | kalah ${s.losses} | win rate ${s.winRate.toFixed(0)}% | total ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2)}R | terbuka ${s.open}`;

  const summaryHeader = [
    line("Order dieksekusi AI", summarize(rows.filter((r) => r.aksi === "DIAMBIL"))),
    line("Semua kandidat", summarize(rows)),
  ].join("\n");

  // Ambil 15 transaksi terbaru yang dieksekusi AI (atau semua kandidat jika belum ada)
  const executed = rows.filter((r) => r.aksi === "DIAMBIL").slice(-15);
  if (!executed.length) return summaryHeader;

  const details = executed.map((r, idx) => {
    const slPips = calcPips(r.pair, r.entry, r.sl);
    const tpPips = calcPips(r.pair, r.entry, r.tp1);
    const statusIcon =
      r.status === "TP1" ? "✅" :
      r.status === "SL" ? "❌" :
      r.status === "EXPIRED" ? "🛡️" : "⏳";
    const rText = r.hasil_r ? ` (${Number(r.hasil_r) >= 0 ? "+" : ""}${r.hasil_r}R)` : "";

    return (
      `${idx + 1}. ${statusIcon} ${r.side} ${r.pair} [${r.status}${rText}]\n` +
      `   Entry: ${r.entry} | SL: ${r.sl} (${slPips} pips) | TP: ${r.tp1} (${tpPips} pips)`
    );
  });

  return `${summaryHeader}\n\n📋 Detail Eksekusi AI (Terbaru):\n${details.join("\n")}`;
}

// ---------- Penanganan Sinyal Baru (Dengan Auto-Execute AI) ----------
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
  let aiScore = 70;
  let aiApproved = true;

  if (AI_FILTER === "true" && aiBudgetOk()) {
    try {
      const ai = await analyzeWithGemini(job, e, bars);
      reason = ai.summary || reason;
      aiScore = ai.score;
      aiDecisionTag = `[${ai.decision} ${ai.score}/100] `;
      aiApproved = ai.score >= Number(MIN_AI_SCORE) && ai.decision !== "REJECT";

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

      evalBlock = [
        "",
        `<b>AI SETUP EVALUATION</b>`,
        `${badgeIcon} <code>[${html(ai.decision)}]</code> • <i>${html(ai.setup_type)}</i>`,
        `<pre>${html(evalPre)}</pre>${contraNote}`,
      ].join("\n");
    } catch (err) {
      console.error("Gemini gagal, fallback ke sinyal teknikal murni:", err.message);
      evalBlock = `\n⚠️ <i>AI Evaluation sibuk (eksekusi berdasarkan indikator teknikal).</i>`;
    }
  }

  let aksiStatus = "MENUNGGU";
  let autoFooter = "<b>Konfirmasi transaksi:</b>";
  let showButtons = true;

  if (isAutoExec) {
    showButtons = false;
    if (aiApproved) {
      try {
        const res = await executor.open({ pair: job.pair, entry, sl, tp1: tp }, side);
        aksiStatus = "DIAMBIL";
        autoFooter =
          `🤖 <b>AI EKSEKUSI ${side} ${html(job.pair)} DI HARGA ${fmt(entry)}</b>\n` +
          `• SL: <b>${fmt(sl)}</b> | TP: <b>${fmt(tp)}</b> (RR ${rrText})\n` +
          `• Skor AI: <b>${aiScore}/100</b> | Trailing Stop: <b>Aktif (+0.6R BE)</b>\n` +
          `<i>${html(res.note)}</i>`;
      } catch (err) {
        aksiStatus = "GAGAL";
        autoFooter = `❌ <b>AI GAGAL EKSEKUSI:</b> ${html(err.message)}`;
      }
    } else {
      aksiStatus = "SKIP";
      autoFooter = `🛡️ <b>AI MENOLAK SETUP (Skor ${aiScore}/100 &lt; ${MIN_AI_SCORE})</b>\n<i>Tidak buka posisi karena risiko terlalu tinggi.</i>`;
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
    autoFooter,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const extra = { parse_mode: "HTML" };
  if (showButtons) {
    extra.reply_markup = {
      inline_keyboard: [[
        { text: "🟢 BUY", callback_data: `buy|${e.id}` },
        { text: "🔴 SELL", callback_data: `sell|${e.id}` },
        { text: "⚪ SKIP", callback_data: `skip|${e.id}` },
      ]],
    };
  }

  const sent = await sendTelegram(text, extra);

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
    aksi: aksiStatus,
    msg_id: sent?.message_id ?? "",
    catatan: `${aiDecisionTag}${reason}`,
  });
  writeJournal(rows);
  console.log(`Sinyal diproses (${aksiStatus}):`, e.id);
}

// ---------- Hasil Sinyal & Laporan Trailing Stop ----------
async function handleResult(e) {
  const row = updateRow(e.id, (r) => {
    if (r.status !== "OPEN") return;
    r.status = e.outcome;
    r.hasil_r = String(e.r ?? 0);
  });
  if (!row || row.status !== e.outcome || row.aksi !== "DIAMBIL") return;

  const rVal = Number(e.r ?? 0);
  const rText = `${rVal >= 0 ? "+" : ""}${rVal}R`;
  const title =
    e.outcome === "TP1" ? `✅ <b>PROFIT (${rText}):</b> ${row.pair} ${row.tf} ${row.side}` :
    e.outcome === "SL"  ? `❌ <b>STOP LOSS (${rText}):</b> ${row.pair} ${row.tf} ${row.side}` :
                          `🛡️ <b>BREAK-EVEN / TUTUP (${rText}):</b> ${row.pair} ${row.tf} ${row.side}`;
  const noteLine = e.note ? `\n<i>${html(e.note)}</i>` : "";

  await sendTelegram(`${title}${noteLine}\n\n${html(recapText())}`, { parse_mode: "HTML" });
}

// ---------- Handler Tombol Manual (Jika Mode Manual) ----------
async function onCallback(cb) {
  if (String(cb.message?.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const answer = (text, alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  const [action, id] = String(cb.data ?? "").split("|");
  const msgId = cb.message.message_id;
  const row = readJournal().find((r) => r.id === id);

  if (!row) { await answer("Sinyal tidak ditemukan", true); await clearButtons(msgId); return; }
  if (row.aksi !== "MENUNGGU") { await answer(`Sudah diproses (${row.aksi})`); await clearButtons(msgId); return; }

  if (action === "skip") {
    updateRow(id, (r) => { r.aksi = "SKIP"; });
    await answer("Sinyal di-SKIP");
    await clearButtons(msgId);
    await sendTelegram(`⚪ <b>SKIP:</b> ${row.pair} ${row.tf}`, { parse_mode: "HTML" });
    return;
  }

  if (action !== "buy" && action !== "sell") return;
  const chosenSide = action.toUpperCase();

  try {
    await answer(`Mengirim order ${chosenSide}...`);
    const res = await executor.open(row, chosenSide);
    updateRow(id, (r) => { r.aksi = "DIAMBIL"; r.side = chosenSide; });
    await clearButtons(msgId);
    await sendTelegram(`✅ <b>ORDER TERKIRIM (${chosenSide} ${row.pair})</b>\n${html(res.note)}`, { parse_mode: "HTML" });
  } catch (err) {
    await answer(`GAGAL: ${err.message.slice(0, 150)}`, true);
  }
}

// ---------- Perintah Telegram ----------
async function onMessage(m) {
  if (String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const cmd = String(m.text ?? "").trim().split(/[ @]/)[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(
      `🤖 <b>Gemini Auto-Trading Bot Menu</b>\n\n` +
        `⚙️ <b>Mode Eksekusi</b>\n` +
        `/auto_on — AI langsung eksekusi otomatis (skor >= ${MIN_AI_SCORE})\n` +
        `/auto_off — Ubah ke mode konfirmasi tombol manual\n` +
        `/pause & /resume — Hentikan/lanjutkan pemantauan\n\n` +
        `📊 <b>Analisa & Jurnal</b>\n` +
        `/rekap — Cek hasil profit/loss AI (cek besok pagi!)\n` +
        `/open — Lihat posisi yang masih aktif & dipantau Trailing Stop\n` +
        `/status — Cek status bot & kuota AI\n` +
        `/analisa — Minta Gemini analisa market saat ini\n` +
        `/tes_sinyal — Simulasi eksekusi sinyal\n` +
        `/reset_jurnal — Reset catatan jurnal`,
      { parse_mode: "HTML" }
    );
  } else if (cmd === "/auto_on") {
    isAutoExec = true;
    await sendTelegram(`🤖 <b>Mode AUTO-EXECUTE AKTIF.</b> AI akan langsung membuka posisi simulasi jika skor >= ${MIN_AI_SCORE}/100.`, { parse_mode: "HTML" });
  } else if (cmd === "/auto_off") {
    isAutoExec = false;
    await sendTelegram("👆 <b>Mode MANUAL AKTIF.</b> Bot akan menampilkan tombol BUY / SELL / SKIP.", { parse_mode: "HTML" });
  } else if (cmd === "/pause") {
    isPaused = true;
    await sendTelegram("⏸️ <b>Bot di-PAUSE.</b>", { parse_mode: "HTML" });
  } else if (cmd === "/resume") {
    isPaused = false;
    await sendTelegram("▶️ <b>Bot AKTIF kembali.</b>", { parse_mode: "HTML" });
  } else if (cmd === "/status") {
    const rows = readJournal();
    const openCount = rows.filter((r) => r.status === "OPEN" && r.aksi === "DIAMBIL").length;
    const wib = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
    await sendTelegram(
      `📡 <b>Status Bot (${wib} WIB)</b>\n` +
        `• Kondisi: <b>${isPaused ? "⏸️ PAUSED" : "🟢 AKTIF"}</b>\n` +
        `• Eksekusi AI: <b>${isAutoExec ? `🤖 AUTO (Skor >= ${MIN_AI_SCORE})` : "👆 MANUAL"}</b>\n` +
        `• Trailing Stop: <b>AKTIF (+0.6R BE, Trail 0.5R)</b>\n` +
        `• Strategi: <b>${jobs.map((j) => j.label).join(", ")}</b>\n` +
        `• Kuota AI Hari Ini: <b>${dayCount} / ${MAX_PER_DAY}</b>\n` +
        `• Posisi Aktif AI: <b>${openCount}</b>`,
      { parse_mode: "HTML" }
    );
  } else if (cmd === "/open") {
    const openRows = readJournal().filter((r) => r.status === "OPEN" && r.aksi === "DIAMBIL");
    if (!openRows.length) {
      await sendTelegram("📭 Tidak ada posisi aktif AI saat ini.");
      return;
    }
    const list = openRows
      .map((r, i) => `${i + 1}. <b>${r.side} ${r.pair}</b> (${r.tf})\n   Entry: ${r.entry} | SL Awal: ${r.sl} | TP: ${r.tp1}`)
      .join("\n\n");
    await sendTelegram(`📂 <b>Posisi Aktif AI (${openRows.length}):</b>\n\n${list}`, { parse_mode: "HTML" });
  } else if (cmd === "/rekap") {
    await sendTelegram(recapText());
  } else if (cmd === "/reset_jurnal") {
    if (fs.existsSync(JOURNAL_FILE)) {
      fs.renameSync(JOURNAL_FILE, JOURNAL_FILE.replace(/\.csv$/, "") + `-arsip-${Date.now()}.csv`);
    }
    writeJournal([]);
    await sendTelegram("🗑️ <b>Jurnal berhasil di-reset!</b> Siap mencatat performa AI mulai sekarang.", { parse_mode: "HTML" });
  } else if (cmd === "/analisa") {
    await sendTelegram("🔍 Menarik data candle & meminta analisa Gemini...");
    try {
      const job = jobs[0];
      const bars = await fetchClosedBars(job.spec, job.tf, process.env);
      const last = bars[bars.length - 1];
      const ind = calcIndicatorsForAI(bars);
      const summary = bars.slice(-25).map((b) => `${new Date(b.t).toISOString().slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c}`).join("\n");
      const prompt = `Berikan analisa scalping singkat (maksimal 5 poin) untuk ${job.pair} (${tfName(job.tf)}) model Hybrid EMA20 + Institutional Liquidity. EMA20=${ind.ema20}, EMA50=${ind.ema50}, ATR14=${ind.atr14}, Harga=${last.c}.\n\nData Candle:\n${summary}`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.25 } }),
      });
      const data = await res.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Tidak ada respon.";
      await sendTelegram(`🧠 <b>Analisa Market ${job.pair} (${tfName(job.tf)})</b>\n\n${html(reply)}`, { parse_mode: "HTML" });
    } catch (err) {
      await sendTelegram(`❌ Gagal analisa: ${html(err.message)}`, { parse_mode: "HTML" });
    }
  } else if (cmd === "/tes_sinyal") {
    await sendTelegram("⏳ Menjalankan simulasi auto-eksekusi AI...");
    const job = jobs[0];
    const bars = await fetchClosedBars(job.spec, job.tf, process.env);
    const last = bars[bars.length - 1];
    await handleSignal(job, {
      id: `TEST-${Date.now()}`,
      time: last.t,
      side: "BUY",
      entry: last.c,
      sl: Number((last.c - 3.0).toFixed(2)),
      tp1: Number((last.c + 4.5).toFixed(2)),
      rr1: 1.5,
      reason: "Simulasi Bullish Liquidity Sweep + Displacement MSS di atas EMA20",
    }, bars);
  }
}

// ---------- Polling & Jadwal ----------
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
        } catch (err) { console.error("Error update Telegram:", err.message); }
      }
    } catch (err) {
      if (err.message.includes("409") && Date.now() - startTime < 90_000) { await sleep(5000); continue; }
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

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
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
      try { await processJob(job); } catch (e) { console.error(`[${job.pair} ${job.label}] gagal: ${e.message}`); }
      await sleep(8000);
    }
  });
  return queue;
}

function scheduleNext(tf) {
  const tfMs = tf * 60_000;
  const now = Date.now();
  const next = Math.floor(now / tfMs) * tfMs + tfMs + 10_000;
  setTimeout(async () => { await cycle(tf); scheduleNext(tf); }, next - now);
}

http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Bot Aktif | Auto-Execute: ${isAutoExec}`);
}).listen(Number(PORT), () => console.log(`Keep-alive server berjalan di port ${PORT}`));

const tfs = [...new Set(jobs.map((j) => j.tf))];
console.log(`Gemini Auto-Trading Bot aktif. Strategi: ${jobs.map((j) => j.label).join(", ")}`);
await sendTelegram(
  `🤖 <b>Bot Auto-Execute AI Aktif!</b>\n` +
  `• Strategi: ${jobs.map((j) => j.label).join(", ")}\n` +
  `• Trailing Stop: Aktif (+0.6R Break-Even, Trail 0.5R)\n` +
  `• Ambang Eksekusi AI: Skor >= ${MIN_AI_SCORE}/100`,
  { parse_mode: "HTML" }
).catch(() => {});

pollTelegram();
setInterval(() => sweepExpired().catch(() => {}), 60_000);
for (const tf of tfs) { await cycle(tf); scheduleNext(tf); }
