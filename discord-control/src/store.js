// Tiny JSON file store for per-server settings (welcome, automod, mod log, warnings).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, "..", "data");
const FILE = path.join(DIR, "config.json");

let data = {};
try {
  data = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  data = {};
}

let timer = null;
function writeNow() {
  clearTimeout(timer);
  timer = null;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error("Could not save settings:", err.message);
  }
}

function persist() {
  if (!timer) timer = setTimeout(writeNow, 1000);
}

// Save anything pending when the bot is stopped (Ctrl+C in Termux).
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    if (timer) writeNow();
    process.exit(0);
  });
}

export function getConfig(guildId) {
  return (data[guildId] ||= {});
}

/** Change a server's settings and save them. */
export function updateConfig(guildId, fn) {
  const cfg = getConfig(guildId);
  fn(cfg);
  persist();
  return cfg;
}
