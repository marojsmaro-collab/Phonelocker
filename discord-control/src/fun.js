// Giveaways, polls and the Question of the Day system.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from "discord.js";
import crypto from "node:crypto";
import { getConfig, updateConfig, allGuildIds } from "./store.js";
import { findTextChannel, findRoleOrThrow } from "./features.js";
import { questionOfTheDay } from "./ai.js";

const hexInt = (c, fallback = 0xf0b232) => {
  const s = String(c || "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : fallback;
};
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// =====================================================================
// Giveaways
// =====================================================================

function gwEmbed(gw) {
  const ends = Math.floor(gw.endsAt / 1000);
  const e = new EmbedBuilder().setColor(gw.ended ? 0x4e5058 : hexInt(gw.color)).setTitle(`🎉 ${gw.prize}${gw.ended ? " (ENDED)" : ""}`);
  const lines = [];
  if (gw.description) lines.push(gw.description, "");
  if (gw.ended) {
    lines.push(gw.winnerIds?.length ? `🏆 Winner${gw.winnerIds.length > 1 ? "s" : ""}: ${gw.winnerIds.map((id) => `<@${id}>`).join(", ")}` : "😭 Nobody entered");
  } else {
    lines.push("Tap **🎉 Enter** to join!", `⏰ Ends <t:${ends}:R> (<t:${ends}:f>)`);
  }
  lines.push(`👥 Entries: **${gw.entrants.length}**`, `🏆 Winners: **${gw.winners}**`);
  return e.setDescription(lines.join("\n").slice(0, 4000));
}

const gwRow = (gw) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gw:${gw.id}`).setLabel("Enter").setEmoji("🎉").setStyle(ButtonStyle.Success)
  );

function durationMinutes(a) {
  const m = Number(a.minutes) || Number(a.hours) * 60 || Number(a.days) * 1440 || 60;
  return Math.max(1, Math.min(60 * 24 * 30, Math.round(m)));
}

export async function startGiveaway(guild, a) {
  if (!a.prize) throw new Error("What's the prize?");
  const ch = findTextChannel(guild, a.channel);
  const gw = {
    id: crypto.randomBytes(4).toString("hex"),
    channelId: ch.id,
    prize: String(a.prize).slice(0, 200),
    description: a.description ? String(a.description).slice(0, 1500) : "",
    winners: Math.max(1, Math.min(20, Math.round(Number(a.winners) || 1))),
    endsAt: Date.now() + durationMinutes(a) * 60_000,
    entrants: [],
    ended: false,
    color: a.color || null,
  };
  const msg = await ch.send({ embeds: [gwEmbed(gw)], components: [gwRow(gw)] });
  gw.messageId = msg.id;
  updateConfig(guild.id, (c) => ((c.giveaways ||= {})[gw.id] = gw));
  return `Giveaway for ${gw.prize} started in #${ch.name}, ends in ${Math.round((gw.endsAt - Date.now()) / 60000)} min`;
}

const editTimers = new Map();
function scheduleEdit(guild, gw) {
  if (editTimers.has(gw.id)) return;
  editTimers.set(
    gw.id,
    setTimeout(async () => {
      editTimers.delete(gw.id);
      const fresh = getConfig(guild.id).giveaways?.[gw.id];
      const ch = guild.channels.cache.get(fresh?.channelId);
      const msg = ch && (await ch.messages.fetch(fresh.messageId).catch(() => null));
      if (msg) await msg.edit({ embeds: [gwEmbed(fresh)], components: fresh.ended ? [] : [gwRow(fresh)] }).catch(() => {});
    }, 2500)
  );
}

export async function onGiveawayButton(interaction, id) {
  const guild = interaction.guild;
  const gw = getConfig(guild.id).giveaways?.[id];
  if (!gw) return interaction.reply(ephemeral("This giveaway doesn't exist anymore."));
  if (gw.ended || Date.now() >= gw.endsAt) return interaction.reply(ephemeral("This giveaway already ended."));
  const uid = interaction.user.id;
  let joined = false;
  updateConfig(guild.id, (c) => {
    const g = c.giveaways[id];
    if (g.entrants.includes(uid)) g.entrants = g.entrants.filter((x) => x !== uid);
    else {
      g.entrants.push(uid);
      joined = true;
    }
  });
  scheduleEdit(guild, gw);
  const n = gw.entrants.length;
  return interaction.reply(ephemeral(joined ? `🎉 You're in! Good luck (${n} ${n === 1 ? "entry" : "entries"})` : "You left the giveaway."));
}

function pick(list, n, exclude = []) {
  const pool = list.filter((x) => !exclude.includes(x));
  const out = [];
  while (pool.length && out.length < n) out.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
  return out;
}

