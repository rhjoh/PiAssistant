import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { startGateway } from "../index.js";
import type { GatewayStatus, PidState } from "./types.js";

const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveExecutablePath(command: string): string | null {
  try {
    const resolved = execFileSync("which", [command], { encoding: "utf8" }).trim();
    return resolved.length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

function resolveNpmCommand(): { command: string; prefixArgs: string[] } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return { command: process.execPath, prefixArgs: [npmExecPath] };
  }

  const npmPath = resolveExecutablePath(process.platform === "win32" ? "npm.cmd" : "npm");
  if (npmPath) {
    return { command: npmPath, prefixArgs: [] };
  }

  throw new Error(
    "Unable to locate npm for --webui startup. Set PATH so npm is available, or run Web UI manually from clients/web_ui."
  );
}

function usage(): void {
  console.log(`personalos <command>

Commands:
  run        Run gateway in foreground
  start      Start gateway in background
             --webui    Also start Web UI dev server (http://127.0.0.1:5173)
  stop       Stop background gateway
  restart    Restart background gateway
  status     Show gateway process status
  logs       Show recent logs
  logs -f    Follow logs
`);
}

async function ensureRuntimeDirs(): Promise<void> {
  await mkdir(config.runtime.runDir, { recursive: true });
  await mkdir(config.runtime.logsDir, { recursive: true });
}

async function readPidState(): Promise<PidState | null> {
  try {
    const raw = await readFile(config.runtime.pidFile, "utf8");
    return JSON.parse(raw) as PidState;
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  // Never probe invalid/special PIDs. Negative PIDs target process groups.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findGatewayProcessPids(): number[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
    const pids: number[] = [];

    for (const line of lines) {
      const firstSpace = line.indexOf(" ");
      if (firstSpace <= 0) continue;
      const pidStr = line.slice(0, firstSpace).trim();
      const command = line.slice(firstSpace + 1).trim();
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (pid === process.pid) continue;

      const inGatewayRepo = command.includes(gatewayRoot);
      const looksLikeGatewayRuntime =
        command.includes("src/index.ts") ||
        command.includes("src/cli.ts run") ||
        command.includes("src/cli/index.ts run") ||
        command.includes("bin/personalos.mjs run");

      if (inGatewayRepo && looksLikeGatewayRuntime) {
        pids.push(pid);
      }
    }

    return pids;
  } catch {
    return [];
  }
}

async function cleanupStalePidFile(): Promise<void> {
  const state = await readPidState();
  if (!state) return;
  const gatewayRunning = isPidRunning(state.pid);
  const webuiRunning = state.webui ? isPidRunning(state.webui.pid) : false;
  if (!gatewayRunning && !webuiRunning) {
    await rm(config.runtime.pidFile, { force: true });
  }
}

interface StartOptions {
  webui: boolean;
}

function parseStartOptions(args: string[]): StartOptions {
  const options: StartOptions = { webui: false };
  for (const arg of args) {
    if (arg === "--webui") {
      options.webui = true;
      continue;
    }
    throw new Error(`Unknown start option: ${arg}`);
  }
  return options;
}

