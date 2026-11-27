# Changelog

## 1.1.0 — 2026-11-27

- Fix the plugin export for OpenCode 1.19+: default-export
  `{ id, server }` so the official loader no longer reports
  `must default export an object with server()`.
- Keep named function exports (`server`, `DoneWebhook`, `Plugin`) for
  older loaders.
- Never throw out of `server()` or the event hook. If
  `OPENCODE_NOTIFY_WEBHOOK_URL` is missing or invalid, log one warning
  and stay loaded as a no-op.
- POST with a 10s timeout, and retry a couple of times with backoff on
  network errors or 5xx responses. Do not retry 4xx.
- Dedupe `session.idle` and `session.execution.succeeded` for the same
  session turn so a mixed 1.19 / v2 bus does not double-post.
- Handle both `properties` and `data` event shapes, and truncate long
  snippets.
- Optional env: `OPENCODE_NOTIFY_EVENTS`, `OPENCODE_NOTIFY_DEBUG`,
  `OPENCODE_NOTIFY_AUTH_SCHEME`.
- Logs use the `opencode-webhook:` prefix and never include the secret
  or the URL query string.
- README troubleshooting (logs, tmux / systemd / launchd, webhook
  inspector), compatibility notes, and project-level
  `.opencode/plugins/` install.
- GitHub Actions CI runs the tests on Node.js and Bun.

## 1.0.0 — 2026-11-27

- Initial plugin, README, MIT license, and tests.
