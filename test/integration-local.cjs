#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const root = resolve(__dirname, "../..");
const deployFile = resolve(root, ".dome-local/base-deploy.json");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

async function waitForHealth(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${url}/health`);
      const health = await response.json();
      if (response.ok && health.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Backend not healthy at ${url}`);
}

async function main() {
  if (!existsSync(deployFile)) {
    console.log("Starting local stack (deploy + backend)");
    run("bash", ["scripts/dev/up.sh"]);
  } else {
    console.log("Ensuring backend is running");
    run("bash", ["scripts/dev/up.sh"]);
  }

  const backendUrl = process.env.DOME_BACKEND_URL || "http://127.0.0.1:8788";
  await waitForHealth(backendUrl);

  console.log("Building @dome/sdk-evm");
  run("npm", ["run", "build"], { cwd: resolve(root, "dome-sdk-evm") });

  console.log("Running SDK integration flow");
  run("node", [resolve(__dirname, "integration-local.mjs")], {
    env: {
      ...process.env,
      DOME_BACKEND_URL: backendUrl,
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
