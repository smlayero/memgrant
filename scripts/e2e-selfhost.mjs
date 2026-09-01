#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const child = spawn(
  process.execPath,
  [vitest, "run", "test/selfhost-e2e.test.ts"],
  { cwd: path.join(root, "packages", "cloud"), stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
