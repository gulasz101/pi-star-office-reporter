// pi-star-office-reporter — Pi extension that reports agent activity to a
// Star Office UI dashboard (ADR-035 event schema v1).
//
// One self-contained ESM file, no runtime dependencies, no Pi imports: Pi loads
// direct .js files from <agent-dir>/extensions/ (default ~/.pi/agent/extensions),
// so the same file is unit-testable with `node --test`.
//
//   Hook layer (adapter):  pi.on("session_start" | "tool_execution_start" |
//                          "tool_execution_end" | "agent_settled" |
//                          "session_shutdown")  ->  the event types below.
//   Pure layer (core):     loadConfig / resolveToken / buildEnvelope /
//                          redactPayload / classifyTool / createReporter
//                          -> exported for tests.
//
// Event types reported:
//   session_start      a Pi session starts (startup/reload/new/resume/fork)
//   tool_call          every tool execution, after it finishes
//   file_edit          write/edit/patch-class tools
//   command_run        bash/shell-class tools, command + exit code
//   code_completion    a run settled after editing files
//   background_start   a nested tool call (a sub-task of another tool) started
//   background_end     ... and finished
//   session_end        session shutdown (quit, SIGTERM/SIGHUP, /new, /resume, fork)
//
// Configuration, precedence env > config file > defaults:
//   SOU_DASHBOARD_URL   default http://127.0.0.1:19000
//   SOU_AGENT_NAME      default pi
//   SOU_TOKEN           ingest token (else SOU_TOKEN_FILE, else ~/.config/sou/<agent>.token)
//   SOU_REPORTER_ENABLED 0/false/no/off disables every POST
//   SOU_TIMEOUT_MS      default 5000, clamped to [200, 30000]
//   SOU_REPORTER_CONFIG path to a JSON config file
//   SOU_DEBUG=1         also append reporter log lines to a file
//
// Privacy: secret-shaped values, secret-named keys and the resolved token are
// redacted, long strings truncated, and the payload kept under the dashboard's
// 65536-byte cap.
// Non-blocking: tool and session hooks never await the network. Only
// `session_shutdown` waits, and only for SHUTDOWN_BUDGET_MS, so a hung
// dashboard cannot delay exit. No failure — bad config, missing token,
// unreachable dashboard — can throw into Pi or stop a run.

import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const EXTENSION_ID = "pi-star-office-reporter";
export const VERSION = "1.0.0";

export const DEFAULTS = {
  dashboardUrl: "http://127.0.0.1:19000",
  agent: "pi",
  timeoutMs: 5000,
  enabled: true,
  minTimeoutMs: 200,
  maxTimeoutMs: 30000,
  maxFieldChars: 4000,
  maxPayloadBytes: 65536, // backend/event_schema.py PAYLOAD_MAX_BYTES
};

const OFF_WORDS = new Set(["0", "false", "no", "off"]);

const isOff = (value) => OFF_WORDS.has(String(value).trim().toLowerCase());

// --- configuration ----------------------------------------------------------

function parseTimeoutMs(raw, fallback) {
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < DEFAULTS.minTimeoutMs) return fallback;
  return Math.min(n, DEFAULTS.maxTimeoutMs);
}

/** Pi's agent directory: PI_CODING_AGENT_DIR, else ~/.pi/agent (Pi's own default). */
export function agentDir(env = process.env) {
  const configured = typeof env.PI_CODING_AGENT_DIR === "string" ? env.PI_CODING_AGENT_DIR.trim() : "";
  if (configured) return configured;
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  return path.join(home, ".pi", "agent");
}

function configFileCandidates(env) {
  const out = [];
  if (env.SOU_REPORTER_CONFIG) out.push(env.SOU_REPORTER_CONFIG);
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  if (env.XDG_CONFIG_HOME) out.push(path.join(env.XDG_CONFIG_HOME, "sou", "reporter.json"));
  out.push(path.join(home, ".config", "sou", "reporter.json"));
  out.push(path.join(agentDir(env), "sou-reporter.json"));
  out.push(path.join(home, ".config", "star-office-reporter.json"));
  return out;
}

function tokenFileCandidates(env, agent) {
  const out = [];
  if (env.SOU_TOKEN_FILE) out.push(env.SOU_TOKEN_FILE);
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  out.push(path.join(xdg, "sou", `${agent}.token`));
  out.push(path.join(xdg, "sou", "token"));
  return out;
}

