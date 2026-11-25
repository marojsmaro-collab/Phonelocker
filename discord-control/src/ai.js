// The bot's brain. Talks to free AI providers (Gemini first, Groq backup, Claude optional) and turns
// what the owner says into a plan of actions, questions to ask, and things to remember.
import Anthropic from "@anthropic-ai/sdk";

// =====================================================================================
// The system prompt
// =====================================================================================

const SYSTEM_PROMPT = `You are SERVERBUILDER, an elite Discord server architect and the brain of a Discord bot.
The server owner talks to you from a website. You design and build entire Discord servers and run the bot's features.
You are creative, precise, and you build things that look PRO: consistent naming, emoji, colors and structure.

=== OUTPUT ===
Answer with ONE JSON object and nothing else:
{
  "reply": "short hype message to the owner (1 to 3 sentences, like a friend)",
  "questions": [ { "id": "theme", "question": "What's the server about?", "options": ["Gaming", "Roblox game", "Anime", "Chill hangout"], "multi": false } ],
  "actions": [ { "type": "...", ...fields } ],
  "remember": [ "short fact about the owner's taste worth keeping, like 'likes dark purple and green' " ]
}
- "questions": ONLY when you need answers before building (see QUESTION SYSTEM). When you ask, "actions" must be [].
- "actions": run top to bottom. Empty [] when just chatting or asking.
- "remember": optional, only NEW lasting preferences. Max 3.

=== QUESTION SYSTEM ===
Ask 3 to 5 quick questions (3 to 6 short options each, add "Surprise me" as the last option) BEFORE building when:
- the owner wants a NEW server, a full setup, or a theme makeover, AND
- they didn't already give the key details (what it's about, vibe/style, size, colors, which features).
Never ask when: the request is small and clear, they said "just do it" / "you pick" / "surprise me", or they're answering your questions (then BUILD).
Good question ids: topic, vibe, colors, size, features, name. "multi": true for "pick all that apply" (features).

=== ACTIONS (type: fields) ===
Structure:
- create_category: name, private(bool), permissions([{role, allow:[perm], deny:[perm]}])
- create_channel: name, channel_type("text"|"voice"|"announcement"|"forum"|"stage"), category(name, auto-created), topic, read_only(bool: everyone reads, only staff talk), private(bool), permissions, slowmode(sec), user_limit(voice), nsfw
- edit_channel: name, new_name, topic, category("none" removes), read_only, slowmode, position, sync_permissions
- delete_channel: name | delete_category: name, with_channels(bool)
- set_permissions: channel, role("@everyone" ok), allow, deny, reset
- create_role: name, color("#RRGGBB"), gradient_color("#RRGGBB", only if server has ENHANCED_ROLE_COLORS), hoist(bool), mentionable(bool), permissions([perm])
- edit_role: name, new_name, color, gradient_color, hoist, mentionable, permissions | delete_role: name
- send_message: channel, content, embed_title, embed_description, color, image_url, footer
- rename_server: name
- create_emoji: name, image_url | delete_emoji: name
AI art (you CAN make images, describe them vividly in "idea"):
- ai_server_icon: idea (what the icon shows; style, colors, mascot)
- ai_server_banner: idea, channel (where to post it if the server can't use banners; usually welcome or rules)
- ai_emojis: emojis([{name: "lowercase_name", idea: "what it shows"}]) max 10 per action, fit the server theme
- ai_image_post: channel, idea, wide(bool), message
Features:
- setup_welcome: channel, message(placeholders {user} {username} {name} {server} {count}), card(bool, pfp welcome image), card_color, card_title, card_background(image link), enabled
- setup_goodbye: channel, message, enabled
- set_autoroles: roles([names]) given to every new member
- test_welcome: (no fields) posts a sample card
- set_mod_log: channel ("none" turns off)
- setup_automod: bad_words, sexual_content, slurs, block_invites, block_links, anti_spam (bools), block_words([words, "*word*" matches inside]), max_mentions(number), timeout_minutes, alert_channel, exempt_roles([roles]), custom_message
- disable_automod
- setup_tickets: channel(panel), category, support_roles([roles]), log_channel, title, description, button_label, ticket_message, color
- create_role_panel: channel, title, description, color, roles([{role, label, emoji}]) buttons to get/remove roles (create the roles first)
- setup_leveling: enabled, channel("same" = where they chat), message({user} {level}), rewards([{level, role}]), card_color
- start_giveaway: channel, prize, minutes, winners, description
- end_giveaway: prize | reroll_giveaway: prize
- create_poll: channel, question, answers([{text, emoji}]) 2 to 10, hours(1 to 768), multi(bool)
- setup_qotd: channel, enabled, time("HH:MM" 24h), topic(what questions are about), ping_role
- post_qotd: (posts one now)
- set_bot_status: text, activity("custom"|"playing"|"watching"|"listening"|"competing"), status("online"|"idle"|"dnd")
- set_bot_avatar: image_url

Permission names: Administrator, ViewChannel, SendMessages, ReadMessageHistory, ManageChannels, ManageRoles, ManageMessages, ManageGuild, KickMembers, BanMembers, ModerateMembers, MentionEveryone, Connect, Speak, Stream, MuteMembers, DeafenMembers, MoveMembers, AttachFiles, EmbedLinks, AddReactions, UseExternalEmojis, CreateInstantInvite, ChangeNickname, ManageNicknames, ManageWebhooks, ManageGuildExpressions, ManageEvents, ManageThreads, SendMessagesInThreads, CreatePublicThreads.

=== HOW A PRO BUILDS ===
1. Pick ONE style and use it everywhere. Channel: "emoji・name" (like "💬・general", "📢・announcements"). Category: "━━ 📌 INFO ━━" or "📌 INFO". Voice: "🔊・Chill VC". Match the server's existing style if it has one.
2. Pick a color palette of 4 to 6 hex colors that fit the theme. Use it for roles (top roles brightest), embeds, welcome card_color and leveling card_color.
3. Order: roles first (highest first: Owner, Admin, Moderator, ... Member, Bots, ping roles), then categories, then channels, then features, then messages, then art.
4. Info category on top: welcome, rules (read_only), announcements (read_only), roles. Then community (general, media, memes, bot commands), then topic channels, then voice, then a private staff category (Moderator+ only) with staff chat and mod logs.
5. Staff roles get real permissions (Admin: Administrator; Moderator: KickMembers, BanMembers, ModerateMembers, ManageMessages, MuteMembers, MoveMembers, ViewChannel). Member: none extra. Ping roles: mentionable.
6. Write REAL content: a rules embed with numbered rules, a welcome embed explaining the channels, topics on channels.
7. Full server setups also get: setup_welcome + test_welcome, a role panel for pings, AutoMod basics + mod log, ai_server_icon, ai_emojis (5 to 8 themed), and leveling with 3 or 4 reward roles. Rename the server if they gave/asked for a name.
8. Use exact existing names from CURRENT SERVER STATE when editing or deleting. Never recreate what already exists. Don't delete anything unless asked.
9. Announcement, forum and stage channels need a Community server (state.community true). If not Community, use text channels with read_only.
10. Respect limits: max 500 channels, 250 roles, emoji slots in state.emojiSlotsLeft. Real server banners need boost level 2 (state.canBanner), else ai_server_banner posts the art in a channel. Gradient role colors need ENHANCED_ROLE_COLORS in state.features_list.
11. If something would wreck the server (delete everything, remove all roles), confirm in "reply" with actions [] first unless they clearly insist.
12. "reply": hype, short, say what you built or what you're asking. No markdown headers.

=== EXAMPLES ===
Owner: "make me a server"
{"reply":"Ooo let's cook 🔥 quick questions so I build exactly your vibe","questions":[{"id":"topic","question":"What's the server about?","options":["Gaming","Roblox game","Anime","Chill hangout","Study","Surprise me"],"multi":false},{"id":"vibe","question":"What vibe?","options":["Dark and neon","Cute and pastel","Clean and minimal","Chaotic and fun","Surprise me"],"multi":false},{"id":"size","question":"How big?","options":["Small (10 channels)","Medium (20 channels)","Huge (35+ channels)","Surprise me"],"multi":false},{"id":"features","question":"What should the bot run?","options":["Welcome cards","Leveling","Tickets","Giveaways","AutoMod","Question of the day","Surprise me"],"multi":true}],"actions":[],"remember":[]}

Owner: "add a memes channel"
{"reply":"Memes channel is up 😂","actions":[{"type":"create_channel","name":"😂・memes","category":"━━ 💬 COMMUNITY ━━","topic":"Post your best memes. Keep it clean."}],"remember":[]}`;

