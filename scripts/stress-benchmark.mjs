#!/usr/bin/env node
/**
 * Synthetic corpus stress benchmark for agy-memory.
 * Creates an isolated temporary 60-session Antigravity corpus (CJK + English transcripts,
 * full-reply hydration, Markdown artifacts, and a 90-message Swarm board), then verifies
 * latency, strict <=8650 B UTF-8 output bounds, and zero errors across repeated queries.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MCP_SERVER = path.join(ROOT, "dist", "mcp-server.mjs");
const HOOK_SCRIPT = path.join(ROOT, "dist", "session-start.mjs");

function buildSyntheticCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-memory-stress-"));
  const baseTime = Date.now() - 3600 * 1000;

  for (let i = 0; i < 60; i += 1) {
    const sid = `${String(i + 1).padStart(8, "0")}-1111-2222-3333-444444444444`;
    const logsDir = path.join(dir, "brain", sid, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    const lines = [];
    const turnCount = i === 0 ? 40 : 6;
    for (let t = 0; t < turnCount; t += 1) {
      const ts = new Date(baseTime - i * 600_000 + t * 10_000).toISOString();
      lines.push(
        JSON.stringify({
          step_index: t * 2,
          type: "USER_INPUT",
          created_at: ts,
          content: `<USER_REQUEST>\nSession ${i} turn ${t}: check cache invalidation 缓存击穿 strategy\n</USER_REQUEST>`,
        }),
      );
      lines.push(
        JSON.stringify({
          step_index: t * 2 + 1,
          type: "PLANNER_RESPONSE",
          created_at: ts,
          tool_calls: [{ name: "read_file" }, { name: "edit_file" }],
          content:
            i === 5 && t === 2
              ? "Root cause confirmed: Redis 缓存击穿 occurred when singleflight lock expired under high QPS."
              : `Analysis complete for session ${i} turn ${t} (${"detail ".repeat(20)}).`,
        }),
      );
    }
    fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), `${lines.join("\n")}\n`);

    if (i === 5) {
      fs.writeFileSync(
        path.join(dir, "brain", sid, "cache_postmortem.md"),
        `# Cache Postmortem\n\nSingleflight mutex TTL raised from 2s to 15s.\n${"Line details.\n".repeat(120)}`,
      );
      const swarmDir = path.join(dir, "brain", sid, ".system_generated", "swarm");
      fs.mkdirSync(swarmDir, { recursive: true });
      const board = [];
      for (let seq = 1; seq <= 90; seq += 1) {
        board.push(
          JSON.stringify({
            seq,
            time: "2026-10-01 12:00:00",
            agent: seq % 2 === 0 ? "reviewer" : "worker-cache",
            text: `Board message #${seq}: verified singleflight lock invariant (${"x".repeat(180)})`,
          }),
        );
      }
      fs.writeFileSync(path.join(swarmDir, "board.jsonl"), `${board.join("\n")}\n`);
    }
  }
  return dir;
}

function callMcpBatch(dataDir, calls) {
  const msgs = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    ...calls.map((c, idx) => ({
      jsonrpc: "2.0",
      id: idx + 1,
      method: "tools/call",
      params: { name: c.name, arguments: c.args },
    })),
  ];
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [MCP_SERVER], {
    env: { ...process.env, AGY_MEMORY_DATA_DIR: dataDir },
    input: `${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 15000,
  });
  const totalMs = performance.now() - t0;
  assert.equal(res.status, 0, `MCP server exited with ${res.status}: ${res.stderr}`);
  const replies = res.stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l));
  return { totalMs, replies: replies.slice(1) };
}

const dataDir = buildSyntheticCorpus();
try {
  const scenarios = [
    { label: "list_sessions (cold)", name: "list_sessions", args: { limit: 15 } },
    { label: "list_sessions (warm)", name: "list_sessions", args: { limit: 15 } },
    { label: "search CJK+EN (cold)", name: "search_sessions", args: { query: "singleflight 缓存击穿" } },
    { label: "search CJK+EN (warm)", name: "search_sessions", args: { query: "singleflight 缓存击穿" } },
    { label: "search artifacts", name: "search_sessions", args: { query: "mutex TTL", scope: "artifacts" } },
    { label: "search swarm", name: "search_sessions", args: { query: "invariant", scope: "swarm" } },
    { label: "search negative", name: "search_sessions", args: { query: "NONEXISTENT-XYZ-999" } },
    { label: "read digest (40 turns)", name: "read_session", args: { sessionId: "00000001", mode: "digest" } },
    { label: "read swarm (90 msgs)", name: "read_session", args: { sessionId: "00000006", mode: "swarm", tailMessages: 60 } },
    { label: "read artifact (budget)", name: "read_session", args: { sessionId: "00000006", mode: "artifacts", artifactName: "cache_postmortem.md" } },
  ];

  const { totalMs, replies } = callMcpBatch(dataDir, scenarios);
  assert.equal(replies.length, scenarios.length);

  console.log(`agy-memory synthetic stress benchmark (60 sessions, ${scenarios.length} MCP calls in ${totalMs.toFixed(1)}ms):`);
  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    const reply = replies[i];
    const text = reply?.result?.content?.[0]?.text || "";
    const bytes = Buffer.byteLength(text, "utf8");
    assert.equal(Boolean(reply?.result?.isError), false, `${sc.label} returned error: ${text}`);
    assert.ok(bytes > 0 && bytes <= 8650, `${sc.label} exceeded 8650B cap: ${bytes}B`);
    console.log(`  [PASS] ${sc.label.padEnd(26)} ${String(bytes).padStart(5)} B`);
  }

  // Verify newest Swarm message #90 is preserved
  const swarmText = replies[8].result.content[0].text;
  assert.ok(swarmText.includes("#90"), "Expected newest swarm message #90 to be preserved");

  // Verify SessionStart hook speed and byte budget
  const h0 = performance.now();
  const hookRes = spawnSync(process.execPath, [HOOK_SCRIPT], {
    env: { ...process.env, AGY_MEMORY_DATA_DIR: dataDir },
    input: JSON.stringify({ conversationId: "00000001-1111-2222-3333-444444444444" }),
    encoding: "utf8",
    timeout: 5000,
  });
  const hookMs = performance.now() - h0;
  assert.equal(hookRes.status, 0);
  const hookJson = JSON.parse(hookRes.stdout.trim());
  const hookBytes = Buffer.byteLength(hookJson?.injectSteps?.[0]?.systemMessage?.systemMessage || "", "utf8");
  assert.ok(hookBytes > 0 && hookBytes <= 1850, `Hook exceeded 1850B cap: ${hookBytes}B`);
  console.log(`  [PASS] ${"SessionStart hook".padEnd(26)} ${String(hookBytes).padStart(5)} B (${hookMs.toFixed(1)}ms)`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
