import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function binPath(name, relative) {
  const fallback = path.resolve(process.cwd(), "node_modules", relative);
  if (existsSync(fallback)) return fallback;
  return name;
}

function run(label, args) {
  process.stdout.write(`\n› ${label}\n`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: process.cwd() });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsc = binPath("tsc", path.join("typescript", "bin", "tsc"));

run("Typechecking the frontend", [tsc, "-p", "tsconfig.json", "--noEmit"]);
run("Typechecking the server", [tsc, "-p", "tsconfig.server.json", "--noEmit"]);

if (process.argv.includes("--build")) {
  const vite = binPath("vite", path.join("vite", "bin", "vite.js"));
  run("Building the frontend", [vite, "build"]);
}
