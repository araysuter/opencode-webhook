# Changelog

## 1.3.1 — 2026-11-27

- Running tools no longer trip the 10-minute stall watchdog. While a
  tool part is in state `running`, the plugin waits for the command's
  `timeout N` prefix or the tool's timeout arg, plus 5 minutes. If
  neither can be parsed, it falls back to
  `OPENCODE_NOTIFY_RUNNING_TOOL_STALL_MINUTES` (default 60). A bad or
  zero cap still falls back to 60, so a hang is never silenced. The
  stalled payload includes the tool name and how many minutes it had
  been running. Sessions with no running tool keep the 10-minute
  behavior. Dedupe is unchanged.


## 1.3.0 — 2026-11-27

- `retrying`: ping on the first `session.status` of type `retry` (model or
  API call failed, OpenCode retrying silently), with `attempt`, `message`,
  and `nextRetryAt`. Once per retry streak; re-arms after real progress.

## 1.2.0 — 2026-11-27

- New `kind` field: `finished`, `error`, `aborted`, `interrupted`,
  `blocked`, `stalled`, `tool_error`. `status` keeps its old values for
  idle/error/interrupted, so existing receivers keep working.
- `blocked`: ping on `permission.asked` and `question.asked` (event
  names checked against OpenCode 1.19.6). Headless sessions used to sit
  "busy" forever on a prompt nobody could see. `detail` carries the
  request ID, permission, patterns, and command so the receiver can reply.
- `stalled`: watchdog pings once if a session stays busy with no
  activity for `OPENCODE_NOTIFY_STALL_MINUTES` (default 10, 0 = off).
  Re-arms on activity. Skipped while a session is already blocked.
- `tool_error` (opt-in group): ping when a tool call errors.
- New `detail` field (null when not used). Dedupe per permission request,
  per quiet stretch, and per tool call.

## 1.1.1 — 2026-11-27

- Match the OpenCode 1.19.6 plugin loader exactly: path plugins must
  default-export `{ id, server }`. `server(input, options)` returns a
  Hooks object. The original `{ id, setup }` default is what produced
  `failed to load plugin` / `must default export an object with server()`.
  Cited from
  [shared.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/plugin/shared.ts)
  and
  [index.ts](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/plugin/index.ts).
- Keep named function exports (`server`, `DoneWebhook`, `Plugin`) as the
  same function so older loaders that scan exports still see a plugin
  function, without extra non-plugin named exports that would trip
  `getLegacyPlugins()`.
- Alias `setup` on the default export for OpenCode 2 loaders.
- Never throw out of `server()` or the event hook. If
  `OPENCODE_NOTIFY_WEBHOOK_URL` is missing or invalid, log one warning
  and stay loaded as a no-op.
- POST with a 10s timeout, and retry a couple of times with backoff on
  network errors or 5xx responses. Do not retry 4xx.
- Dedupe idle/error per session turn (including `session.idle` vs
  `session.execution.succeeded`).
- Handle both `properties` (1.19.6 maps bus `data` → `properties`) and
  the v2 `data` event shape.
- Payload includes `event`, `status`, `sessionID`, `title`, `directory`,
  truncated last assistant snippet, and `timestamp`. Session extras are
  fetched through the provided `client` and fail soft.
- Logs use the `opencode-webhook:` prefix and never include the secret
  or the URL query string.
- README troubleshooting (logs, tmux / systemd / launchd, webhook
  inspector), compatibility notes with source links, and project-level
  `.opencode/plugins/` install. Examples use localhost, not personal hosts.
- GitHub Actions CI runs unit tests on Node.js and Bun, plus an OpenCode
  CLI load smoke test against 1.19.6 and latest.

## 1.1.0 — 2026-11-27

- First attempt at the 1.19+ `{ id, server }` export, hardening, tests,
  and docs.

## 1.0.0 — 2026-11-27

- Initial plugin, README, MIT license, and tests. Default export was
  `{ id, setup }`, which OpenCode 1.19.6 refuses to load.
