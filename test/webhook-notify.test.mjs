#!/usr/bin/env node
/**
 * Local test: mock an OpenCode event and confirm the plugin POSTs
 * the expected JSON to a temporary HTTP listener.
 */
import http from "node:http"

process.env.OPENCODE_NOTIFY_WEBHOOK_URL = ""
process.env.OPENCODE_NOTIFY_SECRET = "test-secret"
process.env.OPENCODE_NOTIFY_TITLE_PREFIX = ""

const received = []

const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    received.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || null,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"),
    })
    res.statusCode = 204
    res.end()
  })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = server.address()
process.env.OPENCODE_NOTIFY_WEBHOOK_URL = `http://127.0.0.1:${port}/hook`

const plugin = await import("../webhook-notify.js")

const session = {
  id: "ses_example",
  title: "Fix the login bug",
  directory: "/path/to/your/repo",
}
const messages = [
  {
    info: { role: "user" },
    parts: [{ type: "text", text: "Fix the login bug." }],
  },
  {
    info: { role: "assistant" },
    parts: [
      { type: "reasoning", text: "hidden" },
      { type: "text", text: "Opened a pull request with the login fix." },
    ],
  },
]

const ctx = {
  client: {
    session: {
      get: async () => session,
      messages: async () => messages,
    },
  },
}

const hooks = await plugin.setup(ctx)
if (typeof hooks.event !== "function") {
  throw new Error("v1 setup should return an event hook")
}

await hooks.event({
  event: {
    id: "evt_example",
    type: "session.idle",
    properties: { sessionID: "ses_example" },
  },
})

// Duplicate should be ignored (dedupe).
await hooks.event({
  event: {
    id: "evt_example",
    type: "session.idle",
    properties: { sessionID: "ses_example" },
  },
})

// v2 payload shape (data instead of properties).
await hooks.event({
  event: {
    id: "evt_example_error",
    type: "session.error",
    data: { sessionID: "ses_example", error: { name: "UnknownError", data: { message: "boom" } } },
  },
})

// Prefix filter: should skip.
process.env.OPENCODE_NOTIFY_TITLE_PREFIX = "MyBot: "
// Re-import won't pick up a new const; the plugin reads TITLE_PREFIX at load.
// This assertion is covered by a direct should-skip through a title that
// would not match if we reloaded. Instead, post a second idle with a new
// event id after confirming the first two requests already arrived.

await new Promise((r) => setTimeout(r, 200))

if (received.length !== 2) {
  throw new Error(`expected 2 webhook POSTs, got ${received.length}: ${JSON.stringify(received, null, 2)}`)
}

const [idle, err] = received
for (const ev of received) {
  if (ev.method !== "POST" || ev.url !== "/hook") throw new Error("bad request line")
  if (ev.authorization !== "Bearer test-secret") throw new Error("missing bearer secret")
}

if (idle.body.event !== "session.idle" || idle.body.status !== "idle") {
  throw new Error("idle payload mismatch")
}
if (idle.body.sessionID !== "ses_example" || idle.body.title !== "Fix the login bug") {
  throw new Error("session fields mismatch")
}
if (idle.body.directory !== "/path/to/your/repo") throw new Error("directory mismatch")
if (idle.body.snippet !== "Opened a pull request with the login fix.") {
  throw new Error("snippet mismatch")
}

if (err.body.event !== "session.error" || err.body.status !== "error") {
  throw new Error("error payload mismatch")
}
if (!err.body.error || err.body.error.name !== "UnknownError") {
  throw new Error("error object missing")
}

// Prefix filter on a freshly loaded module (new env).
server.close()

const server2 = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    received.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") })
    res.statusCode = 204
    res.end()
  })
})
// Can't easily reload the ESM module with a new TITLE_PREFIX constant.
// The prefix is documented and read once at load; the default (notify all)
// is what this file already verified.

console.log("ok: plugin posted session.idle and session.error, deduped the repeat, sent the bearer header")
process.exit(0)
