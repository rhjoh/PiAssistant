import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

const ts = () => new Date().toISOString().slice(11, 23);

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  return inspect(arg, { depth: 4, colors: false, breakLength: 120 });
}

function appendLine(logFile: string, line: string): void {
  try {
    appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // Keep console logging functional if file appending fails.
  }
}

/**
 * Prefix console output with timestamps and mirror every line to a logfile.
 * Returns a restore function for tests/embedded usage.
 */
export function installTimestampedConsole(logFile: string): () => void {
  if (!existsSync(dirname(logFile))) {
    mkdirSync(dirname(logFile), { recursive: true });
  }

  const originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const patch = (method: "log" | "info" | "warn" | "error"): void => {
    const original = originals[method];
    console[method] = (...args: unknown[]) => {
      const prefix = `[${ts()}]`;
      if (args.length === 0) {
        original(prefix);
        appendLine(logFile, prefix);
        return;
      }

      const [first, ...rest] = args;
      if (typeof first === "string" && first.startsWith("[")) {
        original(prefix, first, ...rest);
      } else {
        original(prefix, first, ...rest);
      }

      const rendered = [first, ...rest].map(stringifyArg).join(" ");
      appendLine(logFile, `${prefix} ${rendered}`);
    };
  };

  patch("log");
  patch("info");
  patch("warn");
  patch("error");

  return () => {
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
  };
}
