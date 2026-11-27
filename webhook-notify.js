/**
 * opencode-webhook
 *
 * POSTs JSON when an OpenCode session finishes, fails, gets blocked on a
 * permission/question prompt, or stalls, so another bot or service can
 * hand off a task and always hear back.
 *
 * Install: copy this file to ~/.config/opencode/plugins/ or
 * .opencode/plugins/ in a project, then restart OpenCode.
 *
 * Environment (must be in the same process that starts OpenCode):
 *
 *   OPENCODE_NOTIFY_WEBHOOK_URL    Required. http(s) URL that receives the POST.
 *   OPENCODE_NOTIFY_SECRET         Optional. Sent as Authorization: Bearer <secret>.
 *   OPENCODE_NOTIFY_TITLE_PREFIX   Optional. Only sessions whose title starts with this.
 *   OPENCODE_NOTIFY_EVENTS         Optional. Groups: idle,error,interrupted,blocked,stalled,
 *                                  tool_error (tool_error is off by default) or full event names.
 *   OPENCODE_NOTIFY_STALL_MINUTES  Optional. Busy with no activity this long = "stalled" ping.
 *                                  Default 10. 0 disables the watchdog.
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
const ERROR_IDLE_DEDUPE_MS = 15_000

const DEFAULT_STALL_MINUTES = 10

// Bus event names verified against the OpenCode 1.19.6 binary.
// "stalled" and "tool.error" are synthetic (made by this plugin).
const EVENT_GROUPS = {
  idle: ["session.idle", "session.execution.succeeded"],
  error: ["session.error", "session.execution.failed"],
  interrupted: ["session.execution.interrupted"],
  blocked: ["permission.asked", "question.asked"],
  retrying: ["session.status"],
  stalled: ["stalled"],
  tool_error: ["tool.error"],
}
const DEFAULT_GROUPS = ["idle", "error", "interrupted", "blocked", "retrying", "stalled"]

function env(name, fallback) {
  const value = process.env[name]
  if (value == null || value === "") return fallback
  return value
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim())
}

function parseEventFilter(raw) {
  const allowed = new Set(DEFAULT_GROUPS.flatMap((g) => EVENT_GROUPS[g]))
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

function stallMinutes(raw) {
  if (raw === "") return DEFAULT_STALL_MINUTES
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STALL_MINUTES
}

function readConfig() {
  return {
    url: env("OPENCODE_NOTIFY_WEBHOOK_URL", ""),
    secret: env("OPENCODE_NOTIFY_SECRET", ""),
    titlePrefix: env("OPENCODE_NOTIFY_TITLE_PREFIX", ""),
    events: parseEventFilter(env("OPENCODE_NOTIFY_EVENTS", "")),
    debug: truthy(env("OPENCODE_NOTIFY_DEBUG", "")),
    stallMinutes: stallMinutes(env("OPENCODE_NOTIFY_STALL_MINUTES", "")),
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
  return (
    bag.sessionID ||
    bag.sessionId ||
    bag.part?.sessionID ||
    bag.info?.sessionID ||
    (event?.type?.startsWith("session.") ? bag.info?.id : null) ||
    null
  )
}

function clip(value, max = 300) {
  if (typeof value !== "string") return value ?? null
  return value.length > max ? value.slice(0, max) + "…" : value
}

/**
 * Turn a bus event into a notification, or null.
 * `status` keeps the 1.1 values (idle | error | interrupted) for old
 * receivers; new kinds (blocked, stalled, tool_error) use status = kind.
 * `kind` is the clear one to switch on:
 *   finished | error | aborted | interrupted | blocked | retrying | stalled | tool_error
 */