function normalizeLayer(obj) {
  const layer = {};
  if (typeof obj.dashboardUrl === "string" && obj.dashboardUrl.trim()) {
    layer.dashboardUrl = obj.dashboardUrl.trim().replace(/\/+$/, "");
  }
  if (typeof obj.agent === "string" && obj.agent.trim()) layer.agent = obj.agent.trim();
  if (obj.enabled !== undefined) {
    layer.enabled = typeof obj.enabled === "boolean" ? obj.enabled : !isOff(obj.enabled);
  }
  if (obj.debug !== undefined) {
    layer.debug = typeof obj.debug === "boolean" ? obj.debug : !isOff(obj.debug);
  }
  if (obj.timeoutMs !== undefined) {
    const n = Number.parseInt(String(obj.timeoutMs), 10);
    layer.timeoutMs = Number.isFinite(n) ? n : undefined;
  }
  if (typeof obj.token === "string" && obj.token.trim()) layer.token = obj.token.trim();
  if (typeof obj.tokenFile === "string" && obj.tokenFile.trim()) layer.tokenFile = obj.tokenFile.trim();
  return layer;
}

function safeReadFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Load reporter configuration. `env` defaults to process.env; `opts.readFile`
 * and `opts.configPath` are injectable for tests.
 * Precedence: env vars > JSON config file > defaults.
 */
export function loadConfig(env = process.env, opts = {}) {
  const readFile = opts.readFile ?? safeReadFile;
  let merged = {
    dashboardUrl: DEFAULTS.dashboardUrl,
    agent: DEFAULTS.agent,
    timeoutMs: DEFAULTS.timeoutMs,
    enabled: DEFAULTS.enabled,
    debug: false,
  };

  const candidates = opts.configPath ? [opts.configPath] : configFileCandidates(env);
  for (const file of candidates) {
    const text = readFile(file);
    if (text == null) continue;
    try {
      Object.assign(merged, normalizeLayer(JSON.parse(text)));
    } catch {
      // Malformed config file: ignore it. The reporter must not fight the host.
    }
    break;
  }

  const envLayer = normalizeLayer({
    dashboardUrl: env.SOU_DASHBOARD_URL,
    agent: env.SOU_AGENT_NAME,
    timeoutMs: env.SOU_TIMEOUT_MS,
    enabled: env.SOU_REPORTER_ENABLED === undefined ? undefined : !isOff(env.SOU_REPORTER_ENABLED),
    debug: env.SOU_DEBUG === undefined ? undefined : !isOff(env.SOU_DEBUG),
    token: env.SOU_TOKEN,
    tokenFile: env.SOU_TOKEN_FILE,
  });
  Object.assign(merged, envLayer);

  const agent = merged.agent || DEFAULTS.agent;
  const stateHome = env.XDG_STATE_HOME || path.join(env.HOME || homedir(), ".local", "state");
  const dashboardUrl = String(merged.dashboardUrl || DEFAULTS.dashboardUrl).trim().replace(/\/+$/, "");
  return {
    dashboardUrl,
    eventsUrl: `${dashboardUrl}/events`,
    agent,
    enabled: merged.enabled !== false,
    debug: merged.debug === true,
    debugLogFile: env.SOU_REPORTER_LOG || path.join(stateHome, "sou-reporter", `${agent}.log`),
    timeoutMs: parseTimeoutMs(merged.timeoutMs, DEFAULTS.timeoutMs),
    token: merged.token,
    tokenFile: merged.tokenFile,
    tokenCandidates: tokenFileCandidates(env, agent),
    maxFieldChars: DEFAULTS.maxFieldChars,
    maxPayloadBytes: DEFAULTS.maxPayloadBytes,
    minTimeoutMs: DEFAULTS.minTimeoutMs,
    maxTimeoutMs: DEFAULTS.maxTimeoutMs,
  };
}

/**
 * Resolve the ingest token: SOU_TOKEN, then a configured token file, then the
 * standard locations. The token is read from disk, never logged, and never
 * included in a payload.
 */
export function resolveToken(config, opts = {}) {
  const readFile = opts.readFile ?? safeReadFile;
  if (config.token) return { token: String(config.token).trim(), source: "env" };
  const files = [];
  if (config.tokenFile) files.push(config.tokenFile);
  for (const file of config.tokenCandidates || []) files.push(file);
  for (const file of files) {
    const text = readFile(file);
    if (text == null) continue;
    const token = String(text).trim();
    if (token) return { token, source: `file:${file}` };
  }
  return { token: null, source: null };
}

