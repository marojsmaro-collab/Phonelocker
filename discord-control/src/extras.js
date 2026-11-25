// Tickets, self role buttons, leveling, /help and the bot's own avatar and status.
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, updateConfig } from "./store.js";
import { renderRankCard } from "./card.js";
import { findTextChannel, findRoleOrThrow, modLog } from "./features.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BRAND = 0x5865f2;

function hexInt(c, fallback = BRAND) {
  const s = String(c || "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : fallback;
}

function validEmoji(e) {
  if (typeof e !== "string") return undefined;
  const s = e.trim();
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(s)) return s;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && [...s].length <= 8) return s;
  return undefined;
}

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// =====================================================================
// Self role buttons
// =====================================================================

export async function createRolePanel(guild, a) {
  const ch = findTextChannel(guild, a.channel);
  const items = [].concat(a.roles || []).slice(0, 25).map((r) => {
    const name = typeof r === "string" ? r : r?.role;
    const role = findRoleOrThrow(guild, name);
    return {
      role,
      label: String((typeof r === "object" && r.label) || role.name).slice(0, 80),
      emoji: validEmoji(typeof r === "object" ? r.emoji : undefined),
    };
  });
  if (!items.length) throw new Error("Tell me which roles to put on the panel.");

  const me = guild.members.me;
  const tooHigh = items.filter((i) => i.role.managed || (me && i.role.position >= me.roles.highest.position));

  const rows = chunk(items, 5).map((group) =>
    new ActionRowBuilder().addComponents(
      group.map((i) => {
        const b = new ButtonBuilder().setCustomId(`sr:${i.role.id}`).setLabel(i.label).setStyle(ButtonStyle.Secondary);
        if (i.emoji) b.setEmoji(i.emoji);
        return b;
      })
    )
  );
  const embed = new EmbedBuilder()
    .setColor(hexInt(a.color))
    .setTitle(String(a.title || "🎭 Pick your roles").slice(0, 256))
    .setDescription(
      String(
        a.description ||
          items.map((i) => `${i.emoji ?? "•"} **${i.label}**`).join("\n") + "\n\nTap a button to get a role. Tap it again to remove it."
      ).slice(0, 4000)
    );
  await ch.send({ embeds: [embed], components: rows });
  return (
    `Posted a role panel in #${ch.name} with ${items.length} role(s)` +
    (tooHigh.length ? ` (drag my role above ${tooHigh.map((i) => "@" + i.role.name).join(", ")} so I can hand them out)` : "")
  );
}

async function onSelfRole(interaction, roleId) {
  const guild = interaction.guild;
  const role = guild.roles.cache.get(roleId);
  if (!role) return interaction.reply(ephemeral("That role doesn't exist anymore."));
  const me = guild.members.me;
  if (role.managed || (me && role.position >= me.roles.highest.position)) {
    return interaction.reply(ephemeral("I can't give that role yet. Ask the owner to drag my role higher."));
  }
  const member = interaction.member;
  const has = member.roles.cache.has(roleId);
  if (has) await member.roles.remove(roleId, "Self role");
  else await member.roles.add(roleId, "Self role");
  return interaction.reply(ephemeral(has ? `➖ Removed **${role.name}**` : `➕ You got **${role.name}**`));
}

// =====================================================================
// Tickets
// =====================================================================

const TICKET_TAG = "ticket-owner:";

export async function setupTickets(guild, a) {
  const panel = findTextChannel(guild, a.channel);
  const supportRoles = [].concat(a.support_roles || []).map((r) => findRoleOrThrow(guild, r));
  const logCh = a.log_channel ? findTextChannel(guild, a.log_channel) : null;

  const catName = a.category || "🎫 TICKETS";
  let cat = [...guild.channels.cache.values()].find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === String(catName).toLowerCase()
  );
  if (!cat) {
    cat = await guild.channels.create({
      name: catName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
        ...supportRoles.map((r) => ({ id: r.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] })),
      ],
    });
  }

  const prev = getConfig(guild.id).tickets || {};
  updateConfig(guild.id, (c) => {
    c.tickets = {
      counter: prev.counter || 0,
      categoryId: cat.id,
      supportRoleIds: supportRoles.map((r) => r.id),
      logChannelId: logCh?.id ?? prev.logChannelId ?? null,
      message: a.ticket_message ? String(a.ticket_message).slice(0, 1500) : prev.message || null,
      color: a.color || prev.color || null,
    };
  });

  const embed = new EmbedBuilder()
    .setColor(hexInt(a.color))
    .setTitle(String(a.title || "🎫 Need help?").slice(0, 256))
    .setDescription(String(a.description || "Tap the button below to open a private ticket with the staff team.").slice(0, 4000));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("tk:open")
      .setLabel(String(a.button_label || "Open a ticket").slice(0, 80))
      .setEmoji(validEmoji(a.button_emoji) || "🎫")
      .setStyle(ButtonStyle.Primary)
  );
  await panel.send({ embeds: [embed], components: [row] });
  return `Ticket panel posted in #${panel.name}, tickets open in ${cat.name}${logCh ? `, transcripts go to #${logCh.name}` : ""}`;
}

