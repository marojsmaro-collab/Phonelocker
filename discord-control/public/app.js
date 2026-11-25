"use strict";

// =====================================================================
// basics
// =====================================================================

const $ = (id) => document.getElementById(id);

function load(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function save(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch {} }

const state = {
  key: load("dashKey") || "",
  status: null,
  guilds: [],
  guildId: load("guildId") || null,
  server: null,
  tab: load("tab") || "builder",
  histories: {}, // guildId -> [{role, content}] for the AI
  chats: {}, // guildId -> [message objects] shown in the builder
  busy: false,
};

const TABS = [
  ["builder", "🤖 Builder"],
  ["art", "🎨 Art"],
  ["welcome", "👋 Welcome"],
  ["levels", "⭐ Levels"],
  ["tickets", "🎫 Tickets"],
  ["roles", "🎭 Roles"],
  ["fun", "🎉 Fun"],
  ["mod", "🛡️ Mod"],
  ["bot", "⚙️ Bot"],
];

const SUGGESTIONS = [
  "Build me a full server",
  "Make AI emojis for my server",
  "Make a server icon and banner",
  "Set up welcome cards",
  "Turn on question of the day",
  "Start a giveaway",
  "Set up auto moderation",
  "Make a ticket system",
  "Add leveling with role rewards",
];

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const OFFLINE = "Can't reach the bot. Make sure Termux is still open and running (tap Acquire wakelock in its notification), then try again.";

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers: { "content-type": "application/json", "x-dashboard-key": state.key },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw Object.assign(new Error(OFFLINE), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin("Wrong password."); throw new Error("Wrong password."); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), 3500);
}

// =====================================================================
// login + boot
// =====================================================================

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

async function boot() {
  state.status = await api("/api/status");
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderStatus();
  renderTabs();
  if (state.status.botReady) await loadGuilds();
  else {
    renderRail();
    renderView();
    setTimeout(() => boot().catch(() => {}), 4000);
  }
}

function renderStatus() {
  const s = state.status;
  const name = $("botName");
  name.classList.toggle("online", !!s.botReady);
  name.classList.toggle("offline", !s.botReady && !!s.botError);
  name.textContent = s.bot?.tag || (s.botError ? "Bot offline" : "Connecting…");
  if (s.bot?.avatar) $("botAvatar").src = s.bot.avatar;
  const ai = s.ai?.provider ? `AI: ${s.ai.provider}${s.ai.backups?.length ? ` + ${s.ai.backups.join(", ")}` : ""}` : "No AI key set";
  $("botSub").textContent = s.botError || (s.botWarning ? `⚠️ ${s.botWarning}` : ai);
}

async function loadGuilds() {
  const { guilds } = await api("/api/guilds");
  state.guilds = guilds;
  if (!guilds.find((g) => g.id === state.guildId)) state.guildId = guilds[0]?.id || null;
  renderRail();
  if (state.guildId) await selectGuild(state.guildId);
  else { state.server = null; renderLayout(); renderView(); }
}

// =====================================================================
// servers rail + layout panel
// =====================================================================

const initials = (name) => name.split(/\s+/).map((w) => [...w][0] || "").join("").slice(0, 3);

/** replaceChildren that skips empty bits instead of printing "null". */
function put(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

function renderRail() {
  put($("rail"),
    ...state.guilds.map((g) =>
      h("button", { class: "guild" + (g.id === state.guildId ? " active" : ""), title: g.name, type: "button", onclick: () => selectGuild(g.id) },
        g.icon ? h("img", { src: g.icon, alt: "" }) : initials(g.name))
    ),
    state.guilds.length ? h("div", { class: "sep" }) : null,
    state.status?.invite ? h("a", { class: "guild add", href: state.status.invite, target: "_blank", rel: "noopener", title: "Add the bot to a server" }, "+") : null,
    state.status?.botReady ? h("button", { class: "guild add", type: "button", title: "Reload servers", onclick: () => loadGuilds() }, "↻") : null,
  );
}

async function selectGuild(id) {
  state.guildId = id;
  save("guildId", id);
  renderRail();
  const g = state.guilds.find((x) => x.id === id);
  $("serverName").textContent = g ? g.name : "";
  state.server = null;
  renderView();
  await refreshServer();
}

async function refreshServer(fresh) {
  if (!state.guildId) return;
  try {
    const { server } = await api(`/api/guilds/${state.guildId}${fresh ? "?fresh=1" : ""}`);
    state.server = server;
  } catch (err) {
    state.server = null;
    toast(err.message, true);
  }
  renderLayout();
  if (state.tab !== "builder") renderView();
}

function setServer(server) {
  if (!server || server.id !== state.guildId) return;
  state.server = { ...state.server, ...server };
  renderLayout();
}

const ICON = { text: "#", voice: "🔊", announcement: "📢", forum: "💬", stage: "🎙️", media: "🖼️", other: "•" };

function renderLayout() {
  const box = $("layout");
  const s = state.server;
  if (!s) return box.replaceChildren(h("div", { class: "none" }, state.guildId ? "Loading…" : "Pick a server"));
  const row = (c) => h("div", { class: "ch", title: c.topic || c.name }, h("span", { class: "ico" }, ICON[c.type] || "#"), h("span", {}, c.name), c.private ? h("span", { class: "lock" }, "🔒") : null);
  const parts = [h("h4", {}, "Channels")];
  for (const c of s.uncategorized) parts.push(row(c));
  for (const cat of s.categories) {
    parts.push(h("div", { class: "cat" }, cat.name, cat.private ? " 🔒" : ""));
    if (!cat.channels.length) parts.push(h("div", { class: "none" }, "empty"));
    for (const c of cat.channels) parts.push(row(c));
  }
  parts.push(h("h4", {}, `Roles · ${s.roles.length}`));
  for (const r of s.roles) parts.push(h("div", { class: "role" }, h("span", { class: "dot", style: r.color ? `background:${r.color}` : "" }), h("span", { style: r.color ? `color:${r.color}` : "" }, r.name)));
  parts.push(h("h4", {}, `Emojis · ${s.emojis.length}`));
  parts.push(s.emojis.length ? h("div", { class: "emojis" }, s.emojis.map((e) => h("img", { src: e.url, alt: e.name, title: `:${e.name}:` }))) : h("div", { class: "none" }, "No custom emojis"));
  box.replaceChildren(...parts);
}

$("refresh").addEventListener("click", () => refreshServer(true));
$("togglePanel").addEventListener("click", () => $("panel").classList.toggle("open"));
document.addEventListener("click", (e) => {
  const p = $("panel");
  if (p.classList.contains("open") && !p.contains(e.target) && e.target !== $("togglePanel")) p.classList.remove("open");
});

// =====================================================================
// tabs + views
// =====================================================================

function renderTabs() {
  $("tabs").replaceChildren(...TABS.map(([id, label]) =>
    h("button", { class: "tab" + (state.tab === id ? " active" : ""), type: "button", role: "tab", onclick: () => { state.tab = id; save("tab", id); renderTabs(); renderView(); } }, label)));
}

function renderView() {
  const view = $("view");
  if (!state.status?.botReady) {
    view.className = "view";
    return view.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "big" }, state.status?.botError ? "😵" : "⏳"),
      h("h2", {}, state.status?.botError ? "Bot can't log in" : "Bot is connecting"),
      h("p", {}, state.status?.botError || "Hang on a sec…")));
  }
  if (!state.guildId) {
    view.className = "view";
    return view.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "big" }, "➕"), h("h2", {}, "Add the bot to a server"),
      h("p", {}, "The bot isn't in any server yet. Invite it, then hit ↻."),
      state.status.invite ? h("a", { class: "btn primary", href: state.status.invite, target: "_blank", rel: "noopener" }, "Invite bot") : null));
  }
  if (state.tab === "builder") return renderBuilder();
  view.className = "view scroll";
  if (!state.server) return view.replaceChildren(h("div", { class: "empty" }, h("div", { class: "big" }, "⏳"), h("p", {}, "Loading server…")));
  const page = PAGES[state.tab];
  put(view, page ? page() : []);
}

