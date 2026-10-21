# pi-star-office-reporter

A [Pi](https://pi.dev) **extension** that reports your coding agent's activity to a
[Star Office UI](https://github.com/ringhyacinth/Star-Office-UI) dashboard as it happens.
One file, zero dependencies, standard library only. Pi keeps working — the office feed
lights up with sessions, tool calls, file edits, commands run and completions.

It hooks Pi's extension API (not a wrapper script), so everything the model does through
Pi's tools is captured, including work done inside a headless run
(`pi -p --mode json …`).

## What it reports

Every event is one
[ADR-035 schema-v1 envelope](https://github.com/gulasz101/star-office-ui-fork/blob/master/README.en.md#the-event-envelope-schema-v1)
`POST`ed to the dashboard's `/events` endpoint:

| `event_type`      | when                                            | `payload` fields                                   |
|-------------------|-------------------------------------------------|----------------------------------------------------|
| `session_start`   | a Pi session starts (startup/reload/new/resume/fork) | `cwd` (basename), `source` (mode), `reason`, `model`, `engine` |
| `tool_call`       | every tool execution, success **or** error      | `tool`, `status`, `duration_ms`, `error` (on failure) |
| `file_edit`       | write/edit/patch-class tools                    | `tool`, `file` (basename), `status`, `duration_ms` |
| `command_run`     | bash/shell-class tools                          | `command`, `cwd` (basename), `status`, `exit_code`, `duration_ms` |
| `code_completion` | a run settled after editing files               | `status`, `kind`, `duration_ms`                    |
| `background_start`| a nested tool call started (a sub-task of another tool) | `tool`, `task_id` (parent call id)         |
| `background_end`  | … and finished                                  | `tool`, `task_id`, `status`, `duration_ms`         |
| `session_end`     | session shutdown: quit, SIGTERM/SIGHUP, /new, /resume, fork | `reason`, `status`                     |

Payloads are **labels, not content**: basenames instead of paths, a command string (the
dashboard's ingester reduces it to `program + one allow-listed subcommand`), no prompts, no
tool output, no session ids. The dashboard decides pixel positions and toasts; this reporter
just keeps the event stream honest.

The keys above are what the reporter sends. A Star Office UI dashboard stores only its own
allow-list (`backend/sanitize.py`): `session_start` keeps `cwd`/`source`, `session_end` keeps
`reason`, and the work types keep `tool`, `status`, `duration_ms`, `exit_code`, `command`,
`file` / `cwd` (basenames), `label` and `task_id`. Everything else in those payloads
(`model`, `engine`, `error`, `parent id` keys) is a label the dashboard drops, not a leak —
the reporter sends them so a different consumer can still make sense of the stream.

Pi has no separate background-task concept, so `background_start`/`background_end` map the
one thing that is a sub-task in Pi: a **nested tool call** (`parentToolCallId`, e.g. a
`codemode` script calling another tool).

## Install

**Requires:** Pi ≥ 1.3 and a reachable Star Office UI dashboard (default
`http://127.0.0.1:19000`).

Pi loads every direct `.js`/`.ts` file under the agent directory's `extensions/`
(`~/.pi/agent/extensions/` unless `PI_CODING_AGENT_DIR` says otherwise).

```bash
mkdir -p ~/.pi/agent/extensions
cp pi-star-office-reporter.js ~/.pi/agent/extensions/
# or keep the checkout as the source of truth:
# ln -sfn "$PWD/pi-star-office-reporter.js" ~/.pi/agent/extensions/pi-star-office-reporter.js
```

The token goes in a **file**, never in the extension or a shell history:

```bash
mkdir -p ~/.config/sou && chmod 700 ~/.config/sou
# the dashboard's tokens.py prints the token once; pipe it straight into the file:
kubectl -n star-office exec deploy/sou-ingest -- \
  python backend/tokens.py register pi --room mystery --hoodie 320,0.75,0.9 --token-only \
  > ~/.config/sou/pi.token
chmod 600 ~/.config/sou/pi.token
```

The reporter reads `~/.config/sou/<agent>.token` by default (`pi` → `~/.config/sou/pi.token`).
No rebuild, no restart of anything else: Pi loads extensions at startup.

## Configure

All configuration is optional. **Environment variables override the config file, which
overrides the defaults.**

| Setting            | Env var                | Config-file key | Default                          |
|--------------------|------------------------|-----------------|----------------------------------|
| Dashboard URL      | `SOU_DASHBOARD_URL`    | `dashboardUrl`  | `http://127.0.0.1:19000`         |
| Agent name         | `SOU_AGENT_NAME`       | `agent`         | `pi`                             |
| Ingest token       | `SOU_TOKEN`            | `token`         | `~/.config/sou/<agent>.token`    |
| Token file path    | `SOU_TOKEN_FILE`       | `tokenFile`     | —                                |
| Reporter on/off    | `SOU_REPORTER_ENABLED` | `enabled`       | `true` (`0/false/no/off` disables) |
| Request timeout    | `SOU_TIMEOUT_MS`       | `timeoutMs`     | `5000` (clamped to 200…30000)    |
| Debug log to file  | `SOU_DEBUG`            | `debug`         | `false`                          |
| Config file path   | `SOU_REPORTER_CONFIG`  | —               | first of the locations below     |

Config files are read from the first of:

1. `$SOU_REPORTER_CONFIG`
2. `$XDG_CONFIG_HOME/sou/reporter.json` (or `~/.config/sou/reporter.json`)
3. `~/.pi/agent/sou-reporter.json`
4. `~/.config/star-office-reporter.json`

A typical `~/.config/sou/reporter.json`:

```json
{
  "dashboardUrl": "http://192.168.1.179:30260"
}
```

With `debug: true` (or `SOU_DEBUG=1`) every reporter line is also appended to
`~/.local/state/sou-reporter/<agent>.log` — useful when the host swallows stderr.

## Privacy

- The token is read from a file, sent only as `Authorization: Bearer …`, and **never**
  appears in a payload, a log line or an error message: every occurrence of the resolved
  token value is scrubbed from payloads even when it appears bare (no `Bearer`, no
  secret-named key).
- Secret-shaped values are redacted before anything leaves the process: bearer/basic
  credentials, `sk-…`/`rk-…`/`pk-…` keys, GitHub tokens (`ghp_`, `github_pat_`), AWS
  `AKIA…`, Slack `xox…`, JWTs, and any `key: value`/`key=value` pair whose key looks
  secret-named.
- Free text is truncated (4000 chars per field) and the whole payload is kept under the
  dashboard's 65536-byte cap, so `POST /events` never 400s on size.
- Paths are reduced to basenames; prompts, tool output and session ids are never sent.
- The dashboard additionally enforces its own allow-list (`backend/sanitize.py`), so a
  subscribed reporter cannot widen what is stored.

## Failure behaviour

The reporter can never cost you a run:

- every hook is wrapped — a reporter bug cannot throw into Pi (a throwing `tool_call`
  handler would block the tool);
- POSTs are fire-and-forget with an abort timeout; tool and session hooks never await the
  network. Only `session_shutdown` waits, on a 1.2 s deadline, so a dashboard that accepts
  the socket and never answers cannot hold the process open;
- an unreachable dashboard, a wrong URL or a rejected token costs **one** stderr line per
  run (`further failures this run are counted, not logged`), and the run finishes normally;
- no token configured → the reporter disables itself with one explaining line and sends
  nothing.

## Tests

```bash
npm test    # node --test test/reporter.test.mjs test/adapter.test.mjs
```

No network, no Pi: the adapter tests drive the extension through a mock `pi` object and a
mock `fetch`, and assert the emitted event stream, the privacy pass on the real payload
path, and the failure modes.

## Licence

MIT. See [LICENSE](LICENSE).