async function openTicket(interaction) {
  const guild = interaction.guild;
  const user = interaction.user;
  const cfg = getConfig(guild.id).tickets;
  if (!cfg) return interaction.reply(ephemeral("Tickets aren't set up here yet."));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const existing = guild.channels.cache.find((c) => c.topic?.includes(`${TICKET_TAG}${user.id}`));
  if (existing) return interaction.editReply(`You already have a ticket open: ${existing}`);

  let cat = guild.channels.cache.get(cfg.categoryId);
  if (!cat) {
    cat = await guild.channels.create({ name: "🎫 TICKETS", type: ChannelType.GuildCategory });
    updateConfig(guild.id, (c) => (c.tickets.categoryId = cat.id));
  }

  let number = 0;
  updateConfig(guild.id, (c) => (number = c.tickets.counter = (c.tickets.counter || 0) + 1));
  const supportIds = (cfg.supportRoleIds || []).filter((id) => guild.roles.cache.has(id));
  const view = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
  ];

  const ch = await guild.channels.create({
    name: `ticket-${String(number).padStart(4, "0")}`,
    type: ChannelType.GuildText,
    parent: cat.id,
    topic: `Ticket for ${user.tag} · ${TICKET_TAG}${user.id}`,
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, type: OverwriteType.Member, allow: view },
      ...supportIds.map((id) => ({ id, type: OverwriteType.Role, allow: [...view, PermissionFlagsBits.ManageMessages] })),
      { id: guild.client.user.id, type: OverwriteType.Member, allow: [...view, PermissionFlagsBits.ManageChannels] },
    ],
  });

  const embed = new EmbedBuilder()
    .setColor(hexInt(cfg.color))
    .setTitle(`🎫 Ticket #${String(number).padStart(4, "0")}`)
    .setDescription(cfg.message || "Thanks for reaching out! Tell us what you need and staff will be with you soon.")
    .setFooter({ text: "Press Close when you're done" });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("tk:close").setLabel("Close").setEmoji("🔒").setStyle(ButtonStyle.Danger)
  );
  await ch.send({
    content: [`${user}`, ...supportIds.map((id) => `<@&${id}>`)].join(" "),
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [user.id], roles: supportIds },
  });
  await interaction.editReply(`✅ Your ticket is open: ${ch}`);
  await logTicket(guild, new EmbedBuilder().setColor(0x23a55a).setTitle("🎫 Ticket opened").setDescription(`${ch} by ${user}`).setTimestamp());
}

async function logTicket(guild, embed, files) {
  const id = getConfig(guild.id).tickets?.logChannelId;
  const ch = id && guild.channels.cache.get(id);
  if (ch?.isTextBased()) await ch.send({ embeds: [embed], files }).catch(() => {});
  else await modLog(guild, embed);
}