// =====================================================================
// BUILDER (AI chat)
// =====================================================================

const chat = () => (state.chats[state.guildId] ||= []);
const history = () => (state.histories[state.guildId] ||= []);
const botAvatar = () => h("img", { src: state.status?.bot?.avatar || "logo.png", alt: "" });

function renderBuilder() {
  const view = $("view");
  view.className = "view";
  const msgs = h("div", { class: "messages", id: "messages" });
  const chips = h("div", { class: "chips", id: "chips" });
  const input = h("textarea", { id: "input", rows: 1, placeholder: "Tell me what to build… e.g. make a Roblox game server with AI emojis" });
  const composer = h("form", { class: "composer" }, input, h("button", { class: "btn primary", type: "submit", id: "send", "aria-label": "Send" }, "➤"));
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; };
  const touch = matchMedia("(pointer: coarse)").matches;
  let last = 0;
  const submit = () => {
    if (Date.now() - last < 500) return;
    const t = input.value.trim();
    if (!t) return;
    if (state.busy) return toast("Hold up, I'm still working on the last one ⏳", true);
    last = Date.now();
    input.value = "";
    autosize();
    send(t);
  };
  composer.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  // Desktop: Enter sends, Shift+Enter makes a new line.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !(e.isComposing && !touch)) { e.preventDefault(); submit(); }
  });
  // Phones: keyboards like Gboard don't always send a normal Enter key, so catch the new line itself.
  input.addEventListener("beforeinput", (e) => {
    if (touch && (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph")) { e.preventDefault(); submit(); }
  });
  input.addEventListener("input", () => {
    if (touch && input.value.includes("\n")) { input.value = input.value.replace(/\n+/g, " ").trim(); submit(); return; }
    autosize();
  });
  view.replaceChildren(msgs, chips, composer);
  renderMessages();
}

function renderMessages() {
  const box = $("messages");
  if (!box) return;
  const list = chat();
  if (!list.length) {
    box.replaceChildren(h("div", { class: "empty" },
      h("div", { class: "big" }, "🛠️"), h("h2", {}, "What should I build?"),
      h("p", {}, "Tell me in normal words. Whole servers, channels, roles, colors, AI emojis, icons, banners, welcome cards, giveaways, anything. For big builds I'll ask a few quick questions first.")));
  } else {
    box.replaceChildren(...list.map(messageEl));
    box.scrollTop = box.scrollHeight;
  }
  renderChips();
}

function updateMessage(m) {
  const old = m._el;
  if (old?.isConnected) {
    const box = $("messages");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    old.replaceWith(messageEl(m));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}

function renderChips() {
  const el = $("chips");
  if (!el) return;
  el.replaceChildren(...(state.busy ? [] : SUGGESTIONS.map((s) => h("button", { class: "chip", type: "button", onclick: () => send(s) }, s))));
}

function messageEl(m) {
  const isUser = m.role === "user";
  const el = h("div", { class: `msg ${isUser ? "user" : "bot"}${m.error ? " error" : ""}` },
    h("div", { class: "avatar" }, isUser ? "🙂" : botAvatar()),
    h("div", { class: "body" },
      h("div", { class: "who" }, isUser ? "You" : (state.status?.bot?.tag || "Bot").split("#")[0]),
      m.typing
        ? h("div", {}, h("div", { class: "typing" }, h("span"), h("span"), h("span")), m.status ? h("div", { class: "muted small" }, `${m.status}${m.seconds ? ` · ${m.seconds}s` : ""}`) : null)
        : h("div", { class: "text" }, m.text),
      m.skipped?.length ? h("div", { class: "warnbox", style: "margin-top:8px" }, `⚠️ I skipped ${m.skipped.length} step${m.skipped.length === 1 ? "" : "s"} I didn't understand (${m.skipped.slice(0, 5).join(", ")}). Ask again if something's missing.`) : null,
      m.error && m.retry ? h("div", { class: "row", style: "margin-top:8px" }, h("button", { class: "btn small", type: "button", onclick: () => { if (state.busy) return toast("Still working on something ⏳", true); m.retry = null; updateMessage(m); send(m.request); } }, "🔁 Try again")) : null,
      m.questions?.length ? questionsEl(m) : null,
      m.confirm ? confirmEl(m) : null,
      m.jobId ? jobEl(m) : null,
      m.results?.length ? h("div", { class: "box" }, h("div", { class: "results" }, m.results.map(resultEl))) : null,
    ));
  m._el = el;
  return el;
}

const resultEl = (r) => h("div", { class: `result${r.ok ? "" : " fail"}${r.fix ? " fix" : ""}` }, h("span", {}, r.ok ? (r.fix ? "🔧" : "✅") : "❌"), h("span", {}, r.message));

function questionsEl(m) {
  m.picks ||= {};
  m.other ||= {};
  const done = m.answered;
  return h("div", { class: "box" },
    h("h5", {}, done ? "Your answers" : "Quick questions"),
    m.questions.map((q) => {
      const picked = (m.picks[q.id] ||= []);
      return h("div", { class: "question" },
        h("div", { class: "q" }, q.question),
        h("div", { class: "opts" }, q.options.map((o) =>
          h("button", { type: "button", class: "opt" + (picked.includes(o) ? " on" : ""), disabled: done, onclick: () => {
            if (q.multi) m.picks[q.id] = picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o];
            else m.picks[q.id] = picked.includes(o) ? [] : [o];
            updateMessage(m);
          } }, o))),
        done ? null : h("input", { type: "text", placeholder: "Or type your own…", value: m.other[q.id] || "", oninput: (e) => (m.other[q.id] = e.target.value) }));
    }),
    done ? null : h("div", { class: "row" },
      h("button", { class: "btn primary", type: "button", onclick: () => {
        const lines = m.questions.map((q) => {
          const ans = [...(m.picks[q.id] || []), (m.other[q.id] || "").trim()].filter(Boolean).join(", ") || "you pick";
          return `- ${q.question} ${ans}`;
        });
        m.answered = true;
        updateMessage(m);
        send(`My answers:\n${lines.join("\n")}\nNow build it!`);
      } }, "Build it 🚀"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { m.answered = true; updateMessage(m); send("You pick everything, surprise me. Build it!"); } }, "You pick everything")));
}

