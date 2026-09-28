/**
 * Shared Supabase PostgREST helpers (schema public).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — never log keys.
 */

function supabaseUrl() {
  let u = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  if (!u) return "";
  if (/^postgres(ql)?:\/\//i.test(u)) return "";
  u = u.replace(/\/rest\/v1\/?$/i, "");
  return u;
}

function supabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function supabaseConfigured() {
  return Boolean(supabaseUrl() && supabaseKey());
}

function sbHeaders(extra) {
  const key = supabaseKey();
  return Object.assign(
    {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Profile": "public",
      "Content-Profile": "public",
      Prefer: "return=representation",
    },
    extra || {}
  );
}

/** PostgREST like supabase.from(table) — schema public only. */
function sbFrom(table) {
  return "/rest/v1/" + table;
}

async function sbRest(pathAndQuery, opts) {
  const base = supabaseUrl();
  if (!base || !supabaseKey()) {
    const err = new Error("no_supabase");
    throw err;
  }
  const method = (opts && opts.method) || "GET";
  const headers = sbHeaders(opts && opts.headers);
  const init = { method, headers };
  if (opts && opts.body != null) {
    init.body =
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const url = base + pathAndQuery;
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  }
  if (!res.ok) {
    const detail =
      (data && data.message) ||
      (data && data.hint) ||
      (data && data.error_description) ||
      (typeof data === "string" ? data.slice(0, 200) : "") ||
      "HTTP " + res.status;
    const err = new Error("supabase_" + res.status + ": " + detail);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

module.exports = {
  supabaseUrl,
  supabaseKey,
  supabaseConfigured,
  sbHeaders,
  sbFrom,
  sbRest,
};