function classify(event) {
  const type = event?.type
  const bag = bagOf(event)
  switch (type) {
    case "session.idle":
    case "session.execution.succeeded":
      return { kind: "finished", status: "idle" }
    case "session.error":
    case "session.execution.failed": {
      const name = bag.error?.name || ""
      return { kind: /Abort/i.test(name) ? "aborted" : "error", status: "error" }
    }
    case "session.execution.interrupted":
      return { kind: "interrupted", status: "interrupted" }
    case "permission.asked":
      return {
        kind: "blocked",
        status: "blocked",
        key: `blocked:${bag.id}`,
        detail: {
          reason: "permission",
          requestID: bag.id || null,
          permission: bag.permission || null,
          patterns: Array.isArray(bag.patterns) ? bag.patterns.slice(0, 10) : [],
          command: clip(bag.metadata?.command),
        },
      }
    case "question.asked":
      return {
        kind: "blocked",
        status: "blocked",
        key: `blocked:${bag.id}`,
        detail: {
          reason: "question",
          requestID: bag.id || null,
          question: clip(bag.questions?.[0]?.question || bag.questions?.[0]?.header || null),
        },
      }
    case "session.status":
      // Model/API call failed and OpenCode is retrying (e.g. server out of RAM).
      if (bag.status?.type !== "retry") return null
      return {
        kind: "retrying",
        status: "retrying",
        detail: {
          attempt: bag.status.attempt ?? null,
          message: clip(bag.status.message || ""),
          nextRetryAt: bag.status.next ? new Date(bag.status.next).toISOString() : null,
        },
      }
    case "stalled":
      return { kind: "stalled", status: "stalled", key: `stalled:${bag.sessionID}:${bag.since}`, detail: bag.detail }
    case "tool.error":
      return { kind: "tool_error", status: "tool_error", key: `tool:${bag.callID}`, detail: bag.detail }
    default:
      return null
  }
}