async function buildTranscript(channel) {
  const all = [];
  let before;
  for (let i = 0; i < 5; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.reverse();
  const lines = all.map((m) => {
    const t = new Date(m.createdTimestamp).toISOString().replace("T", " ").slice(0, 16);
    const parts = [m.content || ""];
    if (m.embeds.length) parts.push(m.embeds.map((e) => `[embed: ${e.title || e.description || ""}]`.slice(0, 200)).join(" "));
    if (m.attachments.size) parts.push(m.attachments.map((x) => x.url).join(" "));
    return `[${t}] ${m.author.tag}: ${parts.filter(Boolean).join(" ") || "(no text)"}`;
  });
  return `Transcript of #${channel.name}\n${channel.topic || ""}\n\n${lines.join("\n")}\n`;
}

async function closeTicket(interaction) {
  const ch = interaction.channel;
  const guild = interaction.guild;
  const tag = ch?.topic?.match(new RegExp(`${TICKET_TAG}(\\d+)`));
  if (!tag) return interaction.reply(ephemeral("This isn't a ticket channel."));
  const ownerId = tag[1];
  const cfg = getConfig(guild.id).tickets || {};
  const member = interaction.member;
  const isStaff =
    member.permissions?.has(PermissionFlagsBits.ManageChannels) ||
    (cfg.supportRoleIds || []).some((id) => member.roles.cache.has(id));
  if (interaction.user.id !== ownerId && !isStaff) return interaction.reply(ephemeral("Only the ticket owner or staff can close this."));

  await interaction.reply("🔒 Closing this ticket in 5 seconds...");
  const text = await buildTranscript(ch).catch(() => null);
  const embed = new EmbedBuilder()
    .setColor(0xf23f43)
    .setTitle("🔒 Ticket closed")
    .addFields(
      { name: "Ticket", value: ch.name, inline: true },
      { name: "Opened by", value: `<@${ownerId}>`, inline: true },
      { name: "Closed by", value: `${interaction.user}`, inline: true }
    )
    .setTimestamp();
  await logTicket(guild, embed, text ? [{ attachment: Buffer.from(text, "utf8"), name: `${ch.name}.txt` }] : undefined);
  setTimeout(() => ch.delete("Ticket closed").catch(() => {}), 5000);
}

// =====================================================================
// Leveling
// =====================================================================

export const xpNeeded = (level) => 5 * level * level + 50 * level + 100;
const totalXp = (u) => {
  let t = u.xp || 0;
  for (let l = 0; l < (u.level || 0); l++) t += xpNeeded(l);
  return t;
};
const cooldowns = new Map();
const DEFAULT_LEVELUP = "🎉 GG {user} you just hit **level {level}**!";

export function configureLeveling(guild, a) {
  const prev = getConfig(guild.id).levels || {};
  let channelId = prev.channelId ?? null;
  if (a.channel !== undefined) {
    channelId = !a.channel || /^(same|here|none)$/i.test(String(a.channel)) ? null : findTextChannel(guild, a.channel).id;
  }
  let rewards = prev.rewards || [];
  if (a.rewards !== undefined) {
    rewards = [].concat(a.rewards || []).map((r) => ({
      level: Math.max(1, Math.round(Number(r.level) || 1)),
      roleId: findRoleOrThrow(guild, r.role).id,
    }));
  }
  updateConfig(guild.id, (c) => {
    c.levels = {
      ...prev,
      enabled: a.enabled !== false,
      channelId,
      message: a.message ? String(a.message).slice(0, 500) : prev.message || null,
      rewards,
      color: a.card_color || prev.color || null,
    };
  });
  if (a.enabled === false) return "Leveling turned off";
  const where = channelId ? `#${guild.channels.cache.get(channelId)?.name}` : "the same channel";
  const r = rewards.map((x) => `lvl ${x.level} → @${guild.roles.cache.get(x.roleId)?.name}`).join(", ");
  return `Leveling on, level ups announced in ${where}${r ? `, rewards: ${r}` : ""}`;
}

export async function onMessage(msg) {
  if (!msg.guild || msg.author.bot || msg.webhookId || msg.system) return;
  const lv = getConfig(msg.guild.id).levels;
  if (!lv?.enabled) return;
  const key = `${msg.guild.id}:${msg.author.id}`;
  const now = Date.now();
  if ((cooldowns.get(key) || 0) > now) return;
  cooldowns.set(key, now + 60_000);

  const gain = 15 + Math.floor(Math.random() * 11);
  let newLevel = null;
  updateConfig(msg.guild.id, (c) => {
    c.levels.users ||= {};
    const u = (c.levels.users[msg.author.id] ||= { xp: 0, level: 0, msgs: 0 });
    u.xp += gain;
    u.msgs += 1;
    while (u.xp >= xpNeeded(u.level)) {
      u.xp -= xpNeeded(u.level);
      u.level += 1;
      newLevel = u.level;
    }
  });
  if (!newLevel) return;

  const me = msg.guild.members.me;
  const member = msg.member;
  if (member) {
    for (const r of lv.rewards || []) {
      const role = msg.guild.roles.cache.get(r.roleId);
      if (role && r.level <= newLevel && !member.roles.cache.has(role.id) && me && role.position < me.roles.highest.position) {
        await member.roles.add(role, `Reached level ${r.level}`).catch(() => {});
      }
    }
  }

  const ch = (lv.channelId && msg.guild.channels.cache.get(lv.channelId)) || msg.channel;
  const text = String(lv.message || DEFAULT_LEVELUP)
    .replaceAll("{user}", `${msg.author}`)
    .replaceAll("{username}", msg.author.username)
    .replaceAll("{level}", String(newLevel))
    .replaceAll("{server}", msg.guild.name);
  await ch.send({ content: text.slice(0, 2000), allowedMentions: { users: [msg.author.id] } }).catch(() => {});
}

export function leaderboard(guildId) {
  const users = getConfig(guildId).levels?.users || {};
  return Object.entries(users)
    .map(([id, u]) => ({ id, ...u, total: totalXp(u) }))
    .sort((a, b) => b.total - a.total);
}

// =====================================================================
// Bot avatar and status
// =====================================================================

const ACTIVITY = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
};

