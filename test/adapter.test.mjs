// Adapter tests: the Pi extension contract, driven through a mock `pi` object
// and a mock fetch. They assert the event stream a real Pi run produces, the
// privacy rules on the real payload path, and that no failure mode can throw
// into Pi or stop a run. Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import piStarOfficeReporter, { createExtension, loadConfig } from "../pi-star-office-reporter.js";

const TOKEN = "test-token-not-a-real-one";

function mockPi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
      return () => {
        const list = handlers.get(name) || [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    async emit(name, event, ctx) {
      for (const handler of handlers.get(name) || []) await handler(event, ctx);
    },
  };
}

function mockCtx(overrides = {}) {
  return {
    cwd: "/tmp/paperclip-run",
    mode: "json",
    model: { id: "deepseek-v4.1-flash-go" },
    sessionManager: {
      getSessionId: () => "sess-123",
      getSessionFile: () => "/tmp/paperclip-run/.pi/sessions/sess-123.jsonl",
    },
    ...overrides,
  };
}

/** Fake fetch that records requests; `respond` decides the outcome per call. */
function mockFetch(respond = () => ({ ok: true, status: 201 })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

function harness({ env = {}, fetch, respond, token = TOKEN } = {}) {
  const logs = [];
  const pi = mockPi();
  const config = { ...loadConfig(env, { readFile: () => null }), agent: "pi" };
  const fetchImpl = fetch ?? mockFetch(respond);
  const ext = createExtension(pi, {
    config,
    token,
    fetch: fetchImpl,
    logger: (msg, level = "warn") => logs.push({ msg, level }),
  });
  return { pi, ext, logs, fetch: fetchImpl, ctx: mockCtx(), events: () => fetchImpl.calls.map((c) => c.body) };
}

async function runSession(pi, ctx) {
  await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await pi.emit("tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "README.md" } }, ctx);
  await pi.emit(
    "tool_execution_end",
    { toolCallId: "c1", toolName: "read", result: "ok", isError: false, durationMs: 12 },
    ctx
  );
  await pi.emit(
    "tool_execution_start",
    { toolCallId: "c2", toolName: "bash", args: { command: "npm test", cwd: "/tmp/paperclip-run" } },
    ctx
  );
  await pi.emit(
    "tool_execution_end",
    {
      toolCallId: "c2",
      toolName: "bash",
      result: { content: [], structuredContent: { exit_code: 0, output: "reporter-smoke" } },
      isError: false,
      durationMs: 900,
    },
    ctx
  );
  await pi.emit(
    "tool_execution_start",
    { toolCallId: "c3", toolName: "write", args: { path: "/tmp/paperclip-run/src/app.js" } },
    ctx
  );
  await pi.emit(
    "tool_execution_end",
    { toolCallId: "c3", toolName: "write", result: "written", isError: false, durationMs: 30 },
    ctx
  );
  await pi.emit("agent_settled", { aborted: false }, ctx);
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
}

test("a Pi session reports session_start, tool calls, edits, commands, completion and end", async () => {
  const { pi, ctx, events } = harness();
  await runSession(pi, ctx);

  const types = events().map((e) => e.event_type);
  assert.ok(types.includes("session_start"), types.join(","));
  assert.ok(types.includes("tool_call"), types.join(","));
  assert.ok(types.includes("file_edit"), types.join(","));
  assert.ok(types.includes("command_run"), types.join(","));
  assert.ok(types.includes("code_completion"), types.join(","));
  assert.equal(types[types.length - 1], "session_end");

  assert.equal(types.filter((t) => t === "tool_call").length, 3);
  for (const event of events()) {
    assert.equal(event.version, 1);
    assert.equal(event.agent, "pi");
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof event.payload, "object");
  }

  const start = events().find((e) => e.event_type === "session_start");
  assert.equal(start.payload.reason, "startup");
  assert.equal(start.payload.cwd, "paperclip-run"); // basename, never the tree
  assert.equal(start.payload.source, "json");
  assert.equal(start.payload.engine, "pi");

  const bash = events().find((e) => e.event_type === "command_run");
  assert.equal(bash.payload.command, "npm test");
  assert.equal(bash.payload.exit_code, 0);
  assert.equal(bash.payload.status, "ok");
  assert.equal(bash.payload.duration_ms, 900);

  const edit = events().find((e) => e.event_type === "file_edit");
  assert.equal(edit.payload.file, "app.js");
  assert.equal(edit.payload.tool, "write");

  // code_completion keeps only ingest-allow-listed label keys (backend/sanitize.py).
  const done = events().find((e) => e.event_type === "code_completion");
  assert.equal(done.payload.status, "ok");
  assert.equal(done.payload.kind, "edits");
  assert.equal(typeof done.payload.duration_ms, "number");

  const end = events().find((e) => e.event_type === "session_end");
  assert.equal(end.payload.reason, "quit");
  assert.equal(end.payload.status, "ok");
});

test("the token travels in the Authorization header and never inside a payload", async () => {
  const { pi, ctx, fetch } = harness();
  await runSession(pi, ctx);

  assert.ok(fetch.calls.length > 0);
  for (const call of fetch.calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!JSON.stringify(call.body).includes(TOKEN), "token leaked into a payload");
    assert.equal(call.url, "http://127.0.0.1:19000/events");
  }
});

