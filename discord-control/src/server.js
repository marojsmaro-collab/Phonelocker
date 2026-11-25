import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  client,
  startBot,
  inviteUrl,
  listGuilds,
  getGuild,
  snapshot,
  runActions,
  DESTRUCTIVE,
  ACTION_TYPES,
  membersIntentMissing,
  contentIntentMissing,
  idSets,
  createdSince,
  undoCreated,
  emojiSlotsLeft,
  addEmoji,
  applyIcon,
  applyBanner,
} from "./discord.js";
import { plan, repair, providerInfo } from "./ai.js";
import { makeIcon, makeBanner, makeEmoji, makeImage, imageExt } from "./art.js";
import { getConfig, updateConfig } from "./store.js";
import { leaderboard, xpNeeded } from "./extras.js";

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
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(here, "..", "public")));

// ---------------------------------------------------------------- auth

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const PASSWORD_DIGEST = digest(PASSWORD);
const failures = new Map();

function auth(req, res, next) {
  const ip = req.ip;
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= 10) {
    return res.status(429).json({ error: "Too many wrong passwords. Try again in a few minutes." });
  }
  if (crypto.timingSafeEqual(digest(req.get("x-dashboard-key") || ""), PASSWORD_DIGEST)) {
    failures.delete(ip);
    return next();
  }
  failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 10 * 60 * 1000 });
  return res.status(401).json({ error: "Wrong password." });
}
app.use("/api", auth);

// ---------------------------------------------------------------- helpers

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

const cleanActions = (list) => (Array.isArray(list) ? list : []).filter((a) => a && ACTION_TYPES.includes(a.type)).slice(0, 120);

function memoryOf(guildId) {
  return getConfig(guildId).memory?.notes || [];
}

function remember(guildId, notes) {
  if (!notes?.length) return;
  updateConfig(guildId, (c) => {
    c.memory ||= { notes: [] };
    for (const n of notes) if (!c.memory.notes.includes(n)) c.memory.notes.push(n);
    c.memory.notes = c.memory.notes.slice(-30);
  });
}

async function aiState(guild) {
  const s = await snapshot(guild);
  delete s.config;
  delete s.memory;
  s.features_list = guild.features.filter((f) => ["COMMUNITY", "BANNER", "ENHANCED_ROLE_COLORS", "ANIMATED_ICON", "ROLE_ICONS"].includes(f));
  return s;
}

// ---------------------------------------------------------------- build jobs (live progress + undo)

const jobs = new Map();
const busy = new Map(); // guildId -> jobId

function newJob(guildId, request) {
  const job = { id: crypto.randomBytes(6).toString("hex"), guildId, request, status: "running", phase: "building", total: 0, done: 0, results: [], createdAt: Date.now() };
  jobs.set(job.id, job);
  busy.set(guildId, job.id);
  for (const [id, j] of jobs) if (Date.now() - j.createdAt > 2 * 60 * 60 * 1000) jobs.delete(id);
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    total: job.total,
    done: job.done,
    results: job.results.map((r) => ({ ok: r.ok, message: r.message, fix: Boolean(r.fix) })),
    fixReply: job.fixReply || null,
    created: job.created ? job.created.channels.length + job.created.roles.length + job.created.emojis.length : 0,
    undone: Boolean(job.undone),
    error: job.error || null,
  };
}

const UNFIXABLE = /missing permissions|max number|no more emoji slots|boost level/i;

async function runJob(guild, job, actions) {
  const before = idSets(guild);
  job.total = actions.length;
  try {
    await runActions(guild, actions, (r) => {
      job.results.push(r);
      job.done++;
    });
    const failed = job.results.filter((r) => !r.ok && !UNFIXABLE.test(r.message));
    if (failed.length && process.env.AI_AUTOFIX !== "off") {
      job.phase = "fixing";
      try {
        const fix = await repair({
          request: job.request,
          failures: failed,
          serverState: await aiState(guild),
          memory: memoryOf(guild.id),
          allowedTypes: ACTION_TYPES,
        });
        const fixActions = fix.actions.filter((a) => !DESTRUCTIVE.has(a.type)).slice(0, 30);
        job.fixReply = fix.reply;
        job.total += fixActions.length;
        await runActions(guild, fixActions, (r) => {
          r.fix = true;
          job.results.push(r);
          job.done++;
        });
      } catch (e) {
        job.fixReply = `Couldn't auto-fix: ${e.message}`;
      }
    }
  } catch (e) {
    job.error = e.message;
  } finally {
    job.created = createdSince(guild, before);
    job.status = "done";
    job.phase = "done";
    busy.delete(guild.id);
  }
}

function startJob(guild, request, actions) {
  const job = newJob(guild.id, request);
  runJob(guild, job, actions);
  return job;
}

// ---------------------------------------------------------------- routes: basics

