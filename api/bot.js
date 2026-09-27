/**
 * Telegram webhook: /api/bot
 * Env: TELEGRAM_BOT_TOKEN, GROQ_API_KEY, WEBHOOK_URL (optional)
 * Lists live in-memory Map (demo; may reset on cold start).
 */

const store = new Map();

/** /start, /start@bot, /start payload — same for other cmds */
function isBotCommand(text, cmd) {
  const t = String(text || "").trim();
  return t === cmd || t.startsWith(cmd + " ") || t.startsWith(cmd + "@");
}


const NEW_NOTE_BTN = "Новая заметка";
const DELETE_NOTE_BTN = "Удалить заметку";
const DEFAULT_LIST = "Стикеры";
const MAX_KB_BTN = 64;

const CHAT_PRIMARY = "qwen/qwen3.8-27b";
const CHAT_FALLBACK = "openai/gpt-oss-20b";
const WHISPER_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TRANSCRIBE_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

const SYSTEM_PROMPT = `Ты помощник по спискам заметок. Ответь СТРОГО одним JSON-объектом без markdown:
{"action":"add"|"show"|"new_list"|"delete_last"|"delete_note"|"clear_list"|"rename_list"|"star_list"|"unstar_list"|"move_list_top"|"help","list":"string","new_name":"string","note":"string","index":null|number,"query":"string"}

Правила:
- action=add — добавить заметку; note обязателен.
- action=show — показать список; list если назван, иначе «Стикеры».
- action=new_list — создать пустой список с именем list.
- action=delete_last — удалить ПОСЛЕДНЮЮ заметку в list (если list не назван — «Стикеры»).
- action=delete_note — удалить ОДНУ заметку: index (номер с 1) и/или query (кусок текста); list если указан.
- action=clear_list — ТОЛЬКО если явно просят очистить весь список; list обязателен.
- action=rename_list — переименовать: list = старое имя, new_name = новое («переименуй X в Y», «назови X Y»).
- action=star_list — добавить список в избранное («X в избранное», «звезда на X»).
- action=unstar_list — убрать из избранного («убери звезду с X»).
- action=move_list_top — поднять список наверх своей группы («подними X», «X наверх»).
- action=help — если неясно.
- Не выдумывай заметки, которых нет в контексте списков.
- Если список не назван для add — list = «Стикеры».
- Пиши list/new_name/note/query на русском.

Пунктуация note (жёстко для action=add):
- Исправь пунктуацию, НЕ меняя смысл и НЕ выдумывая слова.
- Точка в конце предложения; запятые в перечислениях; не заменяй все запятые на «и».
- Вопросительный/восклицательный знак — только если по тону фразы ясно.
- Имена списков в note НЕ тащи.
- Одну мысль не раздувай в абзацы; одна короткая фраза-заметка.`;

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
      order: [DEFAULT_LIST],
      starred: [],
      step: null,
      pendingDeletes: null,
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
  if (!Array.isArray(st.order)) st.order = [];
  if (!Array.isArray(st.starred)) st.starred = [];
  // Sync order with existing lists; keep saved order, append unknowns.
  const known = Object.keys(st.lists);
  const seen = new Set();
  const next = [];
  for (const n of st.order) {
    if (st.lists[n] && !seen.has(n)) {
      next.push(n);
      seen.add(n);
    }
  }
  for (const n of known) {
    if (!seen.has(n)) {
      next.push(n);
      seen.add(n);
    }
  }
  if (!seen.has(DEFAULT_LIST)) {
    next.unshift(DEFAULT_LIST);
    if (!Array.isArray(st.lists[DEFAULT_LIST])) st.lists[DEFAULT_LIST] = [];
  }
  st.order = next;
  st.starred = st.starred.filter((n) => !!st.lists[n]);
  migrateIncomingToStickers(st);
  return st;
}

const LEGACY_DEFAULT = "Входящие";

