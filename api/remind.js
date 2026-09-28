/**
 * Due reminders dispatcher: GET/POST /api/remind
 * Env: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Cron/external scheduler should hit this URL periodically.
 */

const {
  supabaseConfigured,
  sbHeaders,
  sbFrom,
  sbRest,
} = require("./_sb");

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function tgSendMessage(chatId, text) {
  const t = token();
  if (!t) throw new Error("no_token");
  const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg =
      (data && data.description) || "Telegram sendMessage HTTP " + res.status;
    throw new Error(msg);
  }
  return data;
}

async function markSent(row) {
  if (row.id != null) {
    await sbRest(sbFrom("reminders") + "?id=eq." + encodeURIComponent(String(row.id)), {
      method: "PATCH",
      headers: sbHeaders({ Prefer: "return=minimal" }),
      body: { sent: true },
    });
    return;
  }
  // Fallback: match by chat_id + fire_at + body
  let q =
    sbFrom("reminders") +
    "?chat_id=eq." +
    encodeURIComponent(String(row.chat_id)) +
    "&fire_at=eq." +
    encodeURIComponent(String(row.fire_at)) +
    "&body=eq." +
    encodeURIComponent(String(row.body)) +
    "&sent=eq.false";
  await sbRest(q, {
    method: "PATCH",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    body: { sent: true },
  });
}

async function processDue() {
  if (!token()) {
    const err = new Error("no_token");
    err.httpStatus = 503;
    throw err;
  }
  if (!supabaseConfigured()) {
    const err = new Error("no_supabase");
    err.httpStatus = 503;
    throw err;
  }

  const nowIso = new Date().toISOString();
  const rows = await sbRest(
    sbFrom("reminders") +
      "?sent=eq.false" +
      "&fire_at=lte." +
      encodeURIComponent(nowIso) +
      "&select=id,chat_id,body,fire_at,sent" +
      "&order=fire_at.asc" +
      "&limit=50"
  );
  const list = Array.isArray(rows) ? rows : [];
  let sent = 0;
  let failed = 0;

  for (const row of list) {
    try {
      const body = row.body != null ? String(row.body) : "";
      await tgSendMessage(
        row.chat_id,
        "Напоминание: " + escapeHtml(body)
      );
      await markSent(row);
      sent += 1;
    } catch (_) {
      failed += 1;
    }
  }

  return { ok: true, sent, failed };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  try {
    const result = await processDue();
    return res.status(200).json(result);
  } catch (err) {
    const code = String((err && err.message) || err);
    const status = (err && err.httpStatus) || (code === "no_supabase" || code === "no_token" ? 503 : 500);
    const short =
      code === "no_token"
        ? "TELEGRAM_BOT_TOKEN не задан"
        : code === "no_supabase"
          ? "Supabase не настроен"
          : code.startsWith("supabase_")
            ? "ошибка базы"
            : "ошибка";
    return res.status(status).json({ ok: false, error: short });
  }
};
