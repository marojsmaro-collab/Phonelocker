import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
} from "discord.js";

export const client = new Client({
  // Guilds is enough to see channels, roles and emojis. No privileged intents needed.
  intents: [GatewayIntentBits.Guilds],
});

export function startBot(token) {
  return new Promise((resolve, reject) => {
    client.once("clientReady", () => resolve(client));
    client.login(token).catch(reject);
  });
}

export function inviteUrl() {
  if (!client.user) return null;
  // permissions=8 is Administrator so the bot can build anything.
  return `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
}

export function listGuilds() {
  return client.guilds.cache.map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.iconURL({ size: 128 }),
    memberCount: g.memberCount,
  }));
}

export function getGuild(id) {
  const guild = client.guilds.cache.get(id);
  if (!guild) throw new Error("The bot is not in that server.");
  return guild;
}

const TYPE_LABEL = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.GuildMedia]: "media",
};

const TYPE_FROM_LABEL = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  news: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
};

/** A compact picture of the server that the AI reads and the website shows. */
export function snapshot(guild) {
  const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread());
  const byPos = (a, b) => a.rawPosition - b.rawPosition;

  const describe = (c) => ({
    id: c.id,
    name: c.name,
    type: TYPE_LABEL[c.type] ?? "other",
    topic: c.topic || undefined,
    private: isPrivate(guild, c) || undefined,
  });

  const categories = channels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort(byPos)
    .map((cat) => ({
      id: cat.id,
      name: cat.name,
      private: isPrivate(guild, cat) || undefined,
      channels: channels.filter((c) => c.parentId === cat.id).sort(byPos).map(describe),
    }));

  const uncategorized = channels
    .filter((c) => c.type !== ChannelType.GuildCategory && !c.parentId)
    .sort(byPos)
    .map(describe);

  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({
      id: r.id,
      name: r.name,
      color: r.hexColor === "#000000" ? null : r.hexColor,
      hoist: r.hoist || undefined,
      admin: r.permissions.has(PermissionFlagsBits.Administrator) || undefined,
    }));

  const emojis = [...guild.emojis.cache.values()].map((e) => ({
    id: e.id,
    name: e.name,
    url: e.imageURL({ size: 64 }),
  }));

  return {
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL({ size: 128 }),
    community: guild.features.includes("COMMUNITY"),
    categories,
    uncategorized,
    roles,
    emojis,
  };
}

function isPrivate(guild, channel) {
  const ow = channel.permissionOverwrites?.cache.get(guild.id);
  return Boolean(ow && ow.deny.has(PermissionFlagsBits.ViewChannel));
}

// ---------- name lookup helpers ----------

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "");

function findBy(collection, name, filter = () => true) {
  if (!name) return null;
  const list = [...collection.values()].filter(filter);
  if (/^\d{17,20}$/.test(String(name))) {
    const byId = list.find((x) => x.id === String(name));
    if (byId) return byId;
  }
  const exact = list.find((x) => x.name === name);
  if (exact) return exact;
  const lower = list.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
  if (lower) return lower;
  const n = norm(name);
  return n ? list.find((x) => norm(x.name) === n) ?? null : null;
}

const findCategory = (guild, name) =>
  findBy(guild.channels.cache, name, (c) => c.type === ChannelType.GuildCategory);

const findChannel = (guild, name, { includeCategories = true } = {}) =>
  findBy(guild.channels.cache, name, (c) =>
    !c.isThread() && (includeCategories || c.type !== ChannelType.GuildCategory)
  );

function findRole(guild, name) {
  if (!name) return null;
  if (["@everyone", "everyone", "everybody"].includes(String(name).toLowerCase())) {
    return guild.roles.everyone;
  }
  return findBy(guild.roles.cache, name);
}

function must(thing, what, name) {
  if (!thing) throw new Error(`Could not find ${what} "${name}".`);
  return thing;
}

// ---------- permissions ----------

const PERM_KEYS = Object.keys(PermissionFlagsBits);
const PERM_LOOKUP = new Map(PERM_KEYS.map((k) => [norm(k), k]));
// Friendly aliases the AI or a person might use.
for (const [alias, key] of Object.entries({
  admin: "Administrator",
  viewchannels: "ViewChannel",
  readmessages: "ViewChannel",
  view: "ViewChannel",
  send: "SendMessages",
  talk: "Speak",
  manageroles: "ManageRoles",
  managemessages: "ManageMessages",
  kick: "KickMembers",
  ban: "BanMembers",
  timeout: "ModerateMembers",
  mute: "MuteMembers",
  createinvite: "CreateInstantInvite",
  manageemojis: "ManageGuildExpressions",
  manageemojisandstickers: "ManageGuildExpressions",
  manageserver: "ManageGuild",
})) {
  if (PERM_KEYS.includes(key)) PERM_LOOKUP.set(alias, key);
}

function toPerms(list = []) {
  const out = [];
  for (const p of [].concat(list || [])) {
    const key = PERM_LOOKUP.get(norm(p));
    if (key) out.push(key);
  }
  return out;
}

function overwriteFor(guild, entry) {
  const role = must(findRole(guild, entry.role), "role", entry.role);
  return {
    id: role.id,
    type: OverwriteType.Role,
    allow: toPerms(entry.allow),
    deny: toPerms(entry.deny),
  };
}

function overwriteObject(entry) {
  const obj = {};
  for (const k of toPerms(entry.allow)) obj[k] = true;
  for (const k of toPerms(entry.deny)) obj[k] = false;
  for (const k of toPerms(entry.reset)) obj[k] = null;
  return obj;
}

function buildOverwrites(guild, a) {
  const list = (a.permissions || []).map((p) => overwriteFor(guild, p));
  if (a.private) {
    const everyone = list.find((o) => o.id === guild.id);
    if (everyone) everyone.deny = [...new Set([...everyone.deny, "ViewChannel"])];
    else list.push({ id: guild.id, type: OverwriteType.Role, allow: [], deny: ["ViewChannel"] });
    // Let the bot keep seeing private channels it makes.
    list.push({
      id: client.user.id,
      type: OverwriteType.Member,
      allow: ["ViewChannel", "ManageChannels", "ManageRoles", "SendMessages", "Connect"],
      deny: [],
    });
  }
  return list.length ? list : undefined;
}

function color(c) {
  if (!c) return undefined;
  const s = String(c).trim();
  if (/^#?[0-9a-f]{6}$/i.test(s)) return s.startsWith("#") ? s : `#${s}`;
  return undefined;
}

