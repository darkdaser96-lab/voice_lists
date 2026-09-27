/**
 * Telegram webhook: /api/bot
 * Env: TELEGRAM_BOT_TOKEN, GROQ_API_KEY, WEBHOOK_URL (optional)
 * Lists live in-memory Map (demo; may reset on cold start).
 */

const store = new Map();

const NEW_NOTE_BTN = "Новая заметка";
const DEFAULT_LIST = "Входящие";

const CHAT_PRIMARY = "qwen/qwen3.8-27b";
const CHAT_FALLBACK = "openai/gpt-oss-20b";
const WHISPER_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

const SYSTEM_PROMPT = `Ты помощник по спискам заметок. Ответь СТРОГО одним JSON-объектом без markdown:
{"action":"add"|"show"|"new_list"|"delete_last"|"help","list":"string","note":"string"}

Правила:
- action=add — добавить заметку в список; note обязателен (исправь пунктуацию, не выдумывай фактов).
- action=show — показать список; list = имя списка, если упомянуто, иначе «Входящие».
- action=new_list — создать пустой список с именем list.
- action=delete_last — удалить последнюю заметку из list (если имя не названо — «Входящие»).
- action=help — если неясно, что делать.
- Если список не назван для add — list = «Входящие».
- Не выдумывай факты; note только из сообщения пользователя (с правкой пунктуации).
- Пиши list и note на русском, как в сообщении.`;

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function groqKey() {
  return process.env.GROQ_API_KEY || "";
}

function webhookPublicUrl() {
  return (
    process.env.WEBHOOK_URL ||
    "https://voice-lists-ten.vercel.app/api/bot"
  );
}

async function tg(method, body) {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg =
      (data && data.description) || `Telegram ${method} HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function tgGet(method, query) {
  const t = token();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const qs = new URLSearchParams(query || {}).toString();
  const url =
    `https://api.telegram.org/bot${t}/${method}` + (qs ? "?" + qs : "");
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg =
      (data && data.description) || `Telegram ${method} HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function getState(chatId) {
  const key = String(chatId);
  if (!store.has(key)) {
    store.set(key, {
      lists: { [DEFAULT_LIST]: [] },
      step: null,
      warnedEphemeral: false,
    });
  }
  const st = store.get(key);
  if (!st.lists || typeof st.lists !== "object") {
    st.lists = { [DEFAULT_LIST]: [] };
  }
  if (!Array.isArray(st.lists[DEFAULT_LIST])) {
    st.lists[DEFAULT_LIST] = [];
  }
  return st;
}

async function sendMessage(chatId, text, extra) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function mainKeyboard() {
  return {
    keyboard: [[{ text: NEW_NOTE_BTN }]],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ensureList(state, name) {
  const listName = (name && String(name).trim()) || DEFAULT_LIST;
  if (!Array.isArray(state.lists[listName])) {
    state.lists[listName] = [];
  }
  return listName;
}

async function maybeWarnEphemeral(chatId, state) {
  if (state.warnedEphemeral) return;
  state.warnedEphemeral = true;
  await sendMessage(
    chatId,
    "Пока списки в памяти сервера — после перезапуска могут пропасть.",
    { reply_markup: mainKeyboard() }
  );
}

async function downloadVoice(fileId) {
  const meta = await tgGet("getFile", { file_id: fileId });
  const filePath = meta.result && meta.result.file_path;
  if (!filePath) throw new Error("no_file_path");
  const t = token();
  const url = `https://api.telegram.org/file/bot${t}/${filePath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("http_" + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  // Telegram voice notes are ogg/opus (.oga). Groq expects a clear audio/* + extension.
  const extRaw = (filePath.split(".").pop() || "ogg").toLowerCase();
  const isOgg = extRaw === "oga" || extRaw === "ogg" || extRaw === "opus";
  const filename = isOgg ? "voice.ogg" : "voice." + extRaw;
  const mime = isOgg
    ? "audio/ogg"
    : extRaw === "mp3"
      ? "audio/mpeg"
      : extRaw === "m4a" || extRaw === "mp4" || extRaw === "mp4a"
        ? "audio/mp4"
        : "audio/ogg";
  return { buf, filename, mime };
}

