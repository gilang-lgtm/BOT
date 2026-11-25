// SMC Agent v4: sinyal (SMC + Scalping) -> Telegram dengan tombol konfirmasi -> order simulasi + jurnal
// Butuh Node.js 20.6+ (fetch bawaan dan --env-file). Tanpa dependensi npm, tanpa domain, tanpa HTTPS.

import fs from "node:fs";
import { runEngine } from "./engine.js";
import { runScalp } from "./scalp.js";
import { fetchClosedBars, labelOf } from "./data.js";
import { makeExecutor } from "./executor.js";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PAIRS = "yahoo:XAUUSD=X,yahoo:EURUSD=X",
  STRATEGIES = "smc,scalp",
  SMC_TF = "15",
  SCALP_TF = "5",
  EXECUTION = "paper",
  SIGNAL_TTL_MIN = "10",
  ANTHROPIC_API_KEY,
  MODEL = "claude-sonnet-5-5",
  AI_NOTE = "false",
  MAX_PER_DAY = "30",
  JOURNAL_FILE = "./journal.csv",
  STATE_FILE = "./state.json",
} = process.env;

for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
  if (!process.env[k]) { console.error(`Env ${k} belum diisi (lihat env.example)`); process.exit(1); }
}
if (AI_NOTE === "true" && !ANTHROPIC_API_KEY) { console.error("AI_NOTE=true butuh ANTHROPIC_API_KEY"); process.exit(1); }

let executor;
try { executor = makeExecutor(EXECUTION); } catch (e) { console.error(e.message); process.exit(1); }

// ---------- strategi & pekerjaan (pair x strategi) ----------
const STRATS = {
  smc:   { label: "SMC",       tf: Number(SMC_TF),   run: runEngine, hasZones: true },
  scalp: { label: "Scalping",  tf: Number(SCALP_TF), run: runScalp,  hasZones: false },
};
const tfName = (m) => (m === 60 ? "H1" : `M${m}`);
const ttlMs = Number(SIGNAL_TTL_MIN) * 60_000;
const jobs = [];
for (const spec of PAIRS.split(",").map((s) => s.trim()).filter(Boolean)) {
  for (const key of STRATEGIES.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!STRATS[key]) { console.error(`Strategi tidak dikenal: "${key}" (pakai smc / scalp)`); process.exit(1); }
    if (![5, 15, 30, 60].includes(STRATS[key].tf)) { console.error("Timeframe harus 5, 15, 30, atau 60 menit"); process.exit(1); }
    jobs.push({ spec, key, pair: labelOf(spec), ...STRATS[key] });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v == null || v === "" ? "-" : Number(v).toFixed(Math.abs(v) < 20 ? 5 : 2));
const html = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- Telegram ----------
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

