#!/usr/bin/env node
import fs from "fs/promises";
import path from "path";
import os from "os";
import readline from "readline/promises";
import { fileURLToPath } from "url";

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeJson(filePath, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, content, "utf8");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

try {
  const apiKey = (await rl.question("Enter your Jules API key: ")).trim();
  if (!apiKey) {
    throw new Error("Jules API key cannot be empty.");
  }

  const __filename = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(__filename);
  const repoRoot = path.resolve(scriptDir, "..");
  const indexPath = path.resolve(repoRoot, "index.js");
  const configPath = path.join(os.homedir(), ".claude.json");
  const stateFile = path.join(os.homedir(), ".jules-sessions.json");

  const config = await readJson(configPath);
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  config.mcpServers.jules = {
    command: "node",
    args: [indexPath],
    env: {
      JULES_API_KEY: apiKey,
      JULES_STATE_FILE: stateFile,
    },
  };

  await writeJson(configPath, config);

  console.log(`Updated Claude Code global config: ${configPath}`);
  console.log(`Jules MCP entry points to: ${indexPath}`);
  console.log(`Jules state file path: ${stateFile}`);
} finally {
  rl.close();
}