// --- privacy ----------------------------------------------------------------

const SECRET_VALUE_PATTERNS = [
  [/\b(bearer|basic)\s+[A-Za-z0-9\-._~+/=]{4,}\b/gi, "$1 [redacted]"],
  [/\b(?:sk|rk|pk|key)-[A-Za-z0-9_\-]{12,}\b/g, "[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{12,}\b/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, "[redacted]"],
  // key: value / key=value with a secret-named key
  [
    /((?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|passwd|credential|authorization|auth[_-]?key)[\w-]*\s*[=:]\s*)(?:"[^"]{1,}"|'[^']{1,}'|(?!\[redacted\])[^\s;,']{4,})/gi,
    "$1[redacted]",
  ],
];

const SECRET_KEY_NAME =
  /(api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|credential|authorization|auth[_-]?key|private[_-]?key|cookie)/i;

function scrubString(str, maxFieldChars) {
  let out = str;
  if (out.length > maxFieldChars) {
    out = `${out.slice(0, maxFieldChars)}…[truncated ${out.length - maxFieldChars} chars]`;
  }
  for (const [re, repl] of SECRET_VALUE_PATTERNS) out = out.replace(re, repl);
  return out;
}

function redactWalk(node, maxFieldChars, depth) {
  if (node === null || node === undefined) return node;
  if (typeof node === "string") return scrubString(node, maxFieldChars);
  if (typeof node === "number" || typeof node === "boolean") return node;
  if (depth > 8) return "[depth-limited]";
  if (Array.isArray(node)) {
    return node.slice(0, 200).map((item) => redactWalk(item, maxFieldChars, depth + 1));
  }
  if (typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node).slice(0, 200)) {
      out[key] = SECRET_KEY_NAME.test(key) ? "[redacted]" : redactWalk(value, maxFieldChars, depth + 1);
    }
    return out;
  }
  return scrubString(String(node), maxFieldChars);
}

/**
 * Remove every occurrence of the configured ingest token from a JSON-safe
 * value: the token may appear bare (no `Bearer`, no secret-named key), and a
 * leaked token is worse than a lost label.
 */
function scrubTokenDeep(value, token) {
  const needle = typeof token === "string" ? token.trim() : "";
  if (!needle) return value;
  if (typeof value === "string") return value.split(needle).join("[redacted]");
  if (Array.isArray(value)) return value.map((item) => scrubTokenDeep(item, needle));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubTokenDeep(item, needle);
    return out;
  }
  return value;
}

/**
 * Privacy pass: redact secret-shaped values and secret-named keys, scrub the
 * configured token wherever it appears, truncate long strings, and keep the
 * serialized payload within config.maxPayloadBytes so POST /events never 400s
 * on size.
 */
export function redactPayload(payload, config = {}) {
  const maxField = config.maxFieldChars ?? DEFAULTS.maxFieldChars;
  const cap = config.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes;
  let out = redactWalk(
    payload && typeof payload === "object" ? payload : { detail: payload ?? {} },
    maxField,
    0
  );

  // Size cap: halve the longest string fields until the payload fits.
  let guard = 0;
  while (Buffer.byteLength(JSON.stringify(out), "utf8") > cap && guard < 8) {
    const limit = Math.max(64, Math.floor(maxField / 2 ** (guard + 1)));
    out = shrinkStrings(out, limit);
    guard += 1;
  }
  if (Buffer.byteLength(JSON.stringify(out), "utf8") > cap) {
    out = { truncated: true, note: "payload exceeded reporter size cap" };
  }
  return scrubTokenDeep(out, config.token);
}

function shrinkStrings(node, limit) {
  if (typeof node === "string") {
    return node.length > limit ? `${node.slice(0, limit)}…[truncated ${node.length - limit} chars]` : node;
  }
  if (Array.isArray(node)) return node.map((item) => shrinkStrings(item, limit));
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = shrinkStrings(value, limit);
    return out;
  }
  return node;
}

// --- classification ---------------------------------------------------------

const FILE_EDIT_TOOL =
  /^(?:[\w.-]+_)?(write|edit|patch|apply_patch|multi[_-]?edit|create[_-]?file|str[_-]?replace|search[_-]?replace|replace[_-]?in[_-]?file)$/i;
