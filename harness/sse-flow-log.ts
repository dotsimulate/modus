import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "fs";
import { dirname } from "path";

let formatter: Intl.DateTimeFormat | undefined;
let formatterTimezone: string | undefined;
let checkedAt = 0;

/** Reuse the locale machinery, but periodically pick up OS timezone changes. */
export function sseTimestamp(date = new Date()): string {
  const now = date.getTime();
  if (!formatter || formatterTimezone !== process.env.TZ || now < checkedAt || now - checkedAt >= 60_000) {
    formatter = new Intl.DateTimeFormat("en-US", {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
    });
    formatterTimezone = process.env.TZ;
    checkedAt = now;
  }
  return formatter.format(date);
}

/** Synchronous diagnostic writes retain their ordering without reopening per event. */
export function createSseFlowLog(file: string, options: { maxBytes?: number; checkBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const checkBytes = options.checkBytes ?? 4 * 1024 * 1024;
  let fd: number | undefined;
  let bytesSinceCheck = checkBytes;

  const close = () => {
    if (fd === undefined) return;
    const current = fd;
    fd = undefined;
    try { closeSync(current); } catch { /* diagnostics cannot break a session */ }
  };

  const write = (event: string, sid: string | undefined, detail: string) => {
    try {
      const line = `${sseTimestamp()} [${sid ? sid.slice(0, 12) : "------------"}] ${event}: ${detail}\n`;
      bytesSinceCheck += Buffer.byteLength(line);
      if (bytesSinceCheck >= checkBytes) {
        bytesSinceCheck = 0;
        if (!existsSync(file)) close();
        else if (statSync(file).size >= maxBytes) {
          // Windows cannot rename an open file. Close only this logger's handle.
          close();
          rmSync(`${file}.1`, { force: true });
          renameSync(file, `${file}.1`);
        }
      }
      if (fd === undefined) {
        mkdirSync(dirname(file), { recursive: true });
        fd = openSync(file, "a");
      }
      // A short write must not silently truncate a diagnostic line.
      const bytes = Buffer.from(line);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written === 0) throw new Error("Empty diagnostic write");
        offset += written;
      }
    } catch {
      close();
      bytesSinceCheck = checkBytes;
    }
  };
  return { write, close };
}
