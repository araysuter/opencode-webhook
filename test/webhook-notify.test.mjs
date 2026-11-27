import { createServer } from "node:http"
import assert from "node:assert/strict"

const pluginPath = new URL("../webhook-notify.js", import.meta.url)

function freshImport() {
  // Bust the ESM cache so each test gets a new module-level runtime.
  return import(`${pluginPath.href}?t=${Date.now()}-${Math.random()}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function withEnv(vars, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v == null) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function startCollector(handler) {
  const posts = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      const rec = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || null,
        body: raw ? JSON.parse(raw) : null,
      }
      posts.push(rec)
      const result = handler ? handler(rec, posts.length) : { status: 204 }
      res.writeHead(result.status, result.headers || {})
      res.end(result.body || "")
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        posts,
        url: `http://127.0.0.1:${port}/hook`,
        close: () =>
          new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      })
    })
  })
}

function collectLogs() {
  const lines = []
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }
  const wrap = (fn) =>
    (...args) => {
      lines.push(args.map((a) => String(a)).join(" "))
      return fn.apply(console, args)
    }
  console.log = wrap(orig.log)
  console.warn = wrap(orig.warn)
  console.error = wrap(orig.error)
  return {
    lines,
    restore() {
      console.log = orig.log
      console.warn = orig.warn
      console.error = orig.error
    },
  }
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

test("default export is { id, server } for OpenCode 1.19+", async () => {
  const plugin = await freshImport()
  assert.equal(plugin.default.id, "opencode-webhook")
  assert.equal(typeof plugin.default.server, "function")
  assert.equal(plugin.default.server, plugin.server)
  assert.equal(typeof plugin.DoneWebhook, "function")
  assert.equal(plugin.DoneWebhook, plugin.server)
  assert.equal(plugin.Plugin, plugin.server)
})

test("server() returns an event hook and never throws without a URL", async () => {
  await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: null, OPENCODE_NOTIFY_SECRET: null }, async () => {
    const plugin = await freshImport()
    const hooks = await plugin.server({})
    assert.equal(typeof hooks.event, "function")
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
  })
})

test("posts on session.idle with the 1.19.6 properties event shape", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url, OPENCODE_NOTIFY_SECRET: "s3cret" }, async () => {
      const plugin = await freshImport()
      const hooks = await plugin.server({
        client: {
          session: {
            get: async () => ({ title: "MyBot: demo", directory: "/path/to/your/repo" }),
            messages: async () => [
              { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
              { info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] },
            ],
          },
        },
      })
      await hooks.event({
        event: {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_1" },
        },
      })
      assert.equal(col.posts.length, 1)
      assert.equal(col.posts[0].authorization, "Bearer s3cret")
      assert.deepEqual(col.posts[0].body, {
        event: "session.idle",
        eventID: "evt_1",
        sessionID: "ses_1",
        title: "MyBot: demo",
        directory: "/path/to/your/repo",
        status: "idle",
        snippet: "all done",
        error: null,
      })
    })
  } finally {
    await col.close()
  }
})

test("handles v2 data event shape and session.execution.failed", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url, OPENCODE_NOTIFY_SECRET: null }, async () => {
      const plugin = await freshImport()
      await plugin.handleEvent(
        {
          id: "evt_err",
          type: "session.execution.failed",
          data: { sessionID: "ses_2", error: { name: "UnknownError", message: "boom" } },
        },
        {},
      )
      assert.equal(col.posts.length, 1)
      assert.equal(col.posts[0].body.status, "error")
      assert.equal(col.posts[0].body.event, "session.execution.failed")
      assert.deepEqual(col.posts[0].body.error, { name: "UnknownError", message: "boom" })
    })
  } finally {
    await col.close()
  }
})

test("dedupes the same event id", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const ev = { id: "evt_dup", type: "session.idle", properties: { sessionID: "ses_3" } }
      await plugin.handleEvent(ev, {})
      await plugin.handleEvent(ev, {})
      assert.equal(col.posts.length, 1)
    })
  } finally {
    await col.close()
  }
})

test("dedupes idle and execution.succeeded for the same session turn", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      await plugin.handleEvent(
        { id: "evt_a", type: "session.idle", properties: { sessionID: "ses_4" } },
        {},
      )
      await plugin.handleEvent(
        { id: "evt_b", type: "session.execution.succeeded", data: { sessionID: "ses_4" } },
        {},
      )
      assert.equal(col.posts.length, 1)
    })
  } finally {
    await col.close()
  }
})

test("skips sessions that do not match OPENCODE_NOTIFY_TITLE_PREFIX", async () => {
  const col = await startCollector()
  try {
    await withEnv(
      { OPENCODE_NOTIFY_WEBHOOK_URL: col.url, OPENCODE_NOTIFY_TITLE_PREFIX: "MyBot:" },
      async () => {
        const plugin = await freshImport()
        const ctx = { session: { get: async () => ({ title: "personal chat" }) } }
        await plugin.handleEvent(
          { id: "evt_skip", type: "session.idle", properties: { sessionID: "ses_5" } },
          ctx,
        )
        assert.equal(col.posts.length, 0)
      },
    )
  } finally {
    await col.close()
  }
})

