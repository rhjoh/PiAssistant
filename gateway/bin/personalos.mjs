#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const binDir = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = resolve(binDir, "..");
const cliPath = resolve(gatewayRoot, "src", "cli", "index.ts");

const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...process.argv.slice(2)], {
  cwd: gatewayRoot,
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
