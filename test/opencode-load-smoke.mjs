/**
 * Integration smoke: install is done by CI. This script starts
 * `opencode serve` with the plugin in an isolated config dir and
 * fails if the 1.19.6 loader error appears.
 *
 *   node test/opencode-load-smoke.mjs
 *
 * Env:
 *   OPENCODE_BIN   optional path to the opencode executable
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, cp, readFile } from "node:fs/promises"
import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pluginSrc = path.join(root, "webhook-notify.js")
const bin = process.env.OPENCODE_BIN || "opencode"
const timeoutMs = Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS || 45_000)

function startCollector() {
  const posts = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      posts.push({ url: req.url, body: raw ? JSON.parse(raw) : null })
      res.writeHead(204)
      res.end()
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

async function waitFor(url, signal) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (signal.aborted) throw new Error("opencode exited before becoming ready")
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.ok || res.status === 404 || res.status === 401) return res.status
    } catch {
      // still booting
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timed out waiting for ${url}`)
}

function collectTreeLogs(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, name.name)
    if (name.isDirectory()) collectTreeLogs(next, acc)
    else if (name.isFile() && /\.log$/.test(name.name)) acc.push(next)
  }
  return acc
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-webhook-smoke-"))
const home = path.join(tmp, "home")
const xdgConfig = path.join(tmp, "config")
const xdgData = path.join(tmp, "data")
const xdgCache = path.join(tmp, "cache")
const xdgState = path.join(tmp, "state")
const configDir = path.join(tmp, "opencode-config")
const workspace = path.join(tmp, "workspace")
const globalPlugins = path.join(xdgConfig, "opencode", "plugins")
const projectPlugins = path.join(workspace, ".opencode", "plugins")
const configPlugins = path.join(configDir, "plugins")

await mkdir(home, { recursive: true })
await mkdir(globalPlugins, { recursive: true })
await mkdir(projectPlugins, { recursive: true })
await mkdir(configPlugins, { recursive: true })
await mkdir(xdgData, { recursive: true })
await mkdir(xdgCache, { recursive: true })
await mkdir(xdgState, { recursive: true })
await mkdir(workspace, { recursive: true })
await writeFile(path.join(workspace, "README.md"), "# smoke\n")

await cp(pluginSrc, path.join(globalPlugins, "webhook-notify.js"))
await cp(pluginSrc, path.join(projectPlugins, "webhook-notify.js"))
await cp(pluginSrc, path.join(configPlugins, "webhook-notify.js"))

const col = await startCollector()
const port = await new Promise((resolve) => {
  const s = createServer()
  s.listen(0, "127.0.0.1", () => {
    const { port: p } = s.address()
    s.close(() => resolve(p))
  })
})

const logs = { stdout: "", stderr: "" }
const child = spawn(
  bin,
  ["serve", "--print-logs", "--log-level", "DEBUG", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_DATA_HOME: xdgData,
      XDG_CACHE_HOME: xdgCache,
      XDG_STATE_HOME: xdgState,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_NOTIFY_WEBHOOK_URL: col.url,
      OPENCODE_NOTIFY_DEBUG: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
)

child.stdout.on("data", (chunk) => {
  logs.stdout += chunk.toString()
})
child.stderr.on("data", (chunk) => {
  logs.stderr += chunk.toString()
})

const aborted = { current: false }
child.on("exit", () => {
  aborted.current = true
})

function dump(extra = "") {
  const files = collectTreeLogs(xdgData)
  return [
    extra,
    "--- stdout ---",
    logs.stdout.slice(-8000),
    "--- stderr ---",
    logs.stderr.slice(-8000),
    files.length ? `--- log files: ${files.join(", ")} ---` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

try {
  const healthUrls = [
    `http://127.0.0.1:${port}/global/health`,
    `http://127.0.0.1:${port}/`,
    `http://127.0.0.1:${port}/doc`,
  ]
  let ready = false
  let lastErr
  for (const url of healthUrls) {
    try {
      await waitFor(url, { get aborted() { return aborted.current } })
      ready = true
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!ready) {
    throw new Error(`OpenCode did not become ready\n${dump(String(lastErr || ""))}`)
  }

  // Give the plugin loader a moment after the HTTP server is up.
  await new Promise((r) => setTimeout(r, 1500))

  const blob = [logs.stdout, logs.stderr].join("\n")
  const fileLogs = []
  for (const file of collectTreeLogs(xdgData)) {
    fileLogs.push(await readFile(file, "utf8"))
  }
  const all = [blob, ...fileLogs].join("\n")

  const loadError = all.match(/failed to load plugin[\s\S]{0,400}/i)
  if (loadError) {
    throw new Error(`plugin failed to load:\n${loadError[0]}\n${dump()}`)
  }
  if (/must default export an object with server\(\)/.test(all)) {
    throw new Error(`loader rejected the plugin export\n${dump()}`)
  }

  const loaded =
    /opencode-webhook:/.test(all) ||
    /webhook-notify\.js/.test(all) ||
    /opencode-webhook/.test(all)
  if (!loaded) {
    console.warn("warning: did not see an explicit plugin log line; HTTP server came up with no loader error")
  } else {
    console.log("ok  - plugin log line present")
  }

  console.log("ok  - opencode serve started without 'failed to load plugin'")

  // Cheap session probe. Creating a session does not need a model.
  // Prompting without a provider may error; either outcome is fine.
  try {
    const created = await fetch(`http://127.0.0.1:${port}/session?directory=${encodeURIComponent(workspace)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "smoke" }),
      signal: AbortSignal.timeout(5000),
    })
    const text = await created.text()
    console.log(`ok  - POST /session -> ${created.status}`)
    let id
    try {
      id = JSON.parse(text)?.id || JSON.parse(text)?.data?.id
    } catch {
      id = null
    }
    if (id) {
      await fetch(`http://127.0.0.1:${port}/session/${id}/prompt_async?directory=${encodeURIComponent(workspace)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "Reply with pong. Do not run tools." }] }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {})
      await new Promise((r) => setTimeout(r, 2000))
      if (col.posts.length) console.log(`ok  - webhook fired (${col.posts.length})`)
      else console.log("ok  - session created; webhook not required without a model")
    }
  } catch (err) {
    console.log(`ok  - session probe skipped (${err?.name || "error"})`)
  }
} finally {
  if (child.exitCode == null && !child.killed) {
    child.kill("SIGTERM")
    await new Promise((r) => setTimeout(r, 500))
    if (child.exitCode == null) child.kill("SIGKILL")
  }
  await col.close().catch(() => {})
}

console.log("smoke passed")
