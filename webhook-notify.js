/**
 * opencode-webhook
 *
 * POSTs a JSON webhook when an OpenCode agent finishes or errors, so
 * another bot or service can hand off a coding task and hear back.
 *
 * Install: copy this file to ~/.config/opencode/plugins/ (or
 * .opencode/plugins/ in a project) and restart OpenCode.
 *
 * Environment (set these in the same process that starts OpenCode):
 *
 *   OPENCODE_NOTIFY_WEBHOOK_URL    Required. URL that receives the POST.
 *   OPENCODE_NOTIFY_SECRET         Optional. Authorization header value
 *                                  (see OPENCODE_NOTIFY_AUTH_SCHEME).
 *   OPENCODE_NOTIFY_AUTH_SCHEME    Optional. Default "Bearer" sends
 *                                  "Authorization: Bearer <secret>".
 *                                  Set to "raw" to send the secret as
 *                                  the entire Authorization value.
 *   OPENCODE_NOTIFY_TITLE_PREFIX   Optional. If set, only sessions whose
 *                                  title starts with this prefix are posted.
 *                                  Unset = notify every finished session.
 *   OPENCODE_NOTIFY_EVENTS         Optional. Comma-separated list of
 *                                  "idle", "error", "interrupted", or full
 *                                  event type names. Default: all of them.
 *   OPENCODE_NOTIFY_DEBUG          Optional. Set to 1/true for verbose logs.
 *
 * OpenCode 1.19+ loads: export default { id, server }.
 * server(ctx) is called with { client, project, directory, worktree, $ }
 * and must return a hooks object (including `event`). See
 * https://github.com/sst/opencode/blob/v1.19.6/packages/opencode/src/plugin/shared.ts
 * and .../plugin/index.ts. Older loaders that look for a plugin function
 * can use the named export `DoneWebhook` / `Plugin`.
 *
 * This file must not throw: a plugin error should never take down OpenCode.
 */

const PREFIX = "opencode-webhook"
const SNIPPET_MAX = 500
const FETCH_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [0, 500, 1500]
const TURN_DEDUPE_MS = 400

const EVENT_GROUPS = {
  idle: ["session.idle", "session.execution.succeeded"],
  error: ["session.error", "session.execution.failed"],
  interrupted: ["session.execution.interrupted"],
}

function env(name, fallback) {
  const value = process.env[name]
  if (value == null || value === "") return fallback
  return value
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim())
}

function parseEventFilter(raw) {
  const allowed = new Set(Object.values(EVENT_GROUPS).flat())
  if (!raw) return allowed
  const next = new Set()
  for (const token of raw.split(",")) {
    const key = token.trim()
    if (!key) continue
    if (EVENT_GROUPS[key]) EVENT_GROUPS[key].forEach((t) => next.add(t))
    else next.add(key)
  }
  return next.size ? next : allowed
}

function readConfig() {
  return {
    url: env("OPENCODE_NOTIFY_WEBHOOK_URL", ""),
    secret: env("OPENCODE_NOTIFY_SECRET", ""),
    authScheme: env("OPENCODE_NOTIFY_AUTH_SCHEME", "Bearer"),
    titlePrefix: env("OPENCODE_NOTIFY_TITLE_PREFIX", ""),
    events: parseEventFilter(env("OPENCODE_NOTIFY_EVENTS", "")),
    debug: truthy(env("OPENCODE_NOTIFY_DEBUG", "")),
  }
}

function safeUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin + parsed.pathname
  } catch {
    return "(invalid url)"
  }
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function writeLog(level, message) {
  const line = `${PREFIX}: ${message}`
  if (level === "warn" && typeof console.warn === "function") console.warn(line)
  else if (level === "error" && typeof console.error === "function") console.error(line)
  else console.log(line)
}

function log(level, message, cfg) {
  if (level === "debug" && !cfg?.debug) return
  writeLog(level === "debug" ? "info" : level, message)
}

