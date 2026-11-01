type LogMeta = Record<string, unknown>;

function write(level: "info" | "warn" | "error", message: string, meta?: LogMeta): void {
  const stamp = new Date().toISOString();
  const line = `${stamp} [${level.toUpperCase()}] ${message}`;

  if (level === "error") console.error(line, meta ?? "");
  else if (level === "warn") console.warn(line, meta ?? "");
  else console.log(line, meta ?? "");
}

export const logger = {
  info: (message: string, meta?: LogMeta) => write("info", message, meta),
  warn: (message: string, meta?: LogMeta) => write("warn", message, meta),
  error: (message: string, meta?: LogMeta) => write("error", message, meta),
};
