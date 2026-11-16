import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, startBot, inviteUrl, listGuilds, getGuild, snapshot, runActions, DESTRUCTIVE, ACTION_TYPES, membersIntentMissing } from "./discord.js";
import { plan, providerInfo } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.DISCORD_TOKEN;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!TOKEN) {
  console.error("DISCORD_TOKEN is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
if (!PASSWORD || PASSWORD.length < 6) {
  console.error("DASHBOARD_PASSWORD is missing or shorter than 6 characters. Set it in .env so randoms can't control your bot.");
  process.exit(1);
}

let botError = null;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "..", "public")));

// ---------- auth ----------

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const PASSWORD_DIGEST = digest(PASSWORD);
const failures = new Map(); // ip -> {count, until}

function auth(req, res, next) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= 10) {
    return res.status(429).json({ error: "Too many wrong passwords. Try again in a few minutes." });
  }
  const given = req.get("x-dashboard-key") || "";
  if (crypto.timingSafeEqual(digest(given), PASSWORD_DIGEST)) {
    failures.delete(ip);
    return next();
  }
  const next10 = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 10 * 60 * 1000 };
  failures.set(ip, next10);
  return res.status(401).json({ error: "Wrong password." });
}

app.use("/api", auth);

// ---------- routes ----------

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err?.message || "Something broke." });
  });

function requireBot(res) {
  if (client?.isReady()) return true;
  res.status(503).json({ error: botError ? `Bot failed to log in: ${botError}` : "Bot is still connecting..." });
  return false;
}

app.get("/api/status", (req, res) => {
  res.json({
    botReady: Boolean(client?.isReady()),
    botError,
    botWarning: membersIntentMissing
      ? "Server Members Intent is off so welcomes and autoroles won't fire. Turn it on in the Developer Portal → Bot, then restart."
      : null,
    bot: client?.user ? { tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 128 }) } : null,
    invite: inviteUrl(),
    ai: providerInfo(),
  });
});

app.get("/api/guilds", (req, res) => {
  if (!requireBot(res)) return;
  res.json({ guilds: listGuilds() });
});

app.get("/api/guilds/:id", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  res.json({ server: await snapshot(guild, { fresh: req.query.fresh === "1" }) });
}));

app.post("/api/guilds/:id/chat", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "Say something first." });
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  const { reply, actions } = await plan({ message, history, serverState: await snapshot(guild) });

  const destructive = actions.filter((a) => DESTRUCTIVE.has(a.type));
  if (destructive.length && !req.body?.skipConfirm) {
    return res.json({ reply, actions, needsConfirm: true });
  }

  const results = actions.length ? await runActions(guild, actions) : [];
  res.json({ reply, actions, results, server: await snapshot(guild, { fresh: true }) });
}));

app.post("/api/guilds/:id/execute", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  const actions = (Array.isArray(req.body?.actions) ? req.body.actions : [])
    .filter((a) => a && ACTION_TYPES.includes(a.type))
    .slice(0, 80);
  const results = await runActions(guild, actions);
  res.json({ results, server: await snapshot(guild, { fresh: true }) });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

// ---------- start ----------

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

startBot(TOKEN)
  .then((c) => {
    botError = null;
    console.log(`Bot logged in as ${c.user.tag}`);
    console.log(`Invite it to a server: ${inviteUrl()}`);
    const { provider, model } = providerInfo();
    console.log(provider ? `AI: ${provider} (${model})` : "AI: none set. Add GEMINI_API_KEY or GROQ_API_KEY to .env");
  })
  .catch((err) => {
    botError = err?.code === "TokenInvalid" ? "the token is invalid. Reset it in the Discord Developer Portal." : err?.message || String(err);
    console.error(`Bot login failed: ${botError}`);
  });
