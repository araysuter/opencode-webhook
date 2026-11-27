/**
 * opencode-webhook
 *
 * POSTs JSON when an OpenCode session finishes or errors, so another
 * bot or service can hand off a task and get pinged when it is done.
 *
 * Install: copy this file to ~/.config/opencode/plugins/ or
 * .opencode/plugins/ in a project, then restart OpenCode.
 *
 * Environment (must be in the same process that starts OpenCode):
 *
 *   OPENCODE_NOTIFY_WEBHOOK_URL    Required. http(s) URL that receives the POST.
 *   OPENCODE_NOTIFY_SECRET         Optional. Sent as Authorization: Bearer <secret>.
 *   OPENCODE_NOTIFY_TITLE_PREFIX   Optional. Only sessions whose title starts with this.
 *   OPENCODE_NOTIFY_EVENTS         Optional. idle,error,interrupted or full event names.
 *   OPENCODE_NOTIFY_DEBUG          Optional. 1/true for verbose logs.
 *
 * OpenCode 1.19.6 path plugins must default-export an object with `id`
 * and `server()`. A `{ id, setup }` default is rejected with
 * `must default export an object with server()`. See:
 *   https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/plugin/shared.ts
 *   https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/plugin/index.ts
 *   https://cdn.jsdelivr.net/npm/@opencode-ai/plugin@1.19.6/dist/index.d.ts
 *
 * server(input, options) receives PluginInput
 *   { client, project, directory, worktree, $, ... }
 * and must return a Hooks object. 1.19.6 delivers bus events as:
 *   hook.event({ event: { id, type, properties: event.data } })
 * so session.idle is `{ type: "session.idle", properties: { sessionID } }`.
 * Some builds still use `data` instead of `properties`; both are read.
 *
 * This file must never throw: a plugin error should not take OpenCode down.
 */

const PREFIX = "opencode-webhook"
const SNIPPET_MAX = 500
const FETCH_TIMEOUT_MS = 10_000
const RETRY_DELAYS_MS = [0, 500, 1500]
const TURN_DEDUPE_MS = 2_000

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

function bagOf(event) {
  return event?.properties || event?.data || {}
}

function sessionIDOf(event) {
  const bag = bagOf(event)
  return bag.sessionID || bag.sessionId || bag.info?.id || null
}

function statusOf(type) {
  if (type === "session.error" || type === "session.execution.failed") return "error"
  if (type === "session.execution.interrupted") return "interrupted"
  return "idle"
}

function errorOf(event) {
  const bag = bagOf(event)
  return bag.error || null
}

function unwrap(value) {
  if (value == null) return null
  // @opencode-ai/sdk 1.19.x returns { data, error } from client methods.
  if (typeof value === "object" && !Array.isArray(value) && "data" in value && value.title == null && value.info == null) {
    return value.data
  }
  return value
}

function snippetFromMessages(messages) {
  const unwrapped = unwrap(messages)
  const list = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped?.data || unwrapped?.messages || messages?.data || messages?.messages || []
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
      const value = unwrap(await fn())
      if (value != null) return value
    } catch {
      // OpenCode 1 and 2 expose slightly different client methods.
    }
  }
  return null
}

