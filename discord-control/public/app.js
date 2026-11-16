"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  key: load("dashKey") || "",
  status: null,
  guilds: [],
  guildId: load("guildId") || null,
  server: null,
  histories: {}, // guildId -> [{role, content}]
  busy: false,
};

const SUGGESTIONS = [
  "Make a general channel with emojis",
  "Set up a full gaming server",
  "Add Owner, Admin, Mod and Member roles with colors",
  "Make a private staff category only mods can see",
  "Create voice channels for chilling and gaming",
  "Post a welcome message in general",
  "Make a rules channel and write the rules",
];

// ---------- tiny helpers ----------

function load(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json", "x-dashboard-key": state.key },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin("Wrong password."); throw new Error("Wrong password."); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- login ----------

function showLogin(err = "") {
  save("dashKey", null);
  state.key = "";
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("loginError").textContent = err;
  $("password").focus();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.key = $("password").value;
  $("loginError").textContent = "";
  try {
    await boot();
    save("dashKey", state.key);
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

// ---------- boot ----------

async function boot() {
  state.status = await api("/api/status");
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderStatus();
  if (state.status.botReady) await loadGuilds();
  else {
    renderRail();
    renderMessages();
    setTimeout(() => boot().catch(() => {}), 4000); // bot still connecting
  }
}

function renderStatus() {
  const s = state.status;
  const name = $("botName");
  name.classList.toggle("online", !!s.botReady);
  name.classList.toggle("offline", !s.botReady && !!s.botError);
  name.textContent = s.bot?.tag || (s.botError ? "Bot offline" : "Connecting…");
  if (s.bot?.avatar) $("botAvatar").src = s.bot.avatar;
  $("botSub").textContent = s.botError
    ? s.botError
    : s.ai?.provider ? `AI: ${s.ai.provider} · ${s.ai.model}` : "No AI key set. Add one to .env";
}

async function loadGuilds() {
  const { guilds } = await api("/api/guilds");
  state.guilds = guilds;
  if (!guilds.find((g) => g.id === state.guildId)) state.guildId = guilds[0]?.id || null;
  renderRail();
  if (state.guildId) await selectGuild(state.guildId);
  else { state.server = null; renderLayout(); renderMessages(); }
}

// ---------- server rail ----------

function initials(name) {
  return name.split(/\s+/).map((w) => [...w][0] || "").join("").slice(0, 3);
}

function renderRail() {
  const rail = $("rail");
  rail.replaceChildren(
    ...state.guilds.map((g) =>
      h("button", {
        class: "guild" + (g.id === state.guildId ? " active" : ""),
        title: g.name,
        type: "button",
        onclick: () => selectGuild(g.id),
      }, g.icon ? h("img", { src: g.icon, alt: "" }) : initials(g.name))
    ),
    state.guilds.length ? h("div", { class: "sep" }) : null,
    state.status?.invite
      ? h("a", { class: "guild add", href: state.status.invite, target: "_blank", rel: "noopener", title: "Add the bot to a server" }, "+")
      : null,
    state.status?.botReady
      ? h("button", { class: "guild add", type: "button", title: "Reload servers", onclick: () => loadGuilds() }, "↻")
      : null,
  );
}

async function selectGuild(id) {
  state.guildId = id;
  save("guildId", id);
  renderRail();
  const g = state.guilds.find((x) => x.id === id);
  $("serverName").textContent = g ? g.name : "";
  renderMessages();
  await refreshServer();
}

async function refreshServer() {
  if (!state.guildId) return;
  try {
    const { server } = await api(`/api/guilds/${state.guildId}`);
    state.server = server;
  } catch (err) {
    state.server = null;
    console.error(err);
  }
  renderLayout();
}

// ---------- layout panel ----------

const ICON = { text: "#", voice: "🔊", announcement: "📢", forum: "💬", stage: "🎙️", media: "🖼️", other: "•" };

function channelRow(c) {
  return h("div", { class: "ch", title: c.topic || c.name },
    h("span", { class: "ico" }, ICON[c.type] || "#"),
    h("span", {}, c.name),
    c.private ? h("span", { class: "lock" }, "🔒") : null,
  );
}

function renderLayout() {
  const box = $("layout");
  const s = state.server;
  if (!s) {
    box.replaceChildren(h("div", { class: "none" }, state.guildId ? "Loading…" : "Pick a server"));
    return;
  }
  const parts = [];
  parts.push(h("h4", {}, "Channels"));
  for (const c of s.uncategorized) parts.push(channelRow(c));
  for (const cat of s.categories) {
    parts.push(h("div", { class: "cat" }, cat.name, cat.private ? " 🔒" : ""));
    if (!cat.channels.length) parts.push(h("div", { class: "none" }, "empty"));
    for (const c of cat.channels) parts.push(channelRow(c));
  }
  if (!s.uncategorized.length && !s.categories.length) parts.push(h("div", { class: "none" }, "No channels yet"));

  parts.push(h("h4", {}, `Roles · ${s.roles.length}`));
  if (!s.roles.length) parts.push(h("div", { class: "none" }, "No roles yet"));
  for (const r of s.roles) {
    parts.push(h("div", { class: "role" },
      h("span", { class: "dot", style: r.color ? `background:${r.color}` : "" }),
      h("span", { style: r.color ? `color:${r.color}` : "" }, r.name),
      r.admin ? h("span", { class: "small muted" }, " admin") : null,
    ));
  }

  parts.push(h("h4", {}, `Emojis · ${s.emojis.length}`));
  parts.push(s.emojis.length
    ? h("div", { class: "emojis" }, s.emojis.map((e) => h("img", { src: e.url, alt: e.name, title: `:${e.name}:` })))
    : h("div", { class: "none" }, "No custom emojis"));

  box.replaceChildren(...parts);
}

$("refresh").addEventListener("click", refreshServer);
$("togglePanel").addEventListener("click", () => $("panel").classList.toggle("open"));
document.addEventListener("click", (e) => {
  const panel = $("panel");
  if (panel.classList.contains("open") && !panel.contains(e.target) && e.target !== $("togglePanel")) {
    panel.classList.remove("open");
  }
});

// ---------- chat ----------

function history() {
  return (state.histories[state.guildId] ||= []);
}

function botAvatar() {
  return state.status?.bot?.avatar ? h("img", { src: state.status.bot.avatar, alt: "" }) : "🤖";
}

function messageEl(m) {
  const isUser = m.role === "user";
  return h("div", { class: `msg ${isUser ? "user" : "bot"}${m.error ? " error" : ""}` },
    h("div", { class: "avatar" }, isUser ? "🙂" : botAvatar()),
    h("div", { class: "body" },
      h("div", { class: "who" }, isUser ? "You" : state.status?.bot?.tag?.split("#")[0] || "Bot"),
      m.typing ? h("div", { class: "typing" }, h("span"), h("span"), h("span")) : h("div", { class: "text" }, m.text),
      m.results?.length ? h("div", { class: "results" }, m.results.map((r) =>
        h("div", { class: "result" + (r.ok ? "" : " fail") }, h("span", { class: "icon" }, r.ok ? "✅" : "❌"), h("span", {}, r.message))
      )) : null,
      m.confirm ? confirmEl(m) : null,
    ),
  );
}

function describe(a) {
  const n = a.name || a.channel || "";
  return `${a.type.replace(/_/g, " ")}${n ? `: ${n}` : ""}`;
}

function confirmEl(m) {
  const danger = m.confirm.filter((a) => /^delete_/.test(a.type));
  return h("div", { class: "confirm" },
    h("strong", {}, `⚠️ This plan deletes ${danger.length} thing${danger.length === 1 ? "" : "s"}. Run it?`),
    h("ul", {}, m.confirm.map((a) => h("li", {}, describe(a)))),
    h("div", { class: "row" },
      h("button", { class: "btn danger small", type: "button", onclick: () => runConfirmed(m) }, "Yes, do it"),
      h("button", { class: "btn small", type: "button", onclick: () => { m.confirm = null; m.text += "\n\n(Cancelled)"; renderMessages(); } }, "Cancel"),
    ),
  );
}

let view = []; // messages displayed for the current guild
const views = {};

function renderMessages() {
  const box = $("messages");
  view = views[state.guildId] ||= [];
  if (!state.status?.botReady) {
    box.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "big" }, state.status?.botError ? "😵" : "⏳"),
      h("h2", {}, state.status?.botError ? "Bot can't log in" : "Bot is connecting"),
      h("p", {}, state.status?.botError || "Hang on a sec…"),
    ));
  } else if (!state.guildId) {
    box.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "big" }, "➕"),
      h("h2", {}, "Add the bot to a server"),
      h("p", {}, "The bot isn't in any server yet. Invite it, then hit ↻."),
      state.status.invite ? h("a", { class: "btn primary", href: state.status.invite, target: "_blank", rel: "noopener" }, "Invite bot") : null,
    ));
  } else if (!view.length) {
    box.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "big" }, "🛠️"),
      h("h2", {}, "What should I build?"),
      h("p", {}, "Tell me in normal words. Channels, categories, roles, permissions, messages, emojis, whole server setups. I'll build it live."),
    ));
  } else {
    box.replaceChildren(...view.map(messageEl));
    box.scrollTop = box.scrollHeight;
  }
  renderChips();
}