async function finishGiveaway(guild, id, { reroll = false } = {}) {
  const gw = getConfig(guild.id).giveaways?.[id];
  if (!gw) throw new Error("Couldn't find that giveaway.");
  const winners = pick(gw.entrants, reroll ? 1 : gw.winners, reroll ? gw.winnerIds || [] : []);
  updateConfig(guild.id, (c) => {
    const g = c.giveaways[id];
    g.ended = true;
    g.endsAt = Math.min(g.endsAt, Date.now());
    g.winnerIds = reroll ? [...(g.winnerIds || []), ...winners] : winners;
  });
  const ch = guild.channels.cache.get(gw.channelId);
  if (!ch) return "The giveaway channel is gone";
  const msg = await ch.messages.fetch(gw.messageId).catch(() => null);
  if (msg) await msg.edit({ embeds: [gwEmbed(getConfig(guild.id).giveaways[id])], components: [] }).catch(() => {});
  const text = winners.length
    ? `🎉 ${reroll ? "New winner" : "Congrats"} ${winners.map((w) => `<@${w}>`).join(", ")}! You won **${gw.prize}**!`
    : `😭 Nobody ${reroll ? "else " : ""}entered the **${gw.prize}** giveaway.`;
  await ch.send({ content: text, allowedMentions: { users: winners }, ...(msg ? { reply: { messageReference: msg.id, failIfNotExists: false } } : {}) });
  return winners.length ? `${gw.prize}: ${winners.length} winner(s) picked` : `${gw.prize}: nobody entered`;
}