function applyStatus(client) {
  const s = getConfig("_bot").status || { text: "Building servers 🛠️", type: "custom", status: "online" };
  const type = ACTIVITY[String(s.type || "custom").toLowerCase()] ?? ActivityType.Custom;
  const activity = !s.text
    ? null
    : type === ActivityType.Custom
      ? { name: "Custom Status", state: s.text, type }
      : { name: s.text, type };
  client.user.setPresence({
    activities: activity ? [activity] : [],
    status: ["online", "idle", "dnd", "invisible"].includes(s.status) ? s.status : "online",
  });
}

export function setBotStatus(client, a) {
  updateConfig("_bot", (c) => {
    c.status = {
      text: a.text ? String(a.text).slice(0, 128) : "",
      type: a.activity || a.type || "custom",
      status: a.status || "online",
    };
  });
  applyStatus(client);
  return a.text ? `Bot status set to "${a.text}"` : "Cleared the bot status";
}

export async function setBotAvatar(client, a) {
  if (!a.image_url || !/^https?:\/\//i.test(a.image_url)) throw new Error("Bot avatars need an image link.");
  await client.user.setAvatar(a.image_url);
  updateConfig("_bot", (c) => (c.avatarHash = "custom"));
  return "Updated the bot's pfp";
}

/** On startup: apply the saved status, and the bundled avatar if it changed since last time. */
export async function applyBranding(client) {
  try {
    applyStatus(client);
  } catch (e) {
    console.error("Status failed:", e.message);
  }
  await applyImage(client, "bot-avatar.png", "avatarHash", (buf) => client.user.setAvatar(buf), "pfp");
  await applyImage(client, "bot-banner.png", "bannerHash", (buf) => client.user.setBanner(buf), "banner");
}

async function applyImage(client, fileName, key, apply, label) {
  try {
    const file = path.join(here, "..", "assets", fileName);
    if (!fs.existsSync(file)) return;
    const buf = fs.readFileSync(file);
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    const saved = getConfig("_bot")[key];
    if (saved === hash || saved === "custom") return;
    await apply(buf);
    updateConfig("_bot", (c) => (c[key] = hash));
    console.log(`Bot ${label} updated`);
  } catch (e) {
    console.error(`Could not set the bot ${label} (Discord limits how often it can change, it'll retry next start):`, e.message);
  }
}

// =====================================================================
// Slash commands for everyone
// =====================================================================

export const extraCommands = [
  new SlashCommandBuilder().setName("rank").setDescription("See your level card")
    .addUserOption((o) => o.setName("user").setDescription("Someone else")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Top 10 most active people"),
  new SlashCommandBuilder().setName("help").setDescription("Everything I can do"),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

const EXTRA_NAMES = new Set(extraCommands.map((c) => c.name));

export function handlesCommand(name) {
  return EXTRA_NAMES.has(name);
}

export async function onExtraCommand(interaction) {
  const { commandName: cmd, guild } = interaction;

  if (cmd === "rank") {
    if (!getConfig(guild.id).levels?.enabled) return interaction.reply(ephemeral("Leveling isn't turned on here."));
    const user = interaction.options.getUser("user") || interaction.user;
    if (user.bot) return interaction.reply(ephemeral("Bots don't level up 🤖"));
    await interaction.deferReply();
    const board = leaderboard(guild.id);
    const idx = board.findIndex((u) => u.id === user.id);
    const u = idx >= 0 ? board[idx] : { xp: 0, level: 0 };
    const png = await renderRankCard({
      avatarUrl: user.displayAvatarURL({ extension: "png", size: 256, forceStatic: true }),
      name: user.username,
      level: u.level,
      rank: idx >= 0 ? idx + 1 : board.length + 1,
      xp: u.xp,
      need: xpNeeded(u.level),
      color: getConfig(guild.id).levels?.color,
    });
    return interaction.editReply({ files: [{ attachment: png, name: "rank.png" }] });
  }

  if (cmd === "leaderboard") {
    if (!getConfig(guild.id).levels?.enabled) return interaction.reply(ephemeral("Leveling isn't turned on here."));
    const top = leaderboard(guild.id).slice(0, 10);
    const medals = ["🥇", "🥈", "🥉"];
    const text = top.length
      ? top.map((u, i) => `${medals[i] || `**${i + 1}.**`} <@${u.id}> · level ${u.level} (${u.msgs || 0} msgs)`).join("\n")
      : "Nobody has XP yet. Start chatting!";
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(BRAND).setTitle(`🏆 ${guild.name} leaderboard`).setDescription(text)],
      allowedMentions: { parse: [] },
    });
  }

  if (cmd === "help") {
    const e = new EmbedBuilder()
      .setColor(BRAND)
      .setTitle("🛠️ Serverbuilder")
      .setDescription("My owner controls me from a website. Here's what you can use in Discord:")
      .addFields(
        { name: "⭐ Everyone", value: "`/rank` your level card\n`/leaderboard` top chatters\n`/help` this list" },
        {
          name: "🛡️ Staff",
          value: "`/ban` `/unban` `/kick` `/timeout` `/untimeout`\n`/warn` `/warnings` `/clearwarns`\n`/purge` `/lock` `/unlock` `/slowmode`",
        },
        { name: "🤖 Automatic", value: "Welcome cards, AutoMod, tickets, self roles and level ups" }
      );
    return interaction.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
  }
}