// ---------- catatan risiko AI (opsional) ----------
let dayKey = "", dayCount = 0;
function aiBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  return dayCount < Number(MAX_PER_DAY);
}
async function callClaude(prompt, maxTokens) {
  dayCount++;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// ---------- jurnal CSV ----------
// aksi: MENUNGGU (tombol aktif) | DIAMBIL | SKIP | TIDAK DIJAWAB
const COLS = ["id", "waktu", "ts", "strategi", "pair", "tf", "side", "entry", "sl", "tp1", "tp2", "rr1", "rr2", "status", "hasil_r", "aksi", "msg_id", "catatan"];
const esc = (v) => String(v ?? "").replace(/[,\r\n]+/g, " ").trim();

function readJournal() {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const lines = fs.readFileSync(JOURNAL_FILE, "utf8").split("\n").filter(Boolean);
  if (lines[0] !== COLS.join(",")) {
    // jurnal lama (versi sebelumnya) dipindah agar tidak tercampur
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
// ubah satu baris secara sinkron (aman dari tabrakan antar handler)
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
const recapLine = (title, s) =>
  `${title}: ${s.closed} selesai | menang ${s.wins} | kalah ${s.losses} | win rate ${s.winRate.toFixed(0)}% | total ${s.totalR >= 0 ? "+" : ""}${s.totalR.toFixed(2)}R | terbuka ${s.open}`;
function recapText() {
  const rows = readJournal();
  return [
    recapLine("Order yang kamu ambil", summarize(rows.filter((r) => r.aksi === "DIAMBIL"))),
    recapLine("Semua sinyal bot", summarize(rows)),
  ].join("\n");
}

// ---------- sinyal baru ----------
async function handleSignal(job, e) {
  if (readJournal().some((r) => r.id === e.id)) return;
  const isBuy = e.side === "BUY";
  const tf = tfName(job.tf);
  // sinyal lama (mis. bot baru menyala lagi setelah mati) tidak dikirim, hanya dicatat di jurnal
  const stale = Date.now() - (e.time + job.tf * 60_000) > ttlMs;

  let note = "";
  if (!stale && AI_NOTE === "true" && aiBudgetOk()) {
    try {
      note = await callClaude(
        [
          "Kamu analis trading. Tulis catatan risiko dalam Bahasa Indonesia, 2-3 kalimat, tanpa format markdown.",
          "Sebutkan hal yang perlu dicek di chart sebelum entry (mis. berita penting, harga sudah menjauh, tren timeframe besar).",
          "Jangan menjanjikan hasil dan jangan memerintahkan entry. Jangan mengarang angka.",
          `Data: ${e.side} ${job.pair} ${tf} strategi ${job.label}, entry ${fmt(e.entry)}, SL ${fmt(e.sl)}, TP ${fmt(e.tp1)}, RR 1:${e.rr2}, alasan: ${e.reason}.`,
        ].join("\n"),
        300
      );
    } catch (err) { console.error("Catatan AI gagal:", err.message); }
  }

  const table = job.hasZones
    ? [
        ["Entry area", `${fmt(e.bot)} - ${fmt(e.top)}`],
        ["Entry limit", fmt(e.entry)],
        ["Stop Loss", fmt(e.sl)],
        ["TP1", `${fmt(e.tp1)} (1:${e.rr1})`],
        ["TP2", `${fmt(e.tp2)} (1:${e.rr2})`],
      ]
    : [
        ["Entry", fmt(e.entry)],
        ["Stop Loss", fmt(e.sl)],
        ["Take Profit", fmt(e.tp1)],
        ["Risk Reward", `1:${e.rr1}`],
      ];
  const w = Math.max(...table.map(([k]) => k.length)) + 2;
  const pre = table.map(([k, v]) => k.padEnd(w) + v).join("\n");

  const text = [
    `${isBuy ? "🟢" : "🔴"} <b>${e.side} ${html(job.pair)}</b>`,
    `<i>${html(job.label)} • Timeframe ${tf}</i>`,
    "",
    `<pre>${html(pre)}</pre>`,
    `${isBuy ? "📈" : "📉"} Trend ${isBuy ? "bullish" : "bearish"}`,
    `<i>${html(e.reason)}</i>`,
    note ? `\n🤖 <i>${html(note)}</i>` : null,
    "",
    `⚠️ <i>Analisis edukasi, bukan saran finansial. Pasang stop loss dan batasi risiko per trade.</i>`,
    `⏳ Berlaku ${SIGNAL_TTL_MIN} menit • Mode ${executor.name.toUpperCase()}`,
    "",
    "<b>Konfirmasi transaksi:</b>",
  ].filter((l) => l !== null).join("\n");

  const sent = stale ? null : await sendTelegram(text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ ${e.side}`, callback_data: `t|${e.id}` },
        { text: "⏭ SKIP", callback_data: `s|${e.id}` },
      ]],
    },
  });

  const rows = readJournal();
  rows.push({
    id: e.id, waktu: new Date(e.time + job.tf * 60_000).toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" }),
    ts: e.time + job.tf * 60_000, strategi: job.label, pair: job.pair, tf, side: e.side,
    entry: fmt(e.entry), sl: fmt(e.sl), tp1: fmt(e.tp1), tp2: fmt(e.tp2), rr1: e.rr1, rr2: e.rr2,
    status: "OPEN", hasil_r: "", aksi: stale ? "TIDAK DIJAWAB" : "MENUNGGU", msg_id: sent?.message_id ?? "", catatan: e.reason,
  });
  writeJournal(rows);
  console.log(stale ? "Sinyal lama dicatat tanpa dikirim:" : "Sinyal terkirim:", e.id);
}

// ---------- hasil sinyal ----------
async function handleResult(e) {
  const row = updateRow(e.id, (r) => {
    if (r.status !== "OPEN") return;
    r.status = e.outcome;
    r.hasil_r = e.outcome === "EXPIRED" ? "0" : String(e.r);
  });
  if (!row || row.status !== e.outcome) return;
  console.log("Hasil dicatat:", e.id, e.outcome, `(aksi: ${row.aksi})`);
  if (row.aksi !== "DIAMBIL") return; // sinyal yang tidak diambil dicatat diam-diam di jurnal

  const title =
    e.outcome === "TP1" ? `✅ ${row.pair} ${row.tf} ${row.side}: target tercapai (+${e.r}R)` :
    e.outcome === "SL"  ? `❌ ${row.pair} ${row.tf} ${row.side}: stop loss kena (-1R)` :
                          `⌛ ${row.pair} ${row.tf} ${row.side}: kedaluwarsa tanpa hasil`;
  await sendTelegram(`${title} [${executor.name}]\n\n${recapText()}\n\nCatatan: hasil dihitung dari harga chart dengan asumsi entry terisi di harga entry. Hasil akun asli bisa berbeda (spread, slippage, telat entry).`);
}

// ---------- tombol & perintah Telegram ----------
async function onCallback(cb) {
  if (String(cb.message?.chat?.id) !== String(TELEGRAM_CHAT_ID)) return; // hanya pemilik bot
  const answer = (text, alert = false) => tg("answerCallbackQuery", { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});
  const [action, id] = String(cb.data ?? "").split("|");
  const msgId = cb.message.message_id;
  const row = readJournal().find((r) => r.id === id);

  if (!row) { await answer("Sinyal tidak ditemukan", true); await clearButtons(msgId); return; }
  if (row.aksi !== "MENUNGGU") { await answer(`Sudah diproses (${row.aksi})`); await clearButtons(msgId); return; }

  if (action === "s") {
    updateRow(id, (r) => { r.aksi = "SKIP"; });
    await answer("Dilewati");
    await clearButtons(msgId);
    await sendTelegram(`⏭ Dilewati: ${row.side} ${row.pair} ${row.tf}. Sinyal ini tetap dipantau di jurnal.`);
    return;
  }
  if (action !== "t") return;

  if (Date.now() - Number(row.ts) > ttlMs) {
    updateRow(id, (r) => { r.aksi = "TIDAK DIJAWAB"; });
    await answer("Sinyal kedaluwarsa, harga sudah bergerak. Tunggu sinyal baru.", true);
    await clearButtons(msgId);
    return;
  }
  if (row.status !== "OPEN") {
    updateRow(id, (r) => { r.aksi = "TIDAK DIJAWAB"; });
    await answer(`Sinyal sudah selesai (${row.status}), tidak bisa diambil.`, true);
    await clearButtons(msgId);
    return;
  }

  try {
    const res = await executor.open(row);
    updateRow(id, (r) => { r.aksi = "DIAMBIL"; });
    await answer("Order dicatat ✅");
    await clearButtons(msgId);
    await sendTelegram(`✅ ${row.side} ${row.pair} ${row.tf} diambil: ${res.note}.\nEntry ${row.entry} | SL ${row.sl} | TP ${row.tp1}\nHasil (SL/TP) akan dikabari di sini.`);
  } catch (err) {
    console.error("Eksekusi gagal:", err.message);
    await answer("Order GAGAL, tidak dicatat. Cek log bot.", true);
  }
}

async function onMessage(m) {
  if (String(m.chat?.id) !== String(TELEGRAM_CHAT_ID)) return;
  const cmd = String(m.text ?? "").trim().split(/[ @]/)[0];
  if (cmd === "/rekap") await sendTelegram(recapText());
  else if (cmd === "/start" || cmd === "/help") {
    await sendTelegram(
      `Halo! Bot sinyal aktif (mode ${executor.name.toUpperCase()}).\n` +
      `Pair: ${[...new Set(jobs.map((j) => j.pair))].join(", ")}\n` +
      `Strategi: ${[...new Set(jobs.map((j) => `${j.label} ${tfName(j.tf)}`))].join(", ")}\n\n` +
      "Tiap sinyal punya tombol konfirmasi. Tekan SKIP bila tidak mau.\n/rekap : ringkasan hasil"
    );
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
        } catch (err) { console.error("Gagal memproses update Telegram:", err.message); }
      }
    } catch (err) {
      console.error("Polling Telegram gagal:", err.message);
      await sleep(5000);
    }
  }
}

// tombol yang tidak dijawab sampai waktu habis dinonaktifkan
async function sweepExpired() {
  const now = Date.now();
  const expired = readJournal().filter((r) => r.aksi === "MENUNGGU" && now - Number(r.ts) > ttlMs);
  for (const r of expired) {
    updateRow(r.id, (x) => { x.aksi = "TIDAK DIJAWAB"; });
    await clearButtons(r.msg_id);
  }
}

// ---------- pemrosesan data ----------
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// pasar forex/emas tutup akhir pekan (hemat request)
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

  // data candle close terbaru belum tersedia di penyedia -> coba lagi sekali
  const expected = Math.floor(Date.now() / tfMs) * tfMs - tfMs;
  if (lastBar < expected && attempt === 1 && !marketClosed()) {
    await sleep(25_000);
    return processJob(job, 2);
  }

  if (state[stateKey] == null) {
    state[stateKey] = lastBar;
    saveState(state);
    console.log(`[${job.pair} ${job.label}] baseline di candle ${new Date(lastBar).toISOString()}; hanya sinyal baru yang dikirim`);
    return;
  }

  const prefix = `${job.pair}-${job.key}-${job.tf}`;
  const events = job.run(bars)
    .map((e) => ({ ...e, id: e.id.replace("{PAIR}", prefix) }))
    .filter((e) => e.time > state[stateKey])
    .sort((a, b) => a.time - b.time);

  for (const e of events) {
    if (e.type === "signal") await handleSignal(job, e);
    else await handleResult(e);
  }
  state[stateKey] = lastBar;
  saveState(state);
  console.log(`[${job.pair} ${job.label}] ${new Date().toISOString()} candle terakhir ${new Date(lastBar).toISOString()}, event baru: ${events.length}`);
}

let queue = Promise.resolve(); // satu siklus pada satu waktu
function cycle(tf) {
  queue = queue.then(async () => {
    await sweepExpired().catch((e) => console.error("Sweep gagal:", e.message));
    if (marketClosed()) { console.log(`Pasar tutup (akhir pekan), siklus ${tfName(tf)} dilewati.`); return; }
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
  const next = Math.floor(now / tfMs) * tfMs + tfMs + 10_000; // 10 detik setelah candle close
  setTimeout(async () => { await cycle(tf); scheduleNext(tf); }, next - now);
  console.log(`Siklus ${tfName(tf)} berikutnya: ${new Date(next).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })} WIB`);
}

// ---------- main ----------
if (process.argv.includes("--test")) {
  await sendTelegram("✅ Tes SMC Agent: koneksi Telegram berhasil.");
  console.log("Pesan tes terkirim ke Telegram.");
  process.exit(0);
}

const tfs = [...new Set(jobs.map((j) => j.tf))];
console.log(`SMC Agent aktif (mode ${executor.name}). Pekerjaan: ${jobs.map((j) => `${j.pair} ${j.label} ${tfName(j.tf)}`).join(", ")}`);
await sendTelegram(`✅ Bot aktif (mode ${executor.name.toUpperCase()}).\n${jobs.map((j) => `• ${j.pair} ${j.label} ${tfName(j.tf)}`).join("\n")}\n\nKetik /rekap untuk ringkasan hasil.`).catch((e) => console.error("Pesan awal gagal:", e.message));

pollTelegram();
setInterval(() => sweepExpired().catch(() => {}), 60_000);
for (const tf of tfs) { await cycle(tf); scheduleNext(tf); }
