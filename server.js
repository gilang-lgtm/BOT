import fs from "node:fs";
import { runEngine } from "./engine.js";
import { runScalp } from "./scalp.js";
import { fetchClosedBars, labelOf } from "./data.js";
import { makeExecutor } from "./executor.js";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PAIRS = "twelvedata:XAU/USD",
  STRATEGIES = "scalp",
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
} = process.env;

let isPaused = false;

for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
  if (!process.env[k]) { console.error(`Env ${k} belum diisi`); process.exit(1); }
}
if (AI_FILTER === "true" && !GEMINI_API_KEY) {
  console.error("AI_FILTER=true membutuhkan GEMINI_API_KEY dari Google AI Studio");
  process.exit(1);
}

let executor;
try { executor = makeExecutor(EXECUTION); } catch (e) { console.error(e.message); process.exit(1); }

const STRATS = {
  smc:   { label: "SMC",            tf: Number(SMC_TF),   run: runEngine, hasZones: true },
  scalp: { label: "FOREX SCALPING", tf: Number(SCALP_TF), run: runScalp,  hasZones: false },
};
const tfName = (m) => (m === 60 ? "H1" : `M${m}`);
const ttlMs = Number(SIGNAL_TTL_MIN) * 60_000;
const jobs = [];

for (const spec of PAIRS.split(",").map((s) => s.trim()).filter(Boolean)) {
  for (const key of STRATEGIES.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!STRATS[key]) { console.error(`Strategi tidak dikenal: "${key}"`); process.exit(1); }
    jobs.push({ spec, key, pair: labelOf(spec), ...STRATS[key] });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v == null || v === "" ? "-" : Number(v).toLocaleString("en-US", { minimumFractionDigits: Math.abs(v) < 20 ? 5 : 2, maximumFractionDigits: Math.abs(v) < 20 ? 5 : 2 }));
const html = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Telegram API ----------
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(`Telegram ${method} ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.result;
}
const sendTelegram = (text, extra = {}) => tg("sendMessage", { chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 3900), ...extra });
const clearButtons = (messageId) =>
  messageId ? tg("editMessageReplyMarkup", { chat_id: TELEGRAM_CHAT_ID, message_id: Number(messageId), reply_markup: { inline_keyboard: [] } }).catch(() => {}) : Promise.resolve();

// ---------- Integrasi Gemini API (Free Tier) ----------
let dayKey = "", dayCount = 0;
function aiBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  return dayCount < Number(MAX_PER_DAY);
}

async function analyzeWithGemini(job, signal, recentBars) {
  dayCount++;
  const candlesSummary = recentBars.slice(-15).map((b) =>
    `${new Date(b.t).toISOString().slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c}`
  ).join("\n");

  const prompt = `Kamu adalah analis trading institusional & scalping profesional.
Evaluasi kandidat sinyal berikut berdasarkan price action 15 candle terakhir:
Pair: ${job.pair} | Timeframe: ${tfName(job.tf)} | Strategi: ${job.label}
Kandidat Arah: ${signal.side}
Entry awal: ${signal.entry} | SL awal: ${signal.sl} | TP awal: ${signal.tp1}
Alasan teknikal awal: ${signal.reason}

15 Candle Terakhir (UTC):
${candlesSummary}

Tugasmu:
1. Tentukan apakah setup ini valid dan memiliki probabilitas tinggi (approve: true) atau rawan fakeout/sideways (approve: false).
2. Jika approve: true, kamu boleh menyempurnakan harga entry, stop_loss, dan take_profit agar pas di struktur support/resistance terdekat dengan Risk Reward minimal 1:1.5.
3. Tulis label tren singkat (contoh: "Trend bullish" atau "Trend bearish") dan alasan singkat 1 kalimat bahasa Indonesia.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            approve: { type: "BOOLEAN" },
            side: { type: "STRING", enum: ["BUY", "SELL"] },
            entry: { type: "NUMBER" },
            stop_loss: { type: "NUMBER" },
            take_profit: { type: "NUMBER" },
            risk_reward: { type: "STRING" },
            trend_label: { type: "STRING" },
            reason: { type: "STRING" },
          },
          required: ["approve", "side", "entry", "stop_loss", "take_profit", "risk_reward", "trend_label", "reason"],
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Respon Gemini kosong");
  return JSON.parse(rawText);
}