function toolErrorOf(event) {
  if (event?.type !== "message.part.updated") return null
  const part = bagOf(event).part
  if (part?.type !== "tool" || part.state?.status !== "error") return null
  return {
    type: "tool.error",
    properties: {
      sessionID: part.sessionID,
      callID: part.callID || part.id,
      detail: { tool: part.tool || null, error: clip(String(part.state.error || "")) },
    },
  }
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

function lastErrorFromMessages(messages) {
  const unwrapped = unwrap(messages)
  const list = Array.isArray(unwrapped) ? unwrapped : unwrapped?.data || unwrapped?.messages || []
  for (let i = list.length - 1; i >= 0; i--) {
    const info = list[i]?.info || list[i]
    if (info?.role !== "assistant") continue
    const err = info.error
    if (!err) {
      // Went idle without the model finishing: aborted before any output.
      if (!info.finish && info.time?.created) {
        return { name: "MessageAbortedError", message: "Turn ended before the model finished" }
      }
      return null
    }
    return { name: err.name || "Error", message: clip(err.data?.message || err.message || "") }
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
    lastError: null,
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
    if (messages) {
      out.snippet = snippetFromMessages(messages)
      out.lastError = lastErrorFromMessages(messages)
    }
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

  // Watchdog state per session: busy flag, last activity, open prompts.
  const sessions = new Map()
  const errorPinged = new Map()
  function track(event) {
    const sessionID = sessionIDOf(event)
    if (!sessionID || event.type === "stalled") return
    const bag = bagOf(event)
    let s = sessions.get(sessionID)
    if (!s) {
      s = { busy: false, last: Date.now(), stalledSent: false, open: new Set() }
      sessions.set(sessionID, s)
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value)
    }
    if (event.type === "session.status" && bag.status?.type === "retry") {
      // Model retries are not progress; keep the stall clock running.
      s.busy = true
      s.retry = { attempt: bag.status.attempt ?? null, message: clip(bag.status.message || "") }
      return
    }
    if (event.type !== "session.status") s.retryPinged = false
    s.last = Date.now()
    s.stalledSent = false
    s.retry = null
    if (event.type === "session.status") s.busy = bag.status?.type !== "idle"
    else if (event.type === "session.idle" || event.type === "session.deleted") s.busy = false
    else if (event.type === "permission.asked" || event.type === "question.asked") s.open.add(bag.id)
    else if (/^(permission|question)\.(replied|rejected)$/.test(event.type)) s.open.delete(bag.requestID || bag.id)
    if (event.type === "session.deleted") sessions.delete(sessionID)
  }

  function stalledEvents(now = Date.now()) {
    const cfg = readConfig()
    const out = []
    if (!cfg.stallMinutes) return out
    const limit = cfg.stallMinutes * 60_000
    for (const [sessionID, s] of sessions) {
      // Blocked sessions already got a "blocked" ping; don't double up.
      if (!s.busy || s.stalledSent || s.open.size || now - s.last < limit) continue
      s.stalledSent = true
      out.push({
        type: "stalled",
        properties: {
          sessionID,
          since: s.last,
          detail: {
            minutesSinceActivity: Math.floor((now - s.last) / 60_000),
            lastActivity: new Date(s.last).toISOString(),
            retry: s.retry || null,
          },
        },
      })
    }
    return out
  }

  async function handleEvent(event, ctx) {
    if (!event) return false
    track(event)
    const toolErr = toolErrorOf(event)
    if (toolErr) await handleEvent(toolErr, ctx)
    const cfg = readConfig()
    if (!cfg.events.has(event.type)) return false
    const sessionID = sessionIDOf(event)
    if (!sessionID) return false
    const info = classify(event)
    if (!info) return false
    const status = info.status
    if (info.kind === "retrying") {
      // One ping per retry streak; re-arms after real progress or idle.
      const s = sessions.get(sessionID)
      if (!s || s.retryPinged) return false
      s.retryPinged = true
    } else if (info.key) {
      if (firedIds.has(info.key)) return false
      firedIds.add(info.key)
      if (firedIds.size > 1000) firedIds.delete(firedIds.values().next().value)
    } else if (alreadyFired(sessionID, status, event.id)) return false

    const extra = await enrich(ctx, sessionID)
    let kind = info.kind
    let error = errorOf(event)
    if (kind === "finished" && extra.lastError) {
      // 1.19.6 aborts via the API often emit only session.idle.
      kind = /Abort/i.test(extra.lastError.name) ? "aborted" : "error"
      error = extra.lastError
    }
    if (kind === "finished" || kind === "aborted" || kind === "error") {
      // One ping per turn: skip the idle that follows an error ping.
      const prev = errorPinged.get(sessionID)
      if (info.kind === "finished" && prev && Date.now() - prev < ERROR_IDLE_DEDUPE_MS) return false
      if (info.kind !== "finished") {
        errorPinged.set(sessionID, Date.now())
        if (errorPinged.size > 500) errorPinged.delete(errorPinged.keys().next().value)
      }
    }
    if (!shouldNotify(extra.title, cfg.titlePrefix)) {
      log("debug", `skip ${event.type} (title prefix)`, cfg)
      return false
    }

    return postWebhook({
      event: event.type,
      status,
      kind,
      sessionID,
      title: extra.title,
      directory: extra.directory,
      snippet: extra.snippet,
      timestamp: new Date().toISOString(),
      eventID: event.id || null,
      error,
      detail: info.detail || null,
    })
  }

  async function checkStalls(ctx, now) {
    for (const ev of stalledEvents(now)) await handleEvent(ev, ctx)
  }

  return { handleEvent, postWebhook, ensureConfigured, checkStalls, sessions }
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

    // Stall watchdog: checks every 30s; never keeps the process alive.
    const timer = setInterval(() => {
      runtime.checkStalls(input).catch(() => {})
    }, 30_000)
    if (typeof timer.unref === "function") timer.unref()
    hooks.dispose = async () => clearInterval(timer)
    // Test hook, hidden from OpenCode's hook lookup.
    Object.defineProperty(hooks, "__checkStalls", {
      value: (now) => runtime.checkStalls(input, now),
      enumerable: false,
    })

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
          const prevStopDispose = hooks.dispose
          hooks.dispose = async () => {
            if (prevStopDispose) await prevStopDispose()
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
