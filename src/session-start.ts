import { buildSessionStartSnapshot, type SessionStartPayload } from "./snapshot.js";

async function readStdinJson(): Promise<SessionStartPayload> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      raw += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(raw.trim() ? (JSON.parse(raw) as SessionStartPayload) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

async function main(): Promise<void> {
  const payload = await readStdinJson();
  const text = buildSessionStartSnapshot(payload);
  if (!text) {
    process.stdout.write("{}\n");
    return;
  }
  const output = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: text,
        },
      },
    ],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch(() => {
  process.stdout.write("{}\n");
});