app.get("/api/status", (req, res) => {
  res.json({
    botReady: Boolean(client?.isReady()),
    botError,
    botWarning: membersIntentMissing
      ? "Server Members Intent is off so welcomes and autoroles won't fire. Turn it on in the Developer Portal → Bot, then restart."
      : contentIntentMissing
        ? "Message Content Intent is off so ticket transcripts won't have message text. Turn it on in the Developer Portal → Bot, then restart."
        : null,
    bot: client?.user ? { tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 128 }) } : null,
    invite: inviteUrl(),
    ai: providerInfo(),
    art: process.env.POLLINATIONS_KEY ? "pollinations (key)" : "pollinations (free)",
  });
});

app.get("/api/guilds", (req, res) => {
  if (!requireBot(res)) return;
  res.json({ guilds: listGuilds() });
});

app.get("/api/guilds/:id", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  const server = await snapshot(guild, { fresh: req.query.fresh === "1" });
  res.json({ server, busyJob: busy.get(guild.id) || null });
}));

// ---------------------------------------------------------------- routes: AI builder

// The AI can take a while on free tiers, so planning runs in the background and the site polls for
// live status ("asking Gemini…", "writing the plan…") instead of waiting on one long request.
const thinks = new Map();

app.post("/api/guilds/:id/chat", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  if (busy.has(guild.id)) return res.status(409).json({ error: "Still building the last thing, give me a sec.", jobId: busy.get(guild.id) });
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  if (!message) return res.status(400).json({ error: "Say something first." });
  const history = Array.isArray(req.body?.history) ? req.body.history : [];

  const t = { id: crypto.randomBytes(6).toString("hex"), status: "thinking", text: "👀 Reading your server…", startedAt: Date.now() };
  thinks.set(t.id, t);
  for (const [id, x] of thinks) if (Date.now() - x.startedAt > 30 * 60 * 1000) thinks.delete(id);
  res.json({ thinkId: t.id });

  console.log(`[AI] Owner: ${message.slice(0, 120)}`);
  try {
    const out = await plan({
      message,
      history,
      serverState: await aiState(guild),
      memory: memoryOf(guild.id),
      allowedTypes: ACTION_TYPES,
      onStatus: (text) => (t.text = text),
    });
    remember(guild.id, out.remember);
    if (out.questions.length || !out.actions.length) t.result = { reply: out.reply, questions: out.questions, actions: [] };
    else if (out.actions.some((a) => DESTRUCTIVE.has(a.type))) t.result = { reply: out.reply, actions: out.actions, needsConfirm: true };
    else if (busy.has(guild.id)) t.result = { reply: `${out.reply}\n\n(Another build is still running, try again in a sec.)`, actions: [] };
    else {
      const job = startJob(guild, message, out.actions);
      t.result = { reply: out.reply, actions: out.actions, jobId: job.id };
    }
    console.log(`[AI] Plan ready: ${out.actions.length} action(s), ${out.questions.length} question(s)`);
    t.status = "done";
  } catch (err) {
    console.error(`[AI] Failed: ${err.message}`);
    t.error = err.message;
    t.status = "error";
  }
}));

app.get("/api/think/:id", (req, res) => {
  const t = thinks.get(req.params.id);
  if (!t) return res.status(404).json({ error: "That message expired. Send it again." });
  res.json({ status: t.status, text: t.text, seconds: Math.round((Date.now() - t.startedAt) / 1000), result: t.result || null, error: t.error || null });
});

app.post("/api/guilds/:id/execute", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  if (busy.has(guild.id)) return res.status(409).json({ error: "Still building the last thing, give me a sec." });
  const actions = cleanActions(req.body?.actions);
  const job = startJob(guild, String(req.body?.request || "confirmed plan"), actions);
  res.json({ jobId: job.id });
}));

app.get("/api/jobs/:id", wrap(async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "That build is gone." });
  const out = publicJob(job);
  if (job.status === "done" && client?.isReady()) {
    const guild = client.guilds.cache.get(job.guildId);
    if (guild) out.server = await snapshot(guild, { fresh: true });
  }
  res.json({ job: out });
}));

app.post("/api/jobs/:id/undo", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const job = jobs.get(req.params.id);
  if (!job?.created) return res.status(404).json({ error: "Nothing to undo for that build." });
  if (job.undone) return res.status(400).json({ error: "Already undone." });
  const guild = getGuild(job.guildId);
  const results = await undoCreated(guild, job.created);
  job.undone = true;
  res.json({ results, server: await snapshot(guild, { fresh: true }) });
}));

app.post("/api/guilds/:id/memory/clear", wrap(async (req, res) => {
  updateConfig(req.params.id, (c) => (c.memory = { notes: [] }));
  res.json({ ok: true });
}));