test("OPENCODE_NOTIFY_EVENTS can limit notifications to errors", async () => {
  const col = await startCollector()
  try {
    await withEnv(
      { OPENCODE_NOTIFY_WEBHOOK_URL: col.url, OPENCODE_NOTIFY_EVENTS: "error" },
      async () => {
        const plugin = await freshImport()
        await plugin.handleEvent(
          { id: "evt_idle", type: "session.idle", properties: { sessionID: "ses_6" } },
          {},
        )
        await plugin.handleEvent(
          { id: "evt_err", type: "session.error", properties: { sessionID: "ses_6", error: { name: "X" } } },
          {},
        )
        assert.equal(col.posts.length, 1)
        assert.equal(col.posts[0].body.event, "session.error")
      },
    )
  } finally {
    await col.close()
  }
})

test("OPENCODE_NOTIFY_AUTH_SCHEME=raw sends the secret as the Authorization value", async () => {
  const col = await startCollector()
  try {
    await withEnv(
      {
        OPENCODE_NOTIFY_WEBHOOK_URL: col.url,
        OPENCODE_NOTIFY_SECRET: "raw-token",
        OPENCODE_NOTIFY_AUTH_SCHEME: "raw",
      },
      async () => {
        const plugin = await freshImport()
        await plugin.postWebhook({ event: "session.idle", sessionID: "ses_7" })
        assert.equal(col.posts[0].authorization, "raw-token")
      },
    )
  } finally {
    await col.close()
  }
})

test("does not retry 4xx responses", async () => {
  const col = await startCollector(() => ({ status: 401 }))
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const ok = await plugin.postWebhook({ event: "session.idle", sessionID: "ses_8" })
      assert.equal(ok, false)
      assert.equal(col.posts.length, 1)
    })
  } finally {
    await col.close()
  }
})

test("retries 5xx responses with backoff, then succeeds", async () => {
  const col = await startCollector((_rec, n) => ({ status: n < 3 ? 503 : 204 }))
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const started = Date.now()
      const ok = await plugin.postWebhook({ event: "session.idle", sessionID: "ses_9" })
      assert.equal(ok, true)
      assert.equal(col.posts.length, 3)
      assert.ok(Date.now() - started >= 1500, "expected backoff before the last retry")
    })
  } finally {
    await col.close()
  }
})

test("warns once and no-ops when the webhook URL is missing", async () => {
  const logs = collectLogs()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: null }, async () => {
      const plugin = await freshImport()
      const hooks = await plugin.server({})
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_10" } } })
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_11" } } })
      const warns = logs.lines.filter((l) => l.includes("OPENCODE_NOTIFY_WEBHOOK_URL is not set"))
      assert.equal(warns.length, 1)
    })
  } finally {
    logs.restore()
  }
})

test("warns once and no-ops when the webhook URL is invalid", async () => {
  const logs = collectLogs()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: "not-a-url" }, async () => {
      const plugin = await freshImport()
      await plugin.server({})
      const warns = logs.lines.filter((l) => l.includes("not a valid http(s) URL"))
      assert.equal(warns.length, 1)
    })
  } finally {
    logs.restore()
  }
})

test("never logs the secret or the URL query string", async () => {
  const col = await startCollector()
  const logs = collectLogs()
  const secret = "supersecret-value"
  try {
    await withEnv(
      {
        OPENCODE_NOTIFY_WEBHOOK_URL: col.url + "?token=" + secret,
        OPENCODE_NOTIFY_SECRET: secret,
        OPENCODE_NOTIFY_DEBUG: "1",
      },
      async () => {
        const plugin = await freshImport()
        await plugin.server({})
        await plugin.postWebhook({ event: "session.idle", sessionID: "ses_12" })
        const blob = logs.lines.join("\n")
        assert.doesNotMatch(blob, /supersecret-value/)
        assert.doesNotMatch(blob, /\?token=/)
        assert.match(blob, /opencode-webhook:/)
      },
    )
  } finally {
    logs.restore()
    await col.close()
  }
})

test("truncates long assistant snippets", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const long = "x".repeat(800)
      await plugin.handleEvent(
        { id: "evt_snip", type: "session.idle", properties: { sessionID: "ses_13" } },
        {
          client: {
            session: {
              get: async () => ({ title: "demo" }),
              messages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: long }] }],
            },
          },
        },
      )
      assert.equal(col.posts[0].body.snippet.length, 501)
      assert.ok(col.posts[0].body.snippet.endsWith("…"))
    })
  } finally {
    await col.close()
  }
})

test("event hook swallows fetch failures and does not throw", async () => {
  await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: "http://127.0.0.1:1/hook" }, async () => {
    const plugin = await freshImport()
    const hooks = await plugin.server({})
    await hooks.event({
      event: { id: "evt_down", type: "session.idle", properties: { sessionID: "ses_14" } },
    })
  })
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok  - ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL - ${name}`)
    console.error(err)
  }
}
if (failed) {
  console.error(`\n${failed} test(s) failed`)
  process.exit(1)
}
console.log(`\n${tests.length} tests passed`)
