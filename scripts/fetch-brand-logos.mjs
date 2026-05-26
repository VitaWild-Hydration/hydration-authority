#!/usr/bin/env node
/**
 * Best-effort competitor logo scraper.
 *
 * Strategy per brand:
 *   1. Fetch the brand homepage HTML.
 *   2. Find all candidate logos in the <header> (or top 12KB): <img>, <svg>, <picture>/<source>.
 *   3. Score by likelihood: alt/class/path "logo" matches, file ext (svg > webp/png > jpg), header position.
 *   4. Try candidates in order, skip anything < 2KB (favicons), keep the largest non-favicon hit.
 *   5. Fall back to apple-touch-icon, og:image, favicon — flagged in the report as low-quality.
 *
 * Usage:
 *   node scripts/fetch-brand-logos.mjs brands.json
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'images', 'brands');
const MIN_BYTES = 2000;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

async function fetchBinary(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  return { buf, contentType: ct, finalUrl: res.url };
}

function ctToExt(ct, urlHint = '') {
  if (ct.includes('svg') || /\.svg(\?|$)/i.test(urlHint)) return 'svg';
  if (ct.includes('png') || /\.png(\?|$)/i.test(urlHint)) return 'png';
  if (ct.includes('webp') || /\.webp(\?|$)/i.test(urlHint)) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg') || /\.jpe?g(\?|$)/i.test(urlHint)) return 'jpg';
  return 'png';
}

function abs(src, base) {
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

function scoreCandidate({ src, alt, cls, parentCls }) {
  let score = 0;
  if (/logo/i.test(alt)) score += 6;
  if (/logo/i.test(cls)) score += 5;
  if (/logo/i.test(parentCls)) score += 4;
  if (/logo/i.test(src)) score += 4;
  if (/wordmark/i.test(src) || /wordmark/i.test(cls)) score += 3;
  if (/\.svg(\?|$)/i.test(src)) score += 3;
  if (/header/i.test(parentCls)) score += 1;
  if (/sprite/i.test(src)) score -= 6;
  if (/favicon/i.test(src)) score -= 8;
  if (/apple-touch/i.test(src)) score -= 4;
  if (/icon-/i.test(src) && !/logo/i.test(src)) score -= 2;
  if (/banner|hero|product|nav-/i.test(src) && !/logo/i.test(src)) score -= 3;
  return score;
}

function findCandidates(html, baseUrl) {
  // Restrict to <header> if found, else top of body.
  const headerMatch = html.match(/<header\b[\s\S]{0,12000}?<\/header>/i);
  const scope = headerMatch ? headerMatch[0] : html.slice(0, 12000);
  const candidates = [];

  // <img> + <picture><source>
  const imgRe = /<(img|source)\b[^>]*>/gi;
  let m;
  while ((m = imgRe.exec(scope)) !== null) {
    const tag = m[0];
    const srcAttr =
      (tag.match(/\bsrcset=["']([^"']+)["']/) || [])[1] ||
      (tag.match(/\bsrc=["']([^"']+)["']/) || [])[1] ||
      (tag.match(/\bdata-src=["']([^"']+)["']/) || [])[1];
    if (!srcAttr) continue;
    const src = srcAttr.split(',')[0].trim().split(' ')[0];
    const alt = (tag.match(/\balt=["']([^"']*)["']/) || [])[1] || '';
    const cls = (tag.match(/\bclass=["']([^"']*)["']/) || [])[1] || '';
    // crude parent-class detection: look back 300 chars for the nearest enclosing class
    const start = Math.max(0, m.index - 400);
    const ctx = scope.slice(start, m.index);
    const parentCls = (ctx.match(/class=["']([^"']*(?:logo|header|brand|navbar)[^"']*)["'][^<]*$/i) || [])[1] || '';

    const absUrl = abs(src, baseUrl);
    if (!absUrl) continue;
    candidates.push({ kind: 'img', src: absUrl, score: scoreCandidate({ src, alt, cls, parentCls }), alt, cls });
  }

  // inline <svg> — extract and treat as embedded asset.
  // We'll only use this if it has class/aria-label containing 'logo'.
  const svgRe = /<svg\b[^>]*?(?:class|aria-label|aria-labelledby)=["'][^"']*logo[^"']*["'][\s\S]*?<\/svg>/gi;
  while ((m = svgRe.exec(scope)) !== null) {
    candidates.push({ kind: 'inline-svg', src: m[0], score: 6 });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function findFallback(html, baseUrl) {
  const opts = [];
  // higher-quality fallbacks first
  for (const re of [
    /<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*>/gi,
    /<meta[^>]+property=["']og:image["'][^>]+>/gi,
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi,
  ]) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const tag = m[0];
      const href = (tag.match(/\bhref=["']([^"']+)["']/) || [])[1] || (tag.match(/\bcontent=["']([^"']+)["']/) || [])[1];
      const a = href && abs(href, baseUrl);
      if (a) opts.push(a);
    }
  }
  return opts;
}

async function tryDownload(slug, attempts) {
  let best = null;
  for (const candidate of attempts) {
    try {
      // inline SVG
      if (candidate.kind === 'inline-svg') {
        const buf = Buffer.from(candidate.src, 'utf-8');
        if (buf.length < 200) continue;
        const score = 1000; // strongly prefer inline svg if found
        if (!best || score > best.score) best = { buf, ext: 'svg', source: 'inline-svg', size: buf.length, score };
        continue;
      }
      const url = candidate.src || candidate;
      const { buf, contentType } = await fetchBinary(url);
      const ext = ctToExt(contentType, url);
      const score = (candidate.score ?? -10) + (buf.length >= MIN_BYTES ? 5 : -5) + (ext === 'svg' ? 4 : 0);
      const ok = buf.length >= MIN_BYTES;
      process.stdout.write(`  ${ok ? '·' : '✗'} ${url}  (${ext}, ${buf.length}b, score ${score})\n`);
      if (!ok) continue;
      if (!best || score > best.score) best = { buf, ext, source: url, size: buf.length, score };
    } catch (e) {
      process.stdout.write(`  ✗ ${candidate.src || candidate}  (${e.message})\n`);
    }
  }
  if (!best) return null;
  const outPath = join(OUT_DIR, `${slug}.${best.ext}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, best.buf);
  return best;
}

async function processBrand(slug, { domain, name }) {
  const homepage = `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  process.stdout.write(`\n[${slug}] ${name} (${homepage})\n`);

  let html, finalUrl;
  try {
    ({ html, finalUrl } = await fetchText(homepage));
  } catch (e) {
    process.stdout.write(`  ✗ homepage fetch failed: ${e.message}\n`);
    return { slug, status: 'failed', reason: `homepage: ${e.message}` };
  }

  const candidates = findCandidates(html, finalUrl);
  const fallbacks = findFallback(html, finalUrl).map((src) => ({ src, score: -3, kind: 'fallback' }));
  const attempts = [...candidates.slice(0, 6), ...fallbacks.slice(0, 3)];

  if (attempts.length === 0) {
    return { slug, status: 'failed', reason: 'no candidates found in HTML' };
  }

  const winner = await tryDownload(slug, attempts);
  if (!winner) return { slug, status: 'failed', reason: 'all candidates too small or unreachable' };

  process.stdout.write(`  ✓ wrote ${slug}.${winner.ext} (${winner.size}b) from ${winner.source}\n`);
  return { slug, status: winner.score < 0 ? 'low-quality' : 'ok', source: winner.source, file: `${slug}.${winner.ext}`, size: winner.size };
}

async function main() {
  const brandsPath = process.argv[2];
  if (!brandsPath) {
    console.error('Usage: node scripts/fetch-brand-logos.mjs <brands.json>');
    process.exit(1);
  }

  const raw = await readFile(brandsPath, 'utf-8');
  const brands = JSON.parse(raw);

  const results = [];
  for (const [slug, info] of Object.entries(brands)) {
    results.push(await processBrand(slug, info));
  }

  const ok = results.filter((r) => r.status === 'ok');
  const low = results.filter((r) => r.status === 'low-quality');
  const fail = results.filter((r) => r.status === 'failed');

  process.stdout.write(`\n────────────\nDone: ${ok.length} ok, ${low.length} low-quality (fallback), ${fail.length} failed\n`);
  if (low.length) {
    process.stdout.write('Low-quality (review manually):\n');
    for (const r of low) process.stdout.write(`  ${r.slug}  ${r.file}  ${r.source}\n`);
  }
  if (fail.length) {
    process.stdout.write('Failed:\n');
    for (const r of fail) process.stdout.write(`  ${r.slug}: ${r.reason}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
