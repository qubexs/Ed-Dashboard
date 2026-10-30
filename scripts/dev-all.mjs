#!/usr/bin/env node
/**
 * Start the three servers (PMS, API, dashboard) in watch mode with prefixed
 * logs. Ctrl+C stops all of them.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

const RESET = "\x1b[0m";
const TARGETS = [
  { name: "pms", file: "src/servers/pms.ts", color: "\x1b[33m" },
  { name: "api", file: "src/servers/api.ts", color: "\x1b[36m" },
  { name: "dashboard", file: "src/servers/dashboard.ts", color: "\x1b[35m" },
];

const port = (name, fallback) => process.env[name] || fallback;

console.log(
  [
    "",
    `  dev:all — PMS :${port("PMS_PORT", 5000)}  |  API :${port("API_PORT", 4000)}  |  dashboard :${port("PORT", 3000)}`,
    "",
  ].join("\n")
);

const children = [];
let stopping = false;

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 400);
}

function pipe(stream, prefix) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) console.log(`${prefix} ${line}`);
  });
}

for (const target of TARGETS) {
  const child = spawn(process.execPath, [tsx, "watch", target.file], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `${target.color}[${target.name}]${RESET}`;
  pipe(child.stdout, prefix);
  pipe(child.stderr, prefix);

  child.on("exit", (code, signal) => {
    console.log(`${prefix} exited (${signal ?? code})`);
    if (!stopping) stop(code ?? 1);
  });

  children.push(child);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