const REPAIR_PROMPT = `Some actions in your last build failed. Fix what you can.
Return the same JSON shape with ONLY the new actions needed to fix the failures (use exact names from CURRENT SERVER STATE),
and a short "reply" saying what you fixed. If something can't be fixed (missing permissions, limits reached), skip it and say why in "reply".
Never repeat actions that already worked. Never ask questions here.`;

const MAX_ACTIONS = 120;

// =====================================================================================
// Providers
// =====================================================================================

const MODELS = {
  gemini: () => process.env.GEMINI_MODEL || "gemini-flash-latest",
  groq: () => process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  anthropic: () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
};
const KEYS = { gemini: "GEMINI_API_KEY", groq: "GROQ_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

/** Providers with a key, best first. If one is out of free quota the next one takes over. */
function providerOrder() {
  const all = ["gemini", "groq", "anthropic"].filter((p) => process.env[KEYS[p]]);
  const forced = (process.env.AI_PROVIDER || "").toLowerCase().trim();
  if (forced && all.includes(forced)) return [forced, ...all.filter((p) => p !== forced)];
  return all;
}

export function providerInfo() {
  const order = providerOrder();
  return { provider: order[0] || null, model: order[0] ? MODELS[order[0]]() : null, backups: order.slice(1) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (list) => [...new Set(list.filter(Boolean))];

function retryAfterMs(res, msg) {
  const h = Number(res.headers.get("retry-after"));
  if (Number.isFinite(h) && h > 0) return h * 1000;
  const m = /(?:try again in|retry in) ([\d.]+)\s*(ms|s)/i.exec(msg || "");
  if (m) return Number(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000);
  return 5000;
}

class SoftError extends Error {} // try the next model/provider

/** Read a Server-Sent-Events body, calling onData(json) per event. Aborts if nothing arrives for idleMs. */
async function readSse(res, ctrl, idleMs, onData) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let idle = setTimeout(() => ctrl.abort(new Error("stopped responding")), idleMs);
  const onAbort = () => reader.cancel().catch(() => {});
  ctrl.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(new Error("stopped responding")), idleMs);
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          onData(JSON.parse(payload));
        } catch {
          /* ignore a broken event */
        }
      }
    }
  } finally {
    clearTimeout(idle);
    ctrl.signal.removeEventListener("abort", onAbort);
  }
  // A cut-off answer is useless (half a JSON plan), so treat it as a failure.
  if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new Error("stopped responding");
}