function sessionIDOf(event) {
  const bag = event?.properties || event?.data || {}
  return bag.sessionID || bag.sessionId || bag.info?.id || null
}

function statusOf(type) {
  if (type === "session.error" || type === "session.execution.failed") return "error"
  if (type === "session.execution.interrupted") return "interrupted"
  return "idle"
}

function errorOf(event) {
  const bag = event?.properties || event?.data || {}
  return bag.error || null
}

function snippetFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : messages?.data || messages?.messages || []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    const role = m?.info?.role || m?.role
    if (role !== "assistant") continue
    const parts = m.parts || m.info?.parts || []
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim()
    if (text) return text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text
  }
  return null
}

function titleOf(session) {
  const info = session?.info && session.title == null ? session.info : session
  return info?.title ?? null
}

function directoryOf(session) {
  const info = session?.info && session.directory == null ? session.info : session
  return info?.directory || info?.path?.directory || null
}

async function tryCall(fns) {
  for (const fn of fns) {
    try {
      const value = await fn()
      if (value != null) return value
    } catch {
      // OpenCode 1 and 2 expose slightly different client methods.
    }
  }
  return null
}

async function enrich(ctx, sessionID) {
  const out = { title: null, directory: null, snippet: null }
  try {
    const sessionApi = ctx?.session || ctx?.client?.session
    if (!sessionApi) return out
    const session = await tryCall([
      () => sessionApi.get({ path: { id: sessionID } }),
      () => sessionApi.get({ sessionID }),
      () => sessionApi.get(sessionID),
    ])
    if (session) {
      out.title = titleOf(session)
      out.directory = directoryOf(session)
    }
    const messages = await tryCall([
      () => sessionApi.messages({ path: { id: sessionID }, query: { limit: 8 } }),
      () => sessionApi.messages({ sessionID, limit: 8 }),
      () => sessionApi.message?.list?.({ path: { id: sessionID }, query: { limit: 8 } }),
    ])
    if (messages) out.snippet = snippetFromMessages(messages)
  } catch {
    // Snippet and title are optional; still send the webhook.
  }
  return out
}

