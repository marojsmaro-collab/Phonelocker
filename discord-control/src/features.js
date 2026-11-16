// Welcome cards, goodbyes, autoroles, Discord AutoMod setup and moderation slash commands.
import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleKeywordPresetType,
  AutoModerationRuleTriggerType,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { getConfig, updateConfig } from "./store.js";
import { renderWelcomeCard } from "./card.js";

// ---------- shared helpers ----------

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "");

function findIn(list, name) {
  if (!name) return null;
  const s = String(name);
  return (
    list.find((x) => x.id === s) ||
    list.find((x) => x.name === s) ||
    list.find((x) => x.name.toLowerCase() === s.toLowerCase()) ||
    (norm(s) ? list.find((x) => norm(x.name) === norm(s)) : null) ||
    null
  );
}

export function findTextChannel(guild, name) {
  const list = [...guild.channels.cache.values()].filter(
    (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
  );
  const ch = findIn(list, String(name ?? "").replace(/^#/, ""));
  if (!ch) throw new Error(`Could not find text channel "${name}".`);
  return ch;
}

export function findRoleOrThrow(guild, name) {
  const role = findIn([...guild.roles.cache.values()].filter((r) => r.id !== guild.id), String(name ?? "").replace(/^@/, ""));
  if (!role) throw new Error(`Could not find role "${name}".`);
  return role;
}

function hexColor(c) {
  const s = String(c || "").trim();
  return /^#?[0-9a-f]{6}$/i.test(s) ? (s.startsWith("#") ? s : `#${s}`) : undefined;
}

// ---------- welcome / goodbye / autoroles ----------

const DEFAULT_WELCOME = "Hey {user} welcome to **{server}** 🎉 you're member #{count}!";
const DEFAULT_GOODBYE = "**{username}** just left {server} 👋";

function fill(template, member) {
  const user = member.user ?? member;
  return String(template)
    .replaceAll("{user}", `<@${user.id}>`)
    .replaceAll("{username}", user.username ?? "someone")
    .replaceAll("{name}", member.displayName ?? user.globalName ?? user.username ?? "someone")
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{count}", String(member.guild.memberCount));
}

export async function sendWelcome(channel, member, w = {}) {
  const user = member.user;
  const payload = {
    content: fill(w.message || DEFAULT_WELCOME, member).slice(0, 2000),
    allowedMentions: { users: [user.id] },
  };
  if (w.card !== false) {
    try {
      const png = await renderWelcomeCard({
        avatarUrl: user.displayAvatarURL({ extension: "png", size: 256, forceStatic: true }),
        name: user.username,
        title: w.cardTitle || "WELCOME",
        subtitle: `Member #${member.guild.memberCount} of ${member.guild.name}`,
        color: w.cardColor,
        backgroundUrl: w.cardBackground,
      });
      payload.files = [{ attachment: png, name: "welcome.png" }];
    } catch (err) {
      console.error("Welcome card failed:", err.message);
    }
  }
  await channel.send(payload);
}

export async function onMemberJoin(member) {
  const cfg = getConfig(member.guild.id);
  const me = member.guild.members.me;

  for (const id of cfg.autoroles || []) {
    const role = member.guild.roles.cache.get(id);
    if (role && me && role.position < me.roles.highest.position) {
      await member.roles.add(role, "Autorole").catch((e) => console.error("Autorole failed:", e.message));
    }
  }

  const w = cfg.welcome;
  if (w?.enabled && w.channelId) {
    const ch = member.guild.channels.cache.get(w.channelId);
    if (ch?.isTextBased()) await sendWelcome(ch, member, w).catch((e) => console.error("Welcome failed:", e.message));
  }
}

export async function onMemberLeave(member) {
  const g = getConfig(member.guild.id).goodbye;
  if (!g?.enabled || !g.channelId) return;
  const ch = member.guild.channels.cache.get(g.channelId);
  if (!ch?.isTextBased()) return;
  await ch
    .send({ content: fill(g.message || DEFAULT_GOODBYE, member).slice(0, 2000), allowedMentions: { parse: [] } })
    .catch((e) => console.error("Goodbye failed:", e.message));
}

// ---------- mod log ----------

export async function modLog(guild, embed) {
  const id = getConfig(guild.id).modLogChannelId;
  const ch = id && guild.channels.cache.get(id);
  if (ch?.isTextBased()) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ---------- AutoMod (runs on Discord's side, even when the bot is offline) ----------

const RULE = {
  preset: "🤬 Bad word filter",
  words: "🚫 Blocked words",
  links: "🔗 Link and invite blocker",
  spam: "📛 Spam filter",
  mentions: "📣 Mention spam",
};

const LINK_REGEX = "(?i)(https?://|www\\.)\\S+";
const INVITE_REGEX = "(?i)(discord\\.gg|discord(app)?\\.com/invite|dsc\\.gg)/\\S+";

export async function setupAutomod(guild, a) {
  const rules = await guild.autoModerationRules.fetch();
  const lines = [];

  let alertChannel = null;
  if (a.alert_channel) alertChannel = findTextChannel(guild, a.alert_channel);
  else {
    const id = getConfig(guild.id).modLogChannelId;
    alertChannel = id ? guild.channels.cache.get(id) : null;
  }
  const exemptRoles = (a.exempt_roles || []).map((r) => findRoleOrThrow(guild, r).id);
  const timeoutSeconds = Math.min(2419200, Math.max(0, Math.round(Number(a.timeout_minutes || 0) * 60)));
  const blockMsg = a.custom_message ? String(a.custom_message).slice(0, 150) : "Watch it! AutoMod blocked that message.";

  const actions = (allowTimeout) => {
    const list = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: blockMsg } }];
    if (alertChannel) list.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: alertChannel.id } });
    if (allowTimeout && timeoutSeconds > 0) {
      list.push({ type: AutoModerationActionType.Timeout, metadata: { durationSeconds: timeoutSeconds } });
    }
    return list;
  };

  async function upsert(label, triggerType, findExisting, enabled, triggerMetadata, allowTimeout) {
    const existing = findExisting();
    try {
      if (!enabled) {
        if (existing && existing.enabled) {
          await existing.edit({ enabled: false });
          lines.push(`turned off ${existing.name}`);
        }
        return;
      }
      const data = {
        enabled: true,
        actions: actions(allowTimeout),
        exemptRoles,
        ...(triggerMetadata ? { triggerMetadata } : {}),
      };
      if (existing) await existing.edit(data);
      else {
        await guild.autoModerationRules.create({
          name: label,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType,
          ...data,
        });
      }
      lines.push(`${existing ? "updated" : "turned on"} ${label}`);
    } catch (err) {
      lines.push(`couldn't set ${label}: ${err.message}`);
    }
  }

  const byType = (t) => () => rules.find((r) => r.triggerType === t);
  const byName = (n) => () => rules.find((r) => r.name === n && r.triggerType === AutoModerationRuleTriggerType.Keyword);

  // Discord's built in word lists (only one of these rules per server)
  if (a.bad_words !== undefined || a.sexual_content !== undefined || a.slurs !== undefined) {
    const presets = [];
    if (a.bad_words) presets.push(AutoModerationRuleKeywordPresetType.Profanity);
    if (a.sexual_content) presets.push(AutoModerationRuleKeywordPresetType.SexualContent);
    if (a.slurs) presets.push(AutoModerationRuleKeywordPresetType.Slurs);
    await upsert(RULE.preset, AutoModerationRuleTriggerType.KeywordPreset, byType(AutoModerationRuleTriggerType.KeywordPreset),
      presets.length > 0, { presets }, false);
  }

  if (a.block_words !== undefined) {
    const words = [].concat(a.block_words || []).map((w) => String(w).trim().slice(0, 60)).filter(Boolean).slice(0, 1000);
    await upsert(RULE.words, AutoModerationRuleTriggerType.Keyword, byName(RULE.words), words.length > 0,
      { keywordFilter: words }, true);
  }

  if (a.block_links !== undefined || a.block_invites !== undefined) {
    const cfgPrev = getConfig(guild.id).automodLinks || {};
    const links = a.block_links ?? cfgPrev.links ?? false;
    const invites = a.block_invites ?? cfgPrev.invites ?? false;
    updateConfig(guild.id, (c) => (c.automodLinks = { links, invites }));
    const patterns = [];
    if (links) patterns.push(LINK_REGEX);
    if (invites && !links) patterns.push(INVITE_REGEX);
    await upsert(RULE.links, AutoModerationRuleTriggerType.Keyword, byName(RULE.links), patterns.length > 0,
      { regexPatterns: patterns }, true);
  }

  if (a.anti_spam !== undefined) {
    await upsert(RULE.spam, AutoModerationRuleTriggerType.Spam, byType(AutoModerationRuleTriggerType.Spam),
      Boolean(a.anti_spam), null, false);
  }

  if (a.max_mentions !== undefined) {
    const n = Math.max(0, Math.min(50, Math.round(Number(a.max_mentions) || 0)));
    await upsert(RULE.mentions, AutoModerationRuleTriggerType.MentionSpam, byType(AutoModerationRuleTriggerType.MentionSpam),
      n > 0, { mentionTotalLimit: n, mentionRaidProtectionEnabled: true }, true);
  }

  if (!lines.length) return "AutoMod: nothing to change";
  if (lines.every((l) => l.startsWith("couldn't"))) throw new Error(`AutoMod: ${lines.join("; ")}`);
  return `AutoMod: ${lines.join(", ")}`;
}