function confirmEl(m) {
  const danger = m.confirm.filter((a) => /^delete_/.test(a.type));
  return h("div", { class: "box warn" },
    h("strong", {}, `⚠️ This deletes ${danger.length} thing${danger.length === 1 ? "" : "s"}. Run it?`),
    h("div", { class: "results" }, m.confirm.map((a) => h("div", { class: "result" + (/^delete_/.test(a.type) ? " fail" : "") }, h("span", {}, "•"), h("span", {}, `${a.type.replace(/_/g, " ")}${a.name || a.channel ? `: ${a.name || a.channel}` : ""}`)))),
    h("div", { class: "row" },
      h("button", { class: "btn danger small", type: "button", onclick: async () => {
        const actions = m.confirm;
        m.confirm = null;
        try {
          const { jobId } = await api(`/api/guilds/${m.guildId}/execute`, { method: "POST", body: { actions, request: m.request } });
          m.jobId = jobId;
          updateMessage(m);
          pollJob(m);
        } catch (err) { m.text += `\n\n${err.message}`; updateMessage(m); }
      } }, "Yes, do it"),
      h("button", { class: "btn small", type: "button", onclick: () => { m.confirm = null; m.text += "\n\n(Cancelled)"; updateMessage(m); } }, "Cancel")));
}

function jobEl(m) {
  const j = m.job || { status: "running", phase: "building", total: 0, done: 0, results: [] };
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 5;
  const label = j.status === "done" ? (j.undone ? "Undone ↩️" : "Done ✅") : j.phase === "fixing" ? "Fixing mistakes… 🔧" : `Building… ${j.done}/${j.total || "?"}`;
  const fails = j.results.filter((r) => !r.ok).length;
  return h("div", { class: "box" },
    h("div", { class: "row" }, h("strong", {}, label), j.status === "done" ? h("span", { class: "muted small" }, `${j.results.length - fails} worked${fails ? `, ${fails} failed` : ""}`) : null),
    h("div", { class: "progress" }, h("div", { style: `width:${j.status === "done" ? 100 : pct}%` })),
    j.results.length ? h("div", { class: "results" }, j.results.map(resultEl)) : null,
    j.fixReply ? h("div", { class: "note" }, `🔧 ${j.fixReply}`) : null,
    m.undoResults ? h("div", { class: "results" }, m.undoResults.map(resultEl)) : null,
    j.status === "done" && j.created > 0 && !j.undone
      ? h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onclick: () => undo(m) }, `↩️ Undo (delete the ${j.created} thing${j.created === 1 ? "" : "s"} this made)`))
      : null);
}

async function pollJob(m) {
  state.busy = true;
  renderChips();
  for (;;) {
    try {
      const { job } = await api(`/api/jobs/${m.jobId}`);
      m.job = job;
      updateMessage(m);
      if (job.status === "done") {
        if (job.server) setServer(job.server);
        const hist = state.histories[m.guildId] || [];
        const last = hist[hist.length - 1];
        if (last?.role === "assistant") {
          last.content += "\n[Built: " + job.results.map((r) => (r.ok ? "" : "FAILED ") + r.message).join("; ").slice(0, 1500) + "]";
        }
        break;
      }
    } catch (err) {
      if (err.offline && (m.misses = (m.misses || 0) + 1) < 40) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      m.text += `\n\n${err.message}`;
      updateMessage(m);
      break;
    }
    m.misses = 0;
    await new Promise((r) => setTimeout(r, 900));
  }
  state.busy = false;
  renderChips();
}

async function undo(m) {
  if (!confirm("Delete everything this build made?")) return;
  try {
    const { results, server } = await api(`/api/jobs/${m.jobId}/undo`, { method: "POST" });
    m.undoResults = results;
    m.job.undone = true;
    setServer(server);
    updateMessage(m);
    toast("Undone ↩️");
  } catch (err) { toast(err.message, true); }
}

async function send(text) {
  text = String(text || "").trim();
  if (!text || state.busy || !state.guildId) return;
  const guildId = state.guildId;
  const prior = history().slice();
  state.busy = true;
  chat().push({ role: "user", text });
  const pending = { role: "bot", typing: true, guildId, request: text };
  chat().push(pending);
  renderMessages();
  try {
    const { thinkId } = await api(`/api/guilds/${guildId}/chat`, { method: "POST", body: { message: text, history: prior } });
    let data = null;
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      let t;
      try {
        t = await api(`/api/think/${thinkId}`);
        misses = 0;
      } catch (err) {
        // The phone may pause the page or the bot for a moment; keep trying for a bit.
        if (err.offline && ++misses < 30) { pending.status = "📶 Reconnecting to the bot…"; updateMessage(pending); continue; }
        throw err;
      }
      pending.status = t.text;
      pending.seconds = t.seconds;
      updateMessage(pending);
      if (t.status === "done") { data = t.result; break; }
      if (t.status === "error") throw new Error(t.error || "The AI failed. Try again.");
    }
    pending.typing = false;
    pending.text = data.reply;
    pending.skipped = data.skipped || null;
    const hist = (state.histories[guildId] ||= []);
    let assistant = data.reply;
    if (data.questions?.length) {
      pending.questions = data.questions;
      assistant += "\n[I asked: " + data.questions.map((q) => `${q.question} (${q.options.join(" / ")})`).join(" | ") + "]";
    }
    hist.push({ role: "user", content: text }, { role: "assistant", content: assistant });
    if (data.needsConfirm) pending.confirm = data.actions;
    if (data.jobId) {
      pending.jobId = data.jobId;
      updateMessage(pending);
      state.busy = false;
      pollJob(pending);
      return;
    }
  } catch (err) {
    pending.typing = false;
    pending.error = true;
    pending.retry = true;
    pending.text = `😵 ${err.message}`;
  }
  state.busy = false;
  if (guildId === state.guildId && state.tab === "builder") renderMessages();
}

// =====================================================================
// dashboard form engine
// =====================================================================

const isText = (c) => c.type === "text" || c.type === "announcement";

function textChannels() {
  const s = state.server;
  if (!s) return [];
  const out = s.uncategorized.filter(isText).map((c) => ({ id: c.id, name: c.name, cat: "" }));
  for (const cat of s.categories) for (const c of cat.channels.filter(isText)) out.push({ id: c.id, name: c.name, cat: cat.name });
  return out;
}

function channelSelect(value, extra = []) {
  const groups = new Map();
  for (const c of textChannels()) {
    if (!groups.has(c.cat)) groups.set(c.cat, []);
    groups.get(c.cat).push(c);
  }
  return h("select", {},
    h("option", { value: "" }, "— pick a channel —"),
    extra.map(([v, l]) => h("option", { value: v, selected: value === v }, l)),
    [...groups].map(([cat, list]) => h("optgroup", { label: cat || "No category" }, list.map((c) => h("option", { value: c.id, selected: c.id === value }, `# ${c.name}`)))));
}

