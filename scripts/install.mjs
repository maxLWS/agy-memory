#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..");
const PLUGIN_NAME = "agy-memory";

function defaultInstallDir() {
  const geminiHome = process.env.GEMINI_HOME || path.join(os.homedir(), ".gemini");
  return path.join(geminiHome, "config", "plugins", PLUGIN_NAME);
}

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst);
  }
}

function checkBinary(candidates, versionArg = "--version") {
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, [versionArg], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { ok: true, bin, version: out.trim().split(/\r?\n/)[0] || "" };
    } catch {
      // Try next candidate
    }
  }
  return { ok: false, bin: null, version: "" };
}

function hasNodeSqlite() {
  try {
    const res = spawnSync(
      process.execPath,
      ["-e", 'import("node:sqlite").then((m) => process.exit(typeof m.DatabaseSync === "function" ? 0 : 1)).catch(() => process.exit(1))'],
      { stdio: "ignore", timeout: 2000 },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

function resolveInstalledDataDir() {
  const envDir = process.env.AGY_MEMORY_DATA_DIR || process.env.AGY_APP_DATA_DIR || "";
  if (envDir.trim()) {
    return path.isAbsolute(envDir.trim())
      ? envDir.trim()
      : path.join(os.homedir(), ".gemini", envDir.trim());
  }
  const cliDir = path.join(os.homedir(), ".gemini", "antigravity-cli");
  if (fs.existsSync(cliDir)) return cliDir;
  const ideDir = path.join(os.homedir(), ".gemini", "antigravity");
  if (fs.existsSync(ideDir)) return ideDir;
  return cliDir;
}

function tryAgyCommand(args) {
  const candidates =
    process.platform === "win32"
      ? [
          { bin: "agy.exe", opts: {} },
          { bin: "agy", opts: {} },
        ]
      : [{ bin: "agy", opts: {} }];

  // On Windows, `.cmd` wrappers (e.g. npm global shims) require cmd.exe; only invoke if `where.exe` finds one.
  if (process.platform === "win32") {
    try {
      const locate = spawnSync("where.exe", ["agy.cmd"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (locate.status === 0 && locate.stdout && locate.stdout.trim()) {
        const firstPath = locate.stdout.trim().split(/\r?\n/)[0];
        if (firstPath) {
          candidates.push({ bin: firstPath, opts: { shell: true } });
        }
      }
    } catch {
      // Ignore if where.exe is unavailable
    }
  }

  for (const { bin, opts } of candidates) {
    try {
      const res = spawnSync(bin, args, {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
        ...opts,
      });
      if (res.error) continue;
      return { found: true, status: res.status ?? 1, stdout: res.stdout || "", stderr: res.stderr || "" };
    } catch {
      // Try next
    }
  }
  return { found: false, status: -1, stdout: "", stderr: "" };
}

function printHelp() {
  console.log(
    [
      "agy-memory installer & diagnostics CLI",
      "",
      "Usage:",
      "  node scripts/install.mjs [install|update|uninstall|status|doctor] [options]",
      "",
      "Options:",
      "  --dir <path>       Install or inspect a custom plugin directory",
      "  --project <path>   Install into <path>/.agents/plugins/agy-memory",
      "  --no-enable        Skip running `agy plugin enable agy-memory`",
      "  -h, --help         Show this help",
    ].join("\n"),
  );
}

function runStatus(targetDir) {
  const pluginJson = path.join(targetDir, "plugin.json");
  const mcpPath = path.join(targetDir, "dist", "mcp-server.mjs");
  const hookPath = path.join(targetDir, "dist", "session-start.mjs");
  if (!fs.existsSync(pluginJson)) {
    console.log(`${PLUGIN_NAME}: not installed at ${targetDir}`);
    process.exitCode = 1;
    return;
  }
  const meta = JSON.parse(fs.readFileSync(pluginJson, "utf8"));
  const complete = fs.existsSync(mcpPath) && fs.existsSync(hookPath);
  console.log(`${PLUGIN_NAME}: installed v${meta.version} at ${targetDir} (${complete ? "complete" : "incomplete"})`);
}

function runDoctor(targetDir) {
  let ok = true;
  const report = [];
  const mark = (pass, label, detail) => {
    if (!pass) ok = false;
    report.push(`${pass ? "[OK]  " : "[FAIL]"} ${label}: ${detail}`);
  };

  // 1. Check installed plugin files & version parity
  const repoPkgPath = path.join(REPO_ROOT, "package.json");
  const repoPkg = fs.existsSync(repoPkgPath) ? JSON.parse(fs.readFileSync(repoPkgPath, "utf8")) : { version: "?" };
  const installedPluginJson = path.join(targetDir, "plugin.json");
  const installedMcp = path.join(targetDir, "dist", "mcp-server.mjs");
  const installedHook = path.join(targetDir, "dist", "session-start.mjs");
  const installedExists =
    fs.existsSync(installedPluginJson) && fs.existsSync(installedMcp) && fs.existsSync(installedHook);
  if (installedExists) {
    const instMeta = JSON.parse(fs.readFileSync(installedPluginJson, "utf8"));
    const verMatch = repoPkg.version === "?" || instMeta.version === repoPkg.version;
    mark(verMatch, "Installed plugin", `${targetDir} (v${instMeta.version}, source v${repoPkg.version})`);
  } else {
    mark(false, "Installed plugin", `Missing required files under ${targetDir}`);
  }

  // 2. Check optional acceleration backends (pure JS fallback always works)
  const nodeSqlite = hasNodeSqlite();
  const sqliteInfo = checkBinary(
    process.platform === "win32"
      ? ["sqlite3", "sqlite3.exe"]
      : ["sqlite3", "/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"],
  );
  const pyInfo = checkBinary(
    process.platform === "win32" ? ["python", "python3"] : ["python3", "/usr/bin/python3", "python"],
  );
  const rgInfo = checkBinary(
    process.platform === "win32"
      ? ["rg", "rg.exe"]
      : ["rg", "/usr/bin/rg", "/usr/local/bin/rg", "/opt/homebrew/bin/rg"],
  );
  const sqliteDetail = nodeSqlite
    ? `built-in node:sqlite (${process.version})`
    : sqliteInfo.ok
      ? `${sqliteInfo.bin} (${sqliteInfo.version})`
      : pyInfo.ok
        ? `python fallback (${pyInfo.bin})`
        : "brain/ filesystem fallback (no sqlite3/python3 needed)";
  mark(true, "SQLite reader", sqliteDetail);
  mark(true, "ripgrep (rg)", rgInfo.ok ? `${rgInfo.bin} (${rgInfo.version})` : "not found (pure JS search active)");

  // 3. Check catalog readability via bundled CLI
  const mcpTarget = fs.existsSync(installedMcp) ? installedMcp : path.join(REPO_ROOT, "dist", "mcp-server.mjs");
  const dataDir = resolveInstalledDataDir();
  const t0 = Date.now();
  const cliRun = spawnSync(process.execPath, [mcpTarget, "--cli", "list", "--limit", "3"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const cliMs = Date.now() - t0;
  const cliOk = cliRun.status === 0 && typeof cliRun.stdout === "string" && cliRun.stdout.trim().length > 0;
  mark(cliOk, "Catalog CLI", cliOk ? `readable from ${dataDir} in ${cliMs}ms` : `exit=${cliRun.status}`);

  // 4. Live MCP stdio handshake smoke test
  const rpcInput =
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {} },
      }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n") + "\n";
  const mcpRun = spawnSync(process.execPath, [mcpTarget], {
    input: rpcInput,
    encoding: "utf8",
    timeout: 4000,
  });
  let mcpOk = false;
  let mcpDetail = `exit=${mcpRun.status}`;
  if (mcpRun.status === 0 && mcpRun.stdout) {
    try {
      const lines = mcpRun.stdout
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      const ver = lines[0]?.result?.serverInfo?.version;
      const toolCount = lines[1]?.result?.tools?.length;
      mcpOk = Boolean(ver && toolCount === 5);
      mcpDetail = `server v${ver}, ${toolCount} tools`;
    } catch (err) {
      mcpDetail = `invalid JSON-RPC response: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  mark(mcpOk, "MCP stdio smoke", mcpDetail);

  // 5. Live SessionStart hook smoke test
  const hookTarget = fs.existsSync(installedHook) ? installedHook : path.join(REPO_ROOT, "dist", "session-start.mjs");
  const hookRun = spawnSync(process.execPath, [hookTarget], {
    input: JSON.stringify({
      conversationId: "00000000-0000-0000-0000-000000000000",
      workspacePaths: [process.cwd()],
    }),
    encoding: "utf8",
    timeout: 4000,
  });
  let hookOk = false;
  let hookDetail = `exit=${hookRun.status}`;
  if (hookRun.status === 0 && hookRun.stdout) {
    try {
      const parsed = JSON.parse(hookRun.stdout.trim());
      const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
      hookOk = typeof parsed === "object" && (msg.includes("[agy-memory]") || Object.keys(parsed).length === 0);
      hookDetail = `${Buffer.byteLength(msg, "utf8")} bytes injected`;
    } catch (err) {
      hookDetail = `invalid hook JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  mark(hookOk, "SessionStart hook", hookDetail);

  // 6. Optional agy manifest validation if `agy` is installed
  if (installedExists) {
    const val = tryAgyCommand(["plugin", "validate", targetDir, "--strict"]);
    if (val.found) {
      mark(val.status === 0, "agy plugin validate", val.status === 0 ? "passed (--strict)" : (val.stderr || val.stdout).trim());
    }
  }

  console.log(report.join("\n"));
  if (!ok) process.exitCode = 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    return;
  }

  const subcmd = args.find((a) => !a.startsWith("-")) || "";
  const isUninstall = subcmd === "uninstall" || args.includes("--uninstall");
  const isDoctor = subcmd === "doctor" || args.includes("--doctor");
  const isStatus = subcmd === "status";
  const skipEnable = args.includes("--no-enable");

  const dirFlagIdx = args.indexOf("--dir");
  const projectFlagIdx = args.indexOf("--project");
  let targetDir = defaultInstallDir();
  if (dirFlagIdx >= 0 && args[dirFlagIdx + 1]) {
    targetDir = path.resolve(args[dirFlagIdx + 1]);
  } else if (projectFlagIdx >= 0 && args[projectFlagIdx + 1]) {
    targetDir = path.join(path.resolve(args[projectFlagIdx + 1]), ".agents", "plugins", PLUGIN_NAME);
  }

  if (isStatus) {
    runStatus(targetDir);
    return;
  }

  if (isDoctor) {
    runDoctor(targetDir);
    return;
  }

  if (isUninstall) {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      console.log(`Removed ${PLUGIN_NAME} from ${targetDir}`);
    } else {
      console.log(`${PLUGIN_NAME} is not installed at ${targetDir}`);
    }
    return;
  }

  // Ensure pre-built dist bundles exist before installing
  const distMcp = path.join(REPO_ROOT, "dist", "mcp-server.mjs");
  const distHook = path.join(REPO_ROOT, "dist", "session-start.mjs");
  if (!fs.existsSync(distMcp) || !fs.existsSync(distHook)) {
    console.error("Error: dist/*.mjs bundles not found. Run `npm run build` first.");
    process.exitCode = 1;
    return;
  }

  // Preserve optional user local rule overrides if reinstalling
  const localRulePath = path.join(targetDir, "rules", "AGENTS.local.md");
  const preservedLocalRule = fs.existsSync(localRulePath) ? fs.readFileSync(localRulePath, "utf8") : null;

  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  // Clean obsolete src/ directory from pre-bundle installations if present
  const oldSrcDir = path.join(targetDir, "src");
  if (fs.existsSync(oldSrcDir)) {
    fs.rmSync(oldSrcDir, { recursive: true, force: true });
  }

  // Ship only zero-dependency runtime files + installer for doctor/uninstall
  const bundleItems = ["package.json", "plugin.json", "mcp_config.json", "hooks.json", "assets", "rules", "dist"];
  for (const item of bundleItems) {
    const srcPath = path.join(REPO_ROOT, item);
    const dstPath = path.join(targetDir, item);
    if (fs.existsSync(dstPath)) {
      fs.rmSync(dstPath, { recursive: true, force: true });
    }
    copyRecursive(srcPath, dstPath);
  }

  const dstInstallerDir = path.join(targetDir, "scripts");
  fs.mkdirSync(dstInstallerDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(REPO_ROOT, "scripts", "install.mjs"), path.join(dstInstallerDir, "install.mjs"));

  if (preservedLocalRule !== null) {
    fs.writeFileSync(localRulePath, preservedLocalRule, "utf8");
  }

  console.log(`Installed ${PLUGIN_NAME} to ${targetDir}`);

  // Validate and enable automatically when `agy` CLI is available on PATH (global install)
  const isGlobal = projectFlagIdx < 0 && dirFlagIdx < 0;
  const val = tryAgyCommand(["plugin", "validate", targetDir, "--strict"]);
  if (val.found) {
    if (val.status === 0) {
      console.log("agy plugin validate --strict: passed");
    } else {
      console.warn(`Warning: agy plugin validate returned exit ${val.status}: ${(val.stderr || val.stdout).trim()}`);
    }
    if (isGlobal && !skipEnable) {
      const en = tryAgyCommand(["plugin", "enable", PLUGIN_NAME]);
      if (en.status === 0) {
        console.log(`Enabled ${PLUGIN_NAME} in agy`);
      }
    }
  }
}

main();
