# opencode-webhook

Get pinged when an [OpenCode](https://opencode.ai) agent finishes.

Any bot or service can hand off a coding task over OpenCode's HTTP API.
This plugin, running inside your OpenCode server, POSTs a small JSON
webhook when that session goes idle or errors — so the caller can hear
back without polling.

## Install

**1. Copy the plugin file**

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/araysuter/opencode-webhook/main/webhook-notify.js \
  -o ~/.config/opencode/plugins/webhook-notify.js
```

Or copy `webhook-notify.js` from this repo into `~/.config/opencode/plugins/` yourself. OpenCode also loads project plugins from `.opencode/plugins/`.

**2. Set the webhook URL**

Set this in the same environment that starts OpenCode (`opencode serve`, `opencode web`, or a systemd/tmux session):

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
```

**3. Restart OpenCode**

Restart the OpenCode server or web UI so it picks up the plugin and the environment variables. Then send a test task and watch your webhook receive a POST.

## Send a task over the API

OpenCode's server publishes an OpenAPI spec at `/doc`. These two calls are enough to start a task and return immediately.

Use your own host, password, and project directory. If you reach the server over [Tailscale](https://tailscale.com), the host looks like `your-pc.your-tailnet.ts.net`.

**Create a session**

```bash
curl -sS -u 'opencode:YOUR_PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Fix the login bug"}' \
  'https://your-pc.your-tailnet.ts.net:8443/session?directory=/path/to/your/repo'
```

The response includes an `id` like `ses_...`. Use that as `SESSION_ID` below.

**Send the prompt (fire and forget)**

```bash
curl -sS -u 'opencode:YOUR_PASSWORD' \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"Fix the login bug. Open a PR when you are done."}]}' \
  'https://your-pc.your-tailnet.ts.net:8443/session/SESSION_ID/prompt_async'
```

`prompt_async` returns **204 No Content** right away. The agent keeps working in the background. When it finishes, the plugin POSTs your webhook.

The default HTTP basic-auth username is `opencode`. The password is the one you set with `OPENCODE_SERVER_PASSWORD` when you started the server.

## Webhook payload

```json
{
  "event": "session.idle",
  "eventID": "evt_...",
  "sessionID": "ses_...",
  "title": "Fix the login bug",
  "directory": "/path/to/your/repo",
  "status": "idle",
  "snippet": "Opened a pull request with the login fix.",
  "error": null
}
```

`status` is `idle` when the session finished, `error` when it failed, or `interrupted` if a v2 run was stopped. `snippet` is a short excerpt of the last assistant message. `error` is filled in on failure.

On OpenCode 2, the `event` field may be `session.execution.succeeded` (or `failed` / `interrupted`) instead of `session.idle`. The rest of the payload is the same.

If you set `OPENCODE_NOTIFY_SECRET`, the request includes `Authorization: Bearer <secret>`. Check that header before you trust the body.

## Test with a webhook inspector

To see a payload without writing a server, create a free URL at [webhook.site](https://webhook.site) (or any similar inspector). Set `OPENCODE_NOTIFY_WEBHOOK_URL` to that URL, restart OpenCode, send a small prompt (`Reply with: pong. Don't run tools.`), and refresh the inspector. You should see one POST when the session finishes.

## Optional: listen from another computer

If you cannot install a plugin on the machine that runs OpenCode, a client can subscribe to the same events with a long-lived SSE request:

```bash
curl -N -u 'opencode:YOUR_PASSWORD' \
  'https://your-pc.your-tailnet.ts.net:8443/event'
```

Watch for `session.idle` or `session.error` (and, on OpenCode 2, `session.execution.succeeded` / `failed` / `interrupted`). The plugin is the simpler path: it lives next to the server and POSTs your URL for you.

## License

MIT