export async function disableAutomod(guild) {
  const rules = await guild.autoModerationRules.fetch();
  const ours = rules.filter((r) => r.creatorId === guild.client.user.id || Object.values(RULE).includes(r.name));
  let n = 0;
  for (const r of ours.values()) {
    if (r.enabled) {
      await r.edit({ enabled: false });
      n++;
    }
  }
  return n ? `Turned off ${n} AutoMod rule(s)` : "AutoMod was already off";
}

// ---------- state the AI and the website can see ----------

const ruleCache = new Map(); // guildId -> {at, rules}

export async function featureState(guild, { fresh = false } = {}) {
  const cfg = getConfig(guild.id);
  const chName = (id) => (id ? guild.channels.cache.get(id)?.name ?? "(deleted channel)" : null);

  let automod = [];
  const cached = ruleCache.get(guild.id);
  if (!fresh && cached && Date.now() - cached.at < 30_000) automod = cached.rules;
  else {
    try {
      const rules = await guild.autoModerationRules.fetch();
      automod = rules.map((r) => ({ name: r.name, enabled: r.enabled }));
      ruleCache.set(guild.id, { at: Date.now(), rules: automod });
    } catch {
      automod = cached?.rules ?? [];
    }
  }

  return {
    welcome: cfg.welcome?.channelId
      ? {
          enabled: Boolean(cfg.welcome.enabled),
          channel: chName(cfg.welcome.channelId),
          card: cfg.welcome.card !== false,
          message: cfg.welcome.message || DEFAULT_WELCOME,
          cardColor: cfg.welcome.cardColor || null,
        }
      : null,
    goodbye: cfg.goodbye?.channelId
      ? { enabled: Boolean(cfg.goodbye.enabled), channel: chName(cfg.goodbye.channelId) }
      : null,
    autoroles: (cfg.autoroles || []).map((id) => guild.roles.cache.get(id)?.name).filter(Boolean),
    modLog: chName(cfg.modLogChannelId),
    automod,
    membersIntent: guild.client.options.intents.has("GuildMembers"),
  };
}

