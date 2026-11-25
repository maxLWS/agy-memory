import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeMemoryUsage, formatMemoryUsageMarkdown } from "../src/analytics.js";
import { buildSessionStartSnapshot } from "../src/snapshot.js";
import {
  clearStoreCaches,
  decodeWorkspaceUris,
  noteWorkspaceMatches,
  truncateUtf8,
  workspaceMatches,
} from "../src/store.js";
import { executeTool, executeToolResult } from "../src/tools.js";

function createTestSummariesDb(
  dbPath: string,
  rows: Array<[string, string, string, number, string, string, string, string, number, string]>,
): boolean {
  const createSql = `
CREATE TABLE conversation_summaries (
  conversation_id text PRIMARY KEY,
  title text NOT NULL DEFAULT "",
  preview text NOT NULL DEFAULT "",
  step_count integer NOT NULL DEFAULT 0,
  last_modified_time datetime NOT NULL,
  workspace_uris text NOT NULL,
  status text NOT NULL DEFAULT "",
  parent_conversation_id text NOT NULL DEFAULT "",
  nesting_depth integer NOT NULL DEFAULT 0,
  last_user_input_time datetime NOT NULL
)`;

  // 1) Try built-in node:sqlite (Node 22.5+ / 24 on all OSes)
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as {
      DatabaseSync?: new (p: string) => {
        exec: (sql: string) => void;
        prepare: (sql: string) => { run: (...args: unknown[]) => void };
        close: () => void;
      };
    };
    if (typeof mod?.DatabaseSync === "function") {
      const db = new mod.DatabaseSync(dbPath);
      db.exec(createSql);
      const stmt = db.prepare("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?)");
      for (const row of rows) stmt.run(...row);
      db.close();
      return true;
    }
  } catch {
    // Fall back to python
  }

  // 2) Try python3 / python / py -3
  const pyScript = `
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute(sys.argv[2])
con.executemany("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?)", json.loads(sys.argv[3]))
con.commit()
con.close()
`;
  const candidates =
    process.platform === "win32"
      ? [
          { bin: "python", prefix: [] as string[] },
          { bin: "python3", prefix: [] as string[] },
          { bin: "py", prefix: ["-3"] },
        ]
      : [
          { bin: "python3", prefix: [] as string[] },
          { bin: "/usr/bin/python3", prefix: [] as string[] },
          { bin: "python", prefix: [] as string[] },
        ];
  for (const cand of candidates) {
    try {
      execFileSync(cand.bin, [...cand.prefix, "-c", pyScript, dbPath, createSql, JSON.stringify(rows)], {
        stdio: "ignore",
      });
      return true;
    } catch {
      // Try next candidate
    }
  }
  return false;
}

function createFixtureDataDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-memory-test-"));

  // Session 1: Root conversation with CJK + English transcript, truncated_fields + transcript_full.jsonl, artifact, and Swarm board
  const s1 = "11111111-aaaa-bbbb-cccc-000000000001";
  const s1Logs = path.join(root, "brain", s1, ".system_generated", "logs");
  const s1Swarm = path.join(root, "brain", s1, ".system_generated", "swarm");
  fs.mkdirSync(s1Logs, { recursive: true });
  fs.mkdirSync(s1Swarm, { recursive: true });
  fs.writeFileSync(
    path.join(s1Logs, "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        created_at: "2026-10-24T12:00:00Z",
        content:
          "<USER_REQUEST>\n分析 Gateway 的限流熔断策略\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        model: "test-model-pro",
        created_at: "2026-10-24T12:00:10Z",
        thinking: "Checking rate-limiter burst bucket behavior.",
        tool_calls: [{ name: "read_file" }],
        truncated_fields: ["content"],
        content: '初步核对完毕：Gateway 在热点突发下出现缓存击穿，配置 retry_scope="last-hop"。',
      }),
      JSON.stringify({
        step_index: 2,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        created_at: "2026-10-24T12:05:00Z",
        content: "<USER_REQUEST>\n把完整报告写进 artifact\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        model: "test-model-pro",
        created_at: "2026-10-24T12:05:20Z",
        content: "已经将完整排查报告写入 `gateway_audit_report.md`。",
      }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(s1Logs, "transcript_full.jsonl"),
    [
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        model: "test-model-pro",
        created_at: "2026-10-24T12:00:10Z",
        content:
          '初步核对完毕：Gateway 在热点突发下出现缓存击穿，配置 retry_scope="last-hop"。完整细节：令牌桶容量 420 & 滑动窗口 290ms。',
      }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(root, "brain", s1, "gateway_audit_report.md"),
    "# Gateway Audit Report\n\nKey finding: burst limiter needs explicit singleflight lock reset.\n",
  );
  fs.writeFileSync(
    path.join(root, "brain", s1, "gateway_audit_report.md.metadata.json"),
    JSON.stringify({ summary: "Rate limiter & cache stampede audit" }),
  );
  fs.writeFileSync(
    path.join(s1Swarm, "members.json"),
    JSON.stringify({
      title: "Gateway Audit Swarm",
      members: {
        coordinator: { conversation_id: s1, role: "coordinator", phase: "RUNNING" },
        analyst: {
          conversation_id: "33333333-aaaa-bbbb-cccc-000000000003",
          role: "worker",
          phase: "KILLED",
          model: "test-model-pro",
        },
      },
    }),
  );
  // Include Go-style HTML-escaped JSON (\u003c, \u003e, \u0026) in board.jsonl
  fs.writeFileSync(
    path.join(s1Swarm, "board.jsonl"),
    '{"seq":1,"time":"2026-10-24 20:01:00","agent":"analyst","text":"@coordinator [done] Audited 216 burst traces (cache \\u0026 limiter, \\u003c=200 lines)."}\n',
  );

  // Session 2: Another root conversation in child workspace
  const s2 = "22222222-aaaa-bbbb-cccc-000000000002";
  const s2Logs = path.join(root, "brain", s2, ".system_generated", "logs");
  fs.mkdirSync(s2Logs, { recursive: true });
  fs.writeFileSync(
    path.join(s2Logs, "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-10-23T10:00:00Z",
        content: "<USER_REQUEST>\nFix terminal OSC 8 hyperlink wrapping\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-23T10:01:00Z",
        content: "Closed and reopened OSC 8 escapes across wrapped lines in wrapAnsiLine.",
      }),
    ].join("\n") + "\n",
  );

  // Session 3: Child worker conversation (hidden when includeChildren=false)
  const s3 = "33333333-aaaa-bbbb-cccc-000000000003";
  const s3Logs = path.join(root, "brain", s3, ".system_generated", "logs");
  fs.mkdirSync(s3Logs, { recursive: true });
  fs.writeFileSync(
    path.join(s3Logs, "transcript.jsonl"),
    JSON.stringify({
      step_index: 0,
      type: "USER_INPUT",
      created_at: "2026-10-24T12:01:00Z",
      content: "Child worker brief for burst traces",
    }) + "\n",
  );

  const hasDb = createTestSummariesDb(path.join(root, "conversation_summaries.db"), [
    [
      s1,
      "Gateway Cache Audit",
      "Gateway Cache Audit",
      12,
      "2026-10-24 12:05:20.123456789+00:00",
      '["file:///workspace/demo"]',
      "IDLE",
      "",
      0,
      "2026-10-24 12:05:00+00:00",
    ],
    [
      s2,
      "Terminal Link Wrapping Fix",
      "Terminal Link Wrapping Fix",
      8,
      "2026-10-23 10:01:00.000000000+00:00",
      '["file:///workspace/demo/cli-ui"]',
      "IDLE",
      "",
      0,
      "2026-10-23 10:00:00+00:00",
    ],
    [
      s3,
      "Child Worker",
      "Child Worker",
      1,
      "2026-10-24 12:01:00.000000000+00:00",
      '["file:///workspace/demo"]',
      "IDLE",
      s1,
      1,
      "2026-10-24 12:01:00+00:00",
    ],
  ]);

  return { root, s1, s2, s3, hasDb };
}

