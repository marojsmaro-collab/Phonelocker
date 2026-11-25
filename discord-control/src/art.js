// AI art: server icons, banners, custom emojis and images.
// 1st choice: a real AI image (Pollinations, free). Backup: the AI designs an SVG that we render ourselves.
import * as PImage from "pureimage";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { completeText } from "./ai.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- SVG rendering (pure WASM, works on Termux)

let resvgReady = null;
function loadResvg() {
  resvgReady ??= (async () => {
    const mod = await import("@resvg/resvg-wasm");
    const dir = path.dirname(require.resolve("@resvg/resvg-wasm"));
    await mod.initWasm(fs.readFileSync(path.join(dir, "index_bg.wasm")));
    const font = new Uint8Array(
      fs.readFileSync(require.resolve("@expo-google-fonts/luckiest-guy/400Regular/LuckiestGuy_400Regular.ttf"))
    );
    return { Resvg: mod.Resvg, font };
  })();
  return resvgReady;
}

export async function svgToPng(svg, width) {
  const { Resvg, font } = await loadResvg();
  const family = "Luckiest Guy";
  const r = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      fontBuffers: [font],
      defaultFontFamily: family,
      sansSerifFamily: family,
      serifFamily: family,
      cursiveFamily: family,
      fantasyFamily: family,
      monospaceFamily: family,
    },
  });
  const img = r.render();
  const png = Buffer.from(img.asPng());
  img.free();
  r.free();
  return png;
}

function cleanSvg(text) {
  const m = String(text || "").match(/<svg[\s\S]*<\/svg>/i);
  if (!m) return null;
  return m[0]
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/(xlink:)?href\s*=\s*"(https?:|file:)[^"]*"/gi, "");
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------------------------------------------------------------- bitmap helpers

async function decode(buf) {
  if (!buf || buf.length < 8) return null;
  const s = new PassThrough();
  s.end(buf);
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return await PImage.decodePNGFromStream(s);
    if (buf[0] === 0xff && buf[1] === 0xd8) return await PImage.decodeJPEGFromStream(s);
  } catch {
    return null;
  }
  return null;
}

function encodePng(bmp) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const out = new Writable({
      write(c, _e, cb) {
        chunks.push(c);
        cb();
      },
    });
    PImage.encodePNGToStream(bmp, out).then(() => resolve(Buffer.concat(chunks)), reject);
  });
}

/** Make the flat background around a sticker transparent (flood fill from the edges). */
function removeBackground(bmp) {
  const { width: w, height: h, data } = bmp;
  const px = (x, y) => (y * w + x) * 4;
  // Background reference = average of the 4 corners
  let br = 0, bg = 0, bb = 0;
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    const i = px(x, y);
    br += data[i]; bg += data[i + 1]; bb += data[i + 2];
  }
  br /= 4; bg /= 4; bb /= 4;
  const near = (i, tol) => Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) < tol;

  const seen = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, 0, x, h - 1);
  for (let y = 0; y < h; y++) stack.push(0, y, w - 1, y);
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const k = y * w + x;
    if (seen[k]) continue;
    seen[k] = 1;
    const i = k * 4;
    if (!near(i, 70)) continue;
    data[i + 3] = 0;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
  // Soften the edge: pixels touching the removed area that are close to the background go half see-through
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = px(x, y);
      if (data[i + 3] === 0) continue;
      const touches = data[px(x + 1, y) + 3] === 0 || data[px(x - 1, y) + 3] === 0 || data[px(x, y + 1) + 3] === 0 || data[px(x, y - 1) + 3] === 0;
      if (touches && near(i, 160)) data[i + 3] = 120;
    }
  }
  return bmp;
}