function migrateIncomingToStickers(st) {
  if (!st.lists || !Object.prototype.hasOwnProperty.call(st.lists, LEGACY_DEFAULT)) {
    return;
  }
  const legacyNotes = Array.isArray(st.lists[LEGACY_DEFAULT])
    ? st.lists[LEGACY_DEFAULT]
    : [];
  if (!Array.isArray(st.lists[DEFAULT_LIST])) {
    st.lists[DEFAULT_LIST] = legacyNotes.slice();
  } else {
    st.lists[DEFAULT_LIST] = st.lists[DEFAULT_LIST].concat(legacyNotes);
  }
  delete st.lists[LEGACY_DEFAULT];
  st.order = (st.order || [])
    .map((n) => (n === LEGACY_DEFAULT ? DEFAULT_LIST : n))
    .filter((n, i, arr) => n && arr.indexOf(n) === i);
  if (!st.order.includes(DEFAULT_LIST)) st.order.unshift(DEFAULT_LIST);
  st.starred = (st.starred || [])
    .map((n) => (n === LEGACY_DEFAULT ? DEFAULT_LIST : n))
    .filter((n, i, arr) => n && arr.indexOf(n) === i && st.lists[n]);
}

async function sendMessage(chatId, text, extra) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function clipBtn(label) {
  const s = String(label || "");
  if (s.length <= MAX_KB_BTN) return s;
  return s.slice(0, MAX_KB_BTN - 1) + "…";
}

function isStarred(state, name) {
  return (state.starred || []).includes(name);
}

function displayListName(state, name) {
  return isStarred(state, name) ? "★ " + name : name;
}

function listNames(state) {
  // Favorites first (preserving their order), then the rest (preserving order).
  const order = (state.order || []).filter((n) => state.lists && state.lists[n]);
  const starredSet = new Set(state.starred || []);
  const fav = order.filter((n) => starredSet.has(n));
  const rest = order.filter((n) => !starredSet.has(n));
  const names = fav.concat(rest);
  if (!names.includes(DEFAULT_LIST) && state.lists && state.lists[DEFAULT_LIST]) {
    // keep DEFAULT in rest group at front of unstarred if somehow missing
    if (starredSet.has(DEFAULT_LIST)) names.unshift(DEFAULT_LIST);
    else {
      const i = names.findIndex((n) => !starredSet.has(n));
      if (i < 0) names.push(DEFAULT_LIST);
      else names.splice(i, 0, DEFAULT_LIST);
    }
  }
  return names.filter((n, i, arr) => arr.indexOf(n) === i);
}

function ensureInOrder(state, name) {
  if (!state.order.includes(name)) state.order.push(name);
}