// ---------- actions ----------

export const DESTRUCTIVE = new Set(["delete_channel", "delete_category", "delete_role", "delete_emoji"]);

const handlers = {
  async create_category(guild, a) {
    const cat = await guild.channels.create({
      name: a.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: buildOverwrites(guild, a),
    });
    return `Created category ${cat.name}`;
  },

  async create_channel(guild, a) {
    const label = String(a.channel_type || "text").toLowerCase();
    const type = TYPE_FROM_LABEL[label];
    if (type === undefined) throw new Error(`Unknown channel type "${a.channel_type}".`);
    let parent;
    if (a.category) {
      parent = findCategory(guild, a.category);
      if (!parent) {
        parent = await guild.channels.create({ name: a.category, type: ChannelType.GuildCategory });
      }
    }
    const opts = {
      name: a.name,
      type,
      parent: parent?.id,
      permissionOverwrites: buildOverwrites(guild, a),
    };
    if (a.topic && type !== ChannelType.GuildVoice && type !== ChannelType.GuildStageVoice) opts.topic = a.topic;
    if (typeof a.nsfw === "boolean") opts.nsfw = a.nsfw;
    if (Number.isFinite(a.slowmode) && a.slowmode > 0) opts.rateLimitPerUser = Math.min(21600, a.slowmode);
    if (Number.isFinite(a.user_limit) && a.user_limit > 0 && type === ChannelType.GuildVoice) {
      opts.userLimit = Math.min(99, a.user_limit);
    }
    if (!opts.permissionOverwrites && parent) delete opts.permissionOverwrites; // inherit from category
    const ch = await guild.channels.create(opts);
    return `Created ${label} channel #${ch.name}${parent ? ` in ${parent.name}` : ""}`;
  },

  async edit_channel(guild, a) {
    const ch = must(findChannel(guild, a.name), "channel", a.name);
    const edit = {};
    if (a.new_name) edit.name = a.new_name;
    if (a.topic !== undefined && "topic" in ch) edit.topic = a.topic;
    if (typeof a.nsfw === "boolean") edit.nsfw = a.nsfw;
    if (Number.isFinite(a.slowmode)) edit.rateLimitPerUser = Math.max(0, Math.min(21600, a.slowmode));
    if (a.category !== undefined && ch.type !== ChannelType.GuildCategory) {
      if (a.category === null || a.category === "" || a.category === "none") edit.parent = null;
      else {
        let parent = findCategory(guild, a.category);
        if (!parent) parent = await guild.channels.create({ name: a.category, type: ChannelType.GuildCategory });
        edit.parent = parent.id;
        edit.lockPermissions = Boolean(a.sync_permissions);
      }
    }
    if (Number.isFinite(a.position)) edit.position = a.position;
    if (!Object.keys(edit).length) return `Nothing to change on ${ch.name}`;
    const updated = await ch.edit(edit);
    return `Updated ${updated.name}`;
  },

  async delete_channel(guild, a) {
    const ch = must(findChannel(guild, a.name, { includeCategories: false }), "channel", a.name);
    const name = ch.name;
    await ch.delete();
    return `Deleted #${name}`;
  },

  async delete_category(guild, a) {
    const cat = must(findCategory(guild, a.name), "category", a.name);
    const name = cat.name;
    let n = 0;
    if (a.with_channels) {
      for (const child of [...guild.channels.cache.values()].filter((c) => c.parentId === cat.id)) {
        await child.delete();
        n++;
      }
    }
    await cat.delete();
    return `Deleted category ${name}${n ? ` and ${n} channel(s) inside it` : ""}`;
  },

  async set_permissions(guild, a) {
    const ch = must(findChannel(guild, a.channel), "channel", a.channel);
    const role = must(findRole(guild, a.role), "role", a.role);
    await ch.permissionOverwrites.edit(role.id, overwriteObject(a));
    return `Updated ${role.name} permissions in ${ch.name}`;
  },

  async create_role(guild, a) {
    const opts = {
      name: a.name,
      hoist: Boolean(a.hoist),
      mentionable: Boolean(a.mentionable),
    };
    const c = color(a.color);
    if (c) opts.colors = { primaryColor: c };
    if (a.permissions) opts.permissions = toPerms(a.permissions);
    const role = await guild.roles.create(opts);
    return `Created role @${role.name}`;
  },

  async edit_role(guild, a) {
    const role = must(findRole(guild, a.name), "role", a.name);
    const edit = {};
    if (a.new_name) edit.name = a.new_name;
    const c = color(a.color);
    if (c) edit.colors = { primaryColor: c };
    if (typeof a.hoist === "boolean") edit.hoist = a.hoist;
    if (typeof a.mentionable === "boolean") edit.mentionable = a.mentionable;
    if (a.permissions) edit.permissions = toPerms(a.permissions);
    if (!Object.keys(edit).length) return `Nothing to change on @${role.name}`;
    const updated = await role.edit(edit);
    return `Updated role @${updated.name}`;
  },

  async delete_role(guild, a) {
    const role = must(findRole(guild, a.name), "role", a.name);
    if (role.id === guild.id) throw new Error("Can't delete @everyone.");
    const name = role.name;
    await role.delete();
    return `Deleted role @${name}`;
  },

  async create_emoji(guild, a) {
    if (!a.image_url || !/^https?:\/\//i.test(a.image_url)) {
      throw new Error("Custom emojis need an image link (png, jpg or gif under 256 KB).");
    }
    const name = String(a.name || "emoji").replace(/[^\w]/g, "_").slice(0, 32).padEnd(2, "_");
    const e = await guild.emojis.create({ attachment: a.image_url, name });
    return `Added emoji :${e.name}:`;
  },

  async delete_emoji(guild, a) {
    const e = must(findBy(guild.emojis.cache, a.name), "emoji", a.name);
    const name = e.name;
    await e.delete();
    return `Deleted emoji :${name}:`;
  },

  async send_message(guild, a) {
    const ch = must(findChannel(guild, a.channel, { includeCategories: false }), "channel", a.channel);
    if (!ch.isTextBased()) throw new Error(`#${ch.name} is not a text channel.`);
    const payload = {};
    if (a.content) payload.content = String(a.content).slice(0, 2000);
    if (a.embed_title || a.embed_description) {
      payload.embeds = [
        {
          title: a.embed_title ? String(a.embed_title).slice(0, 256) : undefined,
          description: a.embed_description ? String(a.embed_description).slice(0, 4096) : undefined,
          color: color(a.color) ? parseInt(color(a.color).slice(1), 16) : 0x5865f2,
        },
      ];
    }
    if (!payload.content && !payload.embeds) throw new Error("Message is empty.");
    await ch.send(payload);
    return `Sent a message in #${ch.name}`;
  },

  async rename_server(guild, a) {
    if (!a.name) throw new Error("No new server name given.");
    await guild.setName(a.name);
    return `Renamed the server to ${a.name}`;
  },
};

