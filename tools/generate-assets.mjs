// Generates the bundled, original assets for FakeCall.
//   node tools/generate-assets.mjs
// Ringtones are synthesised from scratch (no third-party audio).
// Icons are rendered from assets/icons/icon.svg with sharp or Playwright.
// The keep-awake clip is a tiny black, silent video made with ffmpeg (optional).
// The Vercel build runs this script, so the binary assets never need uploading.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SR = 32000; // sample rate, Hz

/** Encode mono float samples (-1..1) as a 16-bit PCM WAV file. */
function encodeWav(samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); // fmt chunk size
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 2, 28); // byte rate
  data.writeUInt16LE(2, 32); // block align
  data.writeUInt16LE(16, 34); // bits per sample
  data.write("data", 36);
  data.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2);
  });
  return data;
}

/** Scale so the loudest sample sits at `peak`. */
function normalise(samples, peak = 0.85) {
  const max = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0) || 1;
  return samples.map((s) => (s / max) * peak);
}

const buffer = (seconds) => new Float64Array(Math.round(seconds * SR));
const TAU = Math.PI * 2;

/** Add one note into `out`, starting at `at` seconds. `voice(t)` returns a sample. */
function addNote(out, at, length, voice) {
  const start = Math.round(at * SR);
  const count = Math.round(length * SR);
  for (let i = 0; i < count && start + i < out.length; i++) {
    out[start + i] += voice(i / SR);
  }
}

// 1. Chime: a mallet-style rising and falling figure, played twice, then a rest.
function chime() {
  const out = buffer(3.2);
  const mallet = (f) => (t) => {
    const attack = Math.min(1, t / 0.004);
    return attack * (Math.sin(TAU * f * t) * Math.exp(-t * 7) + 0.35 * Math.sin(TAU * f * 4 * t) * Math.exp(-t * 22));
  };
  const figure = [587.33, 739.99, 880.0, 1174.66, 880.0, 739.99]; // D5 F#5 A5 D6 A5 F#5
  const steps = [0, 0.14, 0.28, 0.42, 0.7, 0.84];
  for (const offset of [0, 1.2]) {
    figure.forEach((f, i) => addNote(out, offset + steps[i], 0.9, mallet(f)));
  }
  return normalise(Array.from(out));
}

// 2. Classic bell: two trilled bursts ("ring-ring"), then a rest.
function bell() {
  const out = buffer(3.0);
  const partials = [1380, 1720, 2110, 2790];
  const burst = (length) => (t) => {
    const edge = Math.min(1, t / 0.01, (length - t) / 0.03);
    const trill = 0.55 + 0.45 * Math.sin(TAU * 24 * t);
    const tone = partials.reduce((sum, f, i) => sum + Math.sin(TAU * f * t) / (i + 1), 0);
    return Math.max(0, edge) * trill * tone;
  };
  addNote(out, 0, 0.42, burst(0.42));
  addNote(out, 0.6, 0.42, burst(0.42));
  return normalise(Array.from(out), 0.7);
}

// 3. Pulse: soft two-tone digital beeps in two groups, then a rest.
function pulse() {
  const out = buffer(2.6);
  const beep = (f, length) => (t) => {
    const edge = Math.min(1, t / 0.012, (length - t) / 0.02);
    return Math.max(0, edge) * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * f * 2 * t));
  };
  const tones = [987.77, 1318.51, 987.77, 1318.51]; // B5 E6 B5 E6
  for (const offset of [0, 0.75]) {
    tones.forEach((f, i) => addNote(out, offset + i * 0.14, 0.1, beep(f, 0.1)));
  }
  return normalise(Array.from(out), 0.75);
}

mkdirSync(join(ROOT, "assets/ringtones"), { recursive: true });
for (const [name, make] of Object.entries({ chime, bell, pulse })) {
  writeFileSync(join(ROOT, `assets/ringtones/${name}.wav`), encodeWav(make()));
  console.log(`ringtone  assets/ringtones/${name}.wav`);
}

// Icons: rasterise the SVG at the sizes iOS and the manifest ask for.
// Uses sharp when installed (the Vercel build), otherwise Playwright.
const require = createRequire(import.meta.url);
const ICONS = [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]];
const svg = readFileSync(join(ROOT, "assets/icons/icon.svg"));

async function iconsWithSharp() {
  const sharp = require("sharp");
  for (const [file, size] of ICONS) {
    await sharp(svg, { density: 300 }).resize(size, size).png().toFile(join(ROOT, "assets/icons", file));
  }
}

async function iconsWithPlaywright() {
  // require() honours NODE_PATH: NODE_PATH=$(npm root -g) node tools/generate-assets.mjs
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  for (const [file, size] of ICONS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(ROOT, "assets/icons", file) });
    await page.close();
  }
  await browser.close();
}

try {
  await iconsWithSharp().catch(iconsWithPlaywright);
  console.log("icons     assets/icons/*.png");
} catch (error) {
  console.warn("Skipped icons (neither sharp nor Playwright available):", error.message);
}

// Keep-awake clip: fallback for iOS versions where the Wake Lock API fails in Home Screen apps.
let ffmpeg = "ffmpeg";
try {
  ffmpeg = require("ffmpeg-static") || ffmpeg; // bundled binary, used by the Vercel build
} catch {
  /* fall back to ffmpeg on the PATH */
}
try {
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10",
    "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono",
    "-t", "6", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "8k", "-movflags", "+faststart",
    join(ROOT, "assets/keepawake.mp4"),
  ]);
  console.log("video     assets/keepawake.mp4");
} catch (error) {
  console.warn("Skipped keep-awake clip (ffmpeg not available):", error.message);
}
