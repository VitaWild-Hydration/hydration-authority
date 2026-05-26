#!/usr/bin/env node
/**
 * Pull brand logos from logo.dev using the publishable token.
 * logo.dev returns the image body with HTTP 404 when the domain
 * isn't in their curated index — the image is still usable, so we
 * accept 4xx as long as the body is a real PNG/SVG of meaningful size.
 *
 * Usage:
 *   LOGO_DEV_TOKEN=pk_xxxxx node scripts/fetch-logos-logodev.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'images', 'brands');

const TOKEN = process.env.LOGO_DEV_TOKEN;
if (!TOKEN) {
  console.error('Set LOGO_DEV_TOKEN env var to your logo.dev publishable key (pk_...)');
  process.exit(1);
}

const BRANDS = {
  'capri-sun': 'caprisun.com',
  gatorade: 'gatorade.com',
  'liquid-iv': 'liquid-iv.com',
  lmnt: 'drinklmnt.com',
  'moon-juice': 'moonjuice.com',
  'natural-vitality': 'naturalvitality.com',
  olly: 'olly.com',
  pedialyte: 'pedialyte.com',
  'pure-encapsulations': 'pureencapsulations.com',
  ultima: 'ultimareplenisher.com',
  'vita-coco': 'vitacoco.com',
  // VitaWild logo is already in place (operator-provided); skip.
};

const MIN_BYTES = 2000;
const UA = 'Mozilla/5.0';

async function fetchLogo(slug, domain) {
  const url = `https://img.logo.dev/${domain}?token=${TOKEN}&format=png&size=400&retina=true`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_BYTES) {
    return { ok: false, reason: `body too small (${buf.length}b, http ${res.status})` };
  }
  // PNG magic: 89 50 4E 47
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isSvg = buf.slice(0, 200).toString('utf8').includes('<svg');
  if (!isPng && !isSvg) {
    return { ok: false, reason: `not a recognized image format (http ${res.status})` };
  }
  const ext = isPng ? 'png' : 'svg';
  const outPath = join(OUT_DIR, `${slug}.${ext}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  return { ok: true, file: `${slug}.${ext}`, size: buf.length, status: res.status };
}

async function main() {
  console.log(`Fetching ${Object.keys(BRANDS).length} brand logos from logo.dev...\n`);
  let ok = 0, fail = 0;
  for (const [slug, domain] of Object.entries(BRANDS)) {
    try {
      const r = await fetchLogo(slug, domain);
      if (r.ok) {
        console.log(`  ✓ ${slug.padEnd(22)} ${domain.padEnd(28)} → ${r.file} (${r.size}b, http ${r.status})`);
        ok++;
      } else {
        console.log(`  ✗ ${slug.padEnd(22)} ${domain.padEnd(28)} → ${r.reason}`);
        fail++;
      }
    } catch (e) {
      console.log(`  ✗ ${slug.padEnd(22)} ${domain.padEnd(28)} → ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone: ${ok} ok, ${fail} failed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
