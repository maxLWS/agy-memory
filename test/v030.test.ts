import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearAdapterCaches, createScanBudget, streamJsonlFromOffset } from "../src/adapters.js";
import { getMemoryIndexPath, getNotesPath, getTopicsDir, loadNotesWithDiagnostics } from "../src/notes.js";
import { searchSessionsResult } from "../src/search.js";
import { buildSessionStartSnapshot } from "../src/snapshot.js";
import { clearStoreCaches } from "../src/store.js";
import { executeToolResult, TOOL_DEFINITIONS } from "../src/tools.js";
import { clearTraceCaches } from "../src/trace.js";

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mem-v030-"));
  const dataDir = path.join(root, "agy-cli");
  const codexDir = path.join(root, "codex");
  const claudeDir = path.join(root, "claude");
  fs.mkdirSync(path.join(dataDir, "brain"), { recursive: true });
  fs.mkdirSync(path.join(codexDir, "sessions", "2026", "11", "25"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "projects", "demo-proj"), { recursive: true });

  const sharedId = "deadbeef-1111-2222-3333-444444444444";

  // 1. agy session with write_succeeded, write_failed, write_unverified, duplicate basename utils.py,
  //    exact rerun PASSED, unrelated-target rerun UNRESOLVED, and an artifact-filename-only hit
  const agyBrain = path.join(dataDir, "brain", sharedId);
  const agyLogs = path.join(agyBrain, ".system_generated", "logs");
  fs.mkdirSync(agyLogs, { recursive: true });
  fs.writeFileSync(path.join(agyBrain, "unique_artifact_name_xyz.md"), "# Notes\n\nBody without filename.\n", "utf8");
  fs.writeFileSync(
    path.join(agyLogs, "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        created_at: "2026-11-25T01:00:00Z",
        content: "<USER_REQUEST>\nFix cache key bug in packages/core/utils.py and apps/api/utils.py\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:05Z",
        tool_calls: [{ name: "edit_file", arguments: { Path: "/repo/packages/core/utils.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:06Z",
        content: "Made 1 replacement in /repo/packages/core/utils.py starting at line 10 (+1/-1 lines).",
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:10Z",
        tool_calls: [{ name: "edit_file", arguments: { Path: "/repo/apps/api/utils.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 4,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:11Z",
        content: "Encountered error in tool execution: Target not found",
      }),
      JSON.stringify({
        step_index: 5,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:12Z",
        tool_calls: [{ name: "edit_file", arguments: { Path: "/repo/packages/core/unverified.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 6,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:13Z",
        content: "Created At: 2026-11-25\nCompleted At: 2026-11-25\n...",
      }),
      JSON.stringify({
        step_index: 7,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:15Z",
        tool_calls: [{ name: "run_command", arguments: { CommandLine: "pytest -q -k cache tests/test_cache.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 8,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:16Z",
        content: "Command exited with code 1.\nAssertionError: KeyError cache_salt_missing",
      }),
      JSON.stringify({
        step_index: 9,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:20Z",
        tool_calls: [{ name: "edit_file", arguments: { Path: "/repo/packages/core/utils.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 10,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:21Z",
        content: "Made 1 replacement in /repo/packages/core/utils.py starting at line 20 (+2/-1 lines).",
      }),
      JSON.stringify({
        step_index: 11,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:25Z",
        tool_calls: [{ name: "run_command", arguments: { CommandLine: "pytest -q -k cache tests/test_cache.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 12,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:26Z",
        content: "Command exited with code 0.\n4 passed",
      }),
      // Failing test_alpha.py followed by passing test_beta.py sharing the same first 4 tokens -> MUST stay UNRESOLVED!
      JSON.stringify({
        step_index: 13,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:30Z",
        tool_calls: [{ name: "run_command", arguments: { CommandLine: "pytest -q -k suite tests/test_alpha.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 14,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:31Z",
        content: "Command exited with code 2.\nAssertionError: alpha_only_failure",
      }),
      JSON.stringify({
        step_index: 15,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:32Z",
        tool_calls: [{ name: "run_command", arguments: { CommandLine: "pytest -q -k suite tests/test_beta.py" } }],
        content: "",
      }),
      JSON.stringify({
        step_index: 16,
        type: "GENERIC",
        created_at: "2026-11-25T01:00:33Z",
        content: "Command exited with code 0.\n1 passed",
      }),
      JSON.stringify({
        step_index: 17,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T01:00:35Z",
        content: "Fixed cache_salt_missing in packages/core/utils.py; pytest now passes.",
      }),
    ].join("\n") + "\n",
  );

  // 2. Codex session with IDENTICAL native ID and enough turns to verify digest follow-up tip qualifier
  const codexRollout = path.join(codexDir, "sessions", "2026", "11", "25", `rollout-2026-11-25-${sharedId}.jsonl`);
  fs.writeFileSync(
    path.join(codexDir, "session_index.jsonl"),
    JSON.stringify({ id: sharedId, thread_name: "Codex Retry Backoff Patch", updated_at: "2026-11-25T02:00:00Z" }) + "\n",
  );
  const codexLines = [
    JSON.stringify({
      timestamp: "2026-11-25T02:00:00Z",
      type: "session_meta",
      payload: { id: sharedId, cwd: "/repo", timestamp: "2026-11-25T02:00:00Z" },
    }),
    JSON.stringify({
      timestamp: "2026-11-25T02:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Tune exponential backoff jitter in retry.ts to 250ms base." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-11-25T02:00:10Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Updated src/retry.ts backoff base to 250ms with full jitter." }],
      },
    }),
  ];
  for (let i = 2; i <= 14; i += 1) {
    codexLines.push(
      JSON.stringify({
        timestamp: `2026-11-25T02:0${Math.min(9, i % 10)}:00Z`,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Follow-up check ${i}` }] },
      }),
      JSON.stringify({
        timestamp: `2026-11-25T02:0${Math.min(9, i % 10)}:05Z`,
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Verified check ${i}` }] },
      }),
    );
  }
  fs.writeFileSync(codexRollout, codexLines.join("\n") + "\n");

  // 3. Two Claude Code sessions sharing prefix "claude99" (tests regex cold search + ambiguous targeted search)
  for (const suffix of ["aaaa", "bbbb"]) {
    const sid = `claude99-${suffix}-1111-2222-555555555555`;
    const claudeFile = path.join(claudeDir, "projects", "demo-proj", `${sid}.jsonl`);
    fs.writeFileSync(
      claudeFile,
      [
        JSON.stringify({
          type: "user",
          sessionId: sid,
          cwd: "/repo",
          timestamp: "2026-11-25T03:00:00Z",
          message: { role: "user", content: `Document PostgreSQL advisory lock strategy (${suffix}) in db_locks.ts` },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: sid,
          cwd: "/repo",
          timestamp: "2026-11-25T03:00:10Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Used pg_try_advisory_xact_lock (${suffix}) to avoid dangling locks.` }],
          },
        }),
      ].join("\n") + "\n",
    );
  }

  return { root, dataDir, codexDir, claudeDir, sharedId };
}

test("v0.3.0 trace requires positive write confirmation, exact command reruns, disambiguates paths, and reports partial scans", () => {
  const { root, dataDir } = mkFixture();
  clearStoreCaches();
  clearTraceCaches();
  try {
    const fileRes = executeToolResult("search_sessions", { query: "utils.py", mode: "file_history" }, { dataDir });
    assert.equal(fileRes.isError, false, fileRes.text);
    assert.ok(fileRes.text.includes("Disambiguation:"), fileRes.text);
    assert.ok(fileRes.text.includes("/repo/packages/core/utils.py"), fileRes.text);
    assert.ok(fileRes.text.includes("/repo/apps/api/utils.py"), fileRes.text);
    assert.ok(fileRes.text.includes("2 write_succeeded, 1 write_failed"), fileRes.text);

    // Unrecognized GENERIC response MUST NOT be certified as write_succeeded
    const unvRes = executeToolResult("search_sessions", { query: "unverified.py", mode: "file_history" }, { dataDir });
    assert.equal(unvRes.isError, false, unvRes.text);
    assert.ok(unvRes.text.includes("0 write_succeeded"), unvRes.text);
    assert.ok(unvRes.text.includes("1 write_unverified"), unvRes.text);

    // Exact matching rerun -> PASSED; different test target with same first 4 tokens -> UNRESOLVED
    const errResolved = executeToolResult("search_sessions", { query: "cache_salt_missing", mode: "error_history" }, { dataDir });
    assert.equal(errResolved.isError, false, errResolved.text);
    assert.ok(errResolved.text.includes("exit=1"), errResolved.text);
    assert.ok(errResolved.text.includes("candidate changes, not proven sole cause"), errResolved.text);
    assert.ok(errResolved.text.includes("PASSED at #11"), errResolved.text);

    const errDifferentTarget = executeToolResult("search_sessions", { query: "alpha_only_failure", mode: "error_history" }, { dataDir });
    assert.equal(errDifferentTarget.isError, false, errDifferentTarget.text);
    assert.ok(errDifferentTarget.text.includes("UNRESOLVED"), errDifferentTarget.text);
    assert.equal(errDifferentTarget.text.includes("PASSED at #15"), false);

    // Qualified path matching does not match arbitrary substrings
    const partialPath = executeToolResult("search_sessions", { query: "core/util", mode: "file_history" }, { dataDir });
    assert.ok(partialPath.text.includes("No file tool history matched"), partialPath.text);

    // Budget exhaustion must mark INCOMPLETE SCAN explicitly AND preserve partial progress
    clearTraceCaches();
    const incomplete = searchSessionsResult({
      dataDir,
      query: "utils.py",
      mode: "file_history",
      maxScanBytes: 200,
    });
    assert.ok(incomplete.text.includes("INCOMPLETE SCAN"), incomplete.text);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v0.3.0 Markdown notes enforce ID validation, strict CAS expectedRevision, read-only startup, and safe migration", () => {
  const { root, dataDir } = mkFixture();
  try {
    // Seed legacy notes.json
    const legacyPath = getNotesPath(dataDir);
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        notes: [
          {
            id: "abcd1234",
            topic: "Legacy Rate Limit",
            content: "Keep burst limit at 50 req/s.",
            workspace: "/repo",
            tags: ["ops"],
            sessionId: "deadbeef",
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
          },
        ],
      }),
    );

    // 1. SessionStart snapshot is STRICTLY read-only: reads legacy note without creating topics/ or marker
    const snap = buildSessionStartSnapshot({ conversationId: "deadbeef-1111-2222-3333-444444444444", cwd: "/repo" }, dataDir);
    assert.ok(snap.includes("Legacy Rate Limit"), snap);
    assert.ok(snap.includes('excludeSessionId="agy:deadbeef-1111-2222-3333-444444444444"'), snap);
    assert.equal(fs.existsSync(getTopicsDir(dataDir)), false, "SessionStart must not migrate/write on disk");

    // 2. Explicit memory load migrates legacy notes.json AND builds MEMORY.md
    const migrated = loadNotesWithDiagnostics(dataDir);
    assert.equal(migrated.notes.length, 1);
    assert.equal(migrated.notes[0]!.id, "abcd1234");
    assert.ok(fs.existsSync(path.join(getTopicsDir(dataDir), "abcd1234.md")));
    assert.ok(fs.existsSync(getMemoryIndexPath(dataDir)));

    // 3. Reject invalid/path-traversal note IDs
    const badId = executeToolResult("save_note", { id: "../escape", topic: "Bad", content: "x" }, { dataDir });
    assert.equal(badId.isError, true, badId.text);

    // 4. Save new note with indented Markdown -> returns Path + Revision, preserves indentation
    const saved = executeToolResult(
      "save_note",
      { topic: "Cache Policy", content: "    indented_code_block()\n\nLine 2.", workspace: "/repo", tags: ["cache"] },
      { dataDir },
    );
    assert.equal(saved.isError, false, saved.text);
    const idMatch = /\[([0-9a-f]{8})\]/.exec(saved.text);
    const revMatch = /Revision:\s*([0-9a-f]{12})/.exec(saved.text);
    assert.ok(idMatch && revMatch, saved.text);
    const newId = idMatch![1]!;
    const rev1 = revMatch![1]!;

    // 5. Recall returns Revision and preserves leading indentation
    const recalled = executeToolResult("recall_notes", { query: "indented_code_block" }, { dataDir });
    assert.ok(recalled.text.includes(`Revision: ${rev1}`), recalled.text);
    assert.ok(recalled.text.includes("    indented_code_block()"), recalled.text);

    // 6. Stale expectedRevision update MUST FAIL and preserve live file untouched (no conflict sidecar)
    const staleUpdate = executeToolResult(
      "save_note",
      { id: newId, topic: "Cache Policy", content: "Stale overwrite attempt", expectedRevision: "000000000000" },
      { dataDir },
    );
    assert.equal(staleUpdate.isError, true, staleUpdate.text);
    assert.ok(staleUpdate.text.includes("Revision conflict"), staleUpdate.text);
    assert.ok(fs.readFileSync(path.join(getTopicsDir(dataDir), `${newId}.md`), "utf8").includes("indented_code_block()"));

    // 7. Valid expectedRevision ID-only update succeeds AND preserves existing workspace "/repo"
    const validUpdate = executeToolResult(
      "save_note",
      { id: newId, topic: "Cache Policy", content: "Updated tenant isolation rule.", expectedRevision: rev1 },
      { dataDir },
    );
    assert.equal(validUpdate.isError, false, validUpdate.text);
    assert.ok(validUpdate.text.includes("(/repo)"), validUpdate.text);
    const rev2 = /Revision:\s*([0-9a-f]{12})/.exec(validUpdate.text)![1]!;

    // 8. Malformed file on disk is surfaced as warning AND cannot be overwritten via save_note(id=...)
    const badPath = path.join(getTopicsDir(dataDir), "corrupt99.md");
    fs.writeFileSync(badPath, "---\nschema: 1\nid: \"corrupt99\"\ntopic: \"unterminated\n---\nbody", "utf8");
    const overwriteMalformed = executeToolResult(
      "save_note",
      { id: "corrupt99", topic: "Clobber", content: "Should fail" },
      { dataDir },
    );
    assert.equal(overwriteMalformed.isError, true, overwriteMalformed.text);
    assert.ok(fs.readFileSync(badPath, "utf8").includes("unterminated"));

    // 9. Stale expectedRevision delete fails; valid delete succeeds; updating deleted note with revision fails
    const staleDel = executeToolResult("save_note", { deleteId: newId, expectedRevision: rev1 }, { dataDir });
    assert.equal(staleDel.isError, true, staleDel.text);
    const okDel = executeToolResult("save_note", { deleteId: newId, expectedRevision: rev2 }, { dataDir });
    assert.equal(okDel.isError, false, okDel.text);
    const recreateDeleted = executeToolResult(
      "save_note",
      { id: newId, topic: "Cache Policy", content: "Ghost", expectedRevision: rev2 },
      { dataDir },
    );
    assert.equal(recreateDeleted.isError, true, recreateDeleted.text);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v0.3.0 cross-harness search fixes regex cold false-negatives, rejects ambiguous targeted search, and streams safely", () => {
  const { root, dataDir, codexDir, claudeDir, sharedId } = mkFixture();
  const prevCodex = process.env.CODEX_HOME;
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = codexDir;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  clearStoreCaches();
  clearAdapterCaches();
  clearTraceCaches();
  try {
    // 1. Default source is strictly 'agy'; artifact-filename-only hit is NOT dropped by rg prefilter
    const agyOnly = executeToolResult("list_sessions", {}, { dataDir });
    assert.ok(agyOnly.text.includes("sources: agy:1"), agyOnly.text);
    assert.equal(agyOnly.text.includes("Codex Retry Backoff"), false);

    const artNameHit = executeToolResult("search_sessions", { query: "unique_artifact_name_xyz" }, { dataDir });
    assert.equal(artNameHit.isError, false, artNameHit.text);
    assert.ok(artNameHit.text.includes("deadbeef"), artNameHit.text);

    // 2. Cold regex search `^[^{]` on Claude MUST NOT return false-negative 0 (bypasses raw JSONL rg prefilter)
    const coldRegex = executeToolResult(
      "search_sessions",
      { query: "^[^{]", regex: true, source: "claude", scope: "user" },
      { dataDir },
    );
    assert.equal(coldRegex.isError, false, coldRegex.text);
    assert.ok(coldRegex.text.includes("2 matching conversation"), coldRegex.text);

    // 3. Ambiguous targeted search_sessions(sessionId="claude99") MUST reject just like read_session
    const ambigSearch = executeToolResult(
      "search_sessions",
      { query: "advisory", sessionId: "claude99", source: "claude" },
      { dataDir },
    );
    assert.equal(ambigSearch.isError, true, ambigSearch.text);
    assert.ok(ambigSearch.text.includes("Ambiguous"), ambigSearch.text);

    // 4. External digest follow-up tip includes source qualifier (codex:<id>)
    const codexDigest = executeToolResult("read_session", { sessionId: `codex:${sharedId}`, mode: "digest" }, { dataDir });
    assert.equal(codexDigest.isError, false, codexDigest.text);
    assert.ok(codexDigest.text.includes("250ms"), codexDigest.text);
    assert.ok(codexDigest.text.includes(`sessionId="codex:${sharedId.slice(0, 8)}"`), codexDigest.text);

    // 5. External trace mode reports explicit agy-only error cleanly (no unverified external trace claims)
    const extTrace = executeToolResult(
      "search_sessions",
      { query: "retry.ts", mode: "file_history", source: "codex" },
      { dataDir },
    );
    assert.equal(extTrace.isError, true, extTrace.text);
    assert.ok(extTrace.text.includes("Antigravity (agy) sessions only"), extTrace.text);

    // 6. streamJsonlFromOffset: unterminated partial JSON line is not prematurely skipped; I/O error sets incomplete
    const liveFile = path.join(root, "live.jsonl");
    const line1 = JSON.stringify({ step: 1 }) + "\n";
    const partial = '{"step":2,"text":"half';
    fs.writeFileSync(liveFile, line1 + partial, "utf8");
    const seen: string[] = [];
    const r1 = streamJsonlFromOffset(liveFile, 0, (l) => seen.push(l));
    assert.equal(seen.length, 1);
    assert.equal(r1.newOffset, Buffer.byteLength(line1, "utf8"));
    fs.appendFileSync(liveFile, '_done"}\n', "utf8");
    const r2 = streamJsonlFromOffset(liveFile, r1.newOffset, (l) => seen.push(l));
    assert.equal(seen.length, 2);
    assert.equal(r2.eof, true);

    const errBudget = createScanBudget();
    const missing = streamJsonlFromOffset(path.join(root, "does-not-exist.jsonl"), 0, () => {}, errBudget);
    assert.equal(missing.ioError, true);
    assert.equal(errBudget.incomplete, true);

    // 7. Eager tool count stays 5 with zero experiment hooks
    assert.equal(TOOL_DEFINITIONS.length, 5);
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