async function enrich(ctx, sessionID) {
  const out = {
    title: null,
    directory: ctx?.directory || ctx?.worktree || null,
    snippet: null,
  }
  try {
    const sessionApi = ctx?.client?.session || ctx?.session
    if (!sessionApi) return out
    const session = await tryCall([
      () => sessionApi.get({ path: { id: sessionID } }),
      () => sessionApi.get({ sessionID }),
      () => sessionApi.get(sessionID),
    ])
    if (session) {
      out.title = titleOf(session)
      out.directory = directoryOf(session) || out.directory
    }
    const messages = await tryCall([
      () => sessionApi.messages({ path: { id: sessionID }, query: { limit: 8 } }),
      () => sessionApi.messages({ sessionID, limit: 8 }),
      () => sessionApi.message?.list?.({ path: { id: sessionID }, query: { limit: 8 } }),
    ])
    if (messages) out.snippet = snippetFromMessages(messages)
  } catch {
    // Title and snippet are optional; still send the webhook.
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

function createRuntime() {
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
    if (recentTurn.size > 1000) {
      const first = recentTurn.keys().next().value
      recentTurn.delete(first)
    }
    return false
  }

  async function postWebhook(payload) {
    if (!ensureConfigured()) return false
    const cfg = readConfig()

    const headers = { "content-type": "application/json" }
    if (cfg.secret) headers.authorization = `Bearer ${cfg.secret}`
    const dest = safeUrl(cfg.url)
    const body = JSON.stringify(payload)

    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      if (RETRY_DELAYS_MS[i]) await sleep(RETRY_DELAYS_MS[i])
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
      if (typeof timer.unref === "function") timer.unref()
      try {
        const res = await fetch(cfg.url, { method: "POST", headers, body, signal: ac.signal })
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
        const name = err?.name || "error"
        if (i === RETRY_DELAYS_MS.length - 1) {
          log("error", `webhook POST failed (${name}) -> ${dest}`, cfg)
          return false
        }
        log("warn", `webhook POST ${name}, retrying -> ${dest}`, cfg)
      } finally {
        clearTimeout(timer)
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
      log("debug", `skip ${event.type} (title prefix)`, cfg)
      return false
    }

    return postWebhook({
      event: event.type,
      status,
      sessionID,
      title: extra.title,
      directory: extra.directory,
      snippet: extra.snippet,
      timestamp: new Date().toISOString(),
      eventID: event.id || null,
      error: errorOf(event),
    })
  }

  return { handleEvent, postWebhook, ensureConfigured }
}

/**
 * OpenCode 1.19+ calls `default.server(input, options)` and expects Hooks.
 * Older loaders call this function export directly. Never throw from here.
 */
export async function server(input = {}, _options) {
  try {
    const runtime = createRuntime()
    const cfg = readConfig()
    if (runtime.ensureConfigured()) log("debug", `loaded, webhook ${safeUrl(cfg.url)}`, cfg)

    const onEvent = async (raw) => {
      try {
        const event = raw?.event ?? raw
        await runtime.handleEvent(event, input)
      } catch (err) {
        log("error", `handler failed: ${err?.name || "error"}`, readConfig())
      }
    }

    const hooks = {
      event: onEvent,
    }

    // OpenCode 2 may expose a subscribe() stream or data.on() instead of
    // the v1 event hook. 1.19.6 uses the hook above
    // (plugin/index.ts listen → hook.event({ event: { id, type, properties } })).
    if (typeof input?.data?.on === "function") {
      try {
        const types = Object.values(EVENT_GROUPS).flat()
        const stops = types
          .map((type) => {
            try {
              return input.data.on(type, (event) => onEvent(event))
            } catch {
              return null
            }
          })
          .filter(Boolean)
        if (stops.length) {
          hooks.dispose = async () => {
            for (const stop of stops) {
              try {
                if (typeof stop === "function") stop()
              } catch {
                // ignore
              }
            }
          }
        }
      } catch (err) {
        log("error", `data.on failed: ${err?.name || "error"}`, readConfig())
      }
    }

    if (input?.event?.subscribe) {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of input.event.subscribe({ signal: controller.signal })) {
            await onEvent(event)
          }
        } catch (err) {
          if (err?.name !== "AbortError") {
            log("error", `event stream failed: ${err?.name || "error"}`, readConfig())
          }
        }
      })()
      const prevDispose = hooks.dispose
      hooks.dispose = async () => {
        controller.abort()
        if (prevDispose) await prevDispose()
      }
    }

    return hooks
  } catch (err) {
    log("error", `plugin init failed: ${err?.name || "error"}`, readConfig())
    return { event: async () => {} }
  }
}

// Named function aliases for older loaders that scan exports for a plugin
// function. Keep every named export a plugin function (or an alias of one)
// so the 1.19.6 legacy path in getLegacyPlugins() does not throw
// "Plugin export is not a function".
export const DoneWebhook = server
export const Plugin = server

// Dual default: v1.19+ requires server(); v2 loaders look for setup().
// Extra keys are ignored by readV1Plugin as long as tui is not also set.
const plugin = { id: "opencode-webhook", server, setup: server }
export default plugin
