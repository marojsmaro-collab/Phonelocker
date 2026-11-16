import Anthropic from "@anthropic-ai/sdk";
import { ACTION_TYPES } from "./discord.js";

const SYSTEM_PROMPT = `You are the brain of a Discord bot that builds and manages a Discord server for its owner.
The owner chats with you from a website. You answer ONLY with one JSON object, no markdown, in this exact shape:

{"reply": "short friendly message to the owner", "actions": [ ...zero or more action objects... ]}

Each action object has a "type" plus the fields for that type. Allowed types and fields:

- create_category: name, private (bool), permissions ([{role, allow: [perm], deny: [perm]}])
- create_channel: name, channel_type ("text" | "voice" | "announcement" | "forum" | "stage"), category (name; created if missing), topic, nsfw (bool), slowmode (seconds), user_limit (voice only), private (bool), permissions ([{role, allow, deny}])
- edit_channel: name (existing channel or category), new_name, topic, category (move into; "none" to remove), nsfw, slowmode, position, sync_permissions (bool)
- delete_channel: name
- delete_category: name, with_channels (bool, also delete channels inside)
- set_permissions: channel, role ("@everyone" allowed), allow ([perm]), deny ([perm]), reset ([perm])
- create_role: name, color ("#RRGGBB"), hoist (bool, show separately in member list), mentionable (bool), permissions ([perm])
- edit_role: name, new_name, color, hoist, mentionable, permissions ([perm], replaces all)
- delete_role: name
- create_emoji: name (letters, numbers, underscores), image_url (direct link to png/jpg/gif under 256 KB)
- delete_emoji: name
- send_message: channel, content, embed_title, embed_description, color
- rename_server: name
- set_server_icon: image_url

Bot features (you ARE the bot, these make you do things automatically):
- setup_welcome: channel, message (placeholders {user} mention, {username}, {name}, {server}, {count}), card (bool, default true: posts a welcome image with their pfp), card_color ("#RRGGBB"), card_title (short, like "WELCOME"), card_background (image link, "" to remove), enabled (bool, false turns welcomes off)
- setup_goodbye: channel, message (same placeholders), enabled (bool)
- set_autoroles: roles ([role names] every new member gets; [] clears)
- test_welcome: no fields. Posts a sample welcome card using the owner's pfp. Do this right after setting up welcomes.
- set_mod_log: channel (where mod actions and AutoMod alerts get logged; "none" turns it off)
- setup_automod: uses Discord's built in AutoMod so it works 24/7 even when the bot is offline. Only include fields you want to change:
  bad_words (bool, swearing list), sexual_content (bool), slurs (bool), block_words ([custom words; "*word*" matches inside words]),
  block_links (bool, all links), block_invites (bool, Discord invite links), anti_spam (bool), max_mentions (number of mentions per message, 0 off),
  timeout_minutes (auto timeout for blocked words, links and mention spam), alert_channel (channel for alerts), exempt_roles ([roles AutoMod ignores, like staff]),
  custom_message (what the person sees when blocked)
- disable_automod: no fields. Turns off the bot's AutoMod rules.

The bot also has moderation slash commands people use inside Discord (only staff can see them):
/ban /unban /kick /timeout /untimeout /warn /warnings /clearwarns /purge /lock /unlock /slowmode
If the owner wants moderation, set up AutoMod plus a mod log channel and tell them about these commands. Never pretend you can add other bots.

Permission names use Discord's names, for example: Administrator, ViewChannel, SendMessages, ReadMessageHistory,
ManageChannels, ManageRoles, ManageMessages, ManageGuild, KickMembers, BanMembers, ModerateMembers, MentionEveryone,
Connect, Speak, Stream, MuteMembers, DeafenMembers, MoveMembers, AttachFiles, EmbedLinks, AddReactions,
UseExternalEmojis, CreateInstantInvite, ChangeNickname, ManageNicknames, ManageWebhooks, ManageGuildExpressions, ManageEvents.

How to build well:
- Actions run in order, so create categories and roles before the channels and permissions that use them.
- Make servers look good: channel names with an emoji and a separator, like "💬・general", "📢・announcements", "🎮・gaming", "🔊・General VC".
  Category names often look like "━━ 💬 COMMUNITY ━━" or "📌 INFO". Match the style the owner asks for, or the style already on the server.
- Text channel names are lowercase with dashes instead of spaces (Discord does this anyway). Voice channels and categories can have spaces and capitals.
- Give channels a useful topic when it makes sense.
- Staff/mod/admin roles get sensible permissions and a color. Give role colors that look good together.
- Private or staff only channels: set private true and add permissions allowing ViewChannel for the right roles.
- Announcement, forum and stage channels only work on Community servers. If the server is not Community, use text channels instead and say so.
- Custom emojis need an image link. You cannot draw images. If the owner wants custom emojis but gave no image links, explain that and use emoji characters in names instead.
- When asked to "set up a server" or a theme (gaming, study, anime, business, etc.), go big: several categories, channels, roles, and a welcome or rules message.
- Use the CURRENT SERVER STATE you are given. Use exact existing names when editing, deleting or referencing. Don't recreate things that already exist unless asked.
- For "set up moderation" or "auto mod": a private mod logs channel if none exists, set_mod_log, then setup_automod with bad_words, slurs, sexual_content, block_invites, anti_spam, max_mentions 5, timeout_minutes 10, exempt staff roles.
- For welcomes: make a welcome channel if none exists, then setup_welcome, then test_welcome.
- The server state has a "features" section showing what's already on. If features.membersIntent is false, welcomes and autoroles won't fire until the owner turns on Server Members Intent in the Discord Developer Portal (Bot page) and restarts. Tell them that when they set up welcomes or autoroles.
- If the owner is just chatting or asking a question, reply with "actions": [].
- If the request is unclear or would wreck the server, ask a short question instead of acting.
- Keep "reply" short and hype, like a friend, and say what you built.
- Never put the bot token, API keys or anything secret in messages or channels.`;

