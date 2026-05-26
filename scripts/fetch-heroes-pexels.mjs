#!/usr/bin/env node
/**
 * Fetch a hero image per article from Pexels and replace the placeholder SVG.
 *
 * For each entry in QUERIES:
 *   1. Search Pexels for the curated query (landscape orientation).
 *   2. Download the top result's `large2x` size.
 *   3. Save as public/images/articles/<slug>/hero.jpg.
 *   4. Append a credit line to public/images/articles/CREDITS.md.
 *
 * Pexels free tier: 200 req/hr, 20k/mo. Plenty for one pass over 15 articles.
 *
 * Usage:
 *   PEXELS_API_KEY=... node scripts/fetch-heroes-pexels.mjs
 *   PEXELS_API_KEY=... node scripts/fetch-heroes-pexels.mjs anxiety-or-magnesium-deficient
 */

import { writeFile, mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARTICLES_IMG_DIR = join(REPO_ROOT, 'public', 'images', 'articles');
const CREDITS_PATH = join(ARTICLES_IMG_DIR, 'CREDITS.md');

const TOKEN = process.env.PEXELS_API_KEY;
if (!TOKEN) {
  console.error('Set PEXELS_API_KEY env var to your Pexels API key.');
  process.exit(1);
}

// Hand-curated queries derived from each article's actual content.
const QUERIES = {
  'anxiety-or-magnesium-deficient':            'calm woman peaceful morning tea',
  'cellular-hydration-skincare':               'glowing skin water beauty routine',
  'coffee-crash-cycle':                        'tired person coffee desk afternoon',
  'cortisol-cocktail-trend':                   'orange juice glass kitchen morning',
  'family-safe-listicle':                      'kids drinking water happy family',
  'jet-lag-mineral-loss':                      'airplane window traveler water bottle',
  'kids-pediatrician-picks':                   'child drinking from cup healthy',
  'magnesium-citrate-vs-glycinate-vs-threonate': 'supplement pills hand minimal',
  'magnesium-for-sleep-30-nights':             'nightstand dim lamp bedroom peaceful',
  'morning-order-trick-before-coffee':         'morning kitchen counter water glass minimal calm',
  'other-macro-protein-hydration':             'athletic person gym water bottle',
  'perimenopause-3-minerals':                  'woman wellness lifestyle natural light',
  'postpartum-or-mineral-deficiency':          'tired new mother baby home',
  'sweat-sodium-math':                         'runner sweating workout outdoor',
  'vitamin-d-magnesium-connection':            'sunlight outdoor morning warm',
};

async function searchPexels(query) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=landscape&size=large&per_page=5`;
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

async function processArticle(slug, query) {
  process.stdout.write(`\n[${slug}]\n  query: "${query}"\n`);
  const photo = await searchPexels(query);
  process.stdout.write(`  → photo #${photo.id} by ${photo.photographer}\n`);

  const srcUrl = photo.src.large2x || photo.src.large || photo.src.landscape;
  const buf = await downloadImage(srcUrl);

  const outDir = join(ARTICLES_IMG_DIR, slug);
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, 'hero.jpg');
  await writeFile(outPath, buf);
  process.stdout.write(`  ✓ saved ${outPath.replace(REPO_ROOT, '.')} (${buf.length} bytes)\n`);

  return {
    slug,
    query,
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
    pexelsUrl: photo.url,
    pexelsId: photo.id,
  };
}

async function writeCredits(results) {
  await mkdir(ARTICLES_IMG_DIR, { recursive: true });
  const header = `# Hero image credits

Hero photography sourced from Pexels (free for commercial use, no attribution
required by license; we credit voluntarily). Replace any of these with custom
photography by overwriting the corresponding \`/images/articles/<slug>/hero.jpg\`.

Updated: ${new Date().toISOString().slice(0, 10)}
`;
  const rows = ['', '| Article | Photographer | Source |', '|---|---|---|'];
  for (const r of results) {
    rows.push(`| \`${r.slug}\` | [${r.photographer}](${r.photographerUrl}) | [Pexels #${r.pexelsId}](${r.pexelsUrl}) |`);
  }
  await writeFile(CREDITS_PATH, header + rows.join('\n') + '\n');
  process.stdout.write(`\n✓ Updated ${CREDITS_PATH.replace(REPO_ROOT, '.')}\n`);
}

async function main() {
  const onlySlug = process.argv[2];
  const entries = Object.entries(QUERIES).filter(([slug]) => !onlySlug || slug === onlySlug);

  if (entries.length === 0) {
    console.error(`No matching slug: ${onlySlug}`);
    process.exit(1);
  }

  process.stdout.write(`Fetching ${entries.length} hero images from Pexels...\n`);
  const results = [];
  let ok = 0, fail = 0;
  for (const [slug, query] of entries) {
    try {
      const r = await processArticle(slug, query);
      results.push(r);
      ok++;
    } catch (e) {
      process.stdout.write(`  ✗ ${slug}: ${e.message}\n`);
      fail++;
    }
    // be polite to the API
    await new Promise((r) => setTimeout(r, 250));
  }

  if (results.length > 0 && !onlySlug) await writeCredits(results);

  process.stdout.write(`\nDone: ${ok} ok, ${fail} failed\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
