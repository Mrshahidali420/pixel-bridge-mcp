import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * stdout is reserved for the MCP stdio protocol, so all logging goes to
 * stderr plus a rolling file under ~/.pixel-bridge/logs/.
 */
let logStream: fs.WriteStream | null = null;

function stream(): fs.WriteStream {
  if (!logStream) {
    fs.mkdirSync(config.logsDir, { recursive: true });
    const file = path.join(
      config.logsDir,
      `pixel-bridge-${new Date().toISOString().slice(0, 10)}.log`
    );
    logStream = fs.createWriteStream(file, { flags: "a" });
  }
  return logStream;
}

function write(level: string, scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}`;
  process.stderr.write(line + "\n");
  try {
    stream().write(line + "\n");
  } catch {
    // Logging must never take the server down.
  }
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function getLogger(scope: string): Logger {
  return {
    info: (m) => write("INFO", scope, m),
    warn: (m) => write("WARN", scope, m),
    error: (m) => write("ERROR", scope, m),
  };
}

/** Directory where failure screenshots are dumped for debugging. */
export function screenshotPath(name: string): string {
  fs.mkdirSync(config.logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(config.logsDir, `${stamp}-${name}.png`);
}