function findGiveaway(guild, a, { active }) {
  const list = Object.values(getConfig(guild.id).giveaways || {}).filter((g) => (active ? !g.ended : g.ended));
  if (!list.length) throw new Error(active ? "No running giveaways." : "No finished giveaways.");
  if (a.id && list.find((g) => g.id === a.id)) return list.find((g) => g.id === a.id);
  if (a.prize) {
    const p = String(a.prize).toLowerCase();
    const hit = list.find((g) => g.prize.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return list.sort((x, y) => y.endsAt - x.endsAt)[0];
}

export async function endGiveaway(guild, a) {
  return finishGiveaway(guild, findGiveaway(guild, a, { active: true }).id);
}

export async function rerollGiveaway(guild, a) {
  return finishGiveaway(guild, findGiveaway(guild, a, { active: false }).id, { reroll: true });
}

// =====================================================================
// Polls (Discord's own poll feature)
// =====================================================================

export async function createPoll(guild, a) {
  const ch = findTextChannel(guild, a.channel);
  if (!a.question) throw new Error("What's the poll question?");
  const answers = [].concat(a.answers || [])
    .map((x) => (typeof x === "string" ? { text: x } : x))
    .filter((x) => x?.text)
    .slice(0, 10)
    .map((x) => {
      const out = { text: String(x.text).slice(0, 55) };
      if (typeof x.emoji === "string" && /\p{Extended_Pictographic}/u.test(x.emoji) && [...x.emoji].length <= 8) out.emoji = x.emoji.trim();
      return out;
    });
  if (answers.length < 2) throw new Error("A poll needs at least 2 answers.");
  await ch.send({
    content: a.message ? String(a.message).slice(0, 2000) : undefined,
    poll: {
      question: { text: String(a.question).slice(0, 300) },
      answers,
      duration: Math.max(1, Math.min(768, Math.round(Number(a.hours) || 24))),
      allowMultiselect: Boolean(a.multi),
    },
  });
  return `Poll posted in #${ch.name}`;
}

// =====================================================================
// Question of the Day
// =====================================================================

const BACKUP_QUESTIONS = [
  "If you could add one item to any game, what would it be?",
  "What's the most chaotic thing you've done in a game?",
  "Which game would you delete from existence and why?",
  "What's your go-to snack while gaming?",
  "If your pet could talk, what would it roast you about?",
  "What's a game you think is underrated?",
  "Best Roblox game of all time? Defend your answer.",
  "If you had a giant mech for one day, what would you destroy first?",
  "What's the worst game you've ever played?",
  "Which game soundtrack lives in your head rent free?",
  "If you could live inside any game world, which one?",
  "What's your most useless talent?",
  "What would your boss fight theme song be?",
  "Morning person or 3am gamer?",
  "What's one game mechanic you wish every game had?",
  "If you could only eat one food forever, what is it?",
  "What's the funniest bug you've ever seen in a game?",
  "Which fictional character would you want as your teammate?",
  "What's your hottest gaming take?",
  "What was the first game you ever got obsessed with?",
  "If you made a game, what would it be about?",
  "What's the rarest item you've ever had in a game?",
  "Which mobile game are you secretly addicted to?",
  "Describe your playstyle in 3 emojis.",
  "What's a skill you want to learn this year?",
];

export function configureQotd(guild, a) {
  const prev = getConfig(guild.id).qotd || {};
  const ch = a.channel ? findTextChannel(guild, a.channel) : null;
  if (!ch && !prev.channelId && a.enabled !== false) throw new Error("Tell me which channel to post the question of the day in.");
  const time = /^\d{1,2}:\d{2}$/.test(String(a.time || "")) ? String(a.time).padStart(5, "0") : prev.time || "17:00";
  let pingRoleId = prev.pingRoleId ?? null;
  if (a.ping_role !== undefined) pingRoleId = a.ping_role && a.ping_role !== "none" ? findRoleOrThrow(guild, a.ping_role).id : null;
  updateConfig(guild.id, (c) => {
    c.qotd = {
      ...prev,
      enabled: a.enabled !== false,
      ...(ch ? { channelId: ch.id } : {}),
      time,
      topic: a.topic !== undefined ? String(a.topic || "").slice(0, 200) : prev.topic || "",
      pingRoleId,
      history: prev.history || [],
      count: prev.count || 0,
    };
  });
  const q = getConfig(guild.id).qotd;
  if (!q.enabled) return "Question of the Day turned off";
  return `Question of the Day posts daily at ${q.time} in #${guild.channels.cache.get(q.channelId)?.name}`;
}

export async function postQotd(guild) {
  const q = getConfig(guild.id).qotd;
  if (!q?.channelId) throw new Error("Set up Question of the Day first.");
  const ch = guild.channels.cache.get(q.channelId);
  if (!ch?.isTextBased()) throw new Error("The QOTD channel is gone. Set it up again.");
  let question = null;
  try {
    question = await questionOfTheDay({ topic: q.topic, recent: q.history || [] });
  } catch {
    /* use a backup question */
  }
  if (!question) {
    const unused = BACKUP_QUESTIONS.filter((x) => !(q.history || []).includes(x));
    const list = unused.length ? unused : BACKUP_QUESTIONS;
    question = list[crypto.randomInt(list.length)];
  }
  const n = (q.count || 0) + 1;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`❓ Question of the Day #${n}`)
    .setDescription(`**${question}**`)
    .setFooter({ text: "Answer in the thread below 👇" })
    .setTimestamp();
  const msg = await ch.send({
    content: q.pingRoleId ? `<@&${q.pingRoleId}>` : undefined,
    embeds: [embed],
    allowedMentions: { roles: q.pingRoleId ? [q.pingRoleId] : [] },
  });
  await msg.startThread({ name: `QOTD #${n}`, autoArchiveDuration: 1440 }).catch(() => {});
  updateConfig(guild.id, (c) => {
    c.qotd.count = n;
    c.qotd.lastDate = today();
    c.qotd.history = [...(c.qotd.history || []), question].slice(-60);
  });
  return `Posted QOTD #${n} in #${ch.name}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// =====================================================================
// Scheduler: ends giveaways and posts QOTD on time
// =====================================================================

let ticking = false;
export function startScheduler(getClient) {
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const client = getClient();
      if (!client?.isReady()) return;
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      for (const gid of allGuildIds()) {
        const guild = client.guilds.cache.get(gid);
        if (!guild) continue;
        const cfg = getConfig(gid);
        for (const gw of Object.values(cfg.giveaways || {})) {
          if (!gw.ended && gw.endsAt <= Date.now()) {
            await finishGiveaway(guild, gw.id).catch((e) => console.error("Giveaway end failed:", e.message));
          }
        }
        const q = cfg.qotd;
        if (q?.enabled && q.channelId && hhmm >= q.time && q.lastDate !== today()) {
          await postQotd(guild).catch((e) => {
            console.error("QOTD failed:", e.message);
            updateConfig(gid, (c) => (c.qotd.lastDate = today())); // don't spam retries
          });
        }
      }
    } finally {
      ticking = false;
    }
  }, 20_000);
}

/** For the website and the AI. */
export function funState(guild) {
  const cfg = getConfig(guild.id);
  const name = (id) => guild.channels.cache.get(id)?.name ?? null;
  return {
    giveaways: Object.values(cfg.giveaways || {})
      .sort((a, b) => b.endsAt - a.endsAt)
      .slice(0, 15)
      .map((g) => ({ id: g.id, prize: g.prize, channel: name(g.channelId), endsAt: g.endsAt, ended: g.ended, entries: g.entrants.length, winners: g.winners, winnerIds: g.winnerIds || [] })),
    qotd: cfg.qotd
      ? { enabled: cfg.qotd.enabled, channel: name(cfg.qotd.channelId), time: cfg.qotd.time, topic: cfg.qotd.topic, count: cfg.qotd.count || 0 }
      : null,
  };
}
