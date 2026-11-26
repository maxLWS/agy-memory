import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { boardPostResult, boardReadResult, migrateLegacyNotes } from "../src/board.js";
import {
  decodeTrajectoryMetadata,
  decodeTrajectoryProjectId,
  formatScopeKey,
  readConversationDbMeta,
  resolveGitCommonDir,
  resolveScopeKey,
  scopeKeyToBoardDir,
} from "../src/scope.js";
import { buildSessionStartSnapshot, INLINE_BOARD_BYTE_CAP, renderBoardSnapshotSection } from "../src/snapshot.js";
import { clearStoreCaches, loadMultiClientCatalog, loadSingleRootCatalog } from "../src/store.js";
import { checkScanBudget, createScanBudget, streamJsonlFromOffset } from "../src/stream.js";
import { executeTool, executeToolResult } from "../src/tools.js";
import { clearTraceCaches } from "../src/trace.js";

function encodeVarint(val: number): Buffer {
  const bytes: number[] = [];
  let v = BigInt(val);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function encodeStringField(fieldNum: number, value: string): Buffer {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const payload = Buffer.from(value, "utf8");
  return Buffer.concat([tag, encodeVarint(payload.length), payload]);
}

let cachedPython: { bin: string; prefix: string[] } | null = null;

function getPythonCommand(): { bin: string; prefix: string[] } {
  if (cachedPython) return cachedPython;
  const candidates =
    process.platform === "win32"
      ? [
          { bin: "python", prefix: [] as string[] },
          { bin: "py", prefix: ["-3"] },
          { bin: "python3", prefix: [] as string[] },
        ]
      : [
          { bin: "python3", prefix: [] as string[] },
          { bin: "/usr/bin/python3", prefix: [] as string[] },
          { bin: "python", prefix: [] as string[] },
        ];
  for (const cand of candidates) {
    try {
      execFileSync(cand.bin, [...cand.prefix, "-c", "import sqlite3"], { stdio: "ignore" });
      cachedPython = cand;
      return cand;
    } catch {
    }
  }
  throw new Error("No python with sqlite3 found for test fixture generation");
}

function runPySqlite(script: string, args: string[]): void {
  const py = getPythonCommand();
  execFileSync(py.bin, [...py.prefix, "-c", script, ...args], { stdio: "pipe" });
}

function spawnPySqlite(script: string, args: string[]) {
  const py = getPythonCommand();
  return spawn(py.bin, [...py.prefix, "-c", script, ...args]);
}

function createSummariesDb(
  dbPath: string,
  rows: Array<{
    id: string;
    title: string;
    steps: number;
    mtime: string;
    ws: string[];
    projectId: string;
    appDataDir: string;
    notFullyIdle?: number;
  }>,
): void {
  const py = `
import json, pathlib, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA journal_mode=WAL")
con.execute("""
CREATE TABLE conversation_summaries (
  conversation_id text PRIMARY KEY,
  title text NOT NULL DEFAULT "",
  preview text NOT NULL DEFAULT "",
  step_count integer NOT NULL DEFAULT 0,
  last_modified_time datetime NOT NULL,
  workspace_uris text NOT NULL,
  status text NOT NULL DEFAULT "",
  project_id text NOT NULL DEFAULT "",
  app_data_dir text NOT NULL DEFAULT "",
  not_fully_idle numeric NOT NULL DEFAULT 0,
  parent_conversation_id text NOT NULL DEFAULT "",
  nesting_depth integer NOT NULL DEFAULT 0,
  last_user_input_time datetime NOT NULL
)""")
def to_uri(w):
  try:
    return pathlib.Path(w).as_uri()
  except ValueError:
    return "file://" + w
for r in json.loads(sys.argv[2]):
  uris = json.dumps([to_uri(w) for w in r["ws"]])
  con.execute(
    "INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (r["id"], r["title"], "", r["steps"], r["mtime"], uris, "IDLE", r["projectId"], r["appDataDir"], r.get("notFullyIdle", 0), "", 0, r["mtime"])
  )
con.commit()
con.close()
`;
  runPySqlite(py, [dbPath, JSON.stringify(rows)]);
}

function createConversationDb(dbPath: string, blob: Buffer): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const py = `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA journal_mode=WAL")
con.execute("CREATE TABLE trajectory_metadata_blob (id text PRIMARY KEY, data blob)")
con.execute("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)", (bytes.fromhex(sys.argv[2]),))
con.commit()
con.close()
`;
  runPySqlite(py, [dbPath, blob.toString("hex")]);
}