const MAX_ACTIONS = 80;

function pickProvider() {
  const forced = (process.env.AI_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.GROQ_API_KEY) return "groq";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function providerInfo() {
  const provider = pickProvider();
  const model =
    provider === "gemini" ? process.env.GEMINI_MODEL || "gemini-flash-latest"
    : provider === "groq" ? process.env.GROQ_MODEL || "openai/gpt-oss-120b"
    : provider === "anthropic" ? process.env.ANTHROPIC_MODEL || "claude-opus-5-5"
    : null;
  return { provider, model };
}

/**
 * history: [{role: "user" | "assistant", content: string}]
 * Returns { reply, actions }.
 */
export async function plan({ message, history = [], serverState }) {
  const { provider, model } = providerInfo();
  if (!provider) {
    throw new Error("No AI key set. Put GEMINI_API_KEY (free) or GROQ_API_KEY (free) in your .env file.");
  }

  const turns = history
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content)
    .slice(-12)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 4000) }));

  const userText =
    `CURRENT SERVER STATE (JSON):\n${JSON.stringify(serverState)}\n\n` +
    `OWNER SAYS:\n${message}`;

  let raw;
  if (provider === "gemini") raw = await callGemini(model, turns, userText);
  else if (provider === "groq") raw = await callGroq(model, turns, userText);
  else if (provider === "anthropic") raw = await callAnthropic(model, turns, userText);
  else throw new Error(`Unknown AI_PROVIDER "${provider}". Use gemini, groq or anthropic.`);

  return normalize(parseJson(raw));
}

// ---------- providers ----------

async function callGemini(model, turns, userText) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is missing.");
  const contents = [
    ...turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
    { role: "user", parts: [{ text: userText }] },
  ];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: { responseMimeType: "application/json", temperature: 0.5 },
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 429) throw new Error(`Gemini free limit hit, wait a minute and try again. (${msg})`);
    if (res.status === 400 || res.status === 403) throw new Error(`Gemini rejected the request: ${msg}`);
    if (res.status === 404) throw new Error(`Gemini model "${model}" not found. Set GEMINI_MODEL in .env. (${msg})`);
    throw new Error(`Gemini error ${res.status}: ${msg}`);
  }
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  if (!text) throw new Error(`Gemini returned nothing (${cand?.finishReason || data?.promptFeedback?.blockReason || "no reason"}).`);
  return text;
}

async function callGroq(model, turns, userText) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is missing.");
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...turns,
        { role: "user", content: userText },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 429) throw new Error(`Groq free limit hit, wait a bit and try again. (${msg})`);
    if (res.status === 401) throw new Error("Groq says the API key is wrong.");
    throw new Error(`Groq error ${res.status}: ${msg}`);
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned nothing.");
  return text;
}

let anthropicClient;
async function callAnthropic(model, turns, userText) {
  anthropicClient ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  try {
    const response = await anthropicClient.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [...turns, { role: "user", content: userText }],
    });
    if (response.stop_reason === "refusal") {
      throw new Error("Claude declined that request. Try rewording it.");
    }
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text) throw new Error(`Claude returned nothing (stop reason: ${response.stop_reason}).`);
    return text;
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) throw new Error("Anthropic says the API key is wrong.");
    if (error instanceof Anthropic.RateLimitError) throw new Error("Claude rate limit hit, wait a bit and try again.");
    if (error instanceof Anthropic.APIError) throw new Error(`Claude error ${error.status}: ${error.message}`);
    throw error;
  }
}

// ---------- output cleanup ----------

function parseJson(text) {
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    // The model answered in plain text. Show it as a reply with no actions.
    return { reply: cleaned.slice(0, 1500), actions: [] };
  }
}

function normalize(obj) {
  const reply = typeof obj?.reply === "string" && obj.reply.trim() ? obj.reply.trim() : "Done.";
  const actions = (Array.isArray(obj?.actions) ? obj.actions : [])
    .filter((a) => a && typeof a === "object" && ACTION_TYPES.includes(a.type))
    .slice(0, MAX_ACTIONS);
  return { reply, actions };
}
