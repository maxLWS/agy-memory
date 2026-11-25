import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("scripts/install.mjs installs standalone runtime bundle, preserves AGENTS.local.md, runs doctor & uninstall cleanly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-memory-inst-"));
  const targetDir = path.join(tmpDir, "plugins", "agy-memory");
  const installer = path.resolve(process.cwd(), "scripts", "install.mjs");

  try {
    // 1) Install into isolated directory
    const inst = spawnSync(process.execPath, [installer, "install", "--dir", targetDir, "--no-enable"], {
      encoding: "utf8",
    });
    assert.equal(inst.status, 0, inst.stderr || inst.stdout);
    assert.ok(fs.existsSync(path.join(targetDir, "plugin.json")));
    assert.ok(fs.existsSync(path.join(targetDir, "dist", "mcp-server.mjs")));
    assert.ok(fs.existsSync(path.join(targetDir, "dist", "session-start.mjs")));
    assert.ok(fs.existsSync(path.join(targetDir, "rules", "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(targetDir, "scripts", "install.mjs")));
    assert.equal(fs.existsSync(path.join(targetDir, "src")), false, "installed plugin must NOT ship src/");

    // 2) Preserve rules/AGENTS.local.md across reinstall
    const localRule = path.join(targetDir, "rules", "AGENTS.local.md");
    fs.writeFileSync(localRule, "---\ntrigger: always_on\n---\ncustom override\n", "utf8");
    const reinst = spawnSync(process.execPath, [installer, "update", "--dir", targetDir, "--no-enable"], {
      encoding: "utf8",
    });
    assert.equal(reinst.status, 0, reinst.stderr || reinst.stdout);
    assert.ok(fs.readFileSync(localRule, "utf8").includes("custom override"));

    // 3) Run doctor directly from the installed copy (verifying zero src/ dependency)
    const emptyDataDir = path.join(tmpDir, "empty-data");
    fs.mkdirSync(emptyDataDir, { recursive: true });
    const doc = spawnSync(process.execPath, [path.join(targetDir, "scripts", "install.mjs"), "doctor", "--dir", targetDir], {
      env: { ...process.env, AGY_MEMORY_DATA_DIR: emptyDataDir },
      encoding: "utf8",
    });
    assert.equal(doc.status, 0, doc.stderr || doc.stdout);
    assert.match(doc.stdout, /\[OK\]\s+MCP stdio smoke/);
    assert.match(doc.stdout, /\[OK\]\s+SessionStart hook/);

    // 4) Status & uninstall
    const st = spawnSync(process.execPath, [installer, "status", "--dir", targetDir], { encoding: "utf8" });
    assert.equal(st.status, 0, st.stdout);
    assert.ok(st.stdout.includes("installed v0.3.0"), st.stdout);

    const un = spawnSync(process.execPath, [installer, "uninstall", "--dir", targetDir], { encoding: "utf8" });
    assert.equal(un.status, 0, un.stdout);
    assert.equal(fs.existsSync(targetDir), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