function writeTranscript(dataDir: string, sid: string, lines: unknown[]): void {
  const logDir = path.join(dataDir, "brain", sid, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "transcript.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

test("ScopeKey resolves 4 classes, linked Git worktrees, dual projects sharing one folder, and 3-client merge", () => {
  clearStoreCaches();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-scope-"));
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevDataDir = process.env.AGY_MEMORY_DATA_DIR;
  try {
    const geminiHome = path.join(tmp, "gemini");
    const appDir = path.join(geminiHome, "antigravity");
    const cliDir = path.join(geminiHome, "antigravity-cli");
    const ideDir = path.join(geminiHome, "antigravity-ide");
    const boardsHome = path.join(tmp, "boards");
    const sharedRepo = path.join(tmp, "shared-repo");
    const nonGitDir = path.join(tmp, "plain-notes");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(ideDir, { recursive: true });
    fs.mkdirSync(sharedRepo, { recursive: true });
    fs.mkdirSync(nonGitDir, { recursive: true });

    // Real git repo + linked worktree
    execFileSync("git", ["init", "-q"], { cwd: sharedRepo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sharedRepo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: sharedRepo });
    fs.writeFileSync(path.join(sharedRepo, "README.md"), "hello\n");
    execFileSync("git", ["add", "README.md"], { cwd: sharedRepo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: sharedRepo });
    const wtDir = path.join(tmp, "wt-branch");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat-wt", wtDir], { cwd: sharedRepo });

    const commonMain = resolveGitCommonDir(sharedRepo);
    const commonWt = resolveGitCommonDir(wtDir);
    assert.ok(commonMain.endsWith("/.git"), commonMain);
    assert.equal(commonMain, commonWt, "linked worktree must resolve to identical git common dir");

    // 4 ScopeKey classes
    const sProjA = resolveScopeKey({ projectId: "proj-alpha", workspaces: [sharedRepo] });
    const sProjB = resolveScopeKey({ projectId: "proj-beta", workspaces: [sharedRepo] });
    const sCliRepoMain = resolveScopeKey({ projectId: "default-cli-project", workspaces: [sharedRepo] });
    const sCliRepoWt = resolveScopeKey({ projectId: "default-cli-project", workspaces: [wtDir] });
    const sCliWs = resolveScopeKey({ projectId: "default-cli-project", workspaces: [nonGitDir] });
    const sUnres = resolveScopeKey({ projectId: "", workspaces: [sharedRepo] });

    assert.equal(formatScopeKey(sProjA), "project/proj-alpha");
    assert.equal(formatScopeKey(sProjB), "project/proj-beta");
    assert.notEqual(scopeKeyToBoardDir(sProjA, boardsHome), scopeKeyToBoardDir(sProjB, boardsHome));
    assert.equal(formatScopeKey(sCliRepoMain), formatScopeKey(sCliRepoWt));
    assert.equal(sCliWs.kind, "cli_workspace");
    assert.equal(sUnres.kind, "unresolved");

    // Seed 3 client dirs with overlapping conversation + two named projects sharing one folder
    const nowIso = new Date().toISOString();
    const olderIso = new Date(Date.now() - 60_000).toISOString();
    const idAlpha1 = "aaaa0001-1111-2222-3333-444444444444";
    const idAlpha2 = "aaaa0002-1111-2222-3333-444444444444";
    const idBeta1 = "bbbb0001-1111-2222-3333-444444444444";
    const idCliWt = "cccc0001-1111-2222-3333-444444444444";

    createSummariesDb(path.join(appDir, "conversation_summaries.db"), [
      { id: idAlpha1, title: "Alpha App", steps: 10, mtime: nowIso, ws: [sharedRepo], projectId: "proj-alpha", appDataDir: "antigravity" },
      { id: idBeta1, title: "Beta App", steps: 10, mtime: nowIso, ws: [sharedRepo], projectId: "proj-beta", appDataDir: "antigravity" },
    ]);
    createSummariesDb(path.join(cliDir, "conversation_summaries.db"), [
      { id: idAlpha1, title: "Alpha Older Dup", steps: 4, mtime: olderIso, ws: [sharedRepo], projectId: "proj-alpha", appDataDir: "antigravity-cli" },
      { id: idCliWt, title: "CLI Worktree", steps: 6, mtime: nowIso, ws: [wtDir], projectId: "default-cli-project", appDataDir: "antigravity-cli" },
    ]);
    createSummariesDb(path.join(ideDir, "conversation_summaries.db"), [
      { id: idAlpha2, title: "Alpha IDE", steps: 8, mtime: nowIso, ws: [sharedRepo], projectId: "proj-alpha", appDataDir: "antigravity-ide" },
    ]);

    writeTranscript(appDir, idAlpha1, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso, content: "Set secret canary ALPHA_ONLY_991" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: nowIso, content: "Recorded ALPHA_ONLY_991." },
    ]);
    writeTranscript(appDir, idBeta1, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso, content: "Set secret canary BETA_ONLY_772" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: nowIso, content: "Recorded BETA_ONLY_772." },
    ]);
    writeTranscript(ideDir, idAlpha2, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso, content: "Alpha IDE turn" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: nowIso, content: "IDE ready." },
    ]);

    process.env.GEMINI_HOME = geminiHome;
    delete process.env.AGY_MEMORY_DATA_DIR;
    clearStoreCaches();

    const { entries } = loadMultiClientCatalog();
    assert.equal(entries.length, 4, "3 clients deduplicated into 4 unique sessions");
    const alphaEntry = entries.find((e) => e.sessionId === idAlpha1)!;
    assert.equal(alphaEntry.client, "app", "newest duplicate wins across clients");

    // Scoped search in Alpha sees Alpha IDE + App, NEVER Beta even though both share `sharedRepo`
    const alphaSearch = executeTool("search_sessions", { conversationId: idAlpha2, query: "canary" }, { boardsHome });
    assert.ok(alphaSearch.includes("ALPHA_ONLY_991"), alphaSearch);
    assert.equal(alphaSearch.includes("BETA_ONLY_772"), false, "must NOT bleed Beta into Alpha");

    // Dual-project boards on identical folder stay strictly isolated
    boardPostResult({ scope: sProjA, key: "port", body: "Alpha uses port 4001", boardsHome });
    boardPostResult({ scope: sProjB, key: "port", body: "Beta uses port 5002", boardsHome });

    const snapAlpha = buildSessionStartSnapshot(
      { conversationId: idAlpha2, workspacePaths: [sharedRepo] },
      { boardsHome },
    );
    assert.ok(snapAlpha.includes("Alpha uses port 4001"), snapAlpha);
    assert.equal(snapAlpha.includes("Beta uses port 5002"), false);
    assert.ok(snapAlpha.includes("Activity: 1 other active or recent session(s)"), snapAlpha);

    const snapBeta = buildSessionStartSnapshot(
      { conversationId: idBeta1, workspacePaths: [sharedRepo] },
      { boardsHome },
    );
    assert.ok(snapBeta.includes("Beta uses port 5002"), snapBeta);
    assert.equal(snapBeta.includes("Alpha uses port 4001"), false);
    assert.equal(snapBeta.includes("Activity:"), false, "Beta has 0 sibling sessions");
  } finally {
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevDataDir === undefined) delete process.env.AGY_MEMORY_DATA_DIR;
    else process.env.AGY_MEMORY_DATA_DIR = prevDataDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Protobuf field-18 + field-7 decoder handles valid blobs, conflicts, corruption, and WAL-visible SessionStart fallback", () => {
  const validBlob = Buffer.concat([
    encodeStringField(6, "d7a93984-cfc4-44c4-8577-0016b477f092"),
    encodeStringField(7, "file:///workspace/demo"),
    encodeStringField(18, "proj-alpha-test"),
  ]);
  const meta = decodeTrajectoryMetadata(validBlob);
  assert.ok(meta);
  assert.equal(meta.projectId, "proj-alpha-test");
  assert.deepEqual(meta.workspaces, ["/workspace/demo"]);

  // Nested raw 0x92 0x01 inside another field must NOT be misread as top-level field 18
  const decoyBytes = Buffer.from([0x92, 0x01, 0x04, 0x65, 0x76, 0x69, 0x6c]);
  const wrappedDecoy = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(decoyBytes.length), decoyBytes]);
  assert.equal(decodeTrajectoryProjectId(wrappedDecoy), null);

  // Conflicting duplicate field 18 -> null (-> unresolved)
  const conflicting = Buffer.concat([encodeStringField(18, "proj-a"), encodeStringField(18, "proj-b")]);
  assert.equal(decodeTrajectoryProjectId(conflicting), null);

  // Truncated length, bad wire type 3, invalid UTF-8 -> null
  assert.equal(decodeTrajectoryProjectId(Buffer.from([0x92, 0x01, 0x10, 0x41, 0x42])), null);
  assert.equal(decodeTrajectoryProjectId(Buffer.from([(2 << 3) | 3])), null);
  assert.equal(decodeTrajectoryProjectId(Buffer.concat([encodeVarint((18 << 3) | 2), encodeVarint(2), Buffer.from([0xff, 0xfe])])), null);

  // Live conversation DB fallback before summaries DB has the row
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-proto-"));
  try {
    const cliDir = path.join(tmp, "antigravity-cli");
    const boardsHome = path.join(tmp, "boards");
    const cid = "f1112222-3333-4444-5555-666666666666";
    createConversationDb(path.join(cliDir, "conversations", `${cid}.db`), validBlob);
    boardPostResult({
      scope: { kind: "project", projectId: "proj-alpha-test" },
      key: "turn0-rule",
      body: "Visible on Turn 0 via conversations/<id>.db field 18.",
      boardsHome,
    });

    const snap = buildSessionStartSnapshot(
      {
        conversationId: cid,
        transcriptPath: path.join(cliDir, "brain", cid, ".system_generated", "logs", "transcript_full.jsonl"),
        workspacePaths: ["/workspace/demo"],
      },
      { overrideDataDir: cliDir, boardsHome },
    );
    assert.ok(snap.includes("scope=project/proj-alpha-test"), snap);
    assert.ok(snap.includes("Visible on Turn 0 via conversations/<id>.db field 18."), snap);

    // Unknown conversation without DB or conversation .db -> unresolved (suppresses board + hints)
    const unresSnap = buildSessionStartSnapshot(
      { conversationId: "99999999-aaaa-bbbb-cccc-dddddddddddd", workspacePaths: ["/workspace/demo"] },
      { overrideDataDir: cliDir, boardsHome },
    );
    assert.ok(unresSnap.includes("scope=unresolved"), unresSnap);
    assert.equal(unresSnap.includes("Project board"), false);
    assert.equal(unresSnap.includes("Activity:"), false);

    // Path traversal conversationId rejected
    assert.equal(readConversationDbMeta(cliDir, "../evil").projectId, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Board persistence enforces per-key CAS conflict under multi-process contention, lock-free distinct keys, and WAL busy_timeout", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-race-"));
  const boardsHome = path.join(tmp, "boards");
  const serverPath = path.resolve(process.cwd(), "dist", "mcp-server.mjs");
  try {
    const scope = { kind: "project" as const, projectId: "race-proj" };
    const created = boardPostResult({ scope, key: "shared-key", body: "v0", boardsHome });
    assert.equal(created.isError, false);
    const rev0 = /Revision:\s*([0-9a-f]{12})/.exec(created.text)![1]!;

    // Barrier-start two independent child processes racing to update the same key + revision
    const runChild = (args: string[]) =>
      new Promise<{ status: number; stdout: string }>((resolve) => {
        const ch = spawn(process.execPath, [serverPath, "--cli", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        ch.stdout.setEncoding("utf8");
        ch.stdout.on("data", (d: string) => { stdout += d; });
        ch.on("close", (code) => resolve({ status: code ?? 1, stdout }));
      });

    const [r1, r2] = await Promise.all([
      runChild(["board-post", "--boards-home", boardsHome, "--scope", "project/race-proj", "--key", "shared-key", "--body", "writer-1", "--rev", rev0]),
      runChild(["board-post", "--boards-home", boardsHome, "--scope", "project/race-proj", "--key", "shared-key", "--body", "writer-2", "--rev", rev0]),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [0, 1], `Expected exactly one success and one CAS conflict: r1=${r1.stdout} r2=${r2.stdout}`);
    const failedOut = r1.status === 1 ? r1.stdout : r2.stdout;
    assert.match(failedOut, /Revision conflict/);

    // Race distinct keys concurrently -> both succeed
    const [d1, d2] = await Promise.all([
      runChild(["board-post", "--boards-home", boardsHome, "--scope", "project/race-proj", "--key", "key-alpha", "--body", "alpha-val"]),
      runChild(["board-post", "--boards-home", boardsHome, "--scope", "project/race-proj", "--key", "key-beta", "--body", "beta-val"]),
    ]);
    assert.equal(d1.status, 0, d1.stdout);
    assert.equal(d2.status, 0, d2.stdout);
    const allRead = boardReadResult({ scope, boardsHome });
    assert.ok(allRead.text.includes("alpha-val") && allRead.text.includes("beta-val"), allRead.text);

    // SQLite WAL busy_timeout recovery (lock held 250ms < 1000ms timeout)
    const dbDir = path.join(tmp, "wal-client");
    const cid = "eeee0001-1111-2222-3333-444444444444";
    const convDb = path.join(dbDir, "conversations", `${cid}.db`);
    createConversationDb(convDb, encodeStringField(18, "wal-proj"));

    const lockProc = spawnPySqlite(
      "import sqlite3, sys, time\ncon=sqlite3.connect(sys.argv[1])\ncon.execute('BEGIN IMMEDIATE')\nprint('LOCKED', flush=True)\ntime.sleep(0.25)\ncon.commit()\ncon.close()\n",
      [convDb],
    );
    await new Promise<void>((resolve) => {
      lockProc.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("LOCKED")) resolve();
      });
    });
    const readUnderLock = readConversationDbMeta(dbDir, cid, 1200);
    await new Promise((resolve) => lockProc.on("close", resolve));
    assert.equal(readUnderLock.projectId, "wal-proj", "WAL read should succeed cleanly alongside writer");

    // Legacy v0.3 notes migration uses plugin_data/agy-memory/memory/topics, supports dryRun, and is idempotent
    const legacyDir = path.join(tmp, "legacy");
    const topicsDir = path.join(legacyDir, "plugin_data", "agy-memory", "memory", "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    const legacyFile = path.join(topicsDir, "keep-gpu.md");
    fs.writeFileSync(legacyFile, '---\nschema: 1\nid: "keep-gpu"\ntopic: "GPU Guard"\n---\nUse smart_keep_gpu.\n');
    const dry = migrateLegacyNotes({ sourceDataDir: legacyDir, targetScope: { kind: "global" }, boardsHome, dryRun: true });
    assert.equal(dry.imported, 1);
    assert.equal(dry.skipped, 0);
    const m1 = migrateLegacyNotes({ sourceDataDir: legacyDir, targetScope: { kind: "global" }, boardsHome });
    assert.equal(m1.imported, 1);
    assert.ok(fs.existsSync(legacyFile), "original legacy file must remain untouched");
    const m2 = migrateLegacyNotes({ sourceDataDir: legacyDir, targetScope: { kind: "global" }, boardsHome });
    assert.equal(m2.imported, 0);
    assert.equal(m2.skipped, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("SessionStart enforces exact 1536-byte UTF-8 inline-vs-index boundary without mid-entry truncation", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-cap-"));
  const boardsHome = path.join(tmp, "boards");
  try {
    const scope = { kind: "project" as const, projectId: "cap-test" };
    const fixedNow = Date.parse("2026-11-26T00:00:00Z");

    // Measure empty/small overhead, then craft exact 1535B, 1536B, and 1537B boards including multi-byte CJK
    boardPostResult({ scope, key: "entry-one", title: "中文规则", body: "测试条目一：保持稳定。", boardsHome });
    const probe = renderBoardSnapshotSection(scope, boardsHome, fixedNow);
    assert.equal(probe.mode, "inline");

    // Add second entry tuned to hit exact byte boundaries around 1536
    const overheadCheck = boardPostResult({ scope, key: "entry-two", body: "X", boardsHome });
    let rev = /Revision:\s*([0-9a-f]{12})/.exec(overheadCheck.text)![1]!;
    const withOneX = renderBoardSnapshotSection(scope, boardsHome, fixedNow);
    const needed = INLINE_BOARD_BYTE_CAP - withOneX.renderedBytes;
    assert.ok(needed > 10, `expected room, got ${needed}`);

    // 1535 bytes -> inline
    const r1535 = boardPostResult({ scope, key: "entry-two", body: "X".repeat(needed), expectedRevision: rev, boardsHome });
    rev = /Revision:\s*([0-9a-f]{12})/.exec(r1535.text)![1]!;
    const s1535 = renderBoardSnapshotSection(scope, boardsHome, fixedNow);
    assert.equal(s1535.renderedBytes, INLINE_BOARD_BYTE_CAP - 1);
    assert.equal(s1535.mode, "inline");

    // 1536 bytes -> inline (exact cap)
    const r1536 = boardPostResult({ scope, key: "entry-two", body: "X".repeat(needed + 1), expectedRevision: rev, boardsHome });
    rev = /Revision:\s*([0-9a-f]{12})/.exec(r1536.text)![1]!;
    const s1536 = renderBoardSnapshotSection(scope, boardsHome, fixedNow);
    assert.equal(s1536.renderedBytes, INLINE_BOARD_BYTE_CAP);
    assert.equal(s1536.mode, "inline");

    // 1537 bytes -> clean index degradation (lists both complete keys, zero body chopping)
    const r1537 = boardPostResult({ scope, key: "entry-two", body: "X".repeat(needed + 2), expectedRevision: rev, boardsHome });
    assert.equal(r1537.isError, false);
    const s1537 = renderBoardSnapshotSection(scope, boardsHome, fixedNow);
    assert.equal(s1537.mode, "index");
    assert.ok(s1537.text.includes("- entry-one"), s1537.text);
    assert.ok(s1537.text.includes("- entry-two"), s1537.text);
    assert.ok(s1537.text.includes("call board_read"), s1537.text);
    assert.equal(s1537.text.includes("XXXX"), false, "index mode must not leak chopped body fragments");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Trace file_history, error_history, and streaming resume work cleanly without hardcoded vendor names", () => {
  clearStoreCaches();
  clearTraceCaches();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-trace-"));
  try {
    const sid = "dddd0001-1111-2222-3333-444444444444";
    const nowIso = new Date().toISOString();
    createSummariesDb(path.join(tmp, "conversation_summaries.db"), [
      { id: sid, title: "Trace Session", steps: 10, mtime: nowIso, ws: ["/repo"], projectId: "default-cli-project", appDataDir: "antigravity-cli" },
    ]);
    writeTranscript(tmp, sid, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso, content: "Edit app.ts and run pytest" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "custom_apply_edits", args: { cwd: "/repo", edits: [{ path: "src/app.ts" }] } }],
      },
      { step_index: 2, type: "GENERIC", created_at: nowIso, content: "Applied 1 edit to 1 file." },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "run_command", args: { CommandLine: "pytest tests/test_app.py", Cwd: "/repo" } }],
      },
      { step_index: 4, type: "GENERIC", created_at: nowIso, content: "Command exited with code 1\nAssertionError: boom" },
      {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        created_at: nowIso,
        tool_calls: [{ name: "run_command", args: { CommandLine: "pytest tests/test_app.py", Cwd: "/repo" } }],
      },
      { step_index: 6, type: "GENERIC", created_at: nowIso, content: "Command exited with code 0\n1 passed" },
    ]);

    const fh = executeToolResult("search_sessions", { mode: "file_history", query: "app.ts", allScopes: true }, { dataDir: tmp });
    assert.equal(fh.isError, false);
    assert.ok(fh.text.includes("1 write_succeeded"), fh.text);

    const eh = executeToolResult("search_sessions", { mode: "error_history", query: "AssertionError", allScopes: true }, { dataDir: tmp });
    assert.equal(eh.isError, false);
    assert.ok(eh.text.includes("exit=1"), eh.text);
    assert.ok(eh.text.includes("Later matching rerun: PASSED at #5"), eh.text);

    // Streaming budget partial resume
    const bigFile = path.join(tmp, "big.jsonl");
    const line = JSON.stringify({ n: 1, pad: "a".repeat(1000) });
    fs.writeFileSync(bigFile, `${Array.from({ length: 200 }, () => line).join("\n")}\n`);
    const b1 = createScanBudget(50_000, 2000);
    let count1 = 0;
    const r1 = streamJsonlFromOffset(bigFile, 0, () => { count1 += 1; }, b1);
    assert.equal(r1.eof, false);
    assert.equal(checkScanBudget(b1), false);
    const b2 = createScanBudget(500_000, 2000);
    let count2 = 0;
    const r2 = streamJsonlFromOffset(bigFile, r1.newOffset, () => { count2 += 1; }, b2);
    assert.equal(r2.eof, true);
    assert.equal(count1 + count2, 200);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("P1 regressions: unscoped search guard, hook/MCP ScopeKey parity, cross-client conflicts, uncached degraded DB, dead-PID lock reap, strict CLI booleans", async () => {
  clearStoreCaches();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-p1-"));
  const serverPath = path.resolve(process.cwd(), "dist", "mcp-server.mjs");
  const prevGeminiHome = process.env.GEMINI_HOME;
  const prevDataDir = process.env.AGY_MEMORY_DATA_DIR;
  const prevTimeout = process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS;
  try {
    const geminiHome = path.join(tmp, "gemini");
    const appDir = path.join(geminiHome, "antigravity");
    const cliDir = path.join(geminiHome, "antigravity-cli");
    const boardsHome = path.join(tmp, "boards");
    const repoDir = path.join(tmp, "parity-repo");
    const tempWs = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v04-tempws-"));
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });

    const nowIso = new Date().toISOString();
    const olderIso = new Date(Date.now() - 60_000).toISOString();
    const cidParity = "10101010-1111-2222-3333-444444444444";
    const cidConflict = "20202020-1111-2222-3333-444444444444";
    const cidAgree = "30303030-1111-2222-3333-444444444444";

    createSummariesDb(path.join(appDir, "conversation_summaries.db"), [
      { id: cidConflict, title: "App Copy", steps: 5, mtime: nowIso, ws: [repoDir], projectId: "proj-x", appDataDir: "antigravity" },
      { id: cidAgree, title: "App Summary Only", steps: 9, mtime: nowIso, ws: [repoDir], projectId: "proj-x", appDataDir: "antigravity" },
    ]);
    createSummariesDb(path.join(cliDir, "conversation_summaries.db"), [
      { id: cidParity, title: "Temp WS CLI", steps: 4, mtime: nowIso, ws: [tempWs], projectId: "default-cli-project", appDataDir: "antigravity-cli" },
      { id: cidConflict, title: "CLI Conflict Copy", steps: 3, mtime: olderIso, ws: [repoDir], projectId: "proj-y", appDataDir: "antigravity-cli" },
      { id: cidAgree, title: "CLI With Transcript", steps: 8, mtime: olderIso, ws: [repoDir], projectId: "proj-x", appDataDir: "antigravity-cli" },
    ]);
    writeTranscript(cliDir, cidAgree, [
      { step_index: 0, type: "USER_INPUT", created_at: olderIso, content: "Preserve CLI transcript copy" },
      { step_index: 1, type: "PLANNER_RESPONSE", created_at: olderIso, content: "CLI_TRANSCRIPT_PRESERVED_OK" },
    ]);

    process.env.GEMINI_HOME = geminiHome;
    delete process.env.AGY_MEMORY_DATA_DIR;
    clearStoreCaches();

    // 1) Unscoped search rejected unless allScopes=true
    const unscoped = executeToolResult("search_sessions", { query: "Preserve" }, { boardsHome });
    assert.equal(unscoped.isError, true);
    assert.match(unscoped.text, /allScopes=true/);

    // 2) Hook and MCP resolve identical ScopeKey for default-cli-project with temp workspace metadata
    const posted = executeToolResult(
      "board_post",
      { conversationId: cidParity, key: "parity-check", body: "SAME_SCOPE_PARITY_OK" },
      { boardsHome },
    );
    assert.equal(posted.isError, false, posted.text);
    const scopeLine = /in\s+(\S+)/.exec(posted.text)?.[1];
    assert.ok(scopeLine, posted.text);
    const snap = buildSessionStartSnapshot(
      { conversationId: cidParity, cwd: repoDir, workspacePaths: [repoDir] },
      { boardsHome },
    );
    assert.ok(snap.includes(`scope=${scopeLine}`), `Hook scope drifted from MCP (${scopeLine}):\n${snap}`);
    assert.ok(snap.includes("SAME_SCOPE_PARITY_OK"), snap);

    // 3) Cross-client conflict -> unresolved; agreeing copy preserves transcript-bearing path
    const { entries } = loadMultiClientCatalog();
    const confEntry = entries.find((e) => e.sessionId === cidConflict)!;
    assert.equal(confEntry.scopeKey.kind, "unresolved");
    const blockedConf = executeToolResult(
      "board_post",
      { conversationId: cidConflict, key: "k", body: "v" },
      { boardsHome },
    );
    assert.equal(blockedConf.isError, true);
    const agreeEntry = entries.find((e) => e.sessionId === cidAgree)!;
    assert.equal(agreeEntry.hasTranscript, true);
    const readAgree = executeToolResult("read_session", { sessionId: cidAgree, mode: "turns" }, { boardsHome });
    assert.equal(readAgree.isError, false, readAgree.text);
    assert.ok(readAgree.text.includes("CLI_TRANSCRIPT_PRESERVED_OK"), readAgree.text);

    // 4) Degraded SQLite read is NOT cached (recovers when lock clears without DB mtime change)
    const degradedDir = path.join(tmp, "degraded-client");
    fs.mkdirSync(degradedDir, { recursive: true });
    const cidDeg = "40404040-1111-2222-3333-444444444444";
    writeTranscript(degradedDir, cidDeg, [
      { step_index: 0, type: "USER_INPUT", created_at: nowIso, content: "hi" },
    ]);
    const degDb = path.join(degradedDir, "conversation_summaries.db");
    runPySqlite(
      `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count int, last_modified_time text, workspace_uris text, status text, project_id text, app_data_dir text, not_fully_idle int, parent_conversation_id text, nesting_depth int, last_user_input_time text)")
con.execute("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", (sys.argv[2], "Recovered Title", "", 2, sys.argv[3], "[]", "IDLE", "proj-deg", "antigravity-cli", 0, "", 0, sys.argv[3]))
con.commit()
con.close()
`,
      [degDb, cidDeg, nowIso],
    );
    const lockProc = spawnPySqlite(
      "import sqlite3, sys\ncon=sqlite3.connect(sys.argv[1])\ncon.execute('BEGIN EXCLUSIVE')\nprint('LOCKED', flush=True)\nsys.stdin.readline()\ncon.rollback()\ncon.close()\n",
      [degDb],
    );
    await new Promise<void>((resolve) => {
      lockProc.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes("LOCKED")) resolve();
      });
    });
    process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS = "40";
    const whileLocked = loadSingleRootCatalog({ client: "cli", dataDir: degradedDir });
    assert.equal(whileLocked[0]?.title, "", "should degrade to brain fallback under exclusive lock");
    lockProc.stdin.write("\n");
    lockProc.stdin.end();
    await new Promise((resolve) => lockProc.on("close", resolve));
    process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS = "1000";
    const afterUnlock = loadSingleRootCatalog({ client: "cli", dataDir: degradedDir });
    assert.equal(afterUnlock[0]?.title, "Recovered Title", "degraded read must not poison catalog cache");

    // 5) Dead-PID lock reaped cleanly; live-PID old lock NEVER stolen
    const lockScope = { kind: "project" as const, projectId: "lock-reap-proj" };
    const entriesDir = path.join(scopeKeyToBoardDir(lockScope, boardsHome), "entries");
    fs.mkdirSync(entriesDir, { recursive: true });
    const deadChild = spawn(process.execPath, ["-e", ""]);
    const deadPid = deadChild.pid!;
    await new Promise((resolve) => deadChild.on("close", resolve));
    fs.writeFileSync(
      path.join(entriesDir, ".reap-key.lock"),
      JSON.stringify({ pid: deadPid, nonce: "dead", createdAt: Date.now() - 60_000 }),
    );
    const reapedPost = boardPostResult({ scope: lockScope, key: "reap-key", body: "reaped ok", boardsHome });
    assert.equal(reapedPost.isError, false, reapedPost.text);

    const liveLockPath = path.join(entriesDir, ".live-key.lock");
    fs.writeFileSync(liveLockPath, JSON.stringify({ pid: process.pid, nonce: "live", createdAt: Date.now() - 60_000 }));
    const past = new Date(Date.now() - 30_000);
    fs.utimesSync(liveLockPath, past, past);
    const liveBlocked = boardPostResult({ scope: lockScope, key: "live-key", body: "must not steal", boardsHome });
    assert.equal(liveBlocked.isError, true, liveBlocked.text);
    assert.match(liveBlocked.text, /Timed out acquiring board lock/);
    fs.unlinkSync(liveLockPath);

    // 6) Strict CLI boolean flags: --delete=false preserves entry, --delete=bogus exits 1
    const flagCreated = boardPostResult({ scope: lockScope, key: "flag-key", body: "v1", boardsHome });
    const rev1 = /Revision:\s*([0-9a-f]{12})/.exec(flagCreated.text)![1]!;
    const cliKeep = execFileSync(
      process.execPath,
      [serverPath, "--cli", "board-post", "--boards-home", boardsHome, "--scope", "project/lock-reap-proj", "--key", "flag-key", "--body", "v2", "--rev", rev1, "--delete=false"],
      { encoding: "utf8" },
    );
    assert.match(cliKeep, /Updated board key/);
    const cliBadBool = spawn(process.execPath, [
      serverPath, "--cli", "board-post", "--boards-home", boardsHome, "--scope", "project/lock-reap-proj", "--key", "flag-key", "--delete=bogus",
    ]);
    const badCode = await new Promise<number>((resolve) => cliBadBool.on("close", (c) => resolve(c ?? 1)));
    assert.equal(badCode, 1, "--delete=bogus must exit 1");

    fs.rmSync(tempWs, { recursive: true, force: true });
  } finally {
    if (prevGeminiHome === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prevGeminiHome;
    if (prevDataDir === undefined) delete process.env.AGY_MEMORY_DATA_DIR;
    else process.env.AGY_MEMORY_DATA_DIR = prevDataDir;
    if (prevTimeout === undefined) delete process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS;
    else process.env.AGY_MEMORY_SQLITE_TIMEOUT_MS = prevTimeout;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("v0.4.1 regression: read_session(mode=swarm) returns full 3.5KB single message unclipped on startSeq/endSeq", () => {
  clearStoreCaches();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v041-swarm-"));
  try {
    const sid = "79797979-1111-2222-3333-444444444444";
    const swarmDir = path.join(tmp, "brain", sid, ".system_generated", "swarm");
    fs.mkdirSync(swarmDir, { recursive: true });
    const longVerdict = `${"Detailed audit section covering replay and live verification. ".repeat(52)}DEEP_VERDICT_MARKER_3200 delta_cf=30.0% stale=0.0%`;
    assert.ok(longVerdict.length > 3100, `expected >3100 chars, got ${longVerdict.length}`);
    const boardLines: string[] = [];
    for (let seq = 65; seq <= 78; seq += 1) {
      boardLines.push(JSON.stringify({ seq, time: "2026-11-26 04:00:00", agent: "worker", text: `Routine status #${seq}` }));
    }
    boardLines.push(JSON.stringify({ seq: 79, time: "2026-11-26 05:12:00", agent: "codex-reviewer", text: longVerdict }));
    fs.writeFileSync(path.join(swarmDir, "board.jsonl"), `${boardLines.join("\n")}\n`);

    const wide = executeTool("read_session", { sessionId: sid, mode: "swarm", tailMessages: 20 }, { dataDir: tmp });
    assert.ok(wide.includes("pass startSeq=79 endSeq=79 for full message"), wide);

    const exact = executeTool("read_session", { sessionId: sid, mode: "swarm", startSeq: 79, endSeq: 79 }, { dataDir: tmp });
    assert.ok(exact.includes("DEEP_VERDICT_MARKER_3200"), exact);
    assert.ok(exact.includes("delta_cf=30.0%"), exact);
    assert.ok(Buffer.byteLength(exact, "utf8") <= 8650, `exceeded inline cap: ${Buffer.byteLength(exact, "utf8")}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("v0.4.2 regressions: strict MCP booleans, CJK Swarm recovery path, CLI read flags, and multi-client Swarm merge", () => {
  clearStoreCaches();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v042-reg-"));
  const boardsHome = path.join(tmp, "boards");
  try {
    // 1) MCP boundary must not coerce string "false" into true for allScopes or delete
    const scopedReject = executeToolResult(
      "search_sessions",
      { allScopes: "false", query: "anything" },
      { dataDir: tmp },
    );
    assert.equal(scopedReject.isError, true, scopedReject.text);

    const posted = executeToolResult(
      "board_post",
      { scope: "global", key: "keep-alive", body: "still here" },
      { dataDir: tmp, boardsHome },
    );
    assert.equal(posted.isError, false, posted.text);
    const rev = /Revision:\s*([0-9a-f]{12})/.exec(posted.text)![1]!;
    const notDeleted = executeToolResult(
      "board_post",
      { scope: "global", key: "keep-alive", body: "updated body", expectedRevision: rev, delete: "false" },
      { dataDir: tmp, boardsHome },
    );
    assert.equal(notDeleted.isError, false, notDeleted.text);
    assert.ok(notDeleted.text.includes("Updated"), notDeleted.text);

    // 2) Multibyte CJK single Swarm message exceeding 8,650 bytes preserves full board.jsonl path
    const sid = "88888888-1111-2222-3333-444444444444";
    const swarmDir = path.join(tmp, "brain", sid, ".system_generated", "swarm");
    fs.mkdirSync(swarmDir, { recursive: true });
    const cjkBody = "中文评审结论记录。".repeat(400); // 3,600 chars / 10,800 UTF-8 bytes
    const boardPath = path.join(swarmDir, "board.jsonl");
    fs.writeFileSync(
      boardPath,
      `${JSON.stringify({ seq: 1, time: "2026-11-26 06:00:00", agent: "reviewer", text: cjkBody })}\n`,
    );
    const cjkOut = executeTool("read_session", { sessionId: sid, mode: "swarm", startSeq: 1, endSeq: 1 }, { dataDir: tmp });
    assert.ok(Buffer.byteLength(cjkOut, "utf8") <= 8650, `CJK Swarm exceeded cap: ${Buffer.byteLength(cjkOut, "utf8")}`);
    assert.ok(cjkOut.includes(boardPath), `Missing board.jsonl recovery path:\n${cjkOut.slice(-300)}`);

    // 3) CLI read accepts --tools and --include-tools without swallowing positional sessionId
    const bundle = path.resolve("dist/mcp-server.mjs");
    const logDir = path.join(tmp, "brain", sid, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      `${JSON.stringify({ step: 1, type: "USER_INPUT", content: "hi" })}\n${JSON.stringify({ step: 2, type: "PLANNER_RESPONSE", content: "ok", tool_calls: [{ name: "read_file" }] })}\n`,
    );
    const cliTools = spawnSync(
      process.execPath,
      [bundle, "--cli", "read", "--data-dir", tmp, "--mode", "turns", "--tools", sid],
      { encoding: "utf8" },
    );
    assert.equal(cliTools.status, 0, cliTools.stderr || cliTools.stdout);
    assert.ok(cliTools.stdout.includes("Tools: read_file"), cliTools.stdout);

    const cliIncTools = spawnSync(
      process.execPath,
      [bundle, "--cli", "read", "--data-dir", tmp, "--mode", "turns", "--include-tools", sid],
      { encoding: "utf8" },
    );
    assert.equal(cliIncTools.status, 0, cliIncTools.stderr || cliIncTools.stdout);
    assert.ok(cliIncTools.stdout.includes("Tools: read_file"), cliIncTools.stdout);

    // 4) CLI migrate-notes --dry-run inspects v0.3 plugin_data path without writing
    const v03Topics = path.join(tmp, "plugin_data", "agy-memory", "memory", "topics");
    fs.mkdirSync(v03Topics, { recursive: true });
    fs.writeFileSync(path.join(v03Topics, "rule-a.md"), '---\nschema: 1\ntopic: "Rule A"\n---\nBody A.\n');
    const dryCli = spawnSync(
      process.execPath,
      [bundle, "--cli", "migrate-notes", "--data-dir", tmp, "--boards-home", boardsHome, "--scope", "global", "--dry-run"],
      { encoding: "utf8" },
    );
    assert.equal(dryCli.status, 0, dryCli.stderr || dryCli.stdout);
    assert.ok(dryCli.stdout.includes("[dry-run]") && dryCli.stdout.includes("imported=1"), dryCli.stdout);
    const afterDry = executeTool("board_read", { scope: "global", keys: ["rule-a"] }, { dataDir: tmp, boardsHome });
    assert.ok(afterDry.includes("Board empty"), afterDry);

    // 5) Multi-client merge preserves Swarm path from newer App copy alongside older CLI transcript
    const appDir = path.join(tmp, "mc-app");
    const cliDir = path.join(tmp, "mc-cli");
    const mSid = "99999999-1111-2222-3333-444444444444";
    const cliLogDir = path.join(cliDir, "brain", mSid, ".system_generated", "logs");
    const appSwarmDir = path.join(appDir, "brain", mSid, ".system_generated", "swarm");
    fs.mkdirSync(cliLogDir, { recursive: true });
    fs.mkdirSync(appSwarmDir, { recursive: true });
    const cliTranscript = path.join(cliLogDir, "transcript.jsonl");
    const appBoard = path.join(appSwarmDir, "board.jsonl");
    fs.writeFileSync(cliTranscript, `${JSON.stringify({ step: 1, type: "USER_INPUT", content: "hello" })}\n`);
    fs.writeFileSync(appBoard, `${JSON.stringify({ seq: 1, time: "2026-11-26 07:00:00", agent: "worker", text: "APP_SWARM_OK" })}\n`);
    const older = new Date("2026-11-26T01:00:00Z");
    const newer = new Date("2026-11-26T02:00:00Z");
    fs.utimesSync(cliTranscript, older, older);
    fs.utimesSync(appBoard, newer, newer);
    const prevApp = process.env.AGY_APP_DATA_DIR;
    const prevCli = process.env.AGY_CLI_DATA_DIR;
    const prevMem = process.env.AGY_MEMORY_DATA_DIR;
    try {
      delete process.env.AGY_MEMORY_DATA_DIR;
      process.env.AGY_APP_DATA_DIR = appDir;
      process.env.AGY_CLI_DATA_DIR = cliDir;
      clearStoreCaches();
      const swarmMerged = executeTool("read_session", { sessionId: mSid, mode: "swarm" });
      assert.ok(swarmMerged.includes("APP_SWARM_OK"), swarmMerged);
    } finally {
      if (prevApp === undefined) delete process.env.AGY_APP_DATA_DIR;
      else process.env.AGY_APP_DATA_DIR = prevApp;
      if (prevCli === undefined) delete process.env.AGY_CLI_DATA_DIR;
      else process.env.AGY_CLI_DATA_DIR = prevCli;
      if (prevMem === undefined) delete process.env.AGY_MEMORY_DATA_DIR;
      else process.env.AGY_MEMORY_DATA_DIR = prevMem;
      clearStoreCaches();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
