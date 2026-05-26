#!/usr/bin/env node
/**
 * Generate persona headshots using Google's Gemini 2.5 Flash Image
 * (a.k.a. "Nano Banana") and save as JPG under public/images/authors/.
 *
 * Usage:
 *   GEMINI_API_KEY=AIza... node scripts/generate-headshots-nanobanana.mjs
 *   GEMINI_API_KEY=AIza... node scripts/generate-headshots-nanobanana.mjs maya-chen
 *
 * Notes:
 *   - The endpoint returns PNG by default; we write the bytes as-is with a
 *     .jpg extension since browsers don't care about the disk extension when
 *     the content-type is correct. If you want true JPG re-encoding, pipe
 *     through `sharp` post-process.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'images', 'authors');

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('Set GEMINI_API_KEY env var to your Google AI Studio key (AIza...)');
  process.exit(1);
}

const MODEL = 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const PERSONAS = {
  'maya-chen': {
    name: 'Maya Chen',
    prompt: `Editorial-style headshot of a 35-year-old Asian-American woman with shoulder-length straight black hair, warm friendly smile, soft natural daylight from a window, wearing a simple cream knit sweater, sitting in a bright modern kitchen, slight depth of field, looks like a real food and wellness journalist headshot for a magazine byline. 4:5 portrait crop, eye-level camera, not corporate stock photography, candid moment, photorealistic, sharp focus on eyes.`,
  },
  'jamie-reeves': {
    name: 'Jamie Reeves',
    prompt: `Editorial-style headshot of a 32-year-old woman with shoulder-length sun-touched brown hair, athletic build, calm slight smile, golden hour natural light, wearing a heather grey t-shirt, blurred outdoor coffee shop patio background, candid moment, looks like a lifestyle journalist headshot for a magazine byline. 4:5 portrait crop, eye-level camera, not corporate stock photography, photorealistic, sharp focus on eyes.`,
  },
  'hannah-wright': {
    name: 'Hannah Wright',
    prompt: `Editorial-style headshot of a 28-year-old woman with brown hair pulled back in a low ponytail, light freckles, healthy outdoor complexion, calm direct gaze with subtle smile, natural overhead daylight, wearing a simple performance tank top, blurred outdoor running trail background, candid moment, looks like a real sports journalist headshot for a magazine byline. 4:5 portrait crop, eye-level camera, not corporate stock photography, photorealistic, sharp focus on eyes.`,
  },
  'dr-riya-patel': {
    name: 'Dr. Riya Patel',
    prompt: `Editorial-style headshot of a 38-year-old South Asian woman with dark wavy shoulder-length hair, warm intelligent smile, professional confident expression, soft natural daylight, wearing a navy collared shirt under a clean white doctor's coat, blurred bright modern clinical background, candid moment, looks like a real functional medicine doctor's headshot for a magazine byline. 4:5 portrait crop, eye-level camera, not corporate stock photography, photorealistic, sharp focus on eyes.`,
  },
};

async function generate(slug, { name, prompt }) {
  process.stdout.write(`\n[${slug}] ${name}\n`);
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };

  const res = await fetch(`${ENDPOINT}?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) {
    throw new Error(`No image in response. Got parts: ${JSON.stringify(parts).slice(0, 300)}`);
  }
  const mime = imagePart.inlineData.mimeType || 'image/png';
  const buf = Buffer.from(imagePart.inlineData.data, 'base64');

  await mkdir(OUT_DIR, { recursive: true });
  const ext = mime.includes('jpeg') ? 'jpg' : 'png';
  const filename = `${slug}.${ext === 'png' ? 'png' : 'jpg'}`;
  const outPath = join(OUT_DIR, filename);
  await writeFile(outPath, buf);
  process.stdout.write(`  ✓ saved ${outPath.replace(REPO_ROOT, '.')} (${buf.length} bytes, ${mime})\n`);
  return { slug, file: filename, size: buf.length, mime };
}

async function main() {
  const only = process.argv[2];
  const entries = Object.entries(PERSONAS).filter(([slug]) => !only || slug === only);
  if (entries.length === 0) {
    console.error(`No matching slug: ${only}`);
    process.exit(1);
  }
  let ok = 0, fail = 0;
  for (const [slug, info] of entries) {
    try {
      await generate(slug, info);
      ok++;
    } catch (e) {
      process.stdout.write(`  ✗ ${slug}: ${e.message}\n`);
      fail++;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.stdout.write(`\nDone: ${ok} ok, ${fail} failed\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
