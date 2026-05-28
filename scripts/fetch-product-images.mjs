#!/usr/bin/env node
/**
 * Fetch product hero shots for each ranked product across all articles.
 *
 * Strategy:
 *   1. Read every MDX article, extract unique (slug, productName, ctaUrl).
 *   2. For each ctaUrl, fetch the HTML and pull og:image (Shopify, Amazon,
 *      and most brand sites populate this with the main product photo).
 *   3. Download the og:image and save to /public/images/products/<slug>.jpg
 *   4. Report missing entries.
 *
 * The script writes a mapping JSON (./tmp/product-image-map.json) that
 * apply-product-images.mjs uses to rewrite each MDX file's productImage
 * frontmatter field.
 *
 * Usage:
 *   node scripts/fetch-product-images.mjs
 */

import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARTICLES_DIR = join(REPO_ROOT, 'src', 'content', 'articles');
const OUT_DIR = join(REPO_ROOT, 'public', 'images', 'products');
const MAP_DIR = join(REPO_ROOT, 'tmp');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MIN_BYTES = 3000;

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function extractProducts() {
  const files = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.mdx'));
  const products = new Map();
  for (const f of files) {
    const txt = await readFile(join(ARTICLES_DIR, f), 'utf-8');
    const blocks = txt.split(/^  - rank:/m).slice(1);
    for (const b of blocks) {
      const brand = b.match(/\n\s*brand:\s*"([^"]+)"/)?.[1];
      const name = b.match(/\n\s*productName:\s*"([^"]+)"/)?.[1];
      const cta = b.match(/\n\s*ctaUrl:\s*"([^"]+)"/)?.[1];
      if (!brand || !name || !cta) continue;
      const slug = slugify(name);
      if (!products.has(slug)) {
        products.set(slug, { slug, brand, name, cta });
      }
    }
  }
  return [...products.values()];
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

function absolutize(src, base) {
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

function extractOgImage(html, base) {
  // Try og:image and twitter:image variants in priority order.
  const tagPatterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+>/i,
    /<meta[^>]+property=["']og:image["'][^>]+>/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+>/i,
    /<meta[^>]+property=["']twitter:image["'][^>]+>/i,
  ];
  for (const p of tagPatterns) {
    const tag = html.match(p)?.[0];
    if (!tag) continue;
    const url = tag.match(/\bcontent=["']([^"']+)["']/)?.[1];
    const abs = url && absolutize(url, base);
    if (abs) return abs;
  }
  return null;
}

async function fetchBinary(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  return { buf, contentType: ct };
}

function extFor(ct, urlHint = '') {
  if (ct.includes('webp') || /\.webp(\?|$)/i.test(urlHint)) return 'webp';
  if (ct.includes('png') || /\.png(\?|$)/i.test(urlHint)) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g(\?|$)/i.test(urlHint)) return 'jpg';
  return 'jpg';
}

async function processProduct({ slug, brand, name, cta }) {
  process.stdout.write(`\n[${slug}] ${name}\n  source: ${cta}\n`);
  let html, finalUrl;
  try {
    ({ html, finalUrl } = await fetchText(cta));
  } catch (e) {
    return { slug, status: 'failed', reason: `fetch html: ${e.message}` };
  }
  const ogImg = extractOgImage(html, finalUrl);
  if (!ogImg) return { slug, status: 'failed', reason: 'no og:image in HTML' };
  process.stdout.write(`  og:image: ${ogImg}\n`);

  let buf, contentType;
  try {
    ({ buf, contentType } = await fetchBinary(ogImg));
  } catch (e) {
    return { slug, status: 'failed', reason: `download image: ${e.message}` };
  }
  if (buf.length < MIN_BYTES) {
    return { slug, status: 'failed', reason: `image too small (${buf.length}b)` };
  }
  const ext = extFor(contentType, ogImg);
  await mkdir(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${slug}.${ext}`);
  await writeFile(outPath, buf);
  process.stdout.write(`  ✓ saved ${outPath.replace(REPO_ROOT, '.')} (${buf.length}b)\n`);
  return { slug, status: 'ok', file: `${slug}.${ext}`, size: buf.length };
}

async function main() {
  const products = await extractProducts();
  process.stdout.write(`Fetching ${products.length} product images...\n`);
  const results = [];
  for (const p of products) {
    results.push(await processProduct(p));
    await new Promise((r) => setTimeout(r, 300));
  }

  const ok = results.filter((r) => r.status === 'ok');
  const fail = results.filter((r) => r.status === 'failed');

  // write mapping
  await mkdir(MAP_DIR, { recursive: true });
  const mapPath = join(MAP_DIR, 'product-image-map.json');
  const map = {};
  for (const r of ok) {
    map[r.slug] = `/images/products/${r.file}`;
  }
  await writeFile(mapPath, JSON.stringify(map, null, 2));

  process.stdout.write(`\n────────────\nDone: ${ok.length} ok, ${fail.length} failed\n`);
  process.stdout.write(`Map written to ${mapPath.replace(REPO_ROOT, '.')}\n`);
  if (fail.length) {
    process.stdout.write('Failed:\n');
    for (const r of fail) process.stdout.write(`  ${r.slug}: ${r.reason}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