export function forgetRuleCache(guildId) {
  ruleCache.delete(guildId);
}

// ---------- moderation slash commands ----------

export const commands = [
  new SlashCommandBuilder().setName("ban").setDescription("Ban someone")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Why"))
    .addIntegerOption((o) => o.setName("delete_days").setDescription("Delete their messages from the last X days").setMinValue(0).setMaxValue(7))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("unban").setDescription("Unban someone by user ID")
    .addStringOption((o) => o.setName("user_id").setDescription("Their user ID").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("kick").setDescription("Kick someone")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Why"))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName("timeout").setDescription("Mute someone for a while")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .addIntegerOption((o) => o.setName("minutes").setDescription("How long").setRequired(true).setMinValue(1).setMaxValue(40320))
    .addStringOption((o) => o.setName("reason").setDescription("Why"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("untimeout").setDescription("Remove a timeout")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("warn").setDescription("Warn someone (they get a DM)")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Why").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("warnings").setDescription("See someone's warnings")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("clearwarns").setDescription("Clear someone's warnings")
    .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName("purge").setDescription("Delete recent messages in this channel")
    .addIntegerOption((o) => o.setName("amount").setDescription("How many (1 to 100)").setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName("user").setDescription("Only messages from this person"))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("lock").setDescription("Stop everyone from talking in this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("unlock").setDescription("Let everyone talk in this channel again")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName("slowmode").setDescription("Set slowmode for this channel")
    .addIntegerOption((o) => o.setName("seconds").setDescription("0 turns it off").setRequired(true).setMinValue(0).setMaxValue(21600))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());


const COLORS = { ban: 0xf23f43, kick: 0xf0b232, timeout: 0xf0b232, warn: 0xfee75c, ok: 0x23a55a, info: 0x5865f2 };

function logEmbed(kind, title, interaction, target, reason, extra) {
  const e = new EmbedBuilder()
    .setColor(COLORS[kind] ?? COLORS.info)
    .setTitle(title)
    .setTimestamp();
  if (target) e.addFields({ name: "User", value: `${target} (${target.tag ?? target.user?.tag ?? target.id})`, inline: true });
  e.addFields({ name: "Mod", value: `${interaction.user}`, inline: true });
  if (reason) e.addFields({ name: "Reason", value: String(reason).slice(0, 1000) });
  if (extra) e.addFields({ name: "Info", value: extra });
  return e;
}

function blockReason(interaction, target, botCheck) {
  const guild = interaction.guild;
  if (!target) return null;
  if (target.id === interaction.user.id) return "You can't do that to yourself 💀";
  if (target.id === guild.ownerId) return "Can't touch the server owner.";
  if (target.id === interaction.client.user.id) return "Nice try 😏";
  const mod = interaction.member;
  if (interaction.user.id !== guild.ownerId && mod?.roles?.highest && target.roles.highest.position >= mod.roles.highest.position) {
    return "Their role is the same or higher than yours.";
  }
  if (botCheck && !target[botCheck]) return "My role is too low to do that. Drag my role higher in Server Settings → Roles.";
  return null;
}

const fail = (interaction, msg) => interaction.reply({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral });

export async function onInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !interaction.inGuild() || !interaction.guild) return;
  const { commandName: cmd, options, guild, channel } = interaction;

  try {
    if (cmd === "ban") {
      const user = options.getUser("user", true);
      const member = options.getMember("user");
      const reason = options.getString("reason") || "No reason given";
      const why = blockReason(interaction, member, "bannable");
      if (why) return fail(interaction, why);
      await guild.members.ban(user, { reason: `${reason} (by ${interaction.user.tag})`, deleteMessageSeconds: (options.getInteger("delete_days") || 0) * 86400 });
      const e = logEmbed("ban", "🔨 Banned", interaction, user, reason);
      await interaction.reply({ embeds: [e] });
      return modLog(guild, e);
    }

    if (cmd === "unban") {
      const id = options.getString("user_id", true).replace(/\D/g, "");
      await guild.members.unban(id, `by ${interaction.user.tag}`);
      const e = logEmbed("ok", "✅ Unbanned", interaction, { id, toString: () => `<@${id}>` }, null);
      await interaction.reply({ embeds: [e] });
      return modLog(guild, e);
    }

    if (cmd === "kick") {
      const member = options.getMember("user");
      if (!member) return fail(interaction, "They're not in the server.");
      const reason = options.getString("reason") || "No reason given";
      const why = blockReason(interaction, member, "kickable");
      if (why) return fail(interaction, why);
      await member.kick(`${reason} (by ${interaction.user.tag})`);
      const e = logEmbed("kick", "👢 Kicked", interaction, member.user, reason);
      await interaction.reply({ embeds: [e] });
      return modLog(guild, e);
    }

    if (cmd === "timeout") {
      const member = options.getMember("user");
      if (!member) return fail(interaction, "They're not in the server.");
      const minutes = options.getInteger("minutes", true);
      const reason = options.getString("reason") || "No reason given";
      const why = blockReason(interaction, member, "moderatable");
      if (why) return fail(interaction, why);
      await member.timeout(minutes * 60_000, `${reason} (by ${interaction.user.tag})`);
      const e = logEmbed("timeout", "🔇 Timed out", interaction, member.user, reason, `${minutes} minute(s)`);
      await interaction.reply({ embeds: [e] });
      return modLog(guild, e);
    }

    if (cmd === "untimeout") {
      const member = options.getMember("user");
      if (!member) return fail(interaction, "They're not in the server.");
      const why = blockReason(interaction, member, "moderatable");
      if (why) return fail(interaction, why);
      await member.timeout(null, `by ${interaction.user.tag}`);
      const e = logEmbed("ok", "🔊 Timeout removed", interaction, member.user, null);
      await interaction.reply({ embeds: [e] });
      return modLog(guild, e);
    }

    if (cmd === "warn") {
      const user = options.getUser("user", true);
      const member = options.getMember("user");
      const reason = options.getString("reason", true);
      const why = blockReason(interaction, member, null);
      if (why) return fail(interaction, why);
      let count = 0;
      updateConfig(guild.id, (c) => {
        c.warnings ||= {};
        c.warnings[user.id] ||= [];
        c.warnings[user.id].push({ reason, by: interaction.user.id, at: Date.now() });
        count = c.warnings[user.id].length;
      });
      const dm = await user
        .send({ embeds: [new EmbedBuilder().setColor(COLORS.warn).setTitle(`⚠️ You got a warning in ${guild.name}`).setDescription(reason)] })
        .then(() => true, () => false);
      const e = logEmbed("warn", "⚠️ Warned", interaction, user, reason, `Warning #${count}${dm ? "" : " (their DMs are closed)"}`);
      await interaction.reply({ embeds: [e] });
      return modLog(guild, e);
    }

    if (cmd === "warnings") {
      const user = options.getUser("user", true);
      const list = getConfig(guild.id).warnings?.[user.id] || [];
      const text = list.length
        ? list.slice(-10).map((w, i) => `**${i + 1}.** ${w.reason} (by <@${w.by}>, <t:${Math.floor(w.at / 1000)}:R>)`).join("\n")
        : "Clean record ✨";
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle(`Warnings for ${user.tag}: ${list.length}`).setDescription(text)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (cmd === "clearwarns") {
      const user = options.getUser("user", true);
      updateConfig(guild.id, (c) => {
        if (c.warnings) delete c.warnings[user.id];
      });
      return interaction.reply({ content: `🧹 Cleared warnings for ${user}`, flags: MessageFlags.Ephemeral });
    }

    if (cmd === "purge") {
      if (!channel?.bulkDelete) return fail(interaction, "Can't purge here.");
      const amount = options.getInteger("amount", true);
      const only = options.getUser("user");
      let deleted;
      if (only) {
        const recent = await channel.messages.fetch({ limit: 100 });
        const mine = recent.filter((m) => m.author.id === only.id).first(amount);
        deleted = await channel.bulkDelete(mine, true);
      } else {
        deleted = await channel.bulkDelete(amount, true);
      }
      await interaction.reply({ content: `🧹 Deleted ${deleted.size} message(s)`, flags: MessageFlags.Ephemeral });
      return modLog(guild, logEmbed("info", "🧹 Purge", interaction, only, null, `${deleted.size} message(s) in ${channel}`));
    }

    if (cmd === "lock" || cmd === "unlock") {
      if (!channel?.permissionOverwrites) return fail(interaction, "Can't lock this kind of channel.");
      await channel.permissionOverwrites.edit(guild.id, { SendMessages: cmd === "lock" ? false : null });
      await interaction.reply(cmd === "lock" ? "🔒 Channel locked" : "🔓 Channel unlocked");
      return modLog(guild, logEmbed("info", cmd === "lock" ? "🔒 Locked" : "🔓 Unlocked", interaction, null, null, `${channel}`));
    }

    if (cmd === "slowmode") {
      if (!channel?.setRateLimitPerUser) return fail(interaction, "Can't set slowmode here.");
      const s = options.getInteger("seconds", true);
      await channel.setRateLimitPerUser(s);
      return interaction.reply(s ? `🐢 Slowmode set to ${s}s` : "⚡ Slowmode off");
    }
  } catch (err) {
    console.error(`/${cmd} failed:`, err.message);
    const msg = err.code === 50013 ? "I'm missing permissions for that. Drag my role higher." : err.message;
    if (interaction.replied || interaction.deferred) return interaction.followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    return fail(interaction, msg).catch(() => {});
  }
}

// ---------- settings changed from the website ----------

export function configureWelcome(guild, a) {
  const ch = a.channel ? findTextChannel(guild, a.channel) : null;
  const prev = getConfig(guild.id).welcome || {};
  if (!ch && !prev.channelId && a.enabled !== false) throw new Error("Tell me which channel to welcome people in.");
  updateConfig(guild.id, (c) => {
    c.welcome = {
      ...prev,
      enabled: a.enabled !== false,
      ...(ch ? { channelId: ch.id } : {}),
      ...(a.message ? { message: String(a.message).slice(0, 1500) } : {}),
      ...(typeof a.card === "boolean" ? { card: a.card } : {}),
      ...(hexColor(a.card_color) ? { cardColor: hexColor(a.card_color) } : {}),
      ...(a.card_background !== undefined ? { cardBackground: a.card_background || null } : {}),
      ...(a.card_title ? { cardTitle: String(a.card_title).slice(0, 40) } : {}),
    };
  });
  const w = getConfig(guild.id).welcome;
  if (!w.enabled) return "Welcome messages turned off";
  const where = guild.channels.cache.get(w.channelId)?.name;
  const warn = guild.client.options.intents.has("GuildMembers")
    ? ""
    : " (turn on Server Members Intent in the Discord Developer Portal so I can see people join)";
  return `Welcomes on in #${where}${w.card !== false ? " with pfp cards" : ""}${warn}`;
}

export function configureGoodbye(guild, a) {
  const ch = a.channel ? findTextChannel(guild, a.channel) : null;
  const prev = getConfig(guild.id).goodbye || {};
  if (!ch && !prev.channelId && a.enabled !== false) throw new Error("Tell me which channel to post goodbyes in.");
  updateConfig(guild.id, (c) => {
    c.goodbye = {
      ...prev,
      enabled: a.enabled !== false,
      ...(ch ? { channelId: ch.id } : {}),
      ...(a.message ? { message: String(a.message).slice(0, 1500) } : {}),
    };
  });
  const g = getConfig(guild.id).goodbye;
  return g.enabled ? `Goodbye messages on in #${guild.channels.cache.get(g.channelId)?.name}` : "Goodbye messages turned off";
}

export function configureAutoroles(guild, a) {
  const roles = [].concat(a.roles || []).map((r) => findRoleOrThrow(guild, r));
  const me = guild.members.me;
  const tooHigh = roles.filter((r) => me && r.position >= me.roles.highest.position);
  updateConfig(guild.id, (c) => (c.autoroles = roles.map((r) => r.id)));
  if (!roles.length) return "Autoroles cleared";
  return `New members get ${roles.map((r) => "@" + r.name).join(", ")}` +
    (tooHigh.length ? ` (drag my role above ${tooHigh.map((r) => "@" + r.name).join(", ")} or I can't give it)` : "");
}

export function configureModLog(guild, a) {
  if (!a.channel || a.channel === "none") {
    updateConfig(guild.id, (c) => delete c.modLogChannelId);
    return "Mod log turned off";
  }
  const ch = findTextChannel(guild, a.channel);
  updateConfig(guild.id, (c) => (c.modLogChannelId = ch.id));
  return `Mod actions will be logged in #${ch.name}`;
}

export async function testWelcome(guild) {
  const w = getConfig(guild.id).welcome;
  if (!w?.channelId) throw new Error("Set up welcomes first.");
  const ch = guild.channels.cache.get(w.channelId);
  if (!ch?.isTextBased()) throw new Error("The welcome channel is gone. Set it up again.");
  const owner = await guild.fetchOwner();
  await sendWelcome(ch, owner, w);
  return `Sent a test welcome in #${ch.name}`;
}