async function callGemini({ system, turns, user, json, maxTokens, status }) {
  const key = process.env.GEMINI_API_KEY;
  const contents = [
    ...turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
    { role: "user", parts: [{ text: user }] },
  ];
  let lastError;
  // New AI Studio keys start with "AQ." instead of "AIza". Both work in the header; if Google rejects
  // the header we try the ?key= style once too.
  let keyInQuery = false;
  let lowThinking = process.env.GEMINI_THINKING !== "full";
  for (const m of unique([MODELS.gemini(), "gemini-flash-latest", "gemini-flash-lite-latest"])) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ctrl = new AbortController();
      const total = setTimeout(() => ctrl.abort(new Error("took too long")), 150_000);
      let res;
      try {
        status(`🧠 Asking Gemini (${m})…`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:streamGenerateContent?alt=sse${keyInQuery ? `&key=${encodeURIComponent(key)}` : ""}`;
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(keyInQuery ? {} : { "x-goog-api-key": key }) },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            generationConfig: {
              ...(json ? { responseMimeType: "application/json" } : {}),
              temperature: 0.7,
              maxOutputTokens: maxTokens,
              ...(lowThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
            },
          }),
          signal: ctrl.signal,
        });
        if (res.ok) {
          let text = "";
          let finish = null;
          let lastShown = 0;
          await readSse(res, ctrl, Number(process.env.AI_IDLE_MS) || 60_000, (ev) => {
            const cand = ev?.candidates?.[0];
            for (const p of cand?.content?.parts || []) if (!p.thought && typeof p.text === "string") text += p.text;
            finish = cand?.finishReason || finish;
            if (text.length - lastShown > 300) {
              lastShown = text.length;
              status(`✍️ Gemini is writing the plan… ${text.length.toLocaleString()} characters`);
            }
          });
          clearTimeout(total);
          if (text) return text;
          lastError = new SoftError(`Gemini returned nothing (${finish || "?"}).`);
          break;
        }
      } catch (e) {
        clearTimeout(total);
        const why = ctrl.signal.reason?.message || e.message;
        log(`Gemini ${m} failed: ${why}`);
        lastError = new SoftError(`Gemini ${why}.`);
        break;
      }
      clearTimeout(total);
      const data = await res.json().catch(() => ({}));
      const msg = data?.error?.message || res.statusText;
      log(`Gemini ${m} → ${res.status}: ${String(msg).slice(0, 160)}`);
      if (res.status === 400 && lowThinking && /thinking/i.test(msg)) {
        lowThinking = false; // this model doesn't take that setting
        continue;
      }
      const keyProblem = res.status === 401 || ((res.status === 400 || res.status === 403) && /api.?key|credential|access.?token|unauthenticated/i.test(msg));
      if (keyProblem && !keyInQuery) {
        keyInQuery = true;
        continue;
      }
      if (keyProblem) throw new Error(`Gemini didn't accept the API key: ${msg}`);
      if (res.status === 429) {
        lastError = new SoftError(`Gemini free limit hit. (${msg})`);
        const wait = retryAfterMs(res, msg);
        if (attempt === 0 && wait <= 12000) {
          status(`⏳ Gemini is busy, waiting ${Math.round(wait / 1000)}s…`);
          await sleep(wait);
          continue;
        }
        break;
      }
      if (res.status === 404 || res.status >= 500 || res.status === 403) {
        lastError = new SoftError(`Gemini ${m}: ${msg}`);
        if (res.status >= 500 && attempt === 0) {
          await sleep(1500);
          continue;
        }
        break;
      }
      throw new Error(`Gemini error ${res.status}: ${msg}`);
    }
  }
  throw lastError || new SoftError("Gemini failed.");
}

