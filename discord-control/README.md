# Discord Bot Builder

A website where you chat with your Discord bot and it builds your server for you.
Type things like "make a general channel with emojis" or "set up a full gaming server" and it makes the
categories, channels, roles, permissions, messages and emojis live.

## What it can do

- Create, rename, move and delete channels (text, voice, announcement, forum, stage)
- Create and delete categories, including private ones
- Create, edit and delete roles with colors and permissions
- Set channel permissions per role (private staff channels and so on)
- Add custom emojis from an image link, delete emojis
- Send messages and embeds (welcome, rules)
- Rename the server and change its icon
- **Welcome cards**: posts a welcome image with the new member's pfp, plus goodbye messages and autoroles
- **AutoMod**: sets up Discord's own AutoMod (bad words, slurs, links, invites, spam, mention spam, auto timeouts).
  It runs on Discord's side so it keeps working even when the bot is offline
- **Mod log**: logs mod actions and AutoMod alerts to a channel
- **Tickets**: a panel with an "Open a ticket" button that makes a private channel for the member and staff,
  with a Close button that saves a transcript to a log channel
- **Self roles**: a panel of buttons people tap to get or remove roles (pings, games, colors)
- **Leveling**: XP for chatting, level up messages, reward roles, `/rank` cards and `/leaderboard`
- **Bot profile**: sets its own pfp from `assets/bot-avatar.png` and a custom status you can change by chatting
- **Mod commands** inside Discord (only staff can see them): `/ban` `/unban` `/kick` `/timeout` `/untimeout`
  `/warn` `/warnings` `/clearwarns` `/purge` `/lock` `/unlock` `/slowmode`. Everyone gets `/rank` `/leaderboard` `/help`
- Shows the live server layout and which bot features are on next to the chat
- Asks you to confirm before deleting anything

Try: "set up auto moderation", "welcome new people with a pfp card", "make a ticket system for support",
"turn on leveling with role rewards", "make a self roles panel for pings".

## 1. Reset your bot token first

If your token was ever pasted anywhere (chat, Discord, GitHub), reset it:
[Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → **Reset Token**.
Only put the new token in `.env`. Never commit it.

### Turn on the two intents

[Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → scroll to
**Privileged Gateway Intents** → turn on **Server Members Intent** (welcomes, autoroles) and **Message Content Intent**
(full ticket transcripts) → **Save Changes** → restart the bot.

Everything else works without them. The website shows a yellow warning while one is off.

## 2. Get a free AI key (pick one)

| Provider | Cost | Where |
| --- | --- | --- |
| Google Gemini | Free tier | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → sign in with Google → **Create API key** |
| Groq | Free tier | [console.groq.com/keys](https://console.groq.com/keys) → sign up → **Create API Key** |
| Anthropic Claude | Paid (best at big builds) | [platform.claude.com](https://platform.claude.com) |

Free tiers have daily and per-minute limits. If you hit one, wait a bit or switch to the other free provider.

## 3. Run it

Needs [Node.js](https://nodejs.org) 18.17 or newer.

```bash
cd discord-control
npm install
cp .env.example .env     # then open .env and fill it in
npm start
```

Open http://localhost:3000 and log in with your `DASHBOARD_PASSWORD`.

The terminal prints an invite link. Open it to add the bot to your server (it asks for Administrator so it can
build anything). Then hit ↻ on the site.

## Run it on Android (Termux)

Install Termux from [F-Droid](https://f-droid.org/packages/com.termux), open it, and paste:

```bash
pkg update -y && pkg install -y nodejs unzip
cd ~ && curl -L -o bot.zip https://github.com/marojsmaro-collab/Phonelocker/archive/refs/heads/claude/discord-bot-control-site-u87a9o.zip && unzip -o bot.zip && cp -r Phonelocker-*/discord-control ~/ && cd ~/discord-control && cp -n .env.example .env
```

Fill in `~/discord-control/.env` (for example with `nano .env`), then `npm install && npm start`.
Open `localhost:3000` in Chrome. Pull down the Termux notification and tap **Acquire wakelock** so Android doesn't kill it.

**Update to the newest version** (keeps your `.env` and settings):

```bash
cd ~ && rm -rf Phonelocker-* bot.zip && curl -L -o bot.zip https://github.com/marojsmaro-collab/Phonelocker/archive/refs/heads/claude/discord-bot-control-site-u87a9o.zip && unzip -o bot.zip && cp -r Phonelocker-*/discord-control ~/ && cd ~/discord-control && npm install && npm start
```

## 4. Host it for free (optional)

Any host that runs a Node app works. Set the same variables from `.env` in the host's settings instead of
uploading the `.env` file.

- **Render**: New Web Service → this repo → Root Directory `discord-control` → Build `npm install` → Start `npm start`.
  The free plan sleeps when nobody visits, so the bot goes offline until you open the site again.
- **Your own PC**: just leave `npm start` running.

## Settings (`.env`)

| Name | What it does |
| --- | --- |
| `DISCORD_TOKEN` | Your bot token |
| `DASHBOARD_PASSWORD` | Password for the website (6+ characters) |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | The AI key. The first one set is used |
| `AI_PROVIDER` | Force `gemini`, `groq` or `anthropic` |
| `GEMINI_MODEL` | Default `gemini-flash-latest` |
| `GROQ_MODEL` | Default `openai/gpt-oss-120b` |
| `ANTHROPIC_MODEL` | Default `claude-opus-5-5` |
| `PORT` | Default `3000` |

## Notes

- Announcement, forum and stage channels only work if the server has **Community** turned on.
- Custom emojis need a direct image link (png, jpg or gif, under 256 KB). The AI can't draw images, so without a
  link it uses emoji characters in channel names instead.
- The bot can only edit roles that are below its own role. Drag the bot's role to the top in Server Settings → Roles.

## How it works

`src/server.js` runs the website and API. `src/ai.js` sends your message plus the current server layout to the AI,
which answers with a plan (a list of actions). `src/discord.js` runs those actions with discord.js.
`src/features.js` has the welcome, AutoMod and mod command logic, `src/extras.js` has tickets, self roles, leveling
and the bot's profile, `src/card.js` draws welcome and rank cards in pure JavaScript (so it works on Termux too), and
settings are saved in `data/config.json`.

If a free AI tier hits its limit, the bot waits a moment and retries, then tries a lighter model from the same provider.
