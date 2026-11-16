// Welcome card images in pure JavaScript, so it runs anywhere Node runs (PC, servers, Termux on Android).
import * as PImage from "pureimage";
import { createRequire } from "node:module";
import { PassThrough, Writable } from "node:stream";

const require = createRequire(import.meta.url);
const FONT = "CardFont";
let fontReady = null;

function loadFont() {
  fontReady ??= (async () => {
    const file = require.resolve("@expo-google-fonts/luckiest-guy/400Regular/LuckiestGuy_400Regular.ttf");
    await PImage.registerFont(file, FONT).loadPromise();
  })();
  return fontReady;
}

const W = 1024;
const H = 450;

async function fetchBitmap(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null;
    const stream = new PassThrough();
    stream.end(buf);
    if (buf[0] === 0x89 && buf[1] === 0x50) return await PImage.decodePNGFromStream(stream);
    if (buf[0] === 0xff && buf[1] === 0xd8) return await PImage.decodeJPEGFromStream(stream);
    return null; // webp, gif and others are not supported
  } catch {
    return null;
  }
}

function encode(img) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const out = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    PImage.encodePNGToStream(img, out).then(() => resolve(Buffer.concat(chunks)), reject);
  });
}

function hex(c, fallback) {
  const s = String(c || "").trim();
  return /^#?[0-9a-f]{6}$/i.test(s) ? (s.startsWith("#") ? s : `#${s}`) : fallback;
}

function shade(color, amount) {
  const n = parseInt(color.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + (amount < 0 ? v : 255 - v) * amount)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// The card font only has basic Latin letters.
const clean = (s) => String(s ?? "").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();

function fitText(ctx, text, maxWidth, size, min = 20) {
  let s = size;
  do {
    ctx.font = `${s}pt ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 2;
  } while (s > min);
  return s;
}

function shadowText(ctx, text, x, y, color) {
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillText(text, x + 4, y + 5);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/**
 * Returns a PNG Buffer.
 * opts: { avatarUrl, name, title, subtitle, color, backgroundUrl }
 */
export async function renderWelcomeCard(opts = {}) {
  await loadFont();
  const color = hex(opts.color, "#7c3aed");
  const img = PImage.make(W, H);
  const ctx = img.getContext("2d");
  ctx.imageSmoothingEnabled = true;

  // Background
  const bg = await fetchBitmap(opts.backgroundUrl);
  if (bg) {
    const scale = Math.max(W / bg.width, H / bg.height);
    const bw = bg.width * scale, bh = bg.height * scale;
    ctx.drawImage(bg, 0, 0, bg.width, bg.height, (W - bw) / 2, (H - bh) / 2, bw, bh);
    ctx.fillStyle = "rgba(10,5,25,0.55)";
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, shade(color, -0.65));
    g.addColorStop(0.55, shade(color, -0.25));
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // soft bubbles
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    for (const [x, y, r] of [[90, 80, 120], [930, 380, 160], [860, 60, 60], [150, 400, 70]]) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Avatar ring
  const cx = W / 2, cy = 160, r = 108;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();

  const avatar = await fetchBitmap(opts.avatarUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, 0, 0, avatar.width, avatar.height, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = shade(color, -0.3);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = "#ffffff";
    ctx.font = `90pt ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText((clean(opts.name)[0] || "?").toUpperCase(), cx, cy + 45);
  }
  ctx.restore();

  // Text
  ctx.textAlign = "center";
  const title = clean(opts.title || "WELCOME").toUpperCase() || "WELCOME";
  fitText(ctx, title, W - 120, 46);
  shadowText(ctx, title, cx, 345, "#ffffff");

  const name = clean(opts.name) || "new member";
  fitText(ctx, name, W - 160, 30);
  shadowText(ctx, name, cx, 395, shade(color, 0.7));

  if (opts.subtitle) {
    const sub = clean(opts.subtitle);
    fitText(ctx, sub, W - 200, 17, 12);
    shadowText(ctx, sub, cx, 432, "rgba(255,255,255,0.85)");
  }

  return encode(img);
}

/**
 * Rank card for /rank. Returns a PNG Buffer.
 * opts: { avatarUrl, name, level, rank, xp, need, color }
 */
export async function renderRankCard(opts = {}) {
  await loadFont();
  const RW = 934, RH = 282;
  const color = hex(opts.color, "#5865f2");
  const img = PImage.make(RW, RH);
  const ctx = img.getContext("2d");

  const g = ctx.createLinearGradient(0, 0, RW, RH);
  g.addColorStop(0, "#14082b");
  g.addColorStop(1, shade(color, -0.45));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, RW, RH);
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.beginPath();
  ctx.arc(860, 40, 120, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();

  // avatar
  const cx = 141, cy = 141, r = 92;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  const avatar = await fetchBitmap(opts.avatarUrl);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, 0, 0, avatar.width, avatar.height, cx - r, cy - r, r * 2, r * 2);
  else {
    ctx.fillStyle = shade(color, -0.3);
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();

  const level = Number(opts.level) || 0;
  const xp = Math.max(0, Number(opts.xp) || 0);
  const need = Math.max(1, Number(opts.need) || 100);

  // name
  ctx.textAlign = "left";
  const name = clean(opts.name) || "someone";
  fitText(ctx, name, 380, 26, 14);
  shadowText(ctx, name, 270, 150, "#ffffff");

  // rank + level (top right)
  ctx.textAlign = "right";
  ctx.font = `30pt ${FONT}`;
  shadowText(ctx, `LVL ${level}`, 890, 80, shade(color, 0.6));
  ctx.font = `18pt ${FONT}`;
  shadowText(ctx, `RANK #${opts.rank ?? "?"}`, 890, 118, "rgba(255,255,255,0.85)");

  // xp text
  ctx.font = `15pt ${FONT}`;
  shadowText(ctx, `${xp} / ${need} XP`, 890, 166, "rgba(255,255,255,0.85)");

  // progress bar
  const bx = 270, by = 190, bw = 620, bh = 36, br = bh / 2;
  const bar = (w, fill) => {
    if (w <= 0) return;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(bx + br, by + br, br, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    if (w > bh) {
      ctx.fillRect(bx + br, by, w - bh, bh);
      ctx.beginPath();
      ctx.arc(bx + w - br, by + br, br, 0, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    }
  };
  bar(bw, "rgba(255,255,255,0.15)");
  bar(Math.max(bh, Math.round((bw * Math.min(xp, need)) / need)), shade(color, 0.25));

  return encode(img);
}
