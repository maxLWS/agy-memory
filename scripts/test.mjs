import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const testDir = path.join(rootDir, "test");
const tmpOutDir = path.join(rootDir, ".tmp", "tests");

await fs.rm(tmpOutDir, { recursive: true, force: true });
await fs.mkdir(tmpOutDir, { recursive: true });

const entries = (await fs.readdir(testDir))
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (entries.length === 0) {
  console.error("No test files found in test/");
  process.exit(1);
}

const outFiles = [];
for (const file of entries) {
  const outFile = path.join(tmpOutDir, file.replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [path.join(testDir, file)],
    outfile: outFile,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: "inline",
    external: ["node:sqlite"],
  });
  outFiles.push(outFile);
}

const res = spawnSync(process.execPath, ["--test", ...outFiles], {
  cwd: rootDir,
  stdio: "inherit",
});

await fs.rm(path.join(rootDir, ".tmp"), { recursive: true, force: true });
process.exit(res.status ?? 1);