export async function onButton(interaction) {
  const id = interaction.customId;
  try {
    if (id.startsWith("sr:")) return await onSelfRole(interaction, id.slice(3));
    if (id === "tk:open") return await openTicket(interaction);
    if (id === "tk:close") return await closeTicket(interaction);
  } catch (err) {
    console.error(`Button ${id} failed:`, err.message);
    const msg = err.code === 50013 ? "I'm missing permissions for that. Ask the owner to drag my role higher." : err.message;
    if (interaction.deferred || interaction.replied) return interaction.editReply(`❌ ${msg}`).catch(() => {});
    return interaction.reply(ephemeral(`❌ ${msg}`)).catch(() => {});
  }
}

/** Shown on the website and given to the AI. */
export function extraState(guild) {
  const cfg = getConfig(guild.id);
  const name = (id) => (id ? guild.channels.cache.get(id)?.name ?? null : null);
  const role = (id) => guild.roles.cache.get(id)?.name ?? null;
  return {
    tickets: cfg.tickets
      ? {
          category: name(cfg.tickets.categoryId),
          supportRoles: (cfg.tickets.supportRoleIds || []).map(role).filter(Boolean),
          logChannel: name(cfg.tickets.logChannelId),
          opened: cfg.tickets.counter || 0,
        }
      : null,
    leveling: cfg.levels
      ? {
          enabled: Boolean(cfg.levels.enabled),
          channel: name(cfg.levels.channelId) || "same channel",
          rewards: (cfg.levels.rewards || []).map((r) => ({ level: r.level, role: role(r.roleId) })),
          members: Object.keys(cfg.levels.users || {}).length,
        }
      : null,
    botStatus: getConfig("_bot").status?.text ?? "Building servers 🛠️",
  };
}
