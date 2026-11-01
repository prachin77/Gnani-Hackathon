import { spawnSync } from "node:child_process";

function run(label, file) {
  process.stdout.write(`\n› ${label}\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", file], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Batch audio preparation", "scripts/test-batch-audio.ts");
run("Batch proxy relay", "scripts/test-batch-proxy.ts");
