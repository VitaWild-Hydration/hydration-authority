#!/usr/bin/env node
/**
 * Generate placeholder hero SVGs for every article that doesn't have one yet.
 * Each hero is a 16:9 gradient block with the article kicker baked in.
 * Replace with real lifestyle photography per article when available.
 */

import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARTICLES_DIR = join(REPO_ROOT, 'src', 'content', 'articles');
const PUBLIC_DIR = join(REPO_ROOT, 'public');

const PALETTES = [
  ['#1a1d2a', '#3b3050'],
  ['#0e2a37', '#1d5470'],
  ['#22142b', '#4d2a4d'],
  ['#1a302a', '#2c5a4d'],
  ['#2a1f14', '#5a3f24'],
  ['#0f1e2d', '#1f3a55'],
  ['#2c1a1a', '#502d2d'],
  ['#1f1f2c', '#3f3f5c'],
  ['#16302f', '#2a5755'],
  ['#241726', '#42284a'],
];

function svgFor(kicker, paletteIndex) {
  const [c1, c2] = PALETTES[paletteIndex % PALETTES.length];
  const safeKicker = kicker.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 40);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="1" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#g)"/>
  <circle cx="1300" cy="700" r="240" fill="#FF9D00" opacity="0.08"/>
  <circle cx="200" cy="200" r="180" fill="#FFFFFF" opacity="0.04"/>
  <text x="80" y="780" font-family="'Rubik', 'Helvetica Neue', sans-serif" font-size="48" font-weight="700" fill="#FF9D00" letter-spacing="0.05em">
    ${safeKicker}
  </text>
  <text x="80" y="840" font-family="'Nunito Sans', 'Helvetica Neue', sans-serif" font-size="26" font-weight="400" fill="#FFFFFF" opacity="0.7" letter-spacing="0.08em">
    HYDRATION AUTHORITY
  </text>
</svg>
`;
}

function frontmatterField(text, key) {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const m = text.match(re);
  return m ? m[1].trim().replace(/^"|"$/g, '') : null;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const files = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.mdx'));
  let made = 0, skipped = 0;
  let idx = 0;
  for (const f of files.sort()) {
    const src = await readFile(join(ARTICLES_DIR, f), 'utf-8');
    const heroPath = frontmatterField(src, 'heroImage');
    if (!heroPath) {
      console.log(`  - ${f}: no heroImage field, skipping`);
      skipped++;
      continue;
    }
    const onDisk = join(PUBLIC_DIR, heroPath.replace(/^\//, ''));
    if (await exists(onDisk)) {
      console.log(`  · ${f}: hero exists (${heroPath})`);
      skipped++;
      idx++;
      continue;
    }
    const kicker = frontmatterField(src, 'kicker') || 'HYDRATION';
    await mkdir(dirname(onDisk), { recursive: true });
    await writeFile(onDisk, svgFor(kicker, idx));
    console.log(`  ✓ ${f}: wrote ${heroPath}`);
    made++;
    idx++;
  }
  console.log(`\nDone: ${made} created, ${skipped} skipped`);
}

main().catch((e) => { console.error(e); process.exit(1); });
