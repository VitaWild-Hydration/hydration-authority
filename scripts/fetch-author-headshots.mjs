#!/usr/bin/env node
/**
 * Fetch persona headshots from Pexels and save under public/images/authors/.
 *
 * Queries are tuned per persona's implied demographic + brand context.
 * These are stock photos representing fictional personas (the bylines on
 * HA are voice personas, not real authors). Operator approval on each
 * portrait is the final gate.
 *
 * Usage:
 *   PEXELS_API_KEY=... node scripts/fetch-author-headshots.mjs
 *   PEXELS_API_KEY=... node scripts/fetch-author-headshots.mjs maya-chen
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'images', 'authors');

const TOKEN = process.env.PEXELS_API_KEY;
if (!TOKEN) {
  console.error('Set PEXELS_API_KEY env var to your Pexels API key.');
  process.exit(1);
}

const PERSONAS = {
  'maya-chen': {
    name: 'Maya Chen',
    query: 'asian american woman portrait warm smile professional',
  },
  'jamie-reeves': {
    name: 'Jamie Reeves',
    query: 'woman face close up portrait smile natural light',
  },
  'hannah-wright': {
    name: 'Hannah Wright',
    query: 'athletic woman portrait headshot fitness',
  },
  'dr-riya-patel': {
    name: 'Dr. Riya Patel',
    query: 'indian woman face headshot professional smile',
  },
  'adam-wagner': {
    name: 'Adam Wagner',
    query: 'man portrait casual professional founder',
  },
};

async function searchPexels(query) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=5`;
  const res = await fetch(url, { headers: { Authorization: TOKEN } });
  if (!res.ok) throw new Error(`Pexels search HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.photos || data.photos.length === 0) throw new Error('no photos returned');
  return data.photos[0];
}

async function downloadImage(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function processPersona(slug, { name, query }) {
  process.stdout.write(`\n[${slug}]\n  query: "${query}"\n`);
  const photo = await searchPexels(query);
  process.stdout.write(`  → photo #${photo.id} by ${photo.photographer} (${photo.url})\n`);

  // "portrait" size is ~800px wide vertical, "medium" is 1280 — for a 48px avatar
  // anything > 200px is fine. Use "medium" to keep file size reasonable.
  const srcUrl = photo.src.medium || photo.src.portrait || photo.src.large;
  const buf = await downloadImage(srcUrl);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${slug}.jpg`);
  await writeFile(outPath, buf);
  process.stdout.write(`  ✓ saved ${outPath.replace(REPO_ROOT, '.')} (${buf.length} bytes)\n`);

  return {
    slug, name, query,
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
    pexelsUrl: photo.url,
    pexelsId: photo.id,
  };
}

async function main() {
  const onlySlug = process.argv[2];
  const entries = Object.entries(PERSONAS).filter(([slug]) => !onlySlug || slug === onlySlug);
  if (entries.length === 0) {
    console.error(`No matching slug: ${onlySlug}`);
    process.exit(1);
  }

  const results = [];
  let ok = 0, fail = 0;
  for (const [slug, info] of entries) {
    try {
      results.push(await processPersona(slug, info));
      ok++;
    } catch (e) {
      process.stdout.write(`  ✗ ${slug}: ${e.message}\n`);
      fail++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  process.stdout.write(`\nDone: ${ok} ok, ${fail} failed\n`);
  if (results.length) {
    process.stdout.write('\nCredits:\n');
    for (const r of results) {
      process.stdout.write(`  ${r.slug} — Photo by ${r.photographer} (${r.pexelsUrl})\n`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
