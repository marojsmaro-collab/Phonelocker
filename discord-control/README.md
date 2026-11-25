# Server Builder

An AI Discord bot you control from a website. Tell it what you want in normal words and it builds it live:
whole servers, channels, roles, colors, AI made emojis, server icons, banners, welcome cards and more.
Every feature also has its own dashboard page with switches, so you never need commands.

## What it can do

**🤖 AI Builder**
- Builds entire servers from one message: categories, channels, roles with colors and permissions, rules, welcome posts
- Asks you quick questions with tap-to-answer buttons before big builds, so it builds exactly your vibe
- Live progress while it builds, fixes its own mistakes, and an **Undo** button that deletes everything a build made
- Remembers your style (colors, naming) for next time
- Uses the strongest free AI it can (Gemini) and switches to a backup (Groq) if one is busy

**🎨 AI Art Studio**
- Custom emojis with transparent backgrounds, server icons, banners and pictures, made by AI
- Preview first, then tap to use it

**Everything else (each has a dashboard page)**
- 👋 Welcome cards with the new member's pfp, goodbye messages, autoroles
- ⭐ Leveling with rank cards, level up messages, reward roles, leaderboard
- 🎫 Tickets with private channels and transcripts
- 🎭 Self role buttons and quick role making (gradient colors on boosted servers)
- 🎉 Giveaways with an Enter button, Discord polls, and a daily AI **Question of the Day** with a thread for answers
- 🛡️ AutoMod (works even when the bot is offline), mod log, warnings list, and staff slash commands
  (`/ban` `/kick` `/timeout` `/warn` `/purge` `/lock` and more). Everyone gets `/rank` `/leaderboard` `/help`
- ⚙️ Bot status, pfp and banner

## 1. Reset your bot token first

If your token was ever pasted anywhere (chat, Discord, GitHub), reset it:
[Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → **Reset Token**.
Only put the new token in `.env`. Never commit it.

### Turn on the two intents

[Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → scroll to
**Privileged Gateway Intents** → turn on **Server Members Intent** (welcomes, autoroles) and **Message Content Intent**
(full ticket transcripts) → **Save Changes** → restart the bot.

Everything else works without them. The website shows a yellow warning while one is off.

## 2. Get free AI keys (more is better)

| Provider | Cost | Where | Role |
| --- | --- | --- | --- |
| Google Gemini | Free tier | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key** | Main brain (smartest free) |
| Groq | Free tier | [console.groq.com/keys](https://console.groq.com/keys) → **Create API Key** | Fast backup |
| Anthropic Claude | Paid | [platform.claude.com](https://platform.claude.com) | Optional |

Put every key you have in `.env`. If one hits its free limit the bot switches to the next one by itself.
AI images use Pollinations, which works without a key. A free key from [enter.pollinations.ai](https://enter.pollinations.ai)
(`POLLINATIONS_KEY`) makes it faster. If the image AI is down, the bot designs the art itself as a backup.

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

`src/art.js` makes AI art (Pollinations images, background removal for emojis, and an SVG backup rendered with
resvg-wasm). `src/fun.js` has giveaways, polls and Question of the Day with a scheduler.
`src/server.js` runs the website and API, including build jobs with live progress and undo. `src/ai.js` sends your message plus the current server layout to the AI,
which answers with a plan (a list of actions). `src/discord.js` runs those actions with discord.js.
`src/features.js` has the welcome, AutoMod and mod command logic, `src/extras.js` has tickets, self roles, leveling
and the bot's profile, `src/card.js` draws welcome and rank cards in pure JavaScript (so it works on Termux too), and
settings are saved in `data/config.json`.

If a free AI tier hits its limit, the bot waits a moment and retries, then tries a lighter model from the same provider.