test("a nested tool call reports background_start/background_end", async () => {
  const { pi, ctx, events } = harness();
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit(
    "tool_execution_start",
    { toolCallId: "p1/1", toolName: "codemode", args: {}, parentToolCallId: "p1" },
    ctx
  );
  await pi.emit(
    "tool_execution_end",
    { toolCallId: "p1/1", toolName: "codemode", result: "ok", isError: false, durationMs: 5, parentToolCallId: "p1" },
    ctx
  );

  const types = events().map((e) => e.event_type);
  assert.ok(types.includes("background_start"));
  assert.ok(types.includes("background_end"));
  const start = events().find((e) => e.event_type === "background_start");
  assert.equal(start.payload.task_id, "p1");
});

test("dashboard unreachable: the run finishes, exactly one log line, nothing throws", async () => {
  const { pi, ctx, logs, ext } = harness({
    respond: () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    },
  });

  await assert.doesNotReject(() => runSession(pi, ctx));

  assert.equal(logs.length, 1, `expected one line, got ${JSON.stringify(logs)}`);
  assert.match(logs[0].msg, /dashboard unreachable/);
  const stats = ext.reporter.stats();
  assert.ok(stats.failed >= 6);
  assert.ok(stats.sent === 0);
});

test("HTTP 500 from the dashboard is a logged failure, not a thrown one", async () => {
  const { pi, ctx, logs } = harness({ respond: () => ({ ok: false, status: 500 }) });
  await assert.doesNotReject(() => runSession(pi, ctx));
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /HTTP 500/);
});

test("a synchronous fetch explosion cannot reach Pi", async () => {
  const { pi, ctx } = harness({
    fetch: () => {
      throw new Error("boom");
    },
  });
  await assert.doesNotReject(() => runSession(pi, ctx));
});

test("no token: no POSTs, one explaining line", async () => {
  const { pi, ctx, fetch, logs } = harness({ token: null });
  await runSession(pi, ctx);
  assert.equal(fetch.calls.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /no ingest token/);
});

test("SOU_REPORTER_ENABLED=0 silences the reporter entirely", async () => {
  const { pi, ctx, fetch, logs } = harness({ env: { SOU_REPORTER_ENABLED: "0" } });
  await runSession(pi, ctx);
  assert.equal(fetch.calls.length, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0].msg, /disabled/);
});

test("session_end is reported once even when shutdown and dispose both run", async () => {
  const { pi, ctx, events, ext } = harness();
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  await ext.dispose();
  const ends = events().filter((e) => e.event_type === "session_end");
  assert.equal(ends.length, 1);
});

test("registers no process signal listeners: Pi owns SIGINT/SIGTERM/SIGHUP", async () => {
  // Any SIGINT listener replaces Node's default exit, and print/json/rpc Pi has
  // none of its own: one here makes Ctrl+C stop killing `pi -p`. Pi emits
  // session_shutdown on SIGTERM/SIGHUP itself, so the reporter needs none.
  const names = ["SIGINT", "SIGTERM", "SIGHUP"];
  const before = names.map((name) => process.listenerCount(name));
  const pi = mockPi();
  const config = { ...loadConfig({}, { readFile: () => null }), agent: "pi" };
  const ext = createExtension(pi, { config, token: TOKEN, fetch: mockFetch(), logger: () => {} });
  await pi.emit("session_start", { reason: "startup" }, mockCtx());
  assert.deepEqual(names.map((name) => process.listenerCount(name)), before);
  await pi.emit("session_shutdown", { reason: "quit" }, mockCtx());
  await ext.dispose();
  assert.deepEqual(names.map((name) => process.listenerCount(name)), before);
});

test("the default export is the Pi factory and registers handlers", () => {
  assert.equal(typeof piStarOfficeReporter, "function");
  const pi = mockPi();
  piStarOfficeReporter(pi, {
    config: { ...loadConfig({}, { readFile: () => null }), agent: "pi" },
    token: TOKEN,
    fetch: mockFetch(),
    logger: () => {},
  });
  for (const event of ["session_start", "tool_execution_start", "tool_execution_end", "agent_settled", "session_shutdown"]) {
    assert.ok(pi.handlers.has(event), `missing handler for ${event}`);
  }
});

test("a failed write is not an edit: no file_edit, no code_completion", async () => {
  const { pi, ctx, events } = harness();
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("tool_execution_start", { toolCallId: "e1", toolName: "write", args: { path: "/tmp/x/note.txt" } }, ctx);
  await pi.emit(
    "tool_execution_end",
    { toolCallId: "e1", toolName: "write", result: { error: "EACCES" }, isError: true, durationMs: 4 },
    ctx
  );
  await pi.emit("agent_settled", { aborted: false }, ctx);

  const types = events().map((e) => e.event_type);
  assert.ok(types.includes("tool_call"), types.join(","));
  assert.ok(!types.includes("file_edit"), `failed write must not report an edit: ${types.join(",")}`);
  assert.ok(!types.includes("code_completion"), "no completion without a landed edit");
  assert.equal(events().find((e) => e.event_type === "tool_call").payload.status, "error");
});

test("shutdown does not wait on a dashboard that accepts and never answers", async () => {
  const hanging = () => new Promise(() => {}); // accepts, never resolves
  const { pi, ctx, ext } = harness({ fetch: hanging });
  await pi.emit("session_start", { reason: "startup" }, ctx);
  const t0 = Date.now();
  await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `shutdown took ${elapsed}ms`);
  assert.ok(ext.state.sessionEnded);
});