export const ACTION_TYPES = Object.keys(handlers);

/** Run actions in order. One failing action does not stop the rest. */
export async function runActions(guild, actions) {
  const results = [];
  for (const action of actions) {
    const fn = handlers[action?.type];
    if (!fn) {
      results.push({ action, ok: false, message: `Unknown action "${action?.type}"` });
      continue;
    }
    try {
      const message = await fn(guild, action);
      results.push({ action, ok: true, message });
    } catch (err) {
      results.push({ action, ok: false, message: friendlyError(err) });
    }
  }
  return results;
}

function friendlyError(err) {
  const code = err?.code;
  if (code === 50013) return "Missing permissions. Give the bot a higher role or Administrator.";
  if (code === 30005) return "This server already has the max number of roles.";
  if (code === 30013) return "This server already has the max number of channels.";
  if (code === 30008) return "No more emoji slots on this server.";
  if (code === 50035) {
    const msg = String(err.message || "");
    if (/COMMUNITY|community/i.test(msg) || /type/i.test(msg)) {
      return `Discord rejected it: ${msg.split("\n").slice(-1)[0]} (announcement, stage and forum channels need Community turned on).`;
    }
    return `Discord rejected it: ${msg.split("\n").slice(-1)[0]}`;
  }
  return err?.message || String(err);
}