function shouldNotify(title, prefix) {
  if (!prefix) return true
  return typeof title === "string" && title.startsWith(prefix)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function authHeader(secret, scheme) {
  if (!secret) return null
  const trimmed = String(scheme || "").trim()
  if (!trimmed || /^raw$/i.test(trimmed)) return secret
  return `${trimmed} ${secret}`
}

export function createRuntime() {
  const firedIds = new Set()
  const recentTurn = new Map()
  let warnedMissingUrl = false

  function warnOnce(message, cfg) {
    if (warnedMissingUrl) return
    warnedMissingUrl = true
    log("warn", message, cfg)
  }

  function ensureConfigured() {
    const cfg = readConfig()
    if (!cfg.url) {
      warnOnce("OPENCODE_NOTIFY_WEBHOOK_URL is not set; notifications disabled", cfg)
      return false
    }
    if (!isHttpUrl(cfg.url)) {
      warnOnce("OPENCODE_NOTIFY_WEBHOOK_URL is not a valid http(s) URL; notifications disabled", cfg)
      return false
    }
    return true
  }

  function alreadyFired(sessionID, status, eventID) {
    if (eventID) {
      if (firedIds.has(eventID)) return true
      firedIds.add(eventID)
      if (firedIds.size > 1000) {
        const first = firedIds.values().next().value
        firedIds.delete(first)
      }
    }
    const key = `${sessionID}:${status}`
    const now = Date.now()
    const prev = recentTurn.get(key)
    if (prev && now - prev < TURN_DEDUPE_MS) return true
    recentTurn.set(key, now)
    return false
  }

  async function postWebhook(payload) {
    if (!ensureConfigured()) return false
    const cfg = readConfig()

    const headers = { "content-type": "application/json" }
    const authorization = authHeader(cfg.secret, cfg.authScheme)
    if (authorization) headers.authorization = authorization
    const dest = safeUrl(cfg.url)
    const body = JSON.stringify(payload)

    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      if (RETRY_DELAYS_MS[i]) await sleep(RETRY_DELAYS_MS[i])
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
      try {
        const res = await fetch(cfg.url, { method: "POST", headers, body, signal: ac.signal })
        clearTimeout(timer)
        if (res.ok || res.status === 204) {
          log("debug", `webhook POST ${res.status} -> ${dest}`, cfg)
          return true
        }
        if (res.status >= 400 && res.status < 500) {
          log("error", `webhook POST failed ${res.status} (not retrying) -> ${dest}`, cfg)
          return false
        }
        log("warn", `webhook POST ${res.status}, retrying -> ${dest}`, cfg)
      } catch (err) {
        clearTimeout(timer)
        const name = err?.name || "error"
        if (i === RETRY_DELAYS_MS.length - 1) {
          log("error", `webhook POST failed (${name}) -> ${dest}`, cfg)
          return false
        }
        log("warn", `webhook POST ${name}, retrying -> ${dest}`, cfg)
      }
    }
    return false
  }

  async function handleEvent(event, ctx) {
    const cfg = readConfig()
    if (!event || !cfg.events.has(event.type)) return false
    const sessionID = sessionIDOf(event)
    if (!sessionID) return false
    const status = statusOf(event.type)
    if (alreadyFired(sessionID, status, event.id)) return false

    const extra = await enrich(ctx, sessionID)
    if (!shouldNotify(extra.title, cfg.titlePrefix)) {
      log("debug", `skip ${event.type} for ${sessionID} (title prefix)`, cfg)
      return false
    }

    return postWebhook({
      event: event.type,
      eventID: event.id || null,
      sessionID,
      title: extra.title,
      directory: extra.directory,
      status,
      snippet: extra.snippet,
      error: errorOf(event),
    })
  }

  return { handleEvent, postWebhook, ensureConfigured }
}

const fallback = createRuntime()
export const handleEvent = (event, ctx) => fallback.handleEvent(event, ctx)
export const postWebhook = (payload) => fallback.postWebhook(payload)

/**
 * OpenCode 1.19+ calls this as `default.server(input, options)` and
 * expects a hooks object back. Never throw from here.
 */
export async function server(ctx = {}) {
  try {
    const runtime = createRuntime()
    const cfg = readConfig()
    if (runtime.ensureConfigured()) log("debug", `loaded, webhook ${safeUrl(cfg.url)}`, cfg)

    const hooks = {
      event: async (input) => {
        try {
          const event = input?.event ?? input
          await runtime.handleEvent(event, ctx)
        } catch (err) {
          log("error", `handler failed: ${err?.name || "error"}`, readConfig())
        }
      },
    }

    // Newer OpenCode builds may expose a subscribe() stream. 1.19.6
    // delivers events through the hook above instead.
    if (ctx?.event?.subscribe) {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              await runtime.handleEvent(event, ctx)
            } catch (err) {
              log("error", `handler failed: ${err?.name || "error"}`, readConfig())
            }
          }
        } catch (err) {
          if (err?.name !== "AbortError") {
            log("error", `event stream failed: ${err?.name || "error"}`, readConfig())
          }
        }
      })()
      hooks.dispose = async () => controller.abort()
    }

    return hooks
  } catch (err) {
    log("error", `plugin init failed: ${err?.name || "error"}`, readConfig())
    return { event: async () => {} }
  }
}


// Named function exports for older loaders that scan for plugin functions.
export const DoneWebhook = server
export const Plugin = server

// OpenCode 1.19.6: path plugins must default-export an object with
// `id` and `server()`. See readV1Plugin() in the source linked above.
export default { id: "opencode-webhook", server }