async function startCommand(args: string[]): Promise<void> {
  const options = parseStartOptions(args);
  await ensureRuntimeDirs();
  await cleanupStalePidFile();

  const existing = await readPidState();
  if (existing && isPidRunning(existing.pid)) {
    console.log(`personalos already running (pid ${existing.pid})`);
    return;
  }
  const unmanagedPids = findGatewayProcessPids();
  if (unmanagedPids.length > 0) {
    console.log(`personalos appears to already be running without pid management (pid${unmanagedPids.length > 1 ? "s" : ""}: ${unmanagedPids.join(", ")})`);
    console.log("stop that process first, or run via `personalos start` for managed lifecycle");
    return;
  }

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: gatewayRoot,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  let webuiState: PidState["webui"];
  if (options.webui) {
    const webuiRoot = resolve(gatewayRoot, "..", "clients", "web_ui");
    const npm = resolveNpmCommand();
    const webuiArgs = [
      ...npm.prefixArgs,
      "run",
      "dev",
      "--",
      "--host",
      "localhost",
      "--port",
      "5173",
      "--strictPort",
    ];
    const webui = spawn(npm.command, webuiArgs, {
      cwd: webuiRoot,
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    webui.on("error", (err) => {
      console.error(`[personalos] Failed to start webui process: ${err.message}`);
    });
    webui.unref();
    webuiState = {
      pid: webui.pid ?? 0,
      command: `${npm.command} ${webuiArgs.join(" ")}`,
      url: "http://localhost:5173",
    };
  }

  const state: PidState = {
    pid: child.pid ?? -1,
    startedAt: new Date().toISOString(),
    command: `${process.execPath} --import tsx src/index.ts`,
    ...(webuiState ? { webui: webuiState } : {}),
  };

  await writeFile(config.runtime.pidFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(`personalos started (pid ${state.pid})`);
  if (state.webui) {
    console.log(`webui started (pid ${state.webui.pid})`);
    console.log(`webui url: ${state.webui.url}`);
  }
  console.log(`log file: ${config.runtime.logFile}`);
}

async function stopCommand(): Promise<void> {
  await cleanupStalePidFile();
  const state = await readPidState();
  if (!state) {
    console.log("personalos is not running");
    return;
  }
  const stopByPid = async (pid: number, label: string): Promise<boolean> => {
    if (!Number.isInteger(pid) || pid <= 1) {
      return false;
    }
    if (!isPidRunning(pid)) return false;
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20; i++) {
      if (!isPidRunning(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isPidRunning(pid)) {
      console.warn(`process ${pid} (${label}) still running after SIGTERM`);
      return true;
    }
    return false;
  };

  const gatewayWasRunning = isPidRunning(state.pid);
  const webuiWasRunning = state.webui ? isPidRunning(state.webui.pid) : false;

  const gatewayStillRunning = await stopByPid(state.pid, "gateway");
  const webuiStillRunning = state.webui ? await stopByPid(state.webui.pid, "webui") : false;

  if (gatewayWasRunning && !gatewayStillRunning) {
    console.log(`personalos stopped (pid ${state.pid})`);
  }
  if (state.webui && webuiWasRunning && !webuiStillRunning) {
    console.log(`webui stopped (pid ${state.webui.pid})`);
  }

  if (!gatewayStillRunning && !webuiStillRunning) {
    if (!gatewayWasRunning && !webuiWasRunning) {
      console.log("personalos is not running (stale pid file removed)");
    }
    await rm(config.runtime.pidFile, { force: true });
  }
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function minsSince(isoDate: string | null): string {
  if (!isoDate) return "never";
  const diff = Date.now() - new Date(isoDate).getTime();
  return `${formatDuration(diff)} ago`;
}

async function fetchStatus(): Promise<GatewayStatus | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${config.fileServer.port}/status`);
    if (!res.ok) return null;
    return (await res.json()) as GatewayStatus;
  } catch {
    return null;
  }
}

async function statusCommand(): Promise<void> {
  await cleanupStalePidFile();
  const state = await readPidState();
  const gatewayStatus = await fetchStatus();

  if (!state) {
    const unmanagedPids = findGatewayProcessPids();
    if (unmanagedPids.length > 0) {
      console.log("status: running (unmanaged)");
      console.log(`pid${unmanagedPids.length > 1 ? "s" : ""}: ${unmanagedPids.join(", ")}`);
      console.log("note: started outside `personalos start`, so no pid file is present");
      if (gatewayStatus) {
        printGatewayStatus(gatewayStatus);
      }
      console.log(`pid file: ${config.runtime.pidFile}`);
      console.log(`log file: ${config.runtime.logFile}`);
      return;
    }
    console.log("status: stopped");
    console.log(`pid file: ${config.runtime.pidFile}`);
    console.log(`log file: ${config.runtime.logFile}`);
    return;
  }

  const running = isPidRunning(state.pid);
  const webuiRunning = state.webui ? isPidRunning(state.webui.pid) : false;
  console.log(`status: ${running ? "running" : "stopped"}`);
  console.log(`pid: ${state.pid}`);
  console.log(`started: ${state.startedAt}`);
  if (state.webui) {
    console.log(`webui: ${webuiRunning ? "running" : "stopped"} (pid ${state.webui.pid})`);
    console.log(`webui url: ${state.webui.url}`);
  }

  if (running && gatewayStatus) {
    printGatewayStatus(gatewayStatus);
  }

  console.log(`pid file: ${config.runtime.pidFile}`);
  console.log(`log file: ${config.runtime.logFile}`);

  if (!running) {
    console.log("note: stale pid state detected");
  }
}

function printGatewayStatus(s: GatewayStatus): void {
  console.log("");
  console.log("--- Gateway Status ---");
  console.log(`websocket: ${s.websocket.running ? "running" : "stopped"} (port ${s.websocket.port})`);
  console.log(`clients: ${s.websocket.clientCount}`);
  if (s.websocket.clients.length > 0) {
    for (const c of s.websocket.clients) {
      console.log(`  - ${c.id} (${c.type})`);
    }
  }
  console.log(`session: ${s.session.path}`);
  console.log("");
  console.log(`heartbeat: ${minsSince(s.heartbeat.lastRunAt)} (${s.heartbeat.intervalMs / 60000}m interval)`);
  console.log(`memory watcher: ${s.memoryWatcher.enabled ? "enabled" : "disabled"}`);
  if (s.memoryWatcher.enabled) {
    console.log(`  last run: ${minsSince(s.memoryWatcher.lastRunAt)} (${s.memoryWatcher.intervalMs / 60000}m interval)`);
  }
}

async function logsCommand(args: string[]): Promise<void> {
  const follow = args.includes("-f") || args.includes("--follow");
  const logPath = config.runtime.logFile;

  if (!existsSync(logPath)) {
    console.log(`log file not found: ${logPath}`);
    return;
  }

  if (follow) {
    const tail = spawn("tail", ["-n", "100", "-f", logPath], { stdio: "inherit" });
    tail.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const data = await readFile(logPath, "utf8");
  const lines = data.split("\n");
  const out = lines.slice(Math.max(0, lines.length - 100)).join("\n");
  process.stdout.write(out);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  await ensureRuntimeDirs();

  switch (command) {
    case "run":
      await startGateway();
      return;
    case "start":
      await startCommand(args);
      return;
    case "stop":
      await stopCommand();
      return;
    case "restart":
      await stopCommand();
      await startCommand(args);
      return;
    case "status":
      await statusCommand();
      return;
    case "logs":
      await logsCommand(args);
      return;
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[personalos] CLI error:", err);
  process.exit(1);
});
