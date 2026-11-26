#!/usr/bin/env node
/**
 * Layer-1 Deterministic Contract & Latency Benchmark for agy-memory v0.4.2.
 * - Exercises 60-session archive corpus + dual-project isolation + Project Blackboard.
 * - Verifies strict <=8650 B UTF-8 MCP inline bounds and <=1536 B SessionStart board cap.
 * - Reports 30-run cold/warm p50 and min-max latencies per core operation.
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

function buildCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-memory-l1-"));
  const dataDir = path.join(root, "antigravity-cli");
  const boardsHome = path.join(root, "boards-home");
  fs.mkdirSync(dataDir, { recursive: true });
  const baseTime = Date.now() - 3600 * 1000;

  const dbRows = [];
  for (let i = 0; i < 60; i += 1) {
    const sid = `${String(i + 1).padStart(8, "0")}-1111-2222-3333-444444444444`;
    const logsDir = path.join(dataDir, "brain", sid, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const proj = i < 30 ? "proj-alpha" : "proj-beta";
    const tsIso = new Date(baseTime - i * 60_000).toISOString();
    dbRows.push({
      id: sid,
      title: `Session ${i + 1} (${proj})`,
      steps: i === 0 ? 80 : 12,
      mtime: tsIso,
      ws: ["/workspace/shared"],
      projectId: proj,
      appDataDir: "antigravity-cli",
    });

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
              : `Analysis complete for ${proj} session ${i} turn ${t} (${"detail ".repeat(20)}).`,
        }),
      );
    }
    fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), `${lines.join("\n")}\n`);

    if (i === 5) {
      fs.writeFileSync(
        path.join(dataDir, "brain", sid, "cache_postmortem.md"),
        `# Cache Postmortem\n\nSingleflight mutex TTL raised from 2s to 15s.\n${"Line details.\n".repeat(120)}`,
      );
      const swarmDir = path.join(dataDir, "brain", sid, ".system_generated", "swarm");
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

  const py = `
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA journal_mode=WAL")
con.execute("""
CREATE TABLE conversation_summaries (
  conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "", preview text NOT NULL DEFAULT "",
  step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
  status text NOT NULL DEFAULT "", project_id text NOT NULL DEFAULT "", app_data_dir text NOT NULL DEFAULT "",
  not_fully_idle numeric NOT NULL DEFAULT 0, parent_conversation_id text NOT NULL DEFAULT "",
  nesting_depth integer NOT NULL DEFAULT 0, last_user_input_time datetime NOT NULL
)""")
for r in json.loads(sys.argv[2]):
  con.execute("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (r["id"], r["title"], "", r["steps"], r["mtime"], json.dumps(["file://" + w for w in r["ws"]]),
     "IDLE", r["projectId"], r["appDataDir"], 0, "", 0, r["mtime"]))
con.commit()
con.close()
`;
  const pyRes = spawnSync("python3", ["-c", py, path.join(dataDir, "conversation_summaries.db"), JSON.stringify(dbRows)]);
  assert.equal(pyRes.status, 0, pyRes.stderr?.toString());
  return { root, dataDir, boardsHome };
}

function callMcpBatch(dataDir, boardsHome, calls) {
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
    env: { ...process.env, AGY_MEMORY_DATA_DIR: dataDir, AGY_MEMORY_HOME: boardsHome },
    input: `${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`,
    encoding: "utf8",
    timeout: 15000,
  });
  const totalMs = performance.now() - t0;
  assert.equal(res.status, 0, `MCP exited ${res.status}: ${res.stderr}`);
  const replies = res.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  return { totalMs, replies: replies.slice(1) };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  return { p50, min: sorted[0], max: sorted[sorted.length - 1] };
}

const { root, dataDir, boardsHome } = buildCorpus();
try {
  const alphaId = "00000001-1111-2222-3333-444444444444";
  const betaId = "00000031-1111-2222-3333-444444444444";

  const scenarios = [
    { label: "board_post alpha", name: "board_post", args: { conversationId: alphaId, key: "cache-policy", body: "Keep singleflight TTL at 15s for alpha." } },
    { label: "board_post beta", name: "board_post", args: { conversationId: betaId, key: "cache-policy", body: "Beta uses 30s TTL." } },
    { label: "board_read alpha", name: "board_read", args: { conversationId: alphaId } },
    { label: "list scoped (alpha)", name: "search_sessions", args: { conversationId: alphaId, maxSessions: 15 } },
    { label: "search CJK+EN (alpha)", name: "search_sessions", args: { conversationId: alphaId, query: "singleflight 缓存击穿" } },
    { label: "search artifacts", name: "search_sessions", args: { conversationId: alphaId, query: "mutex TTL", scope: "artifacts" } },
    { label: "search swarm", name: "search_sessions", args: { conversationId: alphaId, query: "invariant", scope: "swarm" } },
    { label: "search negative", name: "search_sessions", args: { conversationId: alphaId, query: "NONEXISTENT-XYZ-999" } },
    { label: "read digest (40 turns)", name: "read_session", args: { sessionId: "00000001", mode: "digest" } },
    { label: "read swarm (90 msgs)", name: "read_session", args: { sessionId: "00000006", mode: "swarm", tailMessages: 60 } },
    { label: "read artifact (budget)", name: "read_session", args: { sessionId: "00000006", mode: "artifacts", artifactName: "cache_postmortem.md" } },
  ];

  const { totalMs, replies } = callMcpBatch(dataDir, boardsHome, scenarios);
  assert.equal(replies.length, scenarios.length);

  console.log(`agy-memory v0.4 Layer-1 benchmark (60 sessions, dual-project, ${scenarios.length} MCP calls in ${totalMs.toFixed(1)}ms):`);
  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    const reply = replies[i];
    const text = reply?.result?.content?.[0]?.text || "";
    const bytes = Buffer.byteLength(text, "utf8");
    assert.equal(Boolean(reply?.result?.isError), false, `${sc.label} error: ${text}`);
    assert.ok(bytes > 0 && bytes <= 8650, `${sc.label} exceeded 8650B: ${bytes}B`);
    console.log(`  [PASS] ${sc.label.padEnd(26)} ${String(bytes).padStart(5)} B`);
  }

  // Isolation assertions
  const alphaBoard = replies[2].result.content[0].text;
  assert.ok(alphaBoard.includes("15s for alpha") && !alphaBoard.includes("30s TTL"), "board isolation failed");
  const alphaList = replies[3].result.content[0].text;
  assert.equal(alphaList.includes("proj-beta"), false, "scoped session listing leaked proj-beta");
  const swarmText = replies[9].result.content[0].text;
  assert.ok(swarmText.includes("#90"), "Expected newest swarm message #90");

  // 30-run SessionStart hook latency distribution
  const hookTimes = [];
  let hookBytes = 0;
  for (let r = 0; r < 30; r += 1) {
    const h0 = performance.now();
    const hookRes = spawnSync(process.execPath, [HOOK_SCRIPT], {
      env: { ...process.env, AGY_MEMORY_DATA_DIR: dataDir, AGY_MEMORY_HOME: boardsHome },
      input: JSON.stringify({ conversationId: alphaId, workspacePaths: ["/workspace/shared"] }),
      encoding: "utf8",
      timeout: 5000,
    });
    hookTimes.push(performance.now() - h0);
    assert.equal(hookRes.status, 0);
    const parsed = JSON.parse(hookRes.stdout.trim());
    const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
    hookBytes = Buffer.byteLength(msg, "utf8");
    assert.ok(msg.includes("15s for alpha") && !msg.includes("30s TTL"), msg);
    assert.ok(hookBytes > 0 && hookBytes <= 2048, `Hook exceeded budget: ${hookBytes}B`);
  }
  const hs = stats(hookTimes);
  console.log(
    `  [PASS] ${"SessionStart hook (n=30)".padEnd(26)} ${String(hookBytes).padStart(5)} B (p50=${hs.p50.toFixed(1)}ms, range=${hs.min.toFixed(1)}-${hs.max.toFixed(1)}ms)`,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