function keyboardFor(state) {
  const rows = [[{ text: NEW_NOTE_BTN }, { text: DELETE_NOTE_BTN }]];
  const names = listNames(state);
  for (let i = 0; i < names.length; i += 2) {
    const chunk = [{ text: clipBtn(displayListName(state, names[i])) }];
    if (names[i + 1]) {
      chunk.push({ text: clipBtn(displayListName(state, names[i + 1])) });
    }
    rows.push(chunk);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

function kb(chatId) {
  return keyboardFor(getState(chatId));
}

function resolveListButton(state, text) {
  const raw = String(text || "").trim();
  const stripped = raw.replace(/^★\s*/, "");
  const names = listNames(state);
  for (const n of names) {
    if (n === raw || n === stripped) return n;
    if (clipBtn(n) === raw || clipBtn(n) === stripped) return n;
    if (clipBtn(displayListName(state, n)) === raw) return n;
    if (displayListName(state, n) === raw) return n;
  }
  return null;
}

function formatList(state, name, notes) {
  const title = displayListName(state, name);
  if (!notes.length) return "«" + escapeHtml(title) + "»: пусто.";
  const body = notes
    .map((n, i) => i + 1 + ". " + escapeHtml(n))
    .join("\n");
  return "«" + escapeHtml(title) + "»:\n" + body;
}

function clipShort(label, max) {
  const s = String(label || "");
  const m = max || 28;
  if (s.length <= m) return s;
  return s.slice(0, m - 1) + "…";
}

/** Inline grid only for default «Стикеры» list. */
function stickersInlineKeyboard(notes) {
  const rows = [];
  const n = notes.length;
  if (n <= 4) {
    for (let i = 0; i < n; i++) {
      rows.push([
        { text: clipBtn(notes[i]), callback_data: "sn:" + i },
      ]);
    }
  } else {
    for (let i = 0; i < n; i += 2) {
      const row = [
        { text: clipShort(notes[i], 28), callback_data: "sn:" + i },
      ];
      if (i + 1 < n) {
        row.push({
          text: clipShort(notes[i + 1], 28),
          callback_data: "sn:" + (i + 1),
        });
      }
      rows.push(row);
    }
  }
  return { inline_keyboard: rows };
}

async function showListMessage(chatId, state, name) {
  const notes = state.lists[name] || [];
  if (name === DEFAULT_LIST) {
    const title = displayListName(state, name);
    if (!notes.length) {
      await sendMessage(
        chatId,
        "«" + escapeHtml(title) + "»: пусто.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    // Inline under message; persistent reply keyboard stays from earlier messages.
    await sendMessage(chatId, "«" + escapeHtml(title) + "» — выберите стикер:", {
      reply_markup: stickersInlineKeyboard(notes),
    });
    return;
  }
  await sendMessage(chatId, formatList(state, name, notes), {
    reply_markup: keyboardFor(state),
  });
}

function listsSnapshot(state) {
  return listNames(state)
    .map((name) => {
      const notes = state.lists[name] || [];
      const label = displayListName(state, name);
      if (!notes.length) return "— " + label + ": (пусто)";
      return (
        "— " +
        label +
        ":\n" +
        notes.map((n, i) => "  " + (i + 1) + ". " + n).join("\n")
      );
    })
    .join("\n");
}

function findNoteMatches(state, listHint, query, index) {
  const q = String(query || "").trim().toLowerCase();
  const hasIndex = index != null && Number.isFinite(Number(index));
  const names =
    listHint && Array.isArray(state.lists[listHint])
      ? [listHint]
      : listNames(state);
  const hits = [];
  for (const name of names) {
    const notes = state.lists[name] || [];
    if (hasIndex) {
      const i = Number(index) - 1;
      if (i >= 0 && i < notes.length) {
        hits.push({ list: name, index: i, note: notes[i] });
      }
      continue;
    }
    if (!q) continue;
    notes.forEach((note, i) => {
      if (String(note).toLowerCase().includes(q)) {
        hits.push({ list: name, index: i, note });
      }
    });
  }
  return hits;
}

function ensureList(state, name) {
  let listName = (name && String(name).trim()) || DEFAULT_LIST;
  if (listName === LEGACY_DEFAULT) listName = DEFAULT_LIST;
  if (!Array.isArray(state.lists[listName])) {
    state.lists[listName] = [];
  }
  ensureInOrder(state, listName);
  return listName;
}

async function maybeWarnEphemeral(chatId, state) {
  if (state.warnedEphemeral) return;
  state.warnedEphemeral = true;
  await sendMessage(
    chatId,
    "Пока списки в памяти сервера — после перезапуска могут пропасть.",
    { reply_markup: keyboardFor(state) }
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
  const allowed = [
    "add",
    "show",
    "new_list",
    "delete_last",
    "delete_note",
    "clear_list",
    "rename_list",
    "star_list",
    "unstar_list",
    "move_list_top",
    "help",
  ];
  let index = null;
  if (data.index != null && data.index !== "") {
    const n = Number(data.index);
    if (Number.isFinite(n)) index = n;
  }
  return {
    action: allowed.includes(action) ? action : "help",
    list: typeof data.list === "string" ? data.list.trim() : "",
    new_name: typeof data.new_name === "string" ? data.new_name.trim() : "",
    note: typeof data.note === "string" ? data.note.trim() : "",
    query: typeof data.query === "string" ? data.query.trim() : "",
    index,
  };
}

async function interpret(userText, state, hint) {
  const snapshot = listsSnapshot(state);
  const payload =
    (hint ? "Контекст: " + hint + "\n\n" : "") +
    "Текущие списки:\n" +
    snapshot +
    "\n\nСообщение пользователя:\n" +
    userText;
  let res = await callChat(CHAT_PRIMARY, payload);
  if (res.status === 404) {
    res = await callChat(CHAT_FALLBACK, payload);
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
    "Примеры: «в покупки купить фильтр», «покажи покупки», «удали молоко из покупок»,\n" +
    "«переименуй покупки в дела», «покупки в избранное», «подними покупки».\n" +
    "Кнопки внизу: новая заметка, удалить, и ваши списки (★ — избранные)."
  );
}

async function applyIntent(chatId, state, intent) {
  const action = intent.action;
  if (action === "help") {
    await sendMessage(chatId, helpText(), { reply_markup: keyboardFor(state) });
    return;
  }

  if (action === "new_list") {
    const name = ensureList(state, intent.list || "Новый список");
    await sendMessage(chatId, "Список «" + escapeHtml(name) + "» готов.", {
      reply_markup: keyboardFor(state),
    });
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  if (action === "show") {
    const name = ensureList(state, intent.list || DEFAULT_LIST);
    await showListMessage(chatId, state, name);
    return;
  }

  if (action === "clear_list") {
    if (!intent.list) {
      await sendMessage(
        chatId,
        "Какой список очистить целиком? Напишите имя.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    const name = ensureList(state, intent.list);
    const n = (state.lists[name] || []).length;
    state.lists[name] = [];
    await sendMessage(
      chatId,
      "Очистил «" + escapeHtml(name) + "» (" + n + ").",
      { reply_markup: keyboardFor(state) }
    );
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  if (action === "delete_last") {
    const name = ensureList(state, intent.list || DEFAULT_LIST);
    const notes = state.lists[name] || [];
    if (!notes.length) {
      await sendMessage(
        chatId,
        "В «" + escapeHtml(name) + "» нечего удалять.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    const removed = notes.pop();
    await sendMessage(
      chatId,
      "Удалил из «" + escapeHtml(name) + "»: " + escapeHtml(removed),
      { reply_markup: keyboardFor(state) }
    );
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  if (action === "delete_note") {
    const listHint =
      intent.list && Array.isArray(state.lists[intent.list])
        ? intent.list
        : "";
    const query = intent.query || intent.note || "";
    const hits = findNoteMatches(
      state,
      listHint || null,
      query,
      intent.index
    );

    if (!hits.length) {
      await sendMessage(
        chatId,
        "Не нашёл такую заметку. Уточните номер, кусок текста или список.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }

    if (hits.length > 1) {
      const options = hits.slice(0, 3);
      state.step = "await_delete_pick";
      state.pendingDeletes = options;
      const lines = options
        .map(
          (h, i) =>
            i +
            1 +
            ") «" +
            escapeHtml(h.list) +
            "» #" +
            (h.index + 1) +
            ": " +
            escapeHtml(h.note)
        )
        .join("\n");
      await sendMessage(
        chatId,
        "Нашёл несколько. Какую удалить? Ответьте номером варианта:\n" +
          lines,
        { reply_markup: keyboardFor(state) }
      );
      return;
    }

    const hit = hits[0];
    const arr = state.lists[hit.list] || [];
    if (arr[hit.index] !== hit.note) {
      await sendMessage(
        chatId,
        "Заметка уже изменилась. Покажите список и попробуйте ещё раз.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    arr.splice(hit.index, 1);
    state.step = null;
    state.pendingDeletes = null;
    await sendMessage(
      chatId,
      "Удалил из «" +
        escapeHtml(hit.list) +
        "»: " +
        escapeHtml(hit.note),
      { reply_markup: keyboardFor(state) }
    );
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  if (action === "rename_list") {
    const oldName = (intent.list || "").trim();
    const newName = (intent.new_name || "").trim();
    if (!oldName || !newName) {
      await sendMessage(
        chatId,
        "Укажите старое и новое имя: «переименуй X в Y».",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    if (!Array.isArray(state.lists[oldName])) {
      await sendMessage(
        chatId,
        "Списка «" + escapeHtml(oldName) + "» нет — ничего не менял.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    if (oldName === newName) {
      await sendMessage(
        chatId,
        "Имя то же самое — «" + escapeHtml(oldName) + "».",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    if (Array.isArray(state.lists[newName])) {
      await sendMessage(
        chatId,
        "Имя «" +
          escapeHtml(newName) +
          "» уже занято — не затирал. Выберите другое.",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    state.lists[newName] = state.lists[oldName];
    delete state.lists[oldName];
    state.order = state.order.map((n) => (n === oldName ? newName : n));
    state.starred = state.starred.map((n) => (n === oldName ? newName : n));
    await sendMessage(
      chatId,
      "Переименовал «" +
        escapeHtml(oldName) +
        "» → «" +
        escapeHtml(newName) +
        "».",
      { reply_markup: keyboardFor(state) }
    );
    await maybeWarnEphemeral(chatId, state);
    return;
  }

  if (action === "star_list") {
    const name = (intent.list || "").trim();
    if (!name || !Array.isArray(state.lists[name])) {
      await sendMessage(
        chatId,
        name
          ? "Списка «" + escapeHtml(name) + "» нет."
          : "Какой список в избранное?",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    if (!isStarred(state, name)) state.starred.push(name);
    await sendMessage(
      chatId,
      "★ «" + escapeHtml(name) + "» в избранном.",
      { reply_markup: keyboardFor(state) }
    );
    return;
  }

  if (action === "unstar_list") {
    const name = (intent.list || "").trim();
    if (!name || !Array.isArray(state.lists[name])) {
      await sendMessage(
        chatId,
        name
          ? "Списка «" + escapeHtml(name) + "» нет."
          : "С какого списка убрать звезду?",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    state.starred = state.starred.filter((n) => n !== name);
    await sendMessage(
      chatId,
      "Убрал ★ с «" + escapeHtml(name) + "».",
      { reply_markup: keyboardFor(state) }
    );
    return;
  }

  if (action === "move_list_top") {
    const name = (intent.list || "").trim();
    if (!name || !Array.isArray(state.lists[name])) {
      await sendMessage(
        chatId,
        name
          ? "Списка «" + escapeHtml(name) + "» нет."
          : "Какой список поднять?",
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
    ensureInOrder(state, name);
    const starred = isStarred(state, name);
    // Reorder within group: starred among starred, rest among rest.
    const order = state.order.filter((n) => n !== name);
    const fav = order.filter((n) => isStarred(state, n));
    const rest = order.filter((n) => !isStarred(state, n));
    if (starred) fav.unshift(name);
    else rest.unshift(name);
    state.order = fav.concat(rest);
    await sendMessage(
      chatId,
      "Поднял «" + escapeHtml(name) + "» наверх.",
      { reply_markup: keyboardFor(state) }
    );
    return;
  }

  const name = ensureList(state, intent.list || DEFAULT_LIST);
  const note = (intent.note || "").trim();
  if (!note) {
    await sendMessage(
      chatId,
      "Не понял текст заметки. Пришлите ещё раз голосом или текстом.",
      { reply_markup: keyboardFor(state) }
    );
    return;
  }
  state.lists[name].push(note);
  await sendMessage(
    chatId,
    "Добавил в «" + escapeHtml(name) + "»: " + escapeHtml(note),
    { reply_markup: keyboardFor(state) }
  );
  await maybeWarnEphemeral(chatId, state);
}

async function processUserText(chatId, text) {
  if (!groqKey()) {
    await sendMessage(
      chatId,
      "Сервис временно недоступен: не настроен ключ Groq.",
      { reply_markup: kb(chatId) }
    );
    return;
  }
  const state = getState(chatId);

  if (state.step === "await_delete_pick" && state.pendingDeletes) {
    const m = String(text || "").trim().match(/^[1-3]$/);
    if (m) {
      const pick = Number(m[0]) - 1;
      const hit = state.pendingDeletes[pick];
      state.step = null;
      state.pendingDeletes = null;
      if (!hit) {
        await sendMessage(chatId, "Нет такого варианта.", {
          reply_markup: keyboardFor(state),
        });
        return;
      }
      const arr = state.lists[hit.list] || [];
      const at = arr.indexOf(hit.note);
      if (at < 0) {
        await sendMessage(
          chatId,
          "Эта заметка уже удалена или изменилась.",
          { reply_markup: keyboardFor(state) }
        );
        return;
      }
      arr.splice(at, 1);
      await sendMessage(
        chatId,
        "Удалил из «" +
          escapeHtml(hit.list) +
          "»: " +
          escapeHtml(hit.note),
        { reply_markup: keyboardFor(state) }
      );
      return;
    }
  }

  const deleteHint =
    state.step === "await_delete"
      ? "Пользователь удаляет заметку. Выбери delete_note, delete_last или clear_list."
      : "";
  if (state.step === "await_delete" || state.step === "await_note") {
    state.step = null;
  }

  let intent;
  try {
    intent = await interpret(text, state, deleteHint);
  } catch (_) {
    await sendMessage(
      chatId,
      "Не удалось разобрать сообщение. Попробуйте ещё раз чуть позже.",
      { reply_markup: keyboardFor(state) }
    );
    return;
  }
  await applyIntent(chatId, state, intent);
}

async function handleStart(chatId) {
  const state = getState(chatId);
  state.step = null;
  state.pendingDeletes = null;
  await sendMessage(
    chatId,
    "Пришлите голосовое или текст.\n" +
      "Примеры: «в покупки купить фильтр», «покажи покупки», «удали молоко из покупок».",
    { reply_markup: keyboardFor(state) }
  );
}

async function handleCancel(chatId) {
  const state = getState(chatId);
  state.step = null;
  state.pendingDeletes = null;
  await sendMessage(chatId, "Ок, отменил.", {
    reply_markup: keyboardFor(state),
  });
}

async function handleNewNote(chatId) {
  const state = getState(chatId);
  state.step = "await_note";
  state.pendingDeletes = null;
  await sendMessage(
    chatId,
    "Пришлите голосовое или текст для заметки.",
    { reply_markup: keyboardFor(state) }
  );
}

async function handleDeletePrompt(chatId) {
  const state = getState(chatId);
  state.step = "await_delete";
  state.pendingDeletes = null;
  await sendMessage(
    chatId,
    "Какую удалить? Можно голосом или текстом: номер, кусок текста или список целиком.",
    { reply_markup: keyboardFor(state) }
  );
}

async function handleShowList(chatId, listName) {
  const state = getState(chatId);
  const name = ensureList(state, listName);
  await showListMessage(chatId, state, name);
}

async function handleCallbackQuery(cq) {
  if (!cq || !cq.message || !cq.message.chat) return;
  const chatId = cq.message.chat.id;
  const data = String(cq.data || "");
  try {
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
  } catch (_) {}
  const state = getState(chatId);
  if (!data.startsWith("sn:")) return;
  const idx = Number(data.slice(3));
  const notes = state.lists[DEFAULT_LIST] || [];
  if (!Number.isFinite(idx) || idx < 0 || idx >= notes.length) {
    await sendMessage(chatId, "Этой заметки уже нет.", {
      reply_markup: keyboardFor(state),
    });
    return;
  }
  await sendMessage(chatId, escapeHtml(notes[idx]), {
    reply_markup: keyboardFor(state),
  });
}

async function handleMessage(message) {
  if (!message || !message.chat) return;
  const chatId = message.chat.id;

  if (!token()) {
    return;
  }

  const text = (message.text || "").trim();

  if (isBotCommand(text, "/start")) {
    await handleStart(chatId);
    return;
  }
  if (isBotCommand(text, "/cancel")) {
    await handleCancel(chatId);
    return;
  }
  if (text === NEW_NOTE_BTN) {
    await handleNewNote(chatId);
    return;
  }
  if (text === DELETE_NOTE_BTN) {
    await handleDeletePrompt(chatId);
    return;
  }
  if (text) {
    const state = getState(chatId);
    const listHit = resolveListButton(state, text);
    if (listHit) {
      await handleShowList(chatId, listHit);
      return;
    }
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
        { reply_markup: kb(chatId) }
      );
      return;
    }
    try {
      await sendMessage(chatId, "Слушаю…", {
        reply_markup: kb(chatId),
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
      await sendMessage(chatId, msg, { reply_markup: kb(chatId) });
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
        allowed_updates: ["message", "callback_query"],
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
    return res.status(503).json({ ok: false, error: "no_token" });
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
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      await handleMessage(update.message);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("bot error", err);
    return res.status(200).json({
      ok: false,
      error: String((err && err.message) || err),
    });
  }
};