/** Crop to what's visible, square it, then shrink with proper averaging. */
function cropSquareResize(bmp, size, pad = 0.06) {
  const { width: w, height: h, data } = bmp;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 20) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { minX = 0; minY = 0; maxX = w - 1; maxY = h - 1; }
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const full = Math.round(side * (1 + pad * 2));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const x0 = cx - full / 2, y0 = cy - full / 2;

  const out = PImage.make(size, size);
  const o = out.data;
  const scale = full / size;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const sx0 = Math.floor(x0 + tx * scale), sx1 = Math.max(sx0 + 1, Math.floor(x0 + (tx + 1) * scale));
      const sy0 = Math.floor(y0 + ty * scale), sy1 = Math.max(sy0 + 1, Math.floor(y0 + (ty + 1) * scale));
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          n++;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          const i = (sy * w + sx) * 4;
          const al = data[i + 3];
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al;
        }
      }
      const j = (ty * size + tx) * 4;
      if (a > 0) {
        o[j] = Math.round(r / a); o[j + 1] = Math.round(g / a); o[j + 2] = Math.round(b / a);
        o[j + 3] = Math.round(a / n);
      } else {
        o[j + 3] = 0;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- AI image (Pollinations)

async function aiImage(prompt, width, height) {
  const seed = crypto.randomInt(1, 2_000_000_000);
  const q = `width=${width}&height=${height}&nologo=true&private=true&seed=${seed}&model=flux`;
  const key = process.env.POLLINATIONS_KEY;
  const tries = [];
  if (key) tries.push({ url: `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${q}`, headers: { authorization: `Bearer ${key}` } });
  tries.push({ url: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`, headers: {} });
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: t.headers, signal: AbortSignal.timeout(90_000) });
      if (!res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 3000) return buf;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// ---------------------------------------------------------------- AI designed SVG (backup)

const SVG_RULES = `Output ONLY one complete <svg> element, nothing else. Rules:
- xmlns="http://www.w3.org/2000/svg" and the exact viewBox given.
- Use simple bold shapes: circles, rects, paths, polygons, gradients. Thick dark outlines look great.
- No <image>, no external links, no scripts, no filters except feGaussianBlur.
- Any text uses font-family="Luckiest Guy" and must stay short.`;

async function aiSvg(kind, idea, w, h, extra = "") {
  const brief = {
    emoji: `A Discord custom emoji (sticker style, centered, fills most of the canvas) of: ${idea}. TRANSPARENT background (no background rect). Very simple, readable at 32px.`,
    icon: `A Discord server icon for: ${idea}. Full colorful background, one bold centered emblem, readable when small. ${extra}`,
    banner: `A wide Discord server banner for: ${idea}. Full background with gradients and shapes, ${extra}`,
    image: `An illustration for: ${idea}. Full background. ${extra}`,
  }[kind];
  try {
    const text = await completeText({
      system: `You are a top vector artist. ${SVG_RULES}`,
      user: `${brief}\nviewBox="0 0 ${w} ${h}" width="${w}" height="${h}".`,
      maxTokens: 6000,
    });
    const svg = cleanSvg(text);
    if (svg) {
      const png = await svgToPng(svg, w);
      if (png.length > 500) return png;
    }
  } catch {
    /* fall through to the template */
  }
  return null;
}

function templateSvg(kind, idea, w, h, title) {
  const hue = [...String(idea)].reduce((a, c) => (a + c.charCodeAt(0) * 7) % 360, 0);
  const c1 = `hsl(${hue},80%,55%)`, c2 = `hsl(${(hue + 50) % 360},85%,40%)`;
  const label = esc(String(title || idea).slice(0, kind === "emoji" ? 2 : 28).toUpperCase());
  if (kind === "emoji") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <circle cx="64" cy="64" r="58" fill="url(#g)" stroke="#1a0b2e" stroke-width="8"/>
      <text x="64" y="84" font-size="56" text-anchor="middle" fill="#fff" stroke="#1a0b2e" stroke-width="3" font-family="Luckiest Guy">${label}</text></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c2}"/><stop offset="1" stop-color="${c1}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.85}" cy="${h * 0.2}" r="${h * 0.35}" fill="#ffffff" opacity="0.08"/>
    <circle cx="${w * 0.1}" cy="${h * 0.9}" r="${h * 0.4}" fill="#000000" opacity="0.12"/>
    <text x="${w / 2}" y="${h / 2 + h * 0.06}" font-size="${Math.round(Math.min(w / Math.max(6, label.length) * 1.4, h * 0.22))}" text-anchor="middle" fill="#fff" stroke="#1a0b2e" stroke-width="${Math.max(2, h / 120)}" font-family="Luckiest Guy">${label}</text></svg>`;
}

// ---------------------------------------------------------------- public API

/** Returns { buffer (PNG 128x128, transparent), source } */
export async function makeEmoji(idea) {
  const prompt = `${idea}, one cute die-cut sticker emoji, thick dark outline, vibrant saturated colors, centered, simple shapes, flat cartoon game icon style, isolated on a plain pure white background, no text, no shadow`;
  const img = await aiImage(prompt, 512, 512);
  const bmp = img && (await decode(img));
  if (bmp) return { buffer: await encodePng(cropSquareResize(removeBackground(bmp), 128)), source: "ai-image" };
  const svgPng = await aiSvg("emoji", idea, 128, 128);
  if (svgPng) return { buffer: svgPng, source: "ai-svg" };
  return { buffer: await svgToPng(templateSvg("emoji", idea, 128, 128), 128), source: "template" };
}

/** Square server icon. */
export async function makeIcon(idea, title) {
  const prompt = `${idea}, Discord server icon, one bold centered emblem or mascot, vibrant colors, clean background, high detail, game art style, no text`;
  const img = await aiImage(prompt, 1024, 1024);
  if (img && (await decode(img))) return { buffer: img, source: "ai-image" };
  const svgPng = await aiSvg("icon", idea, 512, 512, title ? `The server is called "${title}".` : "");
  if (svgPng) return { buffer: svgPng, source: "ai-svg" };
  return { buffer: await svgToPng(templateSvg("icon", idea, 512, 512, title), 512), source: "template" };
}

/** 16:9 banner. */
export async function makeBanner(idea, title) {
  const prompt = `${idea}, wide cinematic Discord server banner artwork, vibrant colors, dramatic lighting, detailed background, no text, no words`;
  const img = await aiImage(prompt, 1280, 720);
  if (img && (await decode(img))) return { buffer: img, source: "ai-image" };
  const svgPng = await aiSvg("banner", idea, 960, 540, title ? `Show the server name "${title}" big in the middle.` : "");
  if (svgPng) return { buffer: svgPng, source: "ai-svg" };
  return { buffer: await svgToPng(templateSvg("banner", idea, 960, 540, title), 960), source: "template" };
}

/** Any picture to post in a channel. */
export async function makeImage(idea, wide = true) {
  const [w, h] = wide ? [1280, 720] : [1024, 1024];
  const img = await aiImage(`${idea}, high quality digital art, vibrant`, w, h);
  if (img && (await decode(img))) return { buffer: img, source: "ai-image" };
  const svgPng = await aiSvg("image", idea, wide ? 960 : 640, wide ? 540 : 640);
  if (svgPng) return { buffer: svgPng, source: "ai-svg" };
  return { buffer: await svgToPng(templateSvg("image", idea, 960, 540), 960), source: "template" };
}

export const imageExt = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : "png");

// exported for tests
export const _internal = { removeBackground, cropSquareResize, decode, encodePng, cleanSvg, templateSvg };
