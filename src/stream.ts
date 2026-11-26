import fs from "node:fs";
import path from "node:path";
import type { ScanBudget } from "./types.js";

const CHUNK_BYTES = 64 * 1024;

export function createScanBudget(maxScanBytes = 32 * 1024 * 1024, maxScanMs = 2500): ScanBudget {
  return {
    maxScanBytes,
    maxScanMs,
    startedAtMs: Date.now(),
    bytesRead: 0,
    sessionsScanned: 0,
    incomplete: false,
    reason: "",
  };
}

export function checkScanBudget(budget: ScanBudget | undefined): boolean {
  if (!budget) return true;
  if (budget.incomplete) return false;
  if (budget.bytesRead >= budget.maxScanBytes) {
    budget.incomplete = true;
    budget.reason = `byte budget (${Math.round(budget.maxScanBytes / (1024 * 1024))} MB) reached`;
    return false;
  }
  if (Date.now() - budget.startedAtMs >= budget.maxScanMs) {
    budget.incomplete = true;
    budget.reason = `time budget (${budget.maxScanMs} ms) reached`;
    return false;
  }
  return true;
}

export function streamJsonlFromOffset(
  filePath: string,
  startOffset: number,
  onLine: (line: string) => void,
  budget?: ScanBudget,
): { newOffset: number; eof: boolean; size: number; mtimeMs: number; ioError: boolean } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const st = fs.fstatSync(fd);
    const size = st.size;
    const mtimeMs = st.mtimeMs;
    let pos = Math.max(0, startOffset);
    if (pos >= size) {
      return { newOffset: size, eof: true, size, mtimeMs, ioError: false };
    }

    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let carryParts: Buffer[] = [];
    let carryLen = 0;
    let consumedBytes = pos;

    while (pos < size) {
      if (budget && !checkScanBudget(budget)) {
        return { newOffset: consumedBytes, eof: false, size, mtimeMs, ioError: false };
      }
      const remainingBudget = budget ? Math.max(1, budget.maxScanBytes - budget.bytesRead) : CHUNK_BYTES;
      const toRead = Math.min(CHUNK_BYTES, size - pos, remainingBudget);
      const n = fs.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      pos += n;
      if (budget) budget.bytesRead += n;

      const slice = buf.subarray(0, n);
      let segStart = 0;
      for (let i = 0; i < n; i += 1) {
        if (slice[i] === 0x0a) {
          let lineBuf: Buffer;
          const tailSlice = slice.subarray(segStart, i);
          if (carryLen > 0) {
            carryParts.push(tailSlice);
            lineBuf = Buffer.concat(carryParts, carryLen + tailSlice.length);
            carryParts = [];
            carryLen = 0;
          } else {
            lineBuf = tailSlice;
          }
          consumedBytes += lineBuf.length + 1;
          segStart = i + 1;
          const line = lineBuf.toString("utf8").trim();
          if (line) onLine(line);
        }
      }
      if (segStart < n) {
        const rem = Buffer.from(slice.subarray(segStart));
        carryParts.push(rem);
        carryLen += rem.length;
      }
    }

    if (carryLen > 0 && pos >= size) {
      const trailing = Buffer.concat(carryParts, carryLen);
      const trimmed = trailing.toString("utf8").trim();
      if (trimmed) {
        let validJson = false;
        try {
          JSON.parse(trimmed);
          validJson = true;
        } catch {
          validJson = false;
        }
        if (validJson) {
          consumedBytes += carryLen;
          onLine(trimmed);
        }
      } else {
        consumedBytes += carryLen;
      }
    }
    return { newOffset: consumedBytes, eof: pos >= size, size, mtimeMs, ioError: false };
  } catch (err) {
    if (budget) {
      budget.incomplete = true;
      budget.reason = `I/O read error (${err instanceof Error ? err.message : "read failed"})`;
    }
    return { newOffset: startOffset, eof: false, size: 0, mtimeMs: 0, ioError: true };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}

export function resolveToolPath(
  rawPath: string,
  primaryWorkspace: string,
): {
  rawPath: string;
  resolvedPath: string;
  basename: string;
} {
  const cleaned = String(rawPath || "").trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return { rawPath: "", resolvedPath: "", basename: "" };
  const isWin = /^[a-zA-Z]:[\\/]/.test(cleaned) || /^[a-zA-Z]:[\\/]/.test(primaryWorkspace);
  const pathImpl = isWin ? path.win32 : path.posix;
  let resolved = cleaned;
  if (!pathImpl.isAbsolute(cleaned) && primaryWorkspace) {
    resolved = pathImpl.resolve(primaryWorkspace, cleaned);
  } else {
    resolved = pathImpl.normalize(cleaned);
  }
  const normalized = resolved.replace(/\\/g, "/");
  const basename = path.posix.basename(normalized);
  return { rawPath: cleaned, resolvedPath: normalized, basename };
}