function renderChips() {
  const show = state.status?.botReady && state.guildId && !state.busy;
  $("chips").replaceChildren(...(show ? SUGGESTIONS.map((s) =>
    h("button", { class: "chip", type: "button", onclick: () => send(s) }, s)) : []));
}

function summary(results) {
  if (!results?.length) return "";
  return "\n[Done: " + results.map((r) => (r.ok ? "" : "FAILED ") + r.message).join("; ") + "]";
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy || !state.guildId) return;
  const guildId = state.guildId;
  const hist = history();
  const priorHistory = hist.slice();
  state.busy = true;
  $("send").disabled = true;
  view.push({ role: "user", text });
  const pending = { role: "bot", typing: true };
  view.push(pending);
  renderMessages();

  try {
    const data = await api(`/api/guilds/${guildId}/chat`, { method: "POST", body: { message: text, history: priorHistory } });
    pending.typing = false;
    pending.text = data.reply;
    if (data.needsConfirm) {
      pending.confirm = data.actions;
      pending.guildId = guildId;
    } else {
      pending.results = data.results;
      if (data.server && guildId === state.guildId) { state.server = data.server; renderLayout(); }
    }
    hist.push({ role: "user", content: text }, { role: "assistant", content: data.reply + summary(data.results) });
  } catch (err) {
    pending.typing = false;
    pending.error = true;
    pending.text = err.message;
  } finally {
    state.busy = false;
    $("send").disabled = false;
    renderMessages();
  }
}

async function runConfirmed(m) {
  const actions = m.confirm;
  m.confirm = null;
  m.typing = true;
  const reply = m.text;
  renderMessages();
  try {
    const data = await api(`/api/guilds/${m.guildId}/execute`, { method: "POST", body: { actions } });
    m.results = data.results;
    if (m.guildId === state.guildId) { state.server = data.server; renderLayout(); }
    const hist = state.histories[m.guildId] || [];
    const last = hist[hist.length - 1];
    if (last?.role === "assistant") last.content = reply + summary(data.results);
  } catch (err) {
    m.error = true;
    m.text = reply + "\n\n" + err.message;
  } finally {
    m.typing = false;
    renderMessages();
  }
}

// ---------- composer ----------

const input = $("input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; }
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  autosize();
  send(text);
});

// ---------- start ----------

if (state.key) boot().catch(() => showLogin());
else showLogin();