const COMMAND_TOOL = /^(?:[\w.-]+_)?(bash|shell|sh|zsh|terminal|exec|execute|run[_-]?command|command|cmd|powershell)$/i;

/** Map a tool name to the extra event types it implies. */
export function classifyTool(name) {
  const tool = typeof name === "string" ? name.trim().toLowerCase() : "";
  return { fileEdit: FILE_EDIT_TOOL.test(tool), command: COMMAND_TOOL.test(tool) };
}

// --- envelope ---------------------------------------------------------------

/** Build an ADR-035 event schema v1 envelope. Throws on an unusable shape. */
export function buildEnvelope(config, eventType, payload, now = new Date()) {
  const event = typeof eventType === "string" ? eventType.trim() : "";
  if (!event || /\s/.test(event) || event.length > 100) {
    throw new TypeError(`event_type: must be 1-100 non-whitespace chars, got ${JSON.stringify(eventType)}`);
  }
  const agent = typeof config.agent === "string" ? config.agent.trim() : "";
  if (!agent || /\s/.test(agent) || agent.length > 255) {
    throw new TypeError(`agent: must be a single token of 1-255 chars, got ${JSON.stringify(config.agent)}`);
  }
  return {
    version: 1,
    agent,
    event_type: event,
    timestamp: now.toISOString(),
    payload: redactPayload(payload ?? {}, config),
  };
}

// --- transport --------------------------------------------------------------

/**
 * Fire-and-forget reporter. report() never blocks on the network: it starts the
 * POST and hands back a promise the caller may ignore.
 *
 * Failure logging is deliberately quiet: the first failure prints one line, and
 * repeats are only counted, so an unreachable dashboard costs a run exactly one
 * line of stderr however many events it tried to send.
 */
