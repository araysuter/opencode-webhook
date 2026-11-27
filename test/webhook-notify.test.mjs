import { createServer } from "node:http"
import assert from "node:assert/strict"

const pluginPath = new URL("../webhook-notify.js", import.meta.url)

function freshImport() {
  return import(`${pluginPath.href}?t=${Date.now()}-${Math.random()}`)
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
        close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      })
    })
  })
}

function collectLogs() {
  const lines = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Replica of readV1Plugin() from OpenCode 1.19.6
 * packages/opencode/src/plugin/shared.ts
 */
function readV1Plugin(mod, spec, kind, mode = "strict") {
  const value = mod.default
  if (!isRecord(value)) {
    if (mode === "detect") return
    throw new TypeError(`Plugin ${spec} must default export an object with ${kind}()`)
  }
  if (mode === "detect" && !("id" in value) && !("server" in value) && !("tui" in value)) return

  const server = "server" in value ? value.server : undefined
  const tui = "tui" in value ? value.tui : undefined
  if (server !== undefined && typeof server !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid server export`)
  }
  if (tui !== undefined && typeof tui !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid tui export`)
  }
  if (server !== undefined && tui !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`)
  }
  if (kind === "server" && server === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with server()`)
  }
  if (kind === "tui" && tui === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with tui()`)
  }
  return value
}

function isServerPlugin(value) {
  return typeof value === "function"
}

function getServerPlugin(value) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

/**
 * Replica of getLegacyPlugins() from OpenCode 1.19.6
 * packages/opencode/src/plugin/index.ts
 */
function getLegacyPlugins(mod) {
  const seen = new Set()
  const result = []
  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }
  return result
}

async function applyPlugin(mod, spec, input, options) {
  const plugin = readV1Plugin(mod, spec, "server", "detect")
  if (plugin) {
    if (!plugin.id) throw new TypeError(`Path plugin ${spec} must export id`)
    return [await plugin.server(input, options)]
  }
  const hooks = []
  for (const server of getLegacyPlugins(mod)) {
    hooks.push(await server(input, options))
  }
  return hooks
}

function idleEvent(sessionID, id = "evt_1") {
  return {
    event: {
      id,
      type: "session.idle",
      properties: { sessionID },
    },
  }
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

test("default export is { id, server } for OpenCode 1.19.6", async () => {
  const plugin = await freshImport()
  assert.equal(plugin.default.id, "opencode-webhook")
  assert.equal(typeof plugin.default.server, "function")
  assert.equal(plugin.default.server, plugin.server)
  assert.equal(plugin.default.setup, plugin.server)
  assert.equal(plugin.DoneWebhook, plugin.server)
  assert.equal(plugin.Plugin, plugin.server)
  const named = Object.keys(plugin).filter((k) => k !== "default")
  for (const key of named) {
    assert.equal(typeof plugin[key], "function", `${key} must be a plugin function`)
    assert.equal(plugin[key], plugin.server)
  }
})

test("1.19.6 loader replica accepts this file and calls server(input, options)", async () => {
  const plugin = await freshImport()
  const spec = "file:///tmp/webhook-notify.js"
  const hooks = await applyPlugin(plugin, spec, { directory: "/tmp/demo" }, { flag: true })
  assert.equal(hooks.length, 1)
  assert.equal(typeof hooks[0].event, "function")
})

test("1.19.6 loader replica rejects the old { id, setup } default", async () => {
  const spec = "file:///tmp/old-plugin.js"
  const old = { default: { id: "opencode-webhook", setup: async () => ({}) } }
  assert.throws(
    () => readV1Plugin(old, spec, "server", "detect"),
    /must default export an object with server\(\)/,
  )
})

test("legacy getLegacyPlugins() accepts the module (every export is a plugin function)", async () => {
  const plugin = await freshImport()
  // 1.19.6 applyPlugin() never reaches this path when default has id+server.
  // Older loaders that scan every export still need each value to be a
  // function or `{ server }`. The default object and the named function are
  // distinct values, so this replica may return the same function twice —
  // that is OK, and must not throw "Plugin export is not a function".
  const plugins = getLegacyPlugins(plugin)
  assert.ok(plugins.length >= 1)
  for (const fn of plugins) assert.equal(fn, plugin.server)
})

test("server() returns an event hook and never throws without a URL", async () => {
  await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: null, OPENCODE_NOTIFY_SECRET: null }, async () => {
    const plugin = await freshImport()
    const hooks = await plugin.server({})
    assert.equal(typeof hooks.event, "function")
    await hooks.event(idleEvent("ses_1"))
  })
})

test("posts on session.idle with the 1.19.6 properties event shape", async () => {
  const col = await startCollector()
  try {
    await withEnv(
      { OPENCODE_NOTIFY_WEBHOOK_URL: col.url, OPENCODE_NOTIFY_SECRET: "s3cret" },
      async () => {
        const plugin = await freshImport()
        const hooks = await plugin.default.server(
          {
            directory: "/path/to/your/repo",
            client: {
              session: {
                get: async () => ({ data: { title: "MyBot: demo", directory: "/path/to/your/repo" } }),
                messages: async () => ({
                  data: [
                    { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
                    { info: { role: "assistant" }, parts: [{ type: "text", text: "all done" }] },
                  ],
                }),
              },
            },
          },
          {},
        )
        await hooks.event({
          event: {
            id: "evt_1",
            type: "session.idle",
            properties: { sessionID: "ses_1" },
          },
        })
        assert.equal(col.posts.length, 1)
        assert.equal(col.posts[0].authorization, "Bearer s3cret")
        const body = col.posts[0].body
        assert.equal(body.event, "session.idle")
        assert.equal(body.status, "idle")
        assert.equal(body.sessionID, "ses_1")
        assert.equal(body.title, "MyBot: demo")
        assert.equal(body.directory, "/path/to/your/repo")
        assert.equal(body.snippet, "all done")
        assert.equal(body.eventID, "evt_1")
        assert.equal(body.error, null)
        assert.equal(typeof body.timestamp, "string")
        assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(body.timestamp))
      },
    )
  } finally {
    await col.close()
  }
})

test("handles v2 data event shape and session.execution.failed", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url, OPENCODE_NOTIFY_SECRET: null }, async () => {
      const plugin = await freshImport()
      const hooks = await plugin.server({})
      await hooks.event({
        id: "evt_err",
        type: "session.execution.failed",
        data: { sessionID: "ses_2", error: { name: "UnknownError", message: "boom" } },
      })
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
      const hooks = await plugin.server({})
      const ev = idleEvent("ses_3", "evt_dup")
      await hooks.event(ev)
      await hooks.event(ev)
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
      const hooks = await plugin.server({})
      await hooks.event({
        event: { id: "evt_a", type: "session.idle", properties: { sessionID: "ses_4" } },
      })
      await hooks.event({
        id: "evt_b",
        type: "session.execution.succeeded",
        data: { sessionID: "ses_4" },
      })
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
        const hooks = await plugin.server({
          session: { get: async () => ({ title: "personal chat" }) },
        })
        await hooks.event(idleEvent("ses_5", "evt_skip"))
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
        const hooks = await plugin.server({})
        await hooks.event(idleEvent("ses_6", "evt_idle"))
        await hooks.event({
          event: {
            id: "evt_err",
            type: "session.error",
            properties: { sessionID: "ses_6", error: { name: "X" } },
          },
        })
        assert.equal(col.posts.length, 1)
        assert.equal(col.posts[0].body.event, "session.error")
        assert.equal(col.posts[0].body.status, "error")
      },
    )
  } finally {
    await col.close()
  }
})

test("uses ctx.directory when session lookup is missing", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const hooks = await plugin.server({ directory: "/workspace/demo" })
      await hooks.event(idleEvent("ses_dir", "evt_dir"))
      assert.equal(col.posts[0].body.directory, "/workspace/demo")
    })
  } finally {
    await col.close()
  }
})

test("does not retry 4xx responses", async () => {
  const col = await startCollector(() => ({ status: 401 }))
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const hooks = await plugin.server({})
      await hooks.event(idleEvent("ses_8", "evt_8"))
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
      const hooks = await plugin.server({})
      const started = Date.now()
      await hooks.event(idleEvent("ses_9", "evt_9"))
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
      await hooks.event(idleEvent("ses_10"))
      await hooks.event(idleEvent("ses_11"))
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
        const hooks = await plugin.server({})
        await hooks.event(idleEvent("ses_12", "evt_12"))
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
      const hooks = await plugin.server({
        client: {
          session: {
            get: async () => ({ title: "demo" }),
            messages: async () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: long }] }],
          },
        },
      })
      await hooks.event(idleEvent("ses_13", "evt_snip"))
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
    await hooks.event(idleEvent("ses_14", "evt_down"))
  })
})

test("v2 data.on() terminal events are forwarded", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const listeners = {}
      const ctx = {
        data: {
          on(type, fn) {
            listeners[type] = fn
            return () => delete listeners[type]
          },
        },
      }
      await plugin.server(ctx)
      assert.equal(typeof listeners["session.execution.succeeded"], "function")
      await listeners["session.execution.interrupted"]({
        id: "evt_int",
        type: "session.execution.interrupted",
        data: { sessionID: "ses_15", reason: "user" },
      })
      assert.equal(col.posts.length, 1)
      assert.equal(col.posts[0].body.status, "interrupted")
    })
  } finally {
    await col.close()
  }
})

test("client lookup failures are soft and still post", async () => {
  const col = await startCollector()
  try {
    await withEnv({ OPENCODE_NOTIFY_WEBHOOK_URL: col.url }, async () => {
      const plugin = await freshImport()
      const hooks = await plugin.server({
        directory: "/tmp/demo",
        client: {
          session: {
            get: async () => {
              throw new Error("nope")
            },
            messages: async () => {
              throw new Error("nope")
            },
          },
        },
      })
      await hooks.event(idleEvent("ses_16", "evt_16"))
      assert.equal(col.posts.length, 1)
      assert.equal(col.posts[0].body.title, null)
      assert.equal(col.posts[0].body.directory, "/tmp/demo")
      assert.equal(col.posts[0].body.snippet, null)
    })
  } finally {
    await col.close()
  }
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
