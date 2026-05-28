#!/usr/bin/env node
/**
 * For every ranking in every MDX article, add or update a `productImage`
 * frontmatter field if a matching file exists under /public/images/products/.
 *
 * Slug = productName lowercased + non-alphanumerics → "-".
 * Looks for any of {slug}.jpg, .png, .webp in that order.
 * If found and no productImage line exists in the ranking block, inserts one
 * after the productName line. If a line exists, updates it.
 * If no matching file, leaves the ranking untouched.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARTICLES_DIR = join(REPO_ROOT, 'src', 'content', 'articles');
const PRODUCTS_DIR = join(REPO_ROOT, 'public', 'images', 'products');

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function findImage(slug) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const rel = `${slug}.${ext}`;
    if (existsSync(join(PRODUCTS_DIR, rel))) return `/images/products/${rel}`;
  }
  return null;
}

async function main() {
  const files = (await readdir(ARTICLES_DIR)).filter((f) => f.endsWith('.mdx'));
  let updates = 0, skipped = 0;

  for (const f of files) {
    const path = join(ARTICLES_DIR, f);
    let txt = await readFile(path, 'utf-8');
    const blocks = txt.split(/(?=^  - rank:)/m);

    for (let i = 0; i < blocks.length; i++) {
      if (!blocks[i].startsWith('  - rank:')) continue;
      const nameM = blocks[i].match(/\n\s*productName:\s*"([^"]+)"/);
      if (!nameM) continue;
      const productName = nameM[1];
      const slug = slugify(productName);
      const imgPath = findImage(slug);
      if (!imgPath) {
        skipped++;
        continue;
      }

      const productImageLine = `    productImage: "${imgPath}"\n`;
      if (/\n\s*productImage:\s*"[^"]*"/.test(blocks[i])) {
        blocks[i] = blocks[i].replace(/\n\s*productImage:\s*"[^"]*"/, `\n    productImage: "${imgPath}"`);
      } else {
        blocks[i] = blocks[i].replace(
          /(\n\s*productName:\s*"[^"]+"\n)/,
          `$1${productImageLine}`
        );
      }
      updates++;
    }
    const out = blocks.join('');
    if (out !== txt) {
      await writeFile(path, out);
      process.stdout.write(`✓ ${f}\n`);
    }
  }
  process.stdout.write(`\nDone: ${updates} ranking blocks updated, ${skipped} skipped (no image)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