export function createReporter(config, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const logger = deps.logger ?? (() => {});
  const stats = { sent: 0, failed: 0, dropped: 0, suppressed: 0 };
  const enabled = config.enabled !== false && Boolean(config.token);
  const inflight = new Set();
  let failureLogged = false;

  function noteFailure(envelope, message) {
    stats.failed += 1;
    if (failureLogged) {
      stats.suppressed += 1;
      return false;
    }
    failureLogged = true;
    logger(`${message} (further failures this run are counted, not logged)`, "warn");
    return false;
  }

  async function send(envelope) {
    try {
      if (typeof doFetch !== "function") throw new Error("no fetch implementation");
      const headers = {
        "content-type": "application/json",
        "user-agent": `${EXTENSION_ID}/${VERSION} (${config.agent})`,
      };
      if (config.token) headers.authorization = `Bearer ${config.token}`;
      const res = await doFetch(config.eventsUrl ?? `${config.dashboardUrl}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (res && res.ok) {
        stats.sent += 1;
        return true;
      }
      return noteFailure(envelope, `dashboard rejected ${envelope.event_type}: HTTP ${res ? res.status : "?"}`);
    } catch (err) {
      return noteFailure(
        envelope,
        `dashboard unreachable, dropped ${envelope.event_type}: ${(err && err.message) || err}`
      );
    }
  }

  function report(eventType, payload) {
    if (!enabled) return Promise.resolve(false);
    let envelope;
    try {
      envelope = buildEnvelope(config, eventType, payload ?? {});
    } catch (err) {
      stats.dropped += 1;
      logger(`invalid event ${eventType}: ${err.message}`, "warn");
      return Promise.resolve(false);
    }
    const p = send(envelope).finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  }

  async function flush(boundMs = config.timeoutMs) {
    const all = Promise.allSettled([...inflight]);
    if (boundMs > 0) {
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, boundMs))]);
    } else {
      await all;
    }
  }

  return {
    report,
    flush,
    stats: () => ({ ...stats }),
    enabled,
    failureLogged: () => failureLogged,
  };
}

// --- Pi adapter -------------------------------------------------------------

function compact(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function pickPath(input) {
  if (!input || typeof input !== "object") return undefined;
  return input.path ?? input.filePath ?? input.file_path ?? input.file ?? undefined;
}

/**
 * Labels, not paths: the dashboard shows basenames (its ingester enforces the
 * same rule), so the reporter never puts a directory tree on the wire.
 */
export function label(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parts = value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  return parts.length ? parts[parts.length - 1] : undefined;
}

function extractExitCode(result) {
  if (result && typeof result === "object") {
    const v =
      result.structuredContent?.exit_code ??
      result.structuredContent?.exitCode ??
      result.exitCode ??
      result.exit_code ??
      result.exit ??
      result.details?.exitCode ??
      result.details?.exit_code;
    if (typeof v === "number") return v;
  }
  return undefined;
}

function firstLine(text, limit) {
  if (typeof text !== "string") return undefined;
  const line = text.split("\n", 1)[0].trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** Build the reporter's logger: stderr only, optionally mirrored to a file. */
export function createLogger(config) {
  return (msg, level = "warn") => {
    const line = `[sou-reporter] ${msg}`;
    try {
      console.error(line);
    } catch {
      /* nothing to do */
    }
    if (config.debug) {
      try {
        mkdirSync(path.dirname(config.debugLogFile), { recursive: true });
        appendFileSync(config.debugLogFile, `${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`, "utf8");
      } catch {
        /* best effort */
      }
    }
  };
}

/**
 * Register the reporter on a Pi extension API object. `inject` overrides the
 * config, transport, logger and process hooks, which is how the adapter tests
 * drive it without Pi or a network.
 *
 * Returns { config, reporter, dispose } so tests (and `pi --extension` users)
 * can inspect state; the default export only needs the factory.
 */
export function createExtension(pi, inject = {}) {
  const config = inject.config ?? loadConfig(inject.env ?? process.env);
  const logger = inject.logger ?? createLogger(config);
  const resolved = inject.token === undefined ? resolveToken(config, inject) : { token: inject.token, source: "inject" };
  const active = { ...config, token: resolved.token };
  const reporter = inject.reporter ?? createReporter(active, { fetch: inject.fetch, logger });

  const startedAt = Date.now();
  const starts = new Map(); // toolCallId -> { t0, tool, args }
  const edits = new Set(); // files touched since the last code_completion
  const state = { disposed: false, sessionEnded: false, reasoned: null };

  // Exit must not wait on a slow dashboard: Pi awaits `session_shutdown`, and a
  // host that accepts the socket but never answers would otherwise hold the
  // process for the full request timeout.
  const SHUTDOWN_BUDGET_MS = 1200;
  const withDeadline = (promise, ms) =>
    Promise.race([
      Promise.resolve(promise).catch(() => false),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        if (timer && typeof timer.unref === "function") timer.unref();
      }),
    ]);

  // Payloads use the dashboard's ingest allow-list keys (backend/sanitize.py):
  // free text, session ids and full paths are dropped server-side anyway, so
  // sending only labels keeps the wire honest and the events readable.
  const flushCompletion = () => {
    if (!edits.size) return;
    void reporter.report(
      "code_completion",
      compact({ status: "ok", duration_ms: Math.max(0, Date.now() - startedAt), kind: "edits" })
    );
    edits.clear();
  };

  const reportEnd = (reason) => {
    if (state.sessionEnded) return Promise.resolve(false);
    state.sessionEnded = true;
    flushCompletion();
    // `status` describes what actually reached the dashboard this run, not how
    // many events we tried to send.
    return reporter.report(
      "session_end",
      compact({ reason, status: reporter.stats().sent > 0 ? "ok" : "empty" })
    );
  };

  // Never let a handler throw into Pi: a reporter failure must not cost a tool
  // call, a turn or a run. A thrown `tool_call` handler blocks the tool, so this
  // wrapper is load-bearing, not decoration.
  const safe = (fn) => (event, ctx) => {
    try {
      const r = fn(event ?? {}, ctx);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* reporting must not break the host */
    }
    return undefined;
  };

  const off = [];
  const on = (name, handler) => {
    try {
      const unsubscribe = pi.on(name, handler);
      if (typeof unsubscribe === "function") off.push(unsubscribe);
    } catch (err) {
      logger(`could not subscribe to ${name}: ${(err && err.message) || err}`);
    }
  };

  if (!reporter.enabled) {
    logger(
      resolved.token
        ? "reporting disabled (SOU_REPORTER_ENABLED)"
        : "reporting disabled: no ingest token (SOU_TOKEN, SOU_TOKEN_FILE, or ~/.config/sou/<agent>.token)"
    );
  }

  on(
    "session_start",
    safe((event, ctx) => {
      void reporter.report(
        "session_start",
        compact({
          cwd: label(ctx?.cwd),
          source: safeMode(ctx),
          reason: event.reason,
          model: safeModel(ctx),
          engine: "pi",
        })
      );
    })
  );

  on(
    "tool_execution_start",
    safe((event) => {
      const tool = String(event.toolName ?? "unknown");
      if (starts.size > 500) starts.delete(starts.keys().next().value);
      starts.set(event.toolCallId, { t0: Date.now(), tool, args: event.args });
      if (event.parentToolCallId) {
        void reporter.report("background_start", compact({ tool, task_id: event.parentToolCallId }));
      }
    })
  );

  on(
    "tool_execution_end",
    safe((event) => {
      const tool = String(event.toolName ?? "unknown");
      const start = starts.get(event.toolCallId);
      starts.delete(event.toolCallId);
      const durationMs = typeof event.durationMs === "number" ? Math.round(event.durationMs) : start ? Date.now() - start.t0 : undefined;
      const status = event.isError ? "error" : "ok";
      const args = start?.args;
      const cls = classifyTool(tool);

      void reporter.report(
        "tool_call",
        compact({
          tool,
          status,
          duration_ms: durationMs,
          parent_tool_call_id: event.parentToolCallId,
          error: event.isError ? errorText(event.result) : undefined,
        })
      );

      // Only a write that landed is an edit: a failed edit must not draw an
      // "editing <file>" bubble or feed code_completion.
      if (cls.fileEdit && !event.isError) {
        const file = label(pickPath(args));
        if (file) edits.add(file);
        void reporter.report("file_edit", compact({ tool, file, status, duration_ms: durationMs }));
      }

      if (cls.command) {
        void reporter.report(
          "command_run",
          compact({
            tool,
            command: firstLine(args?.command ?? args?.cmd, 300),
            cwd: label(args?.cwd),
            status,
            exit_code: extractExitCode(event.result),
            duration_ms: durationMs,
          })
        );
      }

      if (event.parentToolCallId) {
        void reporter.report(
          "background_end",
          compact({ tool, task_id: event.parentToolCallId, status, duration_ms: durationMs })
        );
      }
    })
  );

  on(
    "agent_settled",
    safe((event) => {
      flushCompletion();
      if (event && event.aborted) {
        void reporter.report("state_change", compact({ state: "aborted" }));
      }
    })
  );

  // No process signal listeners, on purpose. Pi 1.3 already turns SIGTERM and
  // SIGHUP into `session_shutdown` in every mode (print, json, rpc,
  // interactive), and so does a normal `pi -p` exit. A SIGINT listener here
  // would be the only one in print/json/rpc mode, and any listener replaces
  // Node's default exit: Ctrl+C would stop killing a headless run, and the
  // dashboard would get a session_end while Pi kept working.

  // Pi awaits this handler, so the last event of a run actually leaves the
  // process before it exits. Errors are swallowed: cleanup must be idempotent
  // and must never fail a shutdown.
  on("session_shutdown", async (event) => {
    try {
      // Bounded: a dashboard that accepts the socket and never answers must not
      // hold the exit for the full request timeout.
      await withDeadline(reportEnd(event?.reason ?? "shutdown"), SHUTDOWN_BUDGET_MS);
      await withDeadline(reporter.flush(Math.min(config.timeoutMs, 2000)), SHUTDOWN_BUDGET_MS);
    } catch {
      /* reporting must not break the host */
    }
  });

  // Pi re-runs the factory for every session replacement (/new, /resume, fork)
  // and ignores the factory's return value, so dispose() is a test-only path.
  const dispose = async () => {
    if (state.disposed) return;
    state.disposed = true;
    for (const unsubscribe of off) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    await reportEnd("extension_unload");
    await reporter.flush(Math.min(config.timeoutMs, 2000));
  };

  return { config: active, reporter, dispose, state };
}

function safeMode(ctx) {
  try {
    const mode = ctx?.mode;
    return typeof mode === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(mode) ? mode : undefined;
  } catch {
    return undefined;
  }
}

function safeModel(ctx) {
  try {
    const model = ctx?.model;
    if (!model) return undefined;
    return model.id ?? model.name ?? undefined;
  } catch {
    return undefined;
  }
}

function errorText(result) {
  if (result == null) return "tool failed";
  if (typeof result === "string") return firstLine(result, 200);
  if (typeof result === "object") {
    if (typeof result.error === "string") return firstLine(result.error, 200);
    if (typeof result.message === "string") return firstLine(result.message, 200);
  }
  return "tool failed";
}

/** Pi extension entry point: `export default (pi) => …`. */
export default function piStarOfficeReporter(pi, inject = {}) {
  return createExtension(pi, inject);
}
