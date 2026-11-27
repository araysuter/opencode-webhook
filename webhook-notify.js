/**
 * opencode-webhook
 *
 * A small OpenCode plugin that POSTs a JSON webhook when an agent
 * finishes or errors. Any bot or service can start a session over the
 * HTTP API, then hear back when the work is done.
 *
 * Install: copy this file to ~/.config/opencode/plugins/ and restart OpenCode.
 *
 * Environment (set these in the same shell / service that starts OpenCode):
 *
 *   OPENCODE_NOTIFY_WEBHOOK_URL    Required. URL that receives the POST.
 *   OPENCODE_NOTIFY_SECRET         Optional. Sent as: Authorization: Bearer <secret>
 *   OPENCODE_NOTIFY_TITLE_PREFIX   Optional. If set, only sessions whose
 *                                  title starts with this prefix are posted.
 *                                  Unset = notify every finished session.
 *
 * OpenCode 1 loads the exported function and calls its `event` hook.
 * OpenCode 2 loads the default `{ id, setup }` export and subscribes
 * to the server event stream. Both shapes are exported from this file.
 * Event payloads are read from either `properties` (v1) or `data` (v2).
 */

const WEBHOOK_URL = process.env.OPENCODE_NOTIFY_WEBHOOK_URL
const SECRET = process.env.OPENCODE_NOTIFY_SECRET
const TITLE_PREFIX = process.env.OPENCODE_NOTIFY_TITLE_PREFIX || ""
const SNIPPET_MAX = 500

// "The agent finished" signals. session.idle / session.error are the
// v1 events (and still appear in the v2 schema). The session.execution.*
// events are the v2 end-of-run signals.
const DONE_EVENTS = new Set([
  "session.idle",
  "session.error",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

const fired = new Set()

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
      // Try the next client shape. OpenCode 1 and 2 expose slightly different methods.
    }
  }
  return null
}

async function enrich(ctx, sessionID) {
  const out = { title: null, directory: null, snippet: null }
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
  return out
}

function shouldNotify(title) {
  if (!TITLE_PREFIX) return true
  return typeof title === "string" && title.startsWith(TITLE_PREFIX)
}

export async function postWebhook(payload) {
  if (!WEBHOOK_URL) {
    console.error("opencode-webhook: OPENCODE_NOTIFY_WEBHOOK_URL is not set")
    return false
  }
  const headers = { "content-type": "application/json" }
  if (SECRET) headers.authorization = `Bearer ${SECRET}`
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    console.error("opencode-webhook: webhook POST failed", res.status)
    return false
  }
  return true
}

export async function handleEvent(event, ctx) {
  if (!DONE_EVENTS.has(event?.type)) return
  const sessionID = sessionIDOf(event)
  if (!sessionID) return

  const dedupe = `${event.type}:${event.id || sessionID}`
  if (fired.has(dedupe)) return
  fired.add(dedupe)

  const extra = await enrich(ctx, sessionID)
  if (!shouldNotify(extra.title)) return

  return postWebhook({
    event: event.type,
    eventID: event.id || null,
    sessionID,
    title: extra.title,
    directory: extra.directory,
    status: statusOf(event.type),
    snippet: extra.snippet,
    error: errorOf(event),
  })
}

/**
 * OpenCode 1: return an `event` hook.
 * OpenCode 2: `setup(ctx)` subscribes to the event stream and should
 * return a cleanup function that aborts the subscription.
 */
export async function setup(ctx) {
  if (ctx?.event?.subscribe) {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handleEvent(event, ctx)
          } catch (err) {
            console.error("opencode-webhook: handler failed", err)
          }
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.error("opencode-webhook: event stream failed", err)
        }
      }
    })()
    return () => controller.abort()
  }

  return {
    event: async ({ event }) => {
      try {
        await handleEvent(event, ctx)
      } catch (err) {
        console.error("opencode-webhook: handler failed", err)
      }
    },
  }
}

// OpenCode 1 discovers plugin functions by export name.
export const DoneWebhook = setup

// OpenCode 2 discovers `{ id, setup }` on the default export.
export default { id: "opencode-webhook", setup }