async function transcribe(buf, filename, mime) {
  const key = groqKey();
  if (!key) {
    throw new Error("no_groq");
  }

  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const name = filename || "voice.ogg";
  const type = mime || "audio/ogg";
  let lastHttp = 0;

  for (const model of WHISPER_MODELS) {
    // Try with language=ru first; on HTTP 400 retry the same model without language.
    for (const withLang of [true, false]) {
      const form = new FormData();
      const file =
        typeof File !== "undefined"
          ? new File([bytes], name, { type })
          : new Blob([bytes], { type });
      form.append("file", file, name);
      form.append("model", model);
      form.append("response_format", "json");
      if (withLang) form.append("language", "ru");

      const res = await fetch(GROQ_TRANSCRIBE_URL, {
        method: "POST",
        headers: { Authorization: "Bearer " + key },
        body: form,
      });
      lastHttp = res.status;

      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const textOut = (data && data.text ? String(data.text) : "").trim();
        if (textOut) return textOut;
        // empty body — try next variant/model
        if (withLang) continue;
        break;
      }

      // drain body so the connection can close cleanly
      await res.text().catch(() => "");

      if (res.status === 400 && withLang) {
        continue; // same model, without language=ru
      }
      if (res.status === 404) {
        break; // next model
      }
      // other errors: try next model
      break;
    }
  }

  throw new Error("http_" + (lastHttp || 0));
}

async function callChat(model, userText) {
  const key = groqKey();
  if (!key) throw new Error("no_groq");
  return fetch(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });
}

