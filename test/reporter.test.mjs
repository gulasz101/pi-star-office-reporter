// Pure-layer tests: config precedence, token resolution, the ADR-035 envelope,
// the privacy pass and tool classification. No Pi, no network.
// Run: npm test   (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULTS,
  buildEnvelope,
  classifyTool,
  loadConfig,
  redactPayload,
  resolveToken,
} from "../pi-star-office-reporter.js";

const readFileFrom = (files) => (file) => (Object.hasOwn(files, file) ? files[file] : null);

test("defaults: local dashboard, agent pi, 5s timeout, enabled", () => {
  const config = loadConfig({}, { readFile: () => null });
  assert.equal(config.dashboardUrl, DEFAULTS.dashboardUrl);
  assert.equal(config.agent, "pi");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.enabled, true);
});

test("config file overrides defaults, trailing slash trimmed", () => {
  const config = loadConfig(
    { HOME: "/home/tester" },
    {
      configPath: "/home/tester/.config/sou/reporter.json",
      readFile: readFileFrom({
        "/home/tester/.config/sou/reporter.json": JSON.stringify({
          dashboardUrl: "http://192.168.1.179:30260/",
          agent: "pi-air",
          timeoutMs: 900,
        }),
      }),
    }
  );
  assert.equal(config.dashboardUrl, "http://192.168.1.179:30260");
  assert.equal(config.agent, "pi-air");
  assert.equal(config.timeoutMs, 900);
});

test("env beats config file beats defaults", () => {
  const config = loadConfig(
    {
      HOME: "/home/tester",
      SOU_DASHBOARD_URL: "http://env.example:1234",
      SOU_AGENT_NAME: "pi-env",
      SOU_TIMEOUT_MS: "1500",
    },
    {
      configPath: "/home/tester/.config/sou/reporter.json",
      readFile: readFileFrom({
        "/home/tester/.config/sou/reporter.json": JSON.stringify({
          dashboardUrl: "http://file.example:1",
          agent: "pi-file",
          timeoutMs: 2500,
        }),
      }),
    }
  );
  assert.equal(config.dashboardUrl, "http://env.example:1234");
  assert.equal(config.agent, "pi-env");
  assert.equal(config.timeoutMs, 1500);
});

test("malformed config file is ignored, not fatal", () => {
  const config = loadConfig(
    { HOME: "/home/tester" },
    { configPath: "/home/tester/.config/sou/reporter.json", readFile: () => "{not json" }
  );
  assert.equal(config.dashboardUrl, DEFAULTS.dashboardUrl);
  assert.equal(config.agent, "pi");
});

test("SOU_REPORTER_ENABLED=0 disables; a timeout below the floor is clamped away", () => {
  const off = loadConfig({ SOU_REPORTER_ENABLED: "off", SOU_TIMEOUT_MS: "5" }, { readFile: () => null });
  assert.equal(off.enabled, false);
  assert.equal(off.timeoutMs, DEFAULTS.timeoutMs);
  const clamped = loadConfig({ SOU_TIMEOUT_MS: "999999" }, { readFile: () => null });
  assert.equal(clamped.timeoutMs, DEFAULTS.maxTimeoutMs);
});

test("token: env wins, then token file, then nothing", () => {
  const config = loadConfig({ HOME: "/home/tester" }, { readFile: () => null });
  const fromEnv = resolveToken({ ...config, token: "env-token" }, { readFile: () => "file-token\n" });
  assert.deepEqual(fromEnv, { token: "env-token", source: "env" });

  const fromFile = resolveToken(config, {
    readFile: readFileFrom({ "/home/tester/.config/sou/pi.token": "file-token\n" }),
  });
  assert.equal(fromFile.token, "file-token");
  assert.match(fromFile.source, /pi\.token$/);

  const none = resolveToken(config, { readFile: () => null });
  assert.equal(none.token, null);
});

test("envelope: version 1, agent from config, ISO timestamp, redacted payload", () => {
  const config = { ...loadConfig({}, { readFile: () => null }), agent: "pi" };
  const env = buildEnvelope(
    config,
    "tool_call",
    { tool: "bash", api_key: "sk-should-not-survive-0123456789" },
    new Date("2026-10-21T02:03:04.000Z")
  );
  assert.equal(env.version, 1);
  assert.equal(env.agent, "pi");
  assert.equal(env.event_type, "tool_call");
  assert.equal(env.timestamp, "2026-10-21T02:03:04.000Z");
  assert.equal(env.payload.api_key, "[redacted]");
});

test("envelope: bad event_type / agent throws instead of POSTing nonsense", () => {
  const config = { agent: "pi" };
  assert.throws(() => buildEnvelope(config, "two words", {}), TypeError);
  assert.throws(() => buildEnvelope(config, "", {}), TypeError);
  assert.throws(() => buildEnvelope({ agent: "two words" }, "tool_call", {}), TypeError);
});

test("redaction: bearer tokens, provider keys, JWTs and secret-named keys", () => {
  const payload = redactPayload({
    authorization: "Bearer abcdefghijklmnop",
    note: "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01",
    key: "sk-abcdefghijklmnopqrstuvwx",
    jwt: "eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSM",
    password: "hunter2hunter2",
    tool: "bash",
  });
  const text = JSON.stringify(payload);
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz01"));
  assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwx"));
  assert.ok(!text.includes("SflKxwRJSM"));
  assert.ok(!text.includes("hunter2hunter2"));
  assert.equal(payload.tool, "bash");
});

test("redaction: long strings truncated, payload kept under the byte cap", () => {
  const payload = redactPayload({ output: "x".repeat(200000) }, { maxFieldChars: 4000, maxPayloadBytes: 65536 });
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(bytes <= 65536, `payload was ${bytes} bytes`);
  assert.match(payload.output, /truncated/);
});

test("classifyTool: file-edit and command classes, read tools are neither", () => {
  for (const tool of ["write", "edit", "patch", "apply_patch", "str_replace", "multi_edit"]) {
    assert.equal(classifyTool(tool).fileEdit, true, tool);
  }
  for (const tool of ["bash", "powershell", "exec", "run_command"]) {
    assert.equal(classifyTool(tool).command, true, tool);
  }
  for (const tool of ["read", "grep", "find", "ls"]) {
    const cls = classifyTool(tool);
    assert.equal(cls.fileEdit, false, tool);
    assert.equal(cls.command, false, tool);
  }
});
