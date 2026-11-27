# opencode-webhook

Get pinged when an [OpenCode](https://opencode.ai) agent finishes — or
fails, gets blocked, hits model/API errors, or stalls.

Any bot or service can hand off a coding task over OpenCode's HTTP API.
This plugin, running inside your OpenCode server, POSTs a small JSON
webhook when that session finishes, errors, is waiting on a permission
or question prompt nobody can answer, or goes quiet while still busy —
so the caller always hears back without polling.

It is one JavaScript file. It runs under Node and Bun, and it is written
so a plugin error cannot take OpenCode down.

## Install

**1. Copy the plugin file**

User-wide (applies to every project):

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/araysuter/opencode-webhook/main/webhook-notify.js \
  -o ~/.config/opencode/plugins/webhook-notify.js
```

Or only for one project, so you can commit it with the repo:

```bash
mkdir -p .opencode/plugins
curl -fsSL https://raw.githubusercontent.com/araysuter/opencode-webhook/main/webhook-notify.js \
  -o .opencode/plugins/webhook-notify.js
```

You can also copy `webhook-notify.js` from this repo by hand.

**2. Set the webhook URL**

Set this in the **same process** that starts OpenCode (`opencode serve`,
`opencode web`, or a systemd / tmux / launchd session):

```bash
export OPENCODE_NOTIFY_WEBHOOK_URL="https://example.com/your-webhook"
```

Optional:

```bash
# Sent as: Authorization: Bearer <secret>
export OPENCODE_NOTIFY_SECRET="your-shared-secret"

# Only notify sessions whose title starts with this prefix.
# Unset = notify every finished session.
export OPENCODE_NOTIFY_TITLE_PREFIX="MyBot: "

# Which events to post. Comma-separated.
# Groups: idle, error, interrupted, blocked, retrying, stalled, tool_error
# Default: everything except tool_error (agents recover from most tool errors).
# Or full names: session.idle, session.error, permission.asked, ...
export OPENCODE_NOTIFY_EVENTS="idle,error,blocked,stalled"

# Send one "stalled" ping if a session stays busy with no activity this
# many minutes (resets on any activity). Default 10. 0 turns it off.
export OPENCODE_NOTIFY_STALL_MINUTES=10

# Verbose logs, prefixed with "opencode-webhook:". Never logs the secret
# or the URL query string.
export OPENCODE_NOTIFY_DEBUG=1
```

**3. Restart OpenCode**

Restart the OpenCode server or web UI so it picks up the plugin and the
environment variables. Then send a test task and watch your webhook
receive a POST.

After updating the file, re-run the `curl` command and restart OpenCode
again.

## Send a task over the API

OpenCode's server publishes an OpenAPI spec at `/doc`. These two calls
are enough to start a task and return immediately.

Use your own host, password, and project directory. The examples below
talk to a local `opencode serve` on port 4096.

**Create a session**

```bash
curl -sS -u 'opencode:YOUR_PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix the login bug"}' \
  'http://127.0.0.1:4096/session?directory=/path/to/your/repo'
```

The response includes an `id`. Use that as `SESSION_ID` below.

**Send the prompt (fire and forget)**

```bash
curl -sS -u 'opencode:YOUR_PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Fix the login bug. Open a PR when you are done."}]}' \
  'http://127.0.0.1:4096/session/SESSION_ID/prompt_async'
```

`prompt_async` returns **204 No Content** right away. The agent keeps
working in the background. When it finishes, the plugin POSTs your webhook.

The default HTTP basic-auth username is `opencode`. The password is the
one you set with `OPENCODE_SERVER_PASSWORD` when you started the server.

## Webhook payload

```json
{
  "event": "session.idle",
  "status": "idle",
  "kind": "finished",
  "sessionID": "ses_example",
  "title": "Fix the login bug",
  "directory": "/path/to/your/repo",
  "snippet": "Opened a pull request with the login fix.",
  "timestamp": "2026-11-27T17:00:00.000Z",
  "eventID": "evt_example",
  "error": null,
  "detail": null
}
```

Switch on `kind`:

| `kind` | `status` | When | `detail` |
| --- | --- | --- | --- |
| `finished` | `idle` | Session went idle (`session.idle`) | `null` |
| `error` | `error` | `session.error` (not an abort) | `null`; see `error` |
| `aborted` | `error` | `session.error` with `MessageAbortedError` | `null`; see `error` |
| `interrupted` | `interrupted` | v2 `session.execution.interrupted` | `null` |
| `blocked` | `blocked` | `permission.asked` or `question.asked` — the session is waiting for an answer | `{ reason: "permission" \| "question", requestID, permission, patterns, command }` or `{ reason, requestID, question }` |
| `retrying` | `retrying` | First `session.status` of type `retry`: a model/API call failed and OpenCode is retrying (e.g. the model server is out of memory or down). Once per retry streak; re-arms after real progress. | `{ attempt, message, nextRetryAt }` |
| `stalled` | `stalled` | Busy with no message/tool/permission activity for `OPENCODE_NOTIFY_STALL_MINUTES` | `{ minutesSinceActivity, lastActivity }` |
| `tool_error` | `tool_error` | A tool call errored (opt-in group) | `{ tool, error }` |

`status` keeps the old values (`idle`, `error`, `interrupted`) so older
receivers keep working; new kinds use `status` = `kind`.

Each problem is sent once: one `blocked` per permission request, one
`stalled` per quiet stretch (it re-arms after new activity), one
`tool_error` per tool call. A session blocked on a prompt does not also
get a `stalled` ping.

A `blocked` ping means OpenCode is waiting for a reply. Answer it with
`POST /permission/<requestID>/reply` and `{"reply":"once"|"always"|"reject"}`,
or avoid it entirely for headless use by allowing what your agents need
in `opencode.json`, for example:

```json
"permission": { "external_directory": "allow", "doom_loop": "deny" }
```

`status` is `idle` when the session finished, `error` when it failed, or
`interrupted` if a v2 run was stopped. `snippet` is a short excerpt of
the last assistant message (truncated if it is long). `error` is filled
in on failure.

On OpenCode 2, the `event` field may be `session.execution.succeeded`
(or `failed` / `interrupted`) instead of `session.idle`. The rest of the
payload is the same. The plugin treats `session.idle` and
`session.execution.succeeded` as the same turn, so you get one POST, not two.

If you set `OPENCODE_NOTIFY_SECRET`, the request includes
`Authorization: Bearer <secret>`. Check that header before you trust the body.

The plugin times out after about 10 seconds and retries a couple of times
on network errors or 5xx responses. It does not retry 4xx responses.

## Test with a webhook inspector

To see a payload without writing a server, create a free URL at
[webhook.site](https://webhook.site) (or any similar inspector). Set
`OPENCODE_NOTIFY_WEBHOOK_URL` to that URL, restart OpenCode, send a small
prompt (`Reply with: pong. Don't run tools.`), and refresh the inspector.
You should see one POST when the session finishes.

If `OPENCODE_NOTIFY_WEBHOOK_URL` is missing or not a valid `http(s)` URL,
the plugin stays loaded, does nothing, and logs one warning starting with
`opencode-webhook:`.

## Troubleshooting

**The plugin never fires**

1. Search OpenCode's log for `failed to load plugin` or `opencode-webhook`.
   On Linux the log is usually:

   ```bash
   grep -i "failed to load plugin\|opencode-webhook" ~/.local/share/opencode/log/opencode.log | tail
   ```

   On macOS look under `~/.local/share/opencode/log/` or
   `~/Library/Application Support/opencode/log/`. On Windows, under
   `%USERPROFILE%\.local\share\opencode\log\`.

2. If you see `must default export an object with server()`, you have an
   old copy of this file (the original `{ id, setup }` export). Re-download
   it from this repo and restart OpenCode.

3. Confirm the environment variables reached the OpenCode process, not
   just your interactive shell:

   - **tmux:** a new session does not inherit variables from your current
     shell. Pass them on the command that starts OpenCode:

     ```bash
     tmux new -d -s opencode "OPENCODE_NOTIFY_WEBHOOK_URL=$OPENCODE_NOTIFY_WEBHOOK_URL OPENCODE_NOTIFY_SECRET=$OPENCODE_NOTIFY_SECRET opencode web --port 4096"
     ```

   - **systemd:** set `Environment=` or `EnvironmentFile=` on the service
     unit, then `systemctl daemon-reload && systemctl restart …`.

   - **launchd:** add an `EnvironmentVariables` dictionary to the plist
     and reload the job.

4. Point `OPENCODE_NOTIFY_WEBHOOK_URL` at a webhook inspector (above) and
   send a short test prompt. If the inspector stays empty but OpenCode
   itself finished the task, the log line from step 1 is the next place
   to look. Set `OPENCODE_NOTIFY_DEBUG=1` and restart for more detail.
   The debug logs never include the secret or the URL query string.

## Compatibility

Tested against **OpenCode 1.19.6** (`opencode-ai@1.19.6`). That release
loads path plugins as `export default { id, server }`
([`readV1Plugin()`](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/plugin/shared.ts),
[`applyPlugin()`](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/plugin/index.ts))
and delivers bus events through the `event` hook as
`{ event: { id, type, properties } }`, where `properties` is the bus
payload (`event.data` mapped in `plugin/index.ts`). Types:
[@opencode-ai/plugin@1.19.6](https://cdn.jsdelivr.net/npm/@opencode-ai/plugin@1.19.6/dist/index.d.ts).

`server(input, options)` receives
`{ client, project, directory, worktree, $ }` and must return a hooks
object. Path plugins must also export `id`.

The same file also:

- Exports `server` / `DoneWebhook` / `Plugin` as the same function, for
  older loaders that look for a plugin function instead of `server()`.
- Puts `setup` on the default export (an alias of `server`) for OpenCode 2
  loaders that look for `{ id, setup }`.
- Accepts both the `properties` event shape (1.19) and the `data` shape
  used by v2 `session.execution.*` events.
- Handles v2 `session.execution.succeeded` / `failed` / `interrupted`
  in addition to `session.idle` and `session.error`.

It uses standard `fetch`, `AbortController`, and ES modules, so it runs
under current Node.js and Bun.

## Optional: listen from another computer

If you cannot install a plugin on the machine that runs OpenCode, a
client can subscribe to the same events with a long-lived SSE request:

```bash
curl -N -u 'opencode:YOUR_PASSWORD' \
  'http://127.0.0.1:4096/event'
```

Watch for `session.idle`, `session.error`, or `permission.asked` (and, on OpenCode 2,
`session.execution.succeeded` / `failed` / `interrupted`). The plugin is
the simpler path: it lives next to the server and POSTs your URL for you.

## License

MIT