function roleSelect(value, { none = "— pick a role —" } = {}) {
  return h("select", {}, h("option", { value: "" }, none), (state.server?.roles || []).map((r) => h("option", { value: r.id, selected: r.id === value }, `@ ${r.name}`)));
}

/** Build one field. Returns [element, getter]. */
function field(f, v) {
  const label = f.label ? h("label", {}, f.label) : null;
  const help = f.help ? h("div", { class: "help" }, f.help) : null;
  let input, get;
  switch (f.type) {
    case "toggle": {
      input = h("input", { type: "checkbox", checked: v ?? f.default ?? false });
      return [h("label", { class: "switch" }, h("span", {}, f.label), input), () => input.checked];
    }
    case "textarea":
      input = h("textarea", { placeholder: f.placeholder || "", rows: f.rows || 3 }, v ?? "");
      get = () => input.value.trim();
      break;
    case "list":
      input = h("textarea", { placeholder: f.placeholder || "", rows: 2 }, (v || []).join(", "));
      get = () => input.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      break;
    case "number":
      input = h("input", { type: "number", value: v ?? f.default ?? "", min: f.min, max: f.max, placeholder: f.placeholder || "" });
      get = () => (input.value === "" ? undefined : Number(input.value));
      break;
    case "time":
      input = h("input", { type: "time", value: v || f.default || "17:00" });
      get = () => input.value;
      break;
    case "color": {
      const val = v || f.default || "#5865f2";
      const text = h("input", { type: "text", value: val, style: "max-width:120px" });
      const pick = h("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(val) ? val : "#5865f2", oninput: (e) => (text.value = e.target.value) });
      text.addEventListener("input", () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) pick.value = text.value; });
      input = h("div", { class: "colorpick" }, pick, text);
      get = () => text.value.trim();
      break;
    }
    case "select":
      input = h("select", {}, f.options.map(([val, l]) => h("option", { value: val, selected: (v ?? f.default) === val }, l)));
      get = () => input.value;
      break;
    case "channel":
      input = channelSelect(v, f.extra || []);
      get = () => input.value || null;
      break;
    case "category": {
      const id = `dl${Math.random().toString(36).slice(2)}`;
      input = h("div", {}, h("input", { type: "text", list: id, value: v || "", placeholder: f.placeholder || "" }), h("datalist", { id }, (state.server?.categories || []).map((c) => h("option", { value: c.name }))));
      get = () => input.querySelector("input").value.trim();
      break;
    }
    case "role":
      input = roleSelect(v, { none: f.none });
      get = () => input.value || null;
      break;
    case "roles": {
      const picked = new Set(v || []);
      const roles = state.server?.roles || [];
      input = h("div", { class: "checks" }, roles.length ? roles.map((r) => h("label", { class: "check" },
        h("input", { type: "checkbox", value: r.id, checked: picked.has(r.id) }),
        h("span", { class: "dot", style: `background:${r.color || "#80848e"}` }), r.name)) : h("span", { class: "faint small" }, "No roles yet"));
      get = () => [...input.querySelectorAll("input:checked")].map((x) => x.value);
      break;
    }
    case "rows": {
      const cols = f.cols;
      const wrap = h("div", { class: "rows" });
      const addRow = (data = {}) => {
        const cells = cols.map((c) => {
          if (c.type === "role") { const s = roleSelect(data[c.key]); s.dataset.key = c.key; return s; }
          return h("input", { type: c.type === "number" ? "number" : "text", placeholder: c.placeholder || "", value: data[c.key] ?? "", "data-key": c.key, style: c.width ? `max-width:${c.width}` : "" });
        });
        const line = h("div", { class: "rowline", style: `--cols:${cols.length}` }, cells, h("button", { class: "btn ghost small", type: "button", title: "Remove", onclick: () => line.remove() }, "✕"));
        wrap.append(line);
      };
      const start = v && v.length ? v : Array.from({ length: f.start ?? 1 }, () => ({}));
      start.forEach(addRow);
      input = h("div", { class: "rows" }, wrap, h("button", { class: "btn ghost small", type: "button", style: "justify-self:start", onclick: () => addRow() }, `+ ${f.addLabel || "Add"}`));
      get = () => [...wrap.children].map((line) => {
        const o = {};
        line.querySelectorAll("[data-key]").forEach((el) => {
          const c = cols.find((x) => x.key === el.dataset.key);
          o[el.dataset.key] = c.type === "number" ? (el.value === "" ? undefined : Number(el.value)) : el.value.trim();
        });
        return o;
      }).filter((o) => Object.values(o).some((x) => x !== "" && x != null));
      break;
    }
    default:
      input = h("input", { type: "text", value: v ?? "", placeholder: f.placeholder || "" });
      get = () => input.value.trim();
  }
  return [h("div", { class: "field" }, label, input, help), get];
}

async function runAction(action) {
  const { results, server } = await api(`/api/guilds/${state.guildId}/action`, { method: "POST", body: { action } });
  if (server) setServer(server);
  const r = results[0];
  toast(`${r.ok ? "✅" : "❌"} ${r.message}`, !r.ok);
  return r;
}

/**
 * spec: { title, desc, badge, on, note, fields: [{key, ...}], values, build(vals) -> action, submit, extra: [{label, style, action | run}] }
 */
function formCard(spec) {
  const getters = {};
  const fields = spec.fields.map((f) => {
    const [el, get] = field(f, spec.values?.[f.key]);
    getters[f.key] = get;
    return el;
  });
  const collect = () => Object.fromEntries(Object.entries(getters).map(([k, g]) => [k, g()]));
  const save = h("button", { class: "btn primary", type: "button" }, spec.submit || "Save");
  save.addEventListener("click", async () => {
    save.disabled = true;
    const old = save.textContent;
    save.textContent = "Working…";
    try {
      const action = spec.build(collect());
      if (action) {
        const r = await runAction(action);
        if (r.ok && spec.after) spec.after(r);
      }
      if (state.tab !== "builder") renderView();
    } catch (err) {
      toast(err.message, true);
    } finally {
      save.disabled = false;
      save.textContent = old;
    }
  });
  const extras = (spec.extra || []).map((x) => h("button", { class: `btn ${x.style || ""}`, type: "button", onclick: async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      if (x.run) await x.run(collect());
      else await runAction(typeof x.action === "function" ? x.action(collect()) : x.action);
      if (x.rerender !== false && state.tab !== "builder") renderView();
    } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
  } }, x.label));
  return h("div", { class: "card" },
    h("h3", {}, spec.title, spec.on === undefined ? null : h("span", { class: `badge${spec.on ? " on" : ""}` }, spec.on ? "ON" : "OFF"), spec.badge ? h("span", { class: "badge" }, spec.badge) : null),
    spec.desc ? h("p", { class: "desc" }, spec.desc) : null,
    spec.note ? h("div", { class: "warnbox" }, spec.note) : null,
    fields,
    h("div", { class: "actions" }, save, extras));
}