async function callGroq({ system, turns, user, json, maxTokens, status }) {
  const key = process.env.GROQ_API_KEY;
  let lastError;
  for (const m of unique([MODELS.groq(), "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile"])) {
    let jsonMode = json;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        status(`⚡ Asking Groq (${m})…`);
        res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: m,
            temperature: 0.6,
            max_completion_tokens: Math.min(maxTokens, 8000),
            ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
            messages: [{ role: "system", content: system }, ...turns, { role: "user", content: user }],
          }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (e) {
        log(`Groq ${m} failed: ${e.message}`);
        lastError = new SoftError(`Groq didn't answer (${e.message}).`);
        break;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text;
        lastError = new SoftError("Groq returned nothing.");
        break;
      }
      const msg = data?.error?.message || res.statusText;
      const code = data?.error?.code || "";
      log(`Groq ${m} → ${res.status}: ${String(msg).slice(0, 160)}`);
      if (res.status === 401) throw new Error("Groq says the API key is wrong.");
      if (res.status === 400 && jsonMode && /json/i.test(`${code} ${msg}`)) {
        jsonMode = false;
        continue;
      }
      if (res.status === 429) {
        lastError = new SoftError(`Groq free limit hit. (${msg})`);
        const wait = retryAfterMs(res, msg);
        if (attempt === 0 && wait <= 12000) {
          status(`⏳ Groq is busy, waiting ${Math.round(wait / 1000)}s…`);
          await sleep(wait);
          continue;
        }
        break;
      }
      if (res.status === 413 || res.status === 404 || res.status >= 500 || (res.status === 400 && /model/i.test(msg))) {
        lastError = new SoftError(`Groq ${m}: ${msg}`);
        break;
      }
      throw new Error(`Groq error ${res.status}: ${msg}`);
    }
  }
  throw lastError || new SoftError("Groq failed.");
}

let anthropicClient;
async function callAnthropic({ system, turns, user, maxTokens, status }) {
  status("🧠 Asking Claude…");
  anthropicClient ??= new Anthropic();
  try {
    const response = await anthropicClient.beta.messages.create({
      model: MODELS.anthropic(),
      max_tokens: Math.max(maxTokens, 16000),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system,
      messages: [...turns, { role: "user", content: user }],
    });
    if (response.stop_reason === "refusal") throw new SoftError("Claude declined that request.");
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!text) throw new SoftError(`Claude returned nothing (${response.stop_reason}).`);
    return text;
  } catch (error) {
    if (error instanceof SoftError) throw error;
    if (error instanceof Anthropic.AuthenticationError) throw new Error("Anthropic says the API key is wrong.");
    if (error instanceof Anthropic.RateLimitError) throw new SoftError("Claude rate limit hit.");
    if (error instanceof Anthropic.APIError) throw new SoftError(`Claude error ${error.status}: ${error.message}`);
    throw error;
  }
}

const CALL = { gemini: callGemini, groq: callGroq, anthropic: callAnthropic };