function parseIntent(raw) {
  let text = String(raw || "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  const data = JSON.parse(text);
  const action = String(data.action || "help").toLowerCase();
  const allowed = ["add", "show", "new_list", "delete_last", "help"];
  return {
    action: allowed.includes(action) ? action : "help",
    list: typeof data.list === "string" ? data.list.trim() : "",
    note: typeof data.note === "string" ? data.note.trim() : "",
  };
}

async function interpret(userText) {
  let res = await callChat(CHAT_PRIMARY, userText);
  if (res.status === 404) {
    res = await callChat(CHAT_FALLBACK, userText);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error("chat_failed");
  }
  const content =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  return parseIntent(content);
}

function helpText() {
  return (
    "Пришлите голосовое или текст.\n" +
    "Примеры: «в записнуху купить фильтр», «покажи записнуху».\n" +
    "Кнопка «Новая заметка» — начать новую запись."
  );
}

async function applyIntent(chatId, state, intent) {
  const action = intent.action;
  if (action === "help") {
    await sendMessage(chatId, helpText(), { reply_markup: mainKeyboard() });
    return;
  }

  if (action === "new_list") {
    const name = ensureList(state, intent.list || "Новый список");
    await sendMessage(
      chatId,
      "Список «" + escapeHtml(name) + "» готов.",
      { reply_markup: mainKeyboard() }
    );
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  if (action === "show") {
    const name = ensureList(state, intent.list || DEFAULT_LIST);
    const notes = state.lists[name] || [];
    if (!notes.length) {
      await sendMessage(
        chatId,
        "«" + escapeHtml(name) + "»: пусто.",
        { reply_markup: mainKeyboard() }
      );
      return;
    }
    const body = notes
      .map((n, i) => i + 1 + ". " + escapeHtml(n))
      .join("\n");
    await sendMessage(
      chatId,
      "«" + escapeHtml(name) + "»:\n" + body,
      { reply_markup: mainKeyboard() }
    );
    return;
  }

  if (action === "delete_last") {
    const name = ensureList(state, intent.list || DEFAULT_LIST);
    const notes = state.lists[name] || [];
    if (!notes.length) {
      await sendMessage(
        chatId,
        "В «" + escapeHtml(name) + "» нечего удалять.",
        { reply_markup: mainKeyboard() }
      );
      return;
    }
    const removed = notes.pop();
    await sendMessage(
      chatId,
      "Удалил из «" +
        escapeHtml(name) +
        "»: " +
        escapeHtml(removed),
      { reply_markup: mainKeyboard() }
    );
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  // add
  const name = ensureList(state, intent.list || DEFAULT_LIST);
  const note = (intent.note || "").trim();
  if (!note) {
    await sendMessage(
      chatId,
      "Не понял текст заметки. Пришлите ещё раз голосом или текстом.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }
  state.lists[name].push(note);
  await sendMessage(
    chatId,
    "Добавил в «" + escapeHtml(name) + "»: " + escapeHtml(note),
    { reply_markup: mainKeyboard() }
  );
  await maybeWarnEphemeral(chatId, state);
}

async function processUserText(chatId, text) {
  if (!groqKey()) {
    await sendMessage(
      chatId,
      "Сервис временно недоступен: не настроен ключ Groq.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }
  const state = getState(chatId);
  state.step = null;
  let intent;
  try {
    intent = await interpret(text);
  } catch (_) {
    await sendMessage(
      chatId,
      "Не удалось разобрать сообщение. Попробуйте ещё раз чуть позже.",
      { reply_markup: mainKeyboard() }
    );
    return;
  }
  await applyIntent(chatId, state, intent);
}

async function handleStart(chatId) {
  getState(chatId).step = null;
  await sendMessage(
    chatId,
    "Пришлите голосовое или текст.\n" +
      "Примеры: «в записнуху купить фильтр», «покажи записнуху».",
    { reply_markup: mainKeyboard() }
  );
}

async function handleCancel(chatId) {
  const state = getState(chatId);
  state.step = null;
  await sendMessage(chatId, "Ок, отменил.", {
    reply_markup: mainKeyboard(),
  });
}

async function handleNewNote(chatId) {
  const state = getState(chatId);
  state.step = "await_note";
  await sendMessage(
    chatId,
    "Пришлите голосовое или текст для заметки.",
    { reply_markup: mainKeyboard() }
  );
}

async function handleMessage(message) {
  if (!message || !message.chat) return;
  const chatId = message.chat.id;

  if (!token()) {
    return;
  }

  const text = (message.text || "").trim();

  if (text === "/start" || text.startsWith("/start ")) {
    await handleStart(chatId);
    return;
  }
  if (text === "/cancel" || text.startsWith("/cancel ")) {
    await handleCancel(chatId);
    return;
  }
  if (text === NEW_NOTE_BTN) {
    await handleNewNote(chatId);
    return;
  }

  if (message.voice || message.audio) {
    const fileId =
      (message.voice && message.voice.file_id) ||
      (message.audio && message.audio.file_id);
    if (!fileId) return;
    if (!groqKey()) {
      await sendMessage(
        chatId,
        "Сервис временно недоступен: не настроен ключ Groq.",
        { reply_markup: mainKeyboard() }
      );
      return;
    }
    try {
      await sendMessage(chatId, "Слушаю…", {
        reply_markup: mainKeyboard(),
      });
      const { buf, filename, mime } = await downloadVoice(fileId);
      const transcript = await transcribe(buf, filename, mime);
      await processUserText(chatId, transcript);
    } catch (err) {
      const code = String((err && err.message) || err);
      let msg;
      if (code === "no_groq") {
        msg = "Сервис временно недоступен: не настроен ключ Groq.";
      } else if (code.startsWith("http_")) {
        msg = "Не удалось обработать голосовое (" + code.slice(5) + ").";
      } else {
        msg = "Не удалось обработать голосовое (" + code + ").";
      }
      await sendMessage(chatId, msg, { reply_markup: mainKeyboard() });
    }
    return;
  }

  if (text) {
    await processUserText(chatId, text);
    return;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    try {
      if (!token()) {
        return res.status(503).json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN не задан",
        });
      }
      const url = webhookPublicUrl();
      const result = await tg("setWebhook", {
        url,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      });
      return res.status(200).json({
        ok: true,
        webhook: url,
        telegram: result,
        hasGroq: Boolean(groqKey()),
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: String((err && err.message) || err),
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!token()) {
    return res.status(503).json({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN не задан",
    });
  }

  let update = req.body;
  if (typeof update === "string") {
    try {
      update = JSON.parse(update);
    } catch {
      update = {};
    }
  }
  if (!update || typeof update !== "object") update = {};

  try {
    if (update.message) {
      await handleMessage(update.message);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("bot error", err && err.message ? err.message : err);
    return res.status(200).json({
      ok: false,
      error: "handler_error",
    });
  }
};