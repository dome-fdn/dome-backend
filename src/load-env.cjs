const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;

  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return false;

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }

  return true;
}

function loadBackendEnv() {
  const backendRoot = resolve(__dirname, "..");
  loadEnvFile(resolve(backendRoot, ".env"));
}

module.exports = {
  loadBackendEnv,
  loadEnvFile,
};