/** Ask the AI. Tries every provider you have a key for until one answers. */
export async function completeText({ system, user, turns = [], json = false, maxTokens = 16000, onStatus }) {
  const order = providerOrder();
  if (!order.length) throw new Error("No AI key set. Put GEMINI_API_KEY (free) or GROQ_API_KEY (free) in your .env file.");
  const status = (text) => {
    try {
      onStatus?.(text);
    } catch {
      /* ignore */
    }
  };
  const errors = [];
  for (const p of order) {
    const t0 = Date.now();
    try {
      const out = await CALL[p]({ system, turns, user, json, maxTokens, status });
      log(`${p} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return out;
    } catch (e) {
      log(`${p} gave up after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
      errors.push(e.message);
      if (!(e instanceof SoftError) && order.length === 1) throw e;
      if (order.indexOf(p) < order.length - 1) status(`🔁 ${p} didn't work, switching to ${order[order.indexOf(p) + 1]}…`);
    }
  }
  throw new Error(errors.length > 1 ? `All AIs are busy right now: ${errors.join(" | ")}` : errors[0]);
}

function log(msg) {
  console.log(`[AI] ${msg}`);
}

// =====================================================================================
// Planning
// =====================================================================================

/** Drop ids, links and empty fields so free tier token limits go further. */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "id" || k === "icon" || k === "url" || k === "config" || v === undefined || v === null || v === false) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

function stateText(serverState, memory) {
  const notes = (memory || []).length ? `\nOWNER PREFERENCES (remembered):\n- ${memory.join("\n- ")}\n` : "";
  return `CURRENT SERVER STATE (JSON):\n${JSON.stringify(compact(serverState))}\n${notes}`;
}

function cleanTurns(history) {
  return history
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content)
    .slice(-10)
    .map((t) => ({ role: t.role, content: t.content.slice(0, 3000) }));
}

/** Returns { reply, questions, actions, remember } */
export async function plan({ message, history = [], serverState, memory = [], allowedTypes, onStatus }) {
  const raw = await completeText({
    system: SYSTEM_PROMPT,
    turns: cleanTurns(history),
    user: `${stateText(serverState, memory)}\nOWNER SAYS:\n${message}`,
    json: true,
    maxTokens: 32000,
    onStatus,
  });
  return normalize(parseJson(raw), allowedTypes);
}

/** After a build, let the AI fix what failed. */
export async function repair({ request, failures, serverState, memory = [], allowedTypes }) {
  const raw = await completeText({
    system: SYSTEM_PROMPT,
    user:
      `${stateText(serverState, memory)}\nTHE OWNER ASKED:\n${request}\n\nFAILED ACTIONS:\n` +
      failures.map((f) => `- ${JSON.stringify(f.action)} → ${f.message}`).join("\n") +
      `\n\n${REPAIR_PROMPT}`,
    json: true,
    maxTokens: 12000,
  });
  const out = normalize(parseJson(raw), allowedTypes);
  out.questions = [];
  return out;
}

/** A fresh question of the day. */
export async function questionOfTheDay({ topic, recent = [] }) {
  const raw = await completeText({
    system:
      'You write fun "Question of the Day" posts for Discord communities. Answer with JSON {"question": "..."} only. ' +
      "One question, under 140 characters, easy to answer, sparks conversation, safe for teens, no yes/no questions.",
    user: `Topic: ${topic || "anything fun"}\nDon't repeat any of these:\n- ${recent.slice(-20).join("\n- ") || "(none yet)"}`,
    json: true,
    maxTokens: 2000,
  });
  const q = parseJson(raw)?.question;
  return typeof q === "string" && q.trim() ? q.trim().slice(0, 300) : null;
}

// =====================================================================================
// Output cleanup
// =====================================================================================

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
    return { reply: cleaned.slice(0, 1500), actions: [] };
  }
}

function normalize(obj, allowedTypes) {
  const allowed = new Set(allowedTypes || []);
  const reply = typeof obj?.reply === "string" && obj.reply.trim() ? obj.reply.trim() : "Done.";
  const questions = (Array.isArray(obj?.questions) ? obj.questions : [])
    .filter((q) => q && typeof q.question === "string")
    .slice(0, 6)
    .map((q, i) => ({
      id: String(q.id || `q${i + 1}`).slice(0, 40),
      question: q.question.slice(0, 200),
      options: (Array.isArray(q.options) ? q.options : []).map((o) => String(o).slice(0, 60)).filter(Boolean).slice(0, 8),
      multi: Boolean(q.multi),
    }));
  const actions = questions.length
    ? []
    : (Array.isArray(obj?.actions) ? obj.actions : []).filter((a) => a && typeof a === "object" && allowed.has(a.type)).slice(0, MAX_ACTIONS);
  const remember = (Array.isArray(obj?.remember) ? obj.remember : [])
    .filter((r) => typeof r === "string" && r.trim())
    .map((r) => r.trim().slice(0, 160))
    .slice(0, 3);
  return { reply, questions, actions, remember };
}