const card = (title, ...kids) => h("div", { class: "card" }, h("h3", {}, title), ...kids);
const pageHead = (title, sub) => [h("h2", { class: "page-title" }, title), sub ? h("p", { class: "page-sub" }, sub) : null];
const cards = (...list) => h("div", { class: "cards" }, ...list);

// =====================================================================
// pages
// =====================================================================

const S = () => state.server;
const C = () => state.server?.config || {};

function membersNote() {
  return S().features?.membersIntent === false
    ? "Turn on Server Members Intent in the Discord Developer Portal → Bot, then restart the bot, or welcomes and autoroles won't fire."
    : null;
}

const PAGES = {
  // ------------------------------------------------------------- ART
  art() {
    const s = S();
    return [
      ...pageHead("🎨 AI Art Studio", `Make icons, banners and custom emojis with AI. ${s.emojiSlotsLeft} emoji slots left · boost level ${s.boostLevel}.`),
      cards(artCard("icon"), artCard("banner"), emojiStudio(), artCard("image")),
    ];
  },

  // ------------------------------------------------------------- WELCOME
  welcome() {
    const w = C().welcome || {};
    const g = C().goodbye || {};
    return [
      ...pageHead("👋 Welcome", "Greet new people with a card that has their pfp."),
      cards(
        formCard({
          title: "Welcome cards", on: Boolean(w.enabled && w.channelId), note: membersNote(),
          values: { enabled: w.channelId ? w.enabled !== false : true, channel: w.channelId, message: w.message, card: w.card !== false, card_color: w.cardColor || "#7c3aed", card_title: w.cardTitle, card_background: w.cardBackground },
          fields: [
            { key: "enabled", type: "toggle", label: "Welcome new members" },
            { key: "channel", type: "channel", label: "Channel" },
            { key: "message", type: "textarea", label: "Message", placeholder: "Hey {user} welcome to **{server}** 🎉 you're member #{count}!", help: "{user} pings them · {username} · {server} · {count}" },
            { key: "card", type: "toggle", label: "Show the pfp card image" },
            { key: "card_title", type: "text", label: "Card title", placeholder: "WELCOME" },
            { key: "card_color", type: "color", label: "Card color" },
            { key: "card_background", type: "text", label: "Card background image link (optional)", placeholder: "https://…png" },
          ],
          build: (v) => ({ type: "setup_welcome", ...v }),
          extra: [{ label: "Send a test 🧪", action: { type: "test_welcome" }, rerender: false }],
        }),
        formCard({
          title: "Goodbye messages", on: Boolean(g.enabled && g.channelId),
          values: { enabled: g.channelId ? g.enabled !== false : false, channel: g.channelId, message: g.message },
          fields: [
            { key: "enabled", type: "toggle", label: "Say bye when people leave" },
            { key: "channel", type: "channel", label: "Channel" },
            { key: "message", type: "textarea", label: "Message", placeholder: "**{username}** just left {server} 👋" },
          ],
          build: (v) => ({ type: "setup_goodbye", ...v }),
        }),
        formCard({
          title: "Autoroles", desc: "Roles every new member gets automatically.", on: (C().autoroles || []).length > 0,
          values: { roles: C().autoroles }, fields: [{ key: "roles", type: "roles", label: "Roles" }],
          build: (v) => ({ type: "set_autoroles", roles: v.roles }),
        }),
      ),
    ];
  },

  // ------------------------------------------------------------- LEVELS
  levels() {
    const l = C().levels || {};
    const board = h("div", { class: "list" }, h("div", { class: "faint small" }, "Loading…"));
    api(`/api/guilds/${state.guildId}/leaderboard`).then(({ rows }) => {
      board.replaceChildren(...(rows.length ? rows.map((r) => h("div", { class: "item" },
        h("strong", { style: "width:28px" }, r.rank <= 3 ? ["🥇", "🥈", "🥉"][r.rank - 1] : `#${r.rank}`),
        r.avatar ? h("img", { src: r.avatar, alt: "" }) : null,
        h("div", { class: "grow" }, h("div", {}, r.name), h("div", { class: "lvbar" }, h("div", { style: `width:${Math.min(100, Math.round((r.xp / r.need) * 100))}%` }))),
        h("span", { class: "muted small" }, `lvl ${r.level}`))) : [h("div", { class: "faint small" }, "Nobody has XP yet.")]));
    }).catch((e) => board.replaceChildren(h("div", { class: "faint small" }, e.message)));
    return [
      ...pageHead("⭐ Leveling", "People get XP for chatting (once a minute), level up, and unlock reward roles. They can check /rank."),
      cards(
        formCard({
          title: "Leveling", on: Boolean(l.enabled),
          values: { enabled: l.enabled ?? true, channel: l.channelId || "same", message: l.message, card_color: l.color || "#5865f2", rewards: (l.rewards || []).map((r) => ({ level: r.level, role: r.roleId })) },
          fields: [
            { key: "enabled", type: "toggle", label: "Leveling on" },
            { key: "channel", type: "channel", label: "Level up announcements", extra: [["same", "Same channel they chatted in"]] },
            { key: "message", type: "textarea", label: "Level up message", placeholder: "🎉 GG {user} you just hit **level {level}**!" },
            { key: "card_color", type: "color", label: "Rank card color" },
            { key: "rewards", type: "rows", label: "Reward roles", addLabel: "Add reward", start: 1, cols: [{ key: "level", type: "number", placeholder: "Level", width: "90px" }, { key: "role", type: "role" }] },
          ],
          build: (v) => ({ type: "setup_leveling", ...v, channel: v.channel || "same", rewards: v.rewards.filter((r) => r.level && r.role) }),
        }),
        card("🏆 Leaderboard", board),
      ),
    ];
  },

  // ------------------------------------------------------------- TICKETS
  tickets() {
    const t = C().tickets || {};
    const f = S().features?.tickets;
    return [
      ...pageHead("🎫 Tickets", "Members tap a button to open a private chat with staff. Closing saves a transcript."),
      cards(formCard({
        title: "Ticket panel", on: Boolean(t.categoryId), badge: f ? `${f.opened} opened` : null,
        desc: "Saving posts a new panel in the channel you pick.",
        values: { category: f?.category || "🎫 TICKETS", support_roles: t.supportRoleIds, log_channel: t.logChannelId, ticket_message: t.message, color: t.color || "#5865f2", title: "🎫 Need help?", description: "Tap the button below to open a private ticket with the staff team.", button_label: "Open a ticket" },
        fields: [
          { key: "channel", type: "channel", label: "Post the panel in" },
          { key: "category", type: "category", label: "Tickets go in category", placeholder: "🎫 TICKETS" },
          { key: "support_roles", type: "roles", label: "Staff roles that see tickets" },
          { key: "log_channel", type: "channel", label: "Transcripts go to" },
          { key: "title", type: "text", label: "Panel title" },
          { key: "description", type: "textarea", label: "Panel text" },
          { key: "button_label", type: "text", label: "Button text" },
          { key: "ticket_message", type: "textarea", label: "First message inside a ticket", placeholder: "Thanks for reaching out! Tell us what you need." },
          { key: "color", type: "color", label: "Color" },
        ],
        build: (v) => {
          if (!v.channel) throw new Error("Pick a channel for the panel.");
          return { type: "setup_tickets", ...v };
        },
        submit: "Post ticket panel",
      })),
    ];
  },

  // ------------------------------------------------------------- ROLES
  roles() {
    return [
      ...pageHead("🎭 Roles", "Self role buttons and quick role making."),
      cards(
        formCard({
          title: "Self role panel", desc: "Posts buttons people tap to get or remove roles.",
          values: { title: "🎭 Pick your roles", color: "#5865f2" },
          fields: [
            { key: "channel", type: "channel", label: "Post in" },
            { key: "title", type: "text", label: "Title" },
            { key: "description", type: "textarea", label: "Text (optional)" },
            { key: "color", type: "color", label: "Color" },
            { key: "roles", type: "rows", label: "Buttons", addLabel: "Add button", start: 2, cols: [{ key: "role", type: "role" }, { key: "emoji", placeholder: "Emoji 📢", width: "90px" }, { key: "label", placeholder: "Label (optional)" }] },
          ],
          build: (v) => {
            if (!v.channel) throw new Error("Pick a channel.");
            const roles = v.roles.filter((r) => r.role);
            if (!roles.length) throw new Error("Add at least one role.");
            return { type: "create_role_panel", ...v, roles };
          },
          submit: "Post panel",
        }),
        formCard({
          title: "Make a role",
          values: { color: "#5865f2", hoist: false, mentionable: false },
          fields: [
            { key: "name", type: "text", label: "Name", placeholder: "🔥 Legend" },
            { key: "color", type: "color", label: "Color" },
            { key: "gradient_color", type: "text", label: "Gradient second color (needs boost level 2)", placeholder: "#ff7a1a" },
            { key: "hoist", type: "toggle", label: "Show separately in member list" },
            { key: "mentionable", type: "toggle", label: "Anyone can @ ping it" },
          ],
          build: (v) => {
            if (!v.name) throw new Error("Give it a name.");
            return { type: "create_role", ...v, gradient_color: v.gradient_color || undefined };
          },
          submit: "Create role",
        }),
      ),
    ];
  },

  // ------------------------------------------------------------- FUN
  fun() {
    const q = C().qotd || {};
    const gws = S().features?.giveaways || [];
    const gwList = gws.length ? h("div", { class: "list" }, gws.map((g) => h("div", { class: "item" },
      h("div", { class: "grow" },
        h("div", {}, h("strong", {}, `🎉 ${g.prize}`)),
        h("div", { class: "muted small" }, `#${g.channel || "?"} · ${g.entries} entries · ${g.ended ? `ended, ${g.winnerIds.length} winner(s)` : `ends ${new Date(g.endsAt).toLocaleString()}`}`)),
      g.ended
        ? h("button", { class: "btn small", type: "button", onclick: () => runAction({ type: "reroll_giveaway", id: g.id }).then(() => renderView()) }, "🔁 Reroll")
        : h("button", { class: "btn small", type: "button", onclick: () => runAction({ type: "end_giveaway", id: g.id }).then(() => renderView()) }, "⏹ End now")))) : h("div", { class: "faint small" }, "No giveaways yet.");
    return [
      ...pageHead("🎉 Fun", "Giveaways, polls and Question of the Day."),
      cards(
        formCard({
          title: "Start a giveaway",
          values: { winners: 1, amount: 1, unit: "days" },
          fields: [
            { key: "channel", type: "channel", label: "Channel" },
            { key: "prize", type: "text", label: "Prize", placeholder: "1000 Robux" },
            { key: "description", type: "textarea", label: "Details (optional)", rows: 2 },
            { key: "amount", type: "number", label: "Lasts", min: 1 },
            { key: "unit", type: "select", label: "Unit", options: [["minutes", "Minutes"], ["hours", "Hours"], ["days", "Days"]] },
            { key: "winners", type: "number", label: "Winners", min: 1, max: 20 },
          ],
          build: (v) => {
            if (!v.channel || !v.prize) throw new Error("Pick a channel and a prize.");
            const mult = { minutes: 1, hours: 60, days: 1440 }[v.unit] || 1;
            return { type: "start_giveaway", channel: v.channel, prize: v.prize, description: v.description, winners: v.winners, minutes: (v.amount || 1) * mult };
          },
          submit: "Start giveaway 🎉",
        }),
        card("🎁 Giveaways", gwList),
        formCard({
          title: "Make a poll", desc: "Uses Discord's own poll feature.",
          values: { hours: 24, multi: false },
          fields: [
            { key: "channel", type: "channel", label: "Channel" },
            { key: "question", type: "text", label: "Question", placeholder: "Best update idea?" },
            { key: "answers", type: "rows", label: "Answers", addLabel: "Add answer", start: 3, cols: [{ key: "text", placeholder: "Answer" }, { key: "emoji", placeholder: "Emoji", width: "90px" }] },
            { key: "hours", type: "number", label: "Lasts (hours)", min: 1, max: 768 },
            { key: "multi", type: "toggle", label: "Allow picking more than one" },
          ],
          build: (v) => {
            if (!v.channel || !v.question) throw new Error("Pick a channel and write a question.");
            return { type: "create_poll", ...v, answers: v.answers.filter((a) => a.text) };
          },
          submit: "Post poll 📊",
        }),
        formCard({
          title: "❓ Question of the Day", on: Boolean(q.enabled && q.channelId), badge: q.count ? `#${q.count} posted` : null,
          desc: "The AI writes a fresh question every day and opens a thread for answers.",
          values: { enabled: q.channelId ? q.enabled !== false : true, channel: q.channelId, time: q.time || "17:00", topic: q.topic, ping_role: q.pingRoleId },
          fields: [
            { key: "enabled", type: "toggle", label: "Post every day" },
            { key: "channel", type: "channel", label: "Channel" },
            { key: "time", type: "time", label: "Time (your phone's time)" },
            { key: "topic", type: "text", label: "Topic (optional)", placeholder: "gaming, Roblox, random fun" },
            { key: "ping_role", type: "role", label: "Ping role (optional)", none: "— no ping —" },
          ],
          build: (v) => ({ type: "setup_qotd", ...v, ping_role: v.ping_role || "none" }),
          extra: [{ label: "Post one now", action: { type: "post_qotd" } }],
        }),
      ),
    ];
  },

  // ------------------------------------------------------------- MOD
  mod() {
    const a = C().automod || {};
    const warns = h("div", { class: "list" }, h("div", { class: "faint small" }, "Loading…"));
    api(`/api/guilds/${state.guildId}/warnings`).then(({ rows }) => {
      warns.replaceChildren(...(rows.length ? rows.map((r) => h("div", { class: "item" },
        r.avatar ? h("img", { src: r.avatar, alt: "" }) : null,
        h("div", { class: "grow" }, h("div", {}, r.name), h("div", { class: "muted small" }, `Last: ${r.last?.reason || ""}`)),
        h("span", { class: "badge" }, `${r.count} warn${r.count === 1 ? "" : "s"}`),
        h("button", { class: "btn ghost small", type: "button", onclick: async () => { await api(`/api/guilds/${state.guildId}/warnings/clear`, { method: "POST", body: { userId: r.id } }); toast("Cleared"); renderView(); } }, "Clear"))) : [h("div", { class: "faint small" }, "Nobody has warnings. W server 🫡")]));
    }).catch((e) => warns.replaceChildren(h("div", { class: "faint small" }, e.message)));
    const anyOn = a.bad_words || a.slurs || a.sexual_content || a.block_invites || a.block_links || a.anti_spam || a.max_mentions > 0 || (a.block_words || []).length > 0;
    return [
      ...pageHead("🛡️ Moderation", "AutoMod runs on Discord's side, so it keeps working even when your phone is off."),
      cards(
        formCard({
          title: "AutoMod", on: Boolean(anyOn),
          values: { ...a, max_mentions: a.max_mentions || 0, timeout_minutes: a.timeout_minutes || 0 },
          fields: [
            { key: "bad_words", type: "toggle", label: "Block swearing" },
            { key: "slurs", type: "toggle", label: "Block slurs" },
            { key: "sexual_content", type: "toggle", label: "Block sexual words" },
            { key: "block_invites", type: "toggle", label: "Block other server invites" },
            { key: "block_links", type: "toggle", label: "Block ALL links" },
            { key: "anti_spam", type: "toggle", label: "Block spam" },
            { key: "max_mentions", type: "number", label: "Max pings per message (0 = off)", min: 0, max: 50 },
            { key: "block_words", type: "list", label: "Extra blocked words", placeholder: "word1, word2, *inside*" },
            { key: "timeout_minutes", type: "number", label: "Auto timeout (minutes, 0 = off)", min: 0 },
            { key: "alert_channel", type: "channel", label: "Send alerts to" },
            { key: "exempt_roles", type: "roles", label: "Roles AutoMod ignores" },
            { key: "custom_message", type: "text", label: "What they see when blocked", placeholder: "Watch it! AutoMod blocked that message." },
          ],
          build: (v) => ({ type: "setup_automod", ...v, alert_channel: v.alert_channel || undefined, custom_message: v.custom_message || undefined }),
          extra: [{ label: "Turn all off", style: "danger", action: { type: "disable_automod" } }],
        }),
        formCard({
          title: "📝 Mod log", on: Boolean(C().modLogChannelId), desc: "Bans, kicks, timeouts, warnings and purges get logged here.",
          values: { channel: C().modLogChannelId }, fields: [{ key: "channel", type: "channel", label: "Log channel" }],
          build: (v) => ({ type: "set_mod_log", channel: v.channel || "none" }),
        }),
        card("⚠️ Warnings", warns),
        card("⌨️ Staff commands in Discord",
          h("div", { class: "muted small" }, "Only people with the right permission can see these:"),
          h("div", { class: "row" }, ["/ban", "/unban", "/kick", "/timeout", "/untimeout", "/warn", "/warnings", "/clearwarns", "/purge", "/lock", "/unlock", "/slowmode"].map((c) => h("span", { class: "kbd" }, c))),
          h("div", { class: "muted small" }, "Everyone: "), h("div", { class: "row" }, ["/rank", "/leaderboard", "/help"].map((c) => h("span", { class: "kbd" }, c)))),
      ),
    ];
  },

  // ------------------------------------------------------------- BOT
  bot() {
    const st = C().bot || {};
    const ai = state.status?.ai || {};
    const mem = S().memory || [];
    return [
      ...pageHead("⚙️ Bot", "The bot's look, its brain and what it remembers about your server."),
      cards(
        formCard({
          title: "Status",
          values: { text: st.text ?? "Building servers 🛠️", activity: st.type || "custom", status: st.status || "online" },
          fields: [
            { key: "text", type: "text", label: "Status text" },
            { key: "activity", type: "select", label: "Type", options: [["custom", "Custom"], ["playing", "Playing"], ["watching", "Watching"], ["listening", "Listening to"], ["competing", "Competing in"]] },
            { key: "status", type: "select", label: "Dot", options: [["online", "🟢 Online"], ["idle", "🌙 Idle"], ["dnd", "⛔ Do not disturb"]] },
          ],
          build: (v) => ({ type: "set_bot_status", ...v }),
        }),
        formCard({
          title: "Bot pfp", desc: "Paste a direct image link. Discord only lets bots change pfp a couple times per hour.",
          fields: [{ key: "image_url", type: "text", label: "Image link", placeholder: "https://…png" }],
          build: (v) => {
            if (!/^https?:\/\//.test(v.image_url)) throw new Error("Paste an image link.");
            return { type: "set_bot_avatar", image_url: v.image_url };
          },
        }),
        card("🧠 AI brain",
          h("div", {}, `Main: `, h("strong", {}, ai.provider ? `${ai.provider} (${ai.model})` : "none")),
          h("div", {}, `Backups: `, h("strong", {}, ai.backups?.length ? ai.backups.join(", ") : "none")),
          h("div", {}, `Art: `, h("strong", {}, state.status?.art || "?")),
          ai.provider !== "gemini" ? h("div", { class: "note" }, "Tip: add a free GEMINI_API_KEY from aistudio.google.com/apikey to your .env for the smartest free brain. Your Groq key stays as the backup.") : null,
          aiTestBox()),
        card("💭 What I remember about this server",
          mem.length ? h("div", { class: "list" }, mem.map((n) => h("div", { class: "item" }, h("div", { class: "grow" }, n),
            h("button", { class: "btn ghost small", type: "button", onclick: async () => { await api(`/api/guilds/${state.guildId}/memory/remove`, { method: "POST", body: { note: n } }); state.server.memory = mem.filter((x) => x !== n); renderView(); } }, "✕")))) : h("div", { class: "faint small" }, "Nothing yet. I'll remember your style as we build."),
          mem.length ? h("button", { class: "btn ghost small", type: "button", style: "justify-self:start", onclick: async () => { await api(`/api/guilds/${state.guildId}/memory/clear`, { method: "POST" }); state.server.memory = []; renderView(); } }, "Forget everything") : null),
        card("🔗 Invite",
          state.status?.invite ? h("a", { class: "btn", href: state.status.invite, target: "_blank", rel: "noopener" }, "Add the bot to another server") : null,
          state.status?.botWarning ? h("div", { class: "warnbox" }, state.status.botWarning) : null),
      ),
    ];
  },
};

function aiTestBox() {
  const out = h("div", { class: "list" });
  const btn = h("button", { class: "btn", type: "button", style: "justify-self:start", onclick: async () => {
    btn.disabled = true;
    btn.textContent = "Testing… (up to a minute)";
    out.replaceChildren();
    try {
      const { results } = await api("/api/ai/test", { method: "POST" });
      out.replaceChildren(...(results.length ? results.map((r) => h("div", { class: "item" },
        h("span", {}, r.ok ? "✅" : "❌"),
        h("div", { class: "grow" }, h("div", {}, h("strong", {}, r.provider), ` · ${r.seconds.toFixed(1)}s`), h("div", { class: "muted small", style: "white-space:normal" }, r.ok ? "Working" : r.detail)))) : [h("div", { class: "warnbox" }, "No AI keys found in .env")]));
    } catch (err) { out.replaceChildren(h("div", { class: "warnbox" }, err.message)); }
    btn.disabled = false;
    btn.textContent = "🩺 Test the AI again";
  } }, "🩺 Test the AI");
  return h("div", { class: "rows" }, btn, out);
}

// =====================================================================
// art studio cards
// =====================================================================

const ART = {
  icon: { title: "🖼️ Server icon", ph: "a baby dragon in a mech suit, neon purple and green", apply: "Use as server icon", square: true },
  banner: { title: "🌆 Banner", ph: "a giant monster stomping a city at night, neon lights", apply: "Use as banner" },
  image: { title: "✨ Post an AI picture", ph: "a hype announcement image for our new update", apply: "Post it" },
};

function artCard(kind) {
  const cfg = ART[kind];
  const idea = h("textarea", { rows: 2, placeholder: cfg.ph });
  const chan = kind === "icon" ? null : channelSelect(null);
  const msg = kind === "image" ? h("input", { type: "text", placeholder: "Message with it (optional)" }) : null;
  const out = h("div", {});
  let token = null;
  const gen = h("button", { class: "btn primary", type: "button" }, "Generate ✨");
  const applyBtn = h("button", { class: "btn green hidden", type: "button" }, cfg.apply);
  gen.addEventListener("click", async () => {
    if (!idea.value.trim()) return toast("Describe it first", true);
    gen.disabled = true;
    applyBtn.classList.add("hidden");
    gen.textContent = "Generating… (up to a minute)";
    out.replaceChildren(h("div", { class: "typing" }, h("span"), h("span"), h("span")));
    try {
      const r = await api(`/api/guilds/${state.guildId}/art/preview`, { method: "POST", body: { kind, idea: idea.value } });
      token = r.token;
      out.replaceChildren(h("div", { class: `preview${cfg.square ? " square" : ""}` }, h("img", { src: r.image, alt: "" })),
        r.source !== "ai-image" ? h("div", { class: "faint small" }, "The image AI was busy so this is the backup art style. Try again for a real AI image.") : null);
      applyBtn.classList.remove("hidden");
    } catch (err) {
      out.replaceChildren(h("div", { class: "warnbox" }, err.message));
    } finally {
      gen.disabled = false;
      gen.textContent = token ? "Try again 🔁" : "Generate ✨";
    }
  });
  applyBtn.addEventListener("click", async () => {
    applyBtn.disabled = true;
    try {
      const r = await api(`/api/guilds/${state.guildId}/art/apply`, { method: "POST", body: { token, channel: chan?.value || null, message: msg?.value || "" } });
      toast(`✅ ${r.message}`);
      if (r.server) setServer(r.server);
      applyBtn.classList.add("hidden");
    } catch (err) { toast(err.message, true); } finally { applyBtn.disabled = false; }
  });
  return h("div", { class: "card" }, h("h3", {}, cfg.title),
    h("div", { class: "field" }, h("label", {}, "Describe it"), idea),
    chan ? h("div", { class: "field" }, h("label", {}, kind === "banner" ? (S().canBanner ? "Post in a channel instead (optional)" : "Post it in (your server needs boost level 2 for a real banner)") : "Post in"), chan) : null,
    msg ? h("div", { class: "field" }, msg) : null,
    out, h("div", { class: "actions" }, gen, applyBtn));
}

function emojiStudio() {
  const [rowsEl, getRows] = field({ key: "emojis", type: "rows", label: "Emojis", addLabel: "Add emoji", start: 3, cols: [{ key: "name", placeholder: "name (fire_egg)", width: "140px" }, { key: "idea", placeholder: "what it shows" }] }, []);
  const grid = h("div", { class: "emoji-grid" });
  const made = [];
  const addBtn = h("button", { class: "btn green hidden", type: "button" }, "Add selected");
  const gen = h("button", { class: "btn primary", type: "button" }, "Generate emojis ✨");
  const refreshAdd = () => {
    const n = made.filter((m) => m.on && m.token).length;
    addBtn.textContent = `Add ${n} to server`;
    addBtn.classList.toggle("hidden", n === 0);
  };
  gen.addEventListener("click", async () => {
    const list = getRows().filter((r) => r.idea || r.name).slice(0, 10);
    if (!list.length) return toast("Add at least one emoji idea", true);
    gen.disabled = true;
    made.length = 0;
    grid.replaceChildren();
    for (const e of list) {
      const m = { name: e.name || e.idea, idea: e.idea || e.name, on: true, token: null };
      made.push(m);
      m.el = h("div", { class: "emoji-cell on" }, h("div", { class: "typing" }, h("span"), h("span"), h("span")), h("div", {}, m.name));
      grid.append(m.el);
    }
    for (const m of made) {
      try {
        const r = await api(`/api/guilds/${state.guildId}/art/preview`, { method: "POST", body: { kind: "emoji", idea: m.idea } });
        m.token = r.token;
        const cell = h("div", { class: "emoji-cell on", onclick: () => { m.on = !m.on; cell.classList.toggle("on", m.on); refreshAdd(); } }, h("img", { src: r.image, alt: "" }), h("div", {}, `:${m.name}:`));
        m.el.replaceWith(cell);
        m.el = cell;
      } catch (err) {
        const cell = h("div", { class: "emoji-cell" }, "❌", h("div", { class: "small" }, err.message.slice(0, 60)));
        m.el.replaceWith(cell);
        m.el = cell;
      }
      refreshAdd();
    }
    gen.disabled = false;
  });
  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    let ok = 0;
    for (const m of made.filter((x) => x.on && x.token)) {
      try {
        await api(`/api/guilds/${state.guildId}/art/apply`, { method: "POST", body: { token: m.token, name: m.name } });
        m.token = null;
        m.el.style.opacity = ".4";
        ok++;
      } catch (err) { toast(err.message, true); }
    }
    addBtn.disabled = false;
    refreshAdd();
    if (ok) { toast(`✅ Added ${ok} emoji${ok === 1 ? "" : "s"}`); refreshServer(); }
  });
  return h("div", { class: "card" }, h("h3", {}, "😎 Custom emojis", h("span", { class: "badge" }, `${S().emojiSlotsLeft} slots left`)),
    h("p", { class: "desc" }, "Give each one a name and say what it shows. Tap a preview to skip it."),
    rowsEl, grid, h("div", { class: "actions" }, gen, addBtn));
}

// =====================================================================
// start
// =====================================================================

if (state.key) boot().catch(() => showLogin());
else showLogin();