test("list_sessions, search_sessions (CJK + English + artifacts + swarm), and read_session modes work cleanly", () => {
  clearStoreCaches();
  const { root, s1, s2, hasDb } = createFixtureDataDir();
  try {
    // 1) list_sessions excludes child workers by default, supports prefix excludeSessionId and minSteps
    const listed = executeTool("list_sessions", { limit: 10 }, { dataDir: root });
    assert.ok(listed.includes("11111111"), listed);
    assert.ok(listed.includes("[swarm, 1 artifacts]"), listed);
    assert.ok(listed.includes("22222222"), listed);
    assert.equal(listed.includes("33333333"), false, "child worker should be hidden by default");
    if (hasDb) {
      assert.ok(listed.includes("Gateway Cache Audit"), listed);
      const minStepsOut = executeTool("list_sessions", { minSteps: 10 }, { dataDir: root });
      assert.ok(minStepsOut.includes("11111111"), minStepsOut);
      assert.equal(minStepsOut.includes("22222222"), false, "minSteps=10 should skip 8-step session");
    }

    const excludedPrefix = executeTool("list_sessions", { excludeSessionId: "11111111" }, { dataDir: root });
    assert.equal(excludedPrefix.includes("11111111"), false, "8-char prefix excludeSessionId must work");
    assert.ok(excludedPrefix.includes("22222222"), excludedPrefix);

    const withChildren = executeTool("list_sessions", { includeChildren: true }, { dataDir: root });
    assert.ok(withChildren.includes("33333333"));

    // 2) search_sessions supports CJK multi-word AND, JSON-escaped chars, transcript_full hydration, sessionId, artifacts with Path, and swarm
    const cjkHit = executeTool("search_sessions", { query: "限流熔断 缓存击穿" }, { dataDir: root });
    assert.ok(cjkHit.includes(s1), cjkHit);
    assert.equal(cjkHit.includes(s2), false);

    // JSON-escaped quotes in transcript & Go HTML escapes in swarm board
    const quotedHit = executeTool(
      "search_sessions",
      { query: 'retry_scope="last-hop"', scope: "assistant" },
      { dataDir: root },
    );
    assert.ok(quotedHit.includes(s1), quotedHit);

    const htmlEscSwarm = executeTool("search_sessions", { query: "<=200", scope: "swarm" }, { dataDir: root });
    assert.ok(htmlEscSwarm.includes("swarm:analyst"), htmlEscSwarm);

    const ampSwarm = executeTool("search_sessions", { query: '"cache & limiter"', scope: "swarm" }, { dataDir: root });
    assert.ok(ampSwarm.includes("swarm:analyst"), ampSwarm);

    // transcript_full.jsonl hydration makes truncated conclusions searchable AND readable
    const hydratedSearch = executeTool(
      "search_sessions",
      { query: '"令牌桶容量 420"', scope: "assistant" },
      { dataDir: root },
    );
    assert.ok(hydratedSearch.includes(s1), hydratedSearch);

    const singleSessionSearch = executeTool(
      "search_sessions",
      { query: "OSC 8", sessionId: "22222222" },
      { dataDir: root },
    );
    assert.ok(singleSessionSearch.includes(s2), singleSessionSearch);

    const artHit = executeTool(
      "search_sessions",
      { query: "singleflight lock reset", scope: "artifacts" },
      { dataDir: root },
    );
    assert.ok(artHit.includes("artifact:gateway_audit_report.md"), artHit);
    assert.ok(artHit.includes("Path:"), "artifact search hit should expose full Path for direct read_file");

    if (hasDb) {
      // Strict scope isolation: title-only word "Audit" must NOT match scope="swarm"
      const scopeLeakSwarm = executeTool("search_sessions", { query: "Gateway", scope: "swarm" }, { dataDir: root });
      assert.ok(scopeLeakSwarm.includes("No past conversations matched"), scopeLeakSwarm);
    }

    const swarmHit = executeTool("search_sessions", { query: "216 burst", scope: "swarm" }, { dataDir: root });
    assert.ok(swarmHit.includes("swarm:analyst"), swarmHit);

    // 3) read_session supports prefix lookup + digest / turns (hydrated) / artifacts / swarm modes
    const digest = executeTool("read_session", { sessionId: "11111111", mode: "digest" }, { dataDir: root });
    assert.ok(digest.includes("Turn 1"), digest);
    assert.ok(digest.includes("Turn 2"), digest);
    assert.ok(digest.includes("gateway_audit_report.md"), digest);

    const turns = executeTool(
      "read_session",
      { sessionId: "11111111", mode: "turns", startStep: 0, endStep: 1, includeTools: true, includeThinking: true },
      { dataDir: root },
    );
    assert.ok(turns.includes("Tools: read_file"), turns);
    assert.ok(turns.includes("Checking rate-limiter burst bucket"), turns);
    assert.ok(turns.includes("令牌桶容量 420"), "turns mode should hydrate truncated_fields from transcript_full.jsonl");
    assert.equal(turns.includes("Turn 2"), false);

    const artRead = executeTool(
      "read_session",
      { sessionId: "11111111", mode: "artifacts", artifactName: "gateway_audit_report.md" },
      { dataDir: root },
    );
    assert.ok(artRead.includes("singleflight lock reset"), artRead);
    assert.ok(artRead.includes("showing lines 1-3 of 3"), artRead);

    const swarmRead = executeTool("read_session", { sessionId: "11111111", mode: "swarm" }, { dataDir: root });
    assert.ok(swarmRead.includes("Gateway Audit Swarm"), swarmRead);
    assert.ok(swarmRead.includes("Audited 216 burst"), swarmRead);

    // 4) save_note (incl string tags coercion), recall_notes (incl note.id & quoted phrases), snapshot (with Current session + tags)
    const saved = executeTool(
      "save_note",
      {
        id: "DEMO-1001",
        topic: "Cache lock tuning",
        content: "Keep singleflight TTL at 15s for gateway burst traffic.",
        workspace: "/workspace/demo",
        tags: "gateway, caching",
        sessionId: s1,
      },
      { dataDir: root },
    );
    assert.ok(saved.includes("[DEMO-1001]"), saved);

    const recalledById = executeTool("recall_notes", { query: "DEMO-1001" }, { dataDir: root });
    assert.ok(recalledById.includes("Cache lock tuning"), "recall_notes must search note.id");

    const recalledQuoted = executeTool("recall_notes", { query: '"TTL at 15s"', tag: "gateway" }, { dataDir: root });
    assert.ok(recalledQuoted.includes("Cache lock tuning"), recalledQuoted);

    const snapshot = buildSessionStartSnapshot(
      { conversationId: s2, workspacePaths: ["/workspace/demo"] },
      root,
    );
    assert.ok(snapshot.includes("Current session: 22222222"), snapshot);
    assert.equal(snapshot.includes("- 22222222"), false, "snapshot should exclude current session from recent list");
    assert.ok(snapshot.includes("[gateway, caching]"), "pinned notes in snapshot should show tags");
    if (hasDb) {
      assert.ok(snapshot.includes("11111111"), snapshot);
    }

    const deleted = executeTool("save_note", { deleteId: "DEMO-1001" }, { dataDir: root });
    assert.match(deleted, /Deleted note/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression: snippet cap never drops matchedAll, term diversity, in-flight self-match exclusion, swarm newest preservation, and artifact exact header", () => {
  clearStoreCaches();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-memory-reg-"));
  try {
    // 1) Pure brain/ fallback (no SQLite DB) + snippet cap + term diversity session
    const sDiv = "aaaa1111-0000-0000-0000-000000000001";
    const sDivLogs = path.join(root, "brain", sDiv, ".system_generated", "logs");
    const sDivSwarm = path.join(root, "brain", sDiv, ".system_generated", "swarm");
    fs.mkdirSync(sDivLogs, { recursive: true });
    fs.mkdirSync(sDivSwarm, { recursive: true });

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-10-24T10:00:00Z",
        content: "<USER_REQUEST>Fix alpha and beta together</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-10-24T10:01:00Z",
        content: "Root cause for beta wheel scrolling is mode 1007l.",
      }),
    ];
    for (let i = 2; i < 16; i += 1) {
      lines.push(
        JSON.stringify({
          step_index: i * 10,
          type: "PLANNER_RESPONSE",
          created_at: "2026-10-24T10:05:00Z",
          content: `Later alpha note number ${i}`,
        }),
      );
    }
    fs.writeFileSync(path.join(sDivLogs, "transcript.jsonl"), lines.join("\n") + "\n");

    // Large Swarm board WITHOUT members.json (85 messages; newest #85 must be preserved!)
    const boardLines: string[] = [];
    for (let seq = 1; seq <= 85; seq += 1) {
      const agent = seq === 69 ? "guard-worker" : seq === 70 ? "planner-worker" : seq === 85 ? "verifier" : "coordinator";
      const kind = seq >= 70 && seq <= 74 ? "brief" : "";
      const body =
        seq === 69
          ? "@coordinator [done] Fixed malformed packet tolerance in stream_decoder."
          : seq === 70
            ? "@planner-worker You own the throughput profiling sprint."
            : `Message #${seq} ${"x".repeat(260)} alpha beta marker`;
      boardLines.push(JSON.stringify({ seq, time: "2026-10-24 20:00:00", agent, kind, text: body }));
    }
    fs.writeFileSync(path.join(sDivSwarm, "board.jsonl"), boardLines.join("\n") + "\n");

    // Large Markdown artifact (220 lines) to test accurate shown-line header
    const bigArtLines = Array.from({ length: 220 }, (_, i) => `Line ${i + 1}: ${"content ".repeat(14)}`);
    fs.writeFileSync(path.join(root, "brain", sDiv, "big_plan.md"), bigArtLines.join("\n") + "\n");

    // 2) Brand-new active in-flight session whose ONLY match is USER_INPUT #0
    const sNow = "bbbb2222-0000-0000-0000-000000000002";
    const sNowLogs = path.join(root, "brain", sNow, ".system_generated", "logs");
    fs.mkdirSync(sNowLogs, { recursive: true });
    fs.writeFileSync(
      path.join(sNowLogs, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          created_at: new Date().toISOString(),
          content: "<USER_REQUEST>Search history for PHANTOM-4040 and 虚构代号</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          created_at: new Date().toISOString(),
          tool_calls: [{ name: "mcp_agy-memory_memory_search_sessions" }],
          content: "",
        }),
      ].join("\n") + "\n",
    );

    const divRes = executeTool("search_sessions", { query: "alpha beta", maxSnippetsPerSession: 3 }, { dataDir: root });
    assert.ok(divRes.includes("alpha") && divRes.includes("beta"), divRes);
    assert.ok(divRes.includes("#0") || divRes.includes("swarm:"), divRes);

    const negRes = executeTool("search_sessions", { query: "PHANTOM-4040" }, { dataDir: root });
    assert.ok(negRes.includes("No past conversations matched"), negRes);
    assert.ok(negRes.includes("excluded active in-flight prompt"), negRes);

    const swarmTail = executeTool("read_session", { sessionId: "aaaa1111", mode: "swarm", tailMessages: 50 }, { dataDir: root });
    assert.ok(swarmTail.includes("Board agents"), "should derive agents from board.jsonl when members.json is absent");
    assert.ok(swarmTail.includes("#85"), "newest message #85 must NEVER be truncated away");
    assert.ok(swarmTail.includes("newest preserved"), swarmTail);

    const swarmQuery = executeTool("read_session", { sessionId: "aaaa1111", mode: "swarm", query: "stream_decoder" }, { dataDir: root });
    assert.ok(swarmQuery.includes("#69") && swarmQuery.includes("guard-worker"), swarmQuery);

    const swarmSeq = executeTool("read_session", { sessionId: "aaaa1111", mode: "swarm", startSeq: 69, endSeq: 70 }, { dataDir: root });
    assert.ok(swarmSeq.includes("[#69 ") && swarmSeq.includes("[#70 "), swarmSeq);
    assert.equal(swarmSeq.includes("[#85 "), false);

    // 3) charOffset pagination on >8.2 KB turn & digest tool-only / milestone sampling on 24 turns
    const sLong = "cccc3333-0000-0000-0000-000000000003";
    const sLongLogs = path.join(root, "brain", sLong, ".system_generated", "logs");
    fs.mkdirSync(sLongLogs, { recursive: true });
    const longLines: string[] = [];
    for (let t = 0; t < 24; t += 1) {
      const uStep = t * 2;
      const aStep = t * 2 + 1;
      longLines.push(
        JSON.stringify({
          step_index: uStep,
          type: "USER_INPUT",
          created_at: "2026-10-24T11:00:00Z",
          content: `<USER_REQUEST>Investigate milestone topic ${t} in event pipeline</USER_REQUEST>`,
        }),
      );
      if (t === 5) {
        longLines.push(
          JSON.stringify({
            step_index: aStep,
            type: "PLANNER_RESPONSE",
            created_at: "2026-10-24T11:00:05Z",
            tool_calls: [{ name: "read_file" }, { name: "read_file" }, { name: "run_command" }],
            content: "",
          }),
        );
      } else if (t === 23) {
        longLines.push(
          JSON.stringify({
            step_index: aStep,
            type: "PLANNER_RESPONSE",
            created_at: "2026-10-24T11:05:00Z",
            content: `BIG_START ${"segment-detail ".repeat(700)} BIG_END_MARKER`,
          }),
        );
      } else {
        longLines.push(
          JSON.stringify({
            step_index: aStep,
            type: "PLANNER_RESPONSE",
            created_at: "2026-10-24T11:01:00Z",
            tool_calls: t === 10 ? [{ name: "read_file" }, { name: "run_command" }, { name: "edit_file" }] : [],
            content: `Completed analysis for milestone ${t}.`,
          }),
        );
      }
    }
    fs.writeFileSync(path.join(sLongLogs, "transcript.jsonl"), longLines.join("\n") + "\n");
    clearStoreCaches();

    const longDigest = executeTool("read_session", { sessionId: "cccc3333", mode: "digest" }, { dataDir: root });
    assert.ok(longDigest.includes("Turn 1") && longDigest.includes("Turn 24"), longDigest);
    assert.ok(longDigest.includes("read_file×2") || longDigest.includes("Turn 11"), longDigest);

    const chunk1 = executeTool("read_session", { sessionId: "cccc3333", mode: "turns", startStep: 46, endStep: 47 }, { dataDir: root });
    assert.ok(chunk1.includes("BIG_START"), chunk1);
    const offsetMatch = /charOffset=(\d+)/.exec(chunk1);
    assert.ok(offsetMatch && offsetMatch[1], `Expected charOffset continuation hint: ${chunk1.slice(-200)}`);
    const chunk2 = executeTool(
      "read_session",
      { sessionId: "cccc3333", mode: "turns", startStep: 46, endStep: 47, charOffset: Number(offsetMatch[1]) },
      { dataDir: root },
    );
    assert.ok(chunk2.includes("BIG_END_MARKER"), chunk2);

    const artSlice = executeTool(
      "read_session",
      { sessionId: "aaaa1111", mode: "artifacts", artifactName: "big_plan.md", startLine: 1, endLine: 220, maxChars: 2000 },
      { dataDir: root },
    );
    assert.match(artSlice, /showing lines 1-\d+ of 220; budget-truncated/);
    assert.equal(artSlice.includes("showing lines 1-220 of 220"), false);

    const artOob = executeToolResult(
      "read_session",
      { sessionId: "aaaa1111", mode: "artifacts", artifactName: "big_plan.md", startLine: 999 },
      { dataDir: root },
    );
    assert.equal(artOob.isError, true);
    assert.ok(artOob.text.includes("has only 220 lines"), artOob.text);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression: truncateUtf8 surrogate/byte safety, cross-platform workspaceMatches (POSIX + Windows), validation errors, and offline analytics", () => {
  // 1) Surrogate pair & strict byte/char bounds
  const emojiText = "hello 🚀🚀🚀 world ".repeat(40);
  const clipped = truncateUtf8(emojiText, 64, 80);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= 80, `exceeded maxBytes: ${Buffer.byteLength(clipped, "utf8")}`);
  assert.ok(clipped.length <= 64, `exceeded maxChars: ${clipped.length}`);
  for (let i = 0; i < clipped.length; i += 1) {
    const code = clipped.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = clipped.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, "lone high surrogate found");
      i += 1;
    } else {
      assert.equal(code >= 0xdc00 && code <= 0xdfff, false, "lone low surrogate found");
    }
  }

  const asciiBig = "a".repeat(12000);
  const asciiClip = truncateUtf8(asciiBig, 8640, 8650);
  assert.ok(Buffer.byteLength(asciiClip, "utf8") <= 8650, `ASCII byte overrun: ${Buffer.byteLength(asciiClip, "utf8")}`);

  const negClip = truncateUtf8("abcdef".repeat(200), -5, 8650);
  assert.ok(negClip.startsWith("abcdef"), negClip.slice(0, 30));

  // 2) Path-boundary workspaceMatches & noteWorkspaceMatches (POSIX + Windows)
  assert.equal(workspaceMatches(["/workspace/demo"], "/workspace/demo/cli-ui"), false);
  assert.equal(workspaceMatches(["/workspace/demo/cli-ui"], "/workspace/demo"), true);
  assert.equal(workspaceMatches(["/workspace/agy-memory"], "/workspace/agy"), false);
  assert.equal(noteWorkspaceMatches("/workspace/demo/cli-ui", "/workspace/demo/cli"), false);
  assert.equal(noteWorkspaceMatches("/workspace/demo", "/workspace/demo/cli-ui"), true);

  // Windows URI & path normalization
  assert.deepEqual(decodeWorkspaceUris('["file:///C:/Users/dev/my-app"]'), ["C:/Users/dev/my-app"]);
  assert.equal(workspaceMatches(["C:/Users/dev/my-app/sub"], "C:\\Users\\dev\\my-app"), true);
  assert.equal(workspaceMatches(["C:/Users/dev/my-app-other"], "C:\\Users\\dev\\my-app"), false);

  // 3) Strict validation errors
  const { root } = createFixtureDataDir();
  try {
    const badMode = executeToolResult("read_session", { sessionId: "11111111", mode: "bogus" }, { dataDir: root });
    assert.equal(badMode.isError, true);
    assert.ok(badMode.text.includes("Invalid mode"), badMode.text);

    const badScope = executeToolResult("search_sessions", { query: "test", scope: "bogus" }, { dataDir: root });
    assert.equal(badScope.isError, true);
    assert.ok(badScope.text.includes("Invalid scope"), badScope.text);

    const badRegex = executeToolResult("search_sessions", { query: "[unclosed", regex: true }, { dataDir: root });
    assert.equal(badRegex.isError, true);
    assert.ok(badRegex.text.includes("Invalid regular expression"), badRegex.text);

    const emptyQuotes = executeToolResult("search_sessions", { query: '""' }, { dataDir: root });
    assert.equal(emptyQuotes.isError, true);
    assert.ok(emptyQuotes.text.includes("query is required"), emptyQuotes.text);

    const oobStep = executeToolResult("read_session", { sessionId: "11111111", mode: "turns", startStep: 99999 }, { dataDir: root });
    assert.equal(oobStep.isError, true);
    assert.ok(oobStep.text.includes("Valid step range"), oobStep.text);

    // 4) Offline analytics
    const report = analyzeMemoryUsage({ dataDir: root, recent: 10 });
    assert.equal(report.overall.sessions, 2);
    const md = formatMemoryUsageMarkdown(report);
    assert.ok(md.includes("agy-memory Offline Transcript Analytics"), md);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled MCP stdio server handles JSONL, LSP (Content-Type before Content-Length), error codes, isError, and --cli mode", async () => {
  const { root, hasDb } = createFixtureDataDir();
  const serverPath = path.resolve(process.cwd(), "dist", "mcp-server.mjs");
  try {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, AGY_MEMORY_DATA_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: Array<Record<string, unknown>> = [];
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
      }
    });

    const send = (obj: unknown) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_sessions", arguments: { query: "OSC 8", toolSummary: "Search OSC 8" } },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_sessions", arguments: { query: "" } },
    });
    send({ jsonrpc: "2.0", id: 5 });
    child.stdin.write("{malformed json\n");
    child.stdin.end();

    await new Promise((resolve) => child.on("close", resolve));

    assert.equal(responses.length, 6);
    assert.equal(responses[0]!.id, 0);
    const initResult = responses[0]!.result as Record<string, unknown>;
    assert.equal((initResult.serverInfo as Record<string, unknown>).version, "0.3.0");
    assert.ok(typeof initResult.instructions === "string" && initResult.instructions.includes("list_sessions"));
    const listedTools = (responses[1]!.result as Record<string, unknown>).tools as Array<{
      name: string;
      description: string;
      annotations?: Record<string, unknown>;
    }>;
    assert.equal(listedTools.length, 5);
    for (const tool of listedTools) {
      assert.ok(tool.annotations && typeof tool.annotations.title === "string", `missing annotations on ${tool.name}`);
      assert.equal(tool.annotations.openWorldHint, false, `${tool.name} should be local-only`);
      if (tool.name === "save_note") {
        assert.equal(tool.annotations.readOnlyHint, false);
        assert.equal(tool.annotations.destructiveHint, true);
        assert.equal(tool.annotations.idempotentHint, false);
      } else {
        assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} should be readOnlyHint=true`);
        assert.equal(tool.annotations.destructiveHint, false);
        assert.equal(tool.annotations.idempotentHint, true);
      }
    }
    const searchText = (((responses[2]!.result as Record<string, unknown>).content as Array<{ text: string }>)[0]!).text;
    assert.ok(searchText.includes(hasDb ? "Terminal Link Wrapping Fix" : "22222222"), searchText);
    assert.equal((responses[3]!.result as Record<string, unknown>).isError, true);
    assert.equal((responses[4]!.error as Record<string, unknown>).code, -32600);
    assert.equal((responses[5]!.error as Record<string, unknown>).code, -32700);

    // LSP framing with Content-Type before Content-Length
    const lspChild = spawn(process.execPath, [serverPath], {
      env: { ...process.env, AGY_MEMORY_DATA_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let lspOut = "";
    lspChild.stdout.setEncoding("utf8");
    lspChild.stdout.on("data", (c: string) => {
      lspOut += c;
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    lspChild.stdin.write(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    );
    lspChild.stdin.end();
    await new Promise((resolve) => lspChild.on("close", resolve));
    assert.ok(lspOut.includes("Content-Length:"), `LSP frame failed: ${lspOut}`);
    assert.ok(lspOut.includes('"id":1'), lspOut);

    // --cli search & --cli stats
    const cliOut = execFileSync(process.execPath, [serverPath, "--cli", "search", "--data-dir", root, "限流熔断"], {
      encoding: "utf8",
    });
    assert.ok(cliOut.includes("11111111"), cliOut);

    const statsOut = execFileSync(process.execPath, [serverPath, "--cli", "stats", "--data-dir", root, "--json"], {
      encoding: "utf8",
    });
    const parsedStats = JSON.parse(statsOut) as { overall: { sessions: number } };
    assert.equal(parsedStats.overall.sessions, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