app.post("/api/guilds/:id/memory/remove", wrap(async (req, res) => {
  const note = String(req.body?.note || "");
  updateConfig(req.params.id, (c) => {
    if (c.memory?.notes) c.memory.notes = c.memory.notes.filter((n) => n !== note);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- routes: dashboard

/** Run one action straight from a dashboard form. */
app.post("/api/guilds/:id/action", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  const actions = cleanActions([req.body?.action]);
  if (!actions.length) return res.status(400).json({ error: "Unknown action." });
  const results = await runActions(guild, actions);
  res.json({ results, server: await snapshot(guild, { fresh: true }) });
}));

app.get("/api/guilds/:id/leaderboard", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const board = leaderboard(req.params.id).slice(0, 25);
  const rows = await Promise.all(
    board.map(async (u, i) => {
      const user = await client.users.fetch(u.id).catch(() => null);
      return { rank: i + 1, id: u.id, name: user?.username || u.id, avatar: user?.displayAvatarURL({ size: 64 }) || null, level: u.level, xp: u.xp, need: xpNeeded(u.level), msgs: u.msgs || 0 };
    })
  );
  res.json({ rows });
}));

app.get("/api/guilds/:id/warnings", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const w = getConfig(req.params.id).warnings || {};
  const rows = await Promise.all(
    Object.entries(w)
      .filter(([, list]) => list.length)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 30)
      .map(async ([id, list]) => {
        const user = await client.users.fetch(id).catch(() => null);
        return { id, name: user?.username || id, avatar: user?.displayAvatarURL({ size: 64 }) || null, count: list.length, last: list[list.length - 1] };
      })
  );
  res.json({ rows });
}));

app.post("/api/guilds/:id/warnings/clear", wrap(async (req, res) => {
  const uid = String(req.body?.userId || "");
  updateConfig(req.params.id, (c) => {
    if (c.warnings) delete c.warnings[uid];
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- routes: AI art studio

const previews = new Map(); // token -> {buffer, guildId, kind, at}

app.post("/api/guilds/:id/art/preview", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  const kind = String(req.body?.kind || "");
  const idea = String(req.body?.idea || "").trim().slice(0, 500);
  if (!idea) return res.status(400).json({ error: "Describe what you want first." });
  const make = { icon: () => makeIcon(idea, guild.name), banner: () => makeBanner(idea, guild.name), emoji: () => makeEmoji(idea), image: () => makeImage(idea, true) }[kind];
  if (!make) return res.status(400).json({ error: "Unknown art type." });
  const { buffer, source } = await make();
  const token = crypto.randomBytes(8).toString("hex");
  previews.set(token, { buffer, guildId: guild.id, kind, at: Date.now() });
  for (const [t, p] of previews) if (Date.now() - p.at > 30 * 60 * 1000) previews.delete(t);
  const mime = imageExt(buffer) === "jpg" ? "image/jpeg" : "image/png";
  res.json({ token, source, image: `data:${mime};base64,${buffer.toString("base64")}` });
}));

app.post("/api/guilds/:id/art/apply", wrap(async (req, res) => {
  if (!requireBot(res)) return;
  const guild = getGuild(req.params.id);
  const p = previews.get(String(req.body?.token || ""));
  if (!p || p.guildId !== guild.id) return res.status(404).json({ error: "That preview expired. Generate it again." });
  let message;
  if (p.kind === "icon") message = await applyIcon(guild, p.buffer);
  else if (p.kind === "banner") message = await applyBanner(guild, p.buffer, req.body?.channel || null);
  else if (p.kind === "emoji") message = await addEmoji(guild, req.body?.name || "emoji", p.buffer);
  else if (p.kind === "image") {
    const ch = guild.channels.cache.get(String(req.body?.channel || ""));
    if (!ch?.isTextBased?.()) return res.status(400).json({ error: "Pick a channel to post it in." });
    await ch.send({ content: req.body?.message ? String(req.body.message).slice(0, 2000) : undefined, files: [{ attachment: p.buffer, name: `art.${imageExt(p.buffer)}` }] });
    message = `Posted in #${ch.name}`;
  }
  previews.delete(String(req.body.token));
  res.json({ message, server: await snapshot(guild, { fresh: true }) });
}));

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

// ---------------------------------------------------------------- start

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

startBot(TOKEN)
  .then((c) => {
    botError = null;
    console.log(`Bot logged in as ${c.user.tag}`);
    console.log(`Invite it to a server: ${inviteUrl()}`);
    const ai = providerInfo();
    console.log(ai.provider ? `AI: ${ai.provider} (${ai.model})${ai.backups.length ? ` + backup: ${ai.backups.join(", ")}` : ""}` : "AI: none set. Add GEMINI_API_KEY or GROQ_API_KEY to .env");
  })
  .catch((err) => {
    botError = err?.code === "TokenInvalid" ? "the token is invalid. Reset it in the Discord Developer Portal." : err?.message || String(err);
    console.error(`Bot login failed: ${botError}`);
  });