// ---------- Jurnal CSV ----------
const COLS = ["id", "waktu", "ts", "strategi", "pair", "tf", "side", "entry", "sl", "tp1", "tp2", "rr1", "rr2", "status", "hasil_r", "aksi", "msg_id", "catatan"];
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
    closed: closed.length, wins, losses: closed.length - wins,
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
  if (readJournal().some((r) => r.id === e.id)) return;
  const tf = tfName(job.tf);
  const stale = Date.now() - (e.time + job.tf * 60_000) > ttlMs;
  
  if (stale) return; // Abaikan sinyal lama saat bot baru nyala

  let side = e.side;
  let entry = e.entry;
  let sl = e.sl;
  let tp = e.tp1;
  let rrText = `1:${e.rr1}`;
  let trendLabel = side === "BUY" ? "Trend bullish" : "Trend bearish";
  let reason = e.reason;

  // Validasi dan penyempurnaan oleh Gemini API
  if (AI_FILTER === "true" && aiBudgetOk()) {
    try {
      const ai = await analyzeWithGemini(job, e, bars);
      if (!ai.approve) {
        console.log(`[Gemini Filter] Sinyal ${e.id} ditolak AI: ${ai.reason}`);
        return;
      }
      side = ai.side || side;
      entry = ai.entry || entry;
      sl = ai.stop_loss || sl;
      tp = ai.take_profit || tp;
      rrText = ai.risk_reward || rrText;
      trendLabel = ai.trend_label || trendLabel;
      reason = ai.reason || reason;
    } catch (err) {
      console.error("Gemini gagal, fallback ke sinyal teknikal murni:", err.message);
    }
  }

  const isBuy = side === "BUY";

  // Format pesan menyerupai tampilan pada foto referensi Anda
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
    "",
    "<b>Konfirmasi transaksi:</b>",
  ].join("\n");

  // 3 Tombol Interaktif: BUY | SELL | SKIP
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
    catatan: reason,
  });
  writeJournal(rows);
  console.log("Sinyal Gemini terkirim:", e.id);
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
  const answer = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
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

  if (Date.now() - Number(row.ts) > ttlMs) {
    updateRow(id, (r) => { r.aksi = "TIDAK DIJAWAB"; });
    await answer("Sinyal kedaluwarsa!", true);
    await clearButtons(msgId);
    return;
  }

  const chosenSide = action.toUpperCase(); // "BUY" atau "SELL"

  try {
    await answer(`Mengirim order ${chosenSide} ke broker...`);
    const res = await executor.open(row, chosenSide);
    updateRow(id, (r) => { r.aksi = "DIAMBIL"; r.side = chosenSide; });
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

async function onMessage(m) {
  if (String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const cmd = String(m.text ?? "").trim().split(/[ @]/)[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(
      `🤖 <b>Trading Bot Menu</b>\n\n` +
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
    await sendTelegram("⏸️ <b>Bot di-PAUSE.</b> Sinyal baru tidak akan dikirim sampai Anda mengetik /resume.", { parse_mode: "HTML" });

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
    const list = openRows.map((r, i) =>
      `${i + 1}. <b>${r.side} ${r.pair}</b> (${r.tf}) [${r.aksi}]\n` +
      `   Entry: ${r.entry} | SL: ${r.sl} | TP: ${r.tp1}`
    ).join("\n\n");
    await sendTelegram(`📂 <b>Daftar Sinyal OPEN (${openRows.length}):</b>\n\n${list}`, { parse_mode: "HTML" });

  } else if (cmd === "/rekap") {
    await sendTelegram(recapText());

  } else if (cmd === "/reset_jurnal") {
    if (fs.existsSync(JOURNAL_FILE)) {
      const backupName = JOURNAL_FILE.replace(/\.csv$/, "") + `-arsip-${Date.now()}.csv`;
      fs.renameSync(JOURNAL_FILE, backupName);
    }
    writeJournal([]);
    await sendTelegram("🗑️ <b>Jurnal berhasil di-reset!</b> Data lama telah diarsipkan di server.", { parse_mode: "HTML" });

  } else if (cmd === "/analisa") {
    await sendTelegram("🔍 Sedang menarik data candle terkini & meminta pandangan Gemini...");
    try {
      const job = jobs[0];
      const bars = await fetchClosedBars(job.spec, job.tf, process.env);
      const last = bars[bars.length - 1];
      const summary = bars.slice(-20).map((b) =>
        `${new Date(b.t).toISOString().slice(11, 16)} O:${b.o} H:${b.h} L:${b.l} C:${b.c}`
      ).join("\n");

      const prompt = `Berikan analisa scalping singkat (maksimal 5 poin) untuk ${job.pair} Timeframe ${tfName(job.tf)} berdasarkan 20 candle terakhir (UTC) berikut.
Sebutkan: 1) Arah tren jangka pendek, 2) Level Support & Resistance terdekat, 3) Skenario entry terbaik saat ini, dan 4) Peringatan risiko. Gunakan bahasa Indonesia yang padat dan jelas tanpa tabel.
Harga terakhir: ${last.c}\n\nData Candle:\n${summary}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
      let res;
      for (let attempt = 1; attempt <= 2; attempt++) {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
        });
        if (res.status !== 503) break;
        await sleep(3000);
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Tidak ada respon dari Gemini.";
      await sendTelegram(`🧠 <b>Analisa Market ${job.pair} (${tfName(job.tf)})</b>\n\n${html(reply)}`, { parse_mode: "HTML" });
    } catch (err) {
      await sendTelegram(`❌ Gagal melakukan analisa: ${html(err.message)}`, { parse_mode: "HTML" });
    }

  } else if (cmd === "/tes_sinyal") {
    await sendTelegram("⏳ Menarik data live & meminta analisa Gemini...");
    const job = jobs[0];
    const bars = await fetchClosedBars(job.spec, job.tf, process.env);
    const last = bars[bars.length - 1];
    const dummySignal = {
      id: `TEST-${Date.now()}`,
      time: last.t,
      side: "BUY",
      entry: last.c,
      sl: Number((last.c - 3.0).toFixed(2)),
      tp1: Number((last.c + 4.5).toFixed(2)),
      rr1: 1.5,
      reason: "Simulasi pullback EMA20 pada tren naik M5",
    };
    await handleSignal(job, dummySignal, bars);
  }
}

async function pollTelegram() {
  let offset = 0;
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
  const day = d.getUTCDay(), h = d.getUTCHours();
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
  const events = job.run(bars)
    .map((e) => ({ ...e, id: e.id.replace("{PAIR}", prefix) }))
    .filter((e) => e.time > state[stateKey])
    .sort((a, b) => a.time - b.time);

  for (const e of events) {
    if (e.type === "signal") await handleSignal(job, e, bars);
    else await handleResult(e);
  }
  state[stateKey] = lastBar;
  saveState(state);
}

let queue = Promise.resolve();
function cycle(tf) {
  queue = queue.then(async () => {
    await sweepExpired().catch(() => {});
    if (marketClosed()) return;
    for (const job of jobs.filter((j) => j.tf === tf)) {
      try { await processJob(job); }
      catch (e) { console.error(`[${job.pair} ${job.label}] gagal: ${e.message}`); }
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

if (process.argv.includes("--test")) {
  await sendTelegram("✅ Tes Gemini Trading Bot: koneksi Telegram berhasil.");
  process.exit(0);
}

const tfs = [...new Set(jobs.map((j) => j.tf))];
console.log(`Gemini Trading Bot aktif (mode ${executor.name}).`);
await sendTelegram(`✅ <b>Bot Aktif</b> (Mode: ${executor.name.toUpperCase()})`, { parse_mode: "HTML" }).catch(() => {});

pollTelegram();
setInterval(() => sweepExpired().catch(() => {}), 60_000);
for (const tf of tfs) { await cycle(tf); scheduleNext(tf); }
