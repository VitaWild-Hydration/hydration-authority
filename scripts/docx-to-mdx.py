#!/usr/bin/env python3
"""
Convert HA_*.docx source files to MDX articles in src/content/articles/.

Handles two archetypes:
  - Listicle: multiple Heading-2 product names, each with scored ratings.
  - VitaWild-centric: one ranked product (VitaWild) + "What About X?" alternative
    discussion blocks + protocol/diagnostic sections + conclusion.

For both, output a single .mdx file with:
  - YAML frontmatter (title, kicker, author, updated, description, hero, rankings[], conclusion, finalChoice)
  - MDX body containing the intro narrative

Usage:
  python3 scripts/docx-to-mdx.py path/to/HA_xx.docx [path/to/HA_yy.docx ...]
"""

from __future__ import annotations
import os, re, sys, json, argparse
from dataclasses import dataclass, field
from pathlib import Path
from docx import Document

# --- Brand registry ---------------------------------------------------------
# Maps product names → (brand slug, brand name, suggested CTA URL).
# Used to populate `productLogo` and best-guess `ctaUrl`. Operator verifies.
BRAND_REGISTRY = {
    "vitawild": {
        "patterns": [r"\bvitawild\b"],
        "brand": "VitaWild",
        "logo": "/images/brands/vitawild.png",
        "cta": "https://vitawild.co/products/vitawild-premium-daily-hydration",
    },
    "pedialyte": {
        "patterns": [r"\bpedialyte\b"],
        "brand": "Pedialyte",
        "logo": "/images/brands/pedialyte.png",
        "cta": "https://pedialyte.com",
    },
    "gatorade": {
        "patterns": [r"\bgatorade\b"],
        "brand": "Gatorade",
        "logo": "/images/brands/gatorade.png",
        "cta": "https://www.gatorade.com",
    },
    "capri-sun": {
        "patterns": [r"\bcapri\s?sun\b"],
        "brand": "Capri Sun",
        "logo": "/images/brands/capri-sun.png",
        "cta": "https://www.caprisun.com",
    },
    "liquid-iv": {
        "patterns": [r"\bliquid\s?i\.?\s?v\.?\b"],
        "brand": "Liquid I.V.",
        "logo": "/images/brands/liquid-iv.png",
        "cta": "https://liquid-iv.com",
    },
    "vita-coco": {
        "patterns": [r"\bvita\s?coco\b", r"plain coconut water"],
        "brand": "Vita Coco",
        "logo": "/images/brands/vita-coco.png",
        "cta": "https://www.vitacoco.com",
    },
    "ultima": {
        "patterns": [r"\bultima\s?(replenisher)?\b"],
        "brand": "Ultima Replenisher",
        "logo": "/images/brands/ultima.png",
        "cta": "https://www.ultimareplenisher.com",
    },
    "lmnt": {
        "patterns": [r"\blmnt\b"],
        "brand": "LMNT",
        "logo": "/images/brands/lmnt.png",
        "cta": "https://drinklmnt.com",
    },
}

VITAWILD_DEFAULT_PROMO = (
    "At the time of writing, VitaWild was offering up to 43% off your first "
    "purchase + a free gift."
)

# --- Helpers ----------------------------------------------------------------

def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def is_heading(p, level: int) -> bool:
    return p.style is not None and p.style.name == f"Heading {level}"


def is_list_paragraph(p) -> bool:
    return p.style is not None and p.style.name == "List Paragraph"


def is_placeholder(text: str) -> bool:
    """Detect bracketed editorial markers like [HERO IMAGE: ...], [VITAWILD PRODUCT IMAGE: ...]."""
    t = text.strip()
    return t.startswith("[") and t.endswith("]")


def text_runs_to_markdown(p) -> str:
    """Convert a python-docx paragraph's runs to markdown, preserving bold/italic."""
    parts = []
    for run in p.runs:
        t = run.text
        if not t:
            continue
        if run.bold and run.italic:
            parts.append(f"***{t}***")
        elif run.bold:
            parts.append(f"**{t}**")
        elif run.italic:
            parts.append(f"*{t}*")
        else:
            parts.append(t)
    out = "".join(parts)
    # Collapse stray double-spaces, normalise smart quotes lightly
    out = re.sub(r"\s+", " ", out).strip()
    # Re-merge adjacent bold/italic markers ("**A** **B**" → "**A B**" only when no whitespace in between)
    out = re.sub(r"\*\*\s*\*\*", "", out)
    out = re.sub(r"\*\s*\*", "", out)
    return out


def find_brand(product_name: str) -> dict | None:
    for slug, info in BRAND_REGISTRY.items():
        for pat in info["patterns"]:
            if re.search(pat, product_name, re.IGNORECASE):
                return {"slug": slug, **info}
    return None


# --- Article model ----------------------------------------------------------

@dataclass
class Rating:
    criterion: str
    score: float
    notes: list[str] = field(default_factory=list)


@dataclass
class Ranking:
    rank: int
    brand: str
    product_name: str
    product_logo: str | None
    score: float
    body_paragraphs: list[str] = field(default_factory=list)
    ratings: list[Rating] = field(default_factory=list)
    ha_says: str = ""
    cta_url: str = ""
    promo_disclaimer: str | None = None
    interlude_after_paragraphs: list[str] = field(default_factory=list)


@dataclass
class Article:
    file_path: str
    title: str = ""
    kicker: str = ""
    author: str = ""
    updated: str = ""
    description: str = ""
    hero_image: str = ""
    slug: str = ""
    intro_paragraphs: list[str] = field(default_factory=list)
    rankings: list[Ranking] = field(default_factory=list)
    conclusion_wrap_title: str = ""
    conclusion_paragraphs: list[str] = field(default_factory=list)
    final_choice_use_case: str = ""
    final_choice_summary: str = ""
    final_choice_product: str = ""


# --- Parsing ----------------------------------------------------------------

RATING_RE = re.compile(r"^(?P<criterion>[A-Z][A-Za-z0-9 &/]+?):\s*Rated\s*(?P<score>\d+(?:\.\d+)?)/10\s*$")
BY_LINE_RE = re.compile(r"^By\s+(?P<author>.+?)\s*[·•]\s*Updated:\s*(?P<updated>.+)$", re.IGNORECASE)


def parse_article(path: str) -> Article:
    doc = Document(path)
    art = Article(file_path=path)
    art.slug = derive_slug(path)

    # State machine over paragraphs.
    paras = doc.paragraphs
    i = 0
    n = len(paras)

    # 1) Kicker (first non-empty paragraph, all caps, no style heading)
    while i < n and not paras[i].text.strip():
        i += 1
    if i < n and not is_heading(paras[i], 1):
        art.kicker = paras[i].text.strip()
        i += 1

    # 2) H1 title
    while i < n and not paras[i].text.strip():
        i += 1
    if i < n and is_heading(paras[i], 1):
        art.title = paras[i].text.strip()
        i += 1

    # 3) Byline
    while i < n and not paras[i].text.strip():
        i += 1
    if i < n:
        m = BY_LINE_RE.match(paras[i].text.strip())
        if m:
            art.author = m.group("author").strip()
            art.updated = m.group("updated").strip()
            i += 1

    # 4) Hero image placeholder (optional)
    while i < n and not paras[i].text.strip():
        i += 1
    if i < n and is_placeholder(paras[i].text):
        # We'll generate a placeholder hero SVG path later.
        art.hero_image = f"/images/articles/{art.slug}/hero.svg"
        i += 1
    else:
        art.hero_image = f"/images/articles/{art.slug}/hero.svg"

    # 5) Intro paragraphs — everything up to the first H2 (which is always a product or section).
    while i < n and not is_heading(paras[i], 2):
        p = paras[i]
        t = text_runs_to_markdown(p)
        if not t:
            i += 1
            continue
        if is_placeholder(p.text):
            i += 1
            continue
        if t.strip() in {"Visit Site"}:
            i += 1
            continue
        if is_heading(p, 3):
            # H3 inside intro — treat as a markdown h3 for emphasis
            art.intro_paragraphs.append(f"### {t}")
        elif is_list_paragraph(p):
            art.intro_paragraphs.append(f"- {t}")
        else:
            art.intro_paragraphs.append(t)
        i += 1

    # 6) H2-led sections. Each is either:
    #    - A ranking block (product name) — has ratings + HA Says
    #    - An alternative discussion section (e.g., "What About X?")
    #    - "Conclusion:" — wrap-up
    #    - "My #1 Choice for ..." — final choice card
    rank_index = 1
    pending_interlude: list[str] = []
    last_ranking: Ranking | None = None

    while i < n:
        p = paras[i]
        if not is_heading(p, 2):
            i += 1
            continue
        h2_text = p.text.strip()
        i += 1

        # Special H2: Conclusion marker (followed by H1 wrap title)
        if h2_text.lower().startswith("conclusion"):
            # Capture H1 wrap title
            while i < n and not paras[i].text.strip():
                i += 1
            if i < n and is_heading(paras[i], 1):
                art.conclusion_wrap_title = paras[i].text.strip()
                i += 1
            # Capture body until next H2 ("My #1 Choice for ...")
            while i < n and not is_heading(paras[i], 2):
                p2 = paras[i]
                t = text_runs_to_markdown(p2)
                i += 1
                if not t or is_placeholder(p2.text) or t.strip() == "Visit Site":
                    continue
                if is_list_paragraph(p2):
                    art.conclusion_paragraphs.append(f"- {t}")
                elif is_heading(p2, 3):
                    art.conclusion_paragraphs.append(f"### {t}")
                else:
                    art.conclusion_paragraphs.append(t)
            continue

        # Special H2: Final-choice card
        if h2_text.lower().startswith("my #1 choice for "):
            art.final_choice_use_case = h2_text.split("for ", 1)[1].strip()
            # Following paragraphs until end / next H2: product name in H3? Or just body.
            summary_parts = []
            while i < n and not is_heading(paras[i], 2):
                p2 = paras[i]
                t = text_runs_to_markdown(p2)
                i += 1
                if not t or is_placeholder(p2.text) or t.strip() == "Visit Site":
                    continue
                summary_parts.append(t)
            art.final_choice_summary = " ".join(summary_parts).strip()
            art.final_choice_product = "VitaWild – Daily Fast Hydration"
            continue

        # Alternative discussion ("What About X?", "The Order, Step By Step", etc.)
        # Heuristic: if there's no ratings line in the next few paras, treat as discussion section.
        # Peek ahead.
        body_start = i
        has_ratings = False
        for j in range(i, min(n, i + 40)):
            if is_heading(paras[j], 2):
                break
            if RATING_RE.match(paras[j].text.strip()):
                has_ratings = True
                break

        if not has_ratings:
            # Alternative / protocol / educational section — flow into the last ranking's interludeAfter,
            # OR into intro if no ranking yet.
            section_lines: list[str] = [f"## {h2_text}"]
            while i < n and not is_heading(paras[i], 2):
                p2 = paras[i]
                t = text_runs_to_markdown(p2)
                i += 1
                if not t or is_placeholder(p2.text) or t.strip() == "Visit Site":
                    continue
                if is_list_paragraph(p2):
                    section_lines.append(f"- {t}")
                elif is_heading(p2, 3):
                    section_lines.append(f"### {t}")
                else:
                    section_lines.append(t)
            block = "\n\n".join(section_lines)
            if last_ranking:
                last_ranking.interlude_after_paragraphs.append(block)
            else:
                art.intro_paragraphs.append(block)
            continue

        # H2 with ratings → this is a ranking product.
        product_name = h2_text
        brand_info = find_brand(product_name)
        brand_label = brand_info["brand"] if brand_info else product_name.split("–")[0].strip().split("(")[0].strip()
        logo = brand_info["logo"] if brand_info else None
        cta = brand_info["cta"] if brand_info else ""

        rank = Ranking(
            rank=rank_index,
            brand=brand_label,
            product_name=product_name,
            product_logo=logo,
            score=0.0,
            cta_url=cta,
        )
        if brand_info and brand_info["slug"] == "vitawild":
            rank.promo_disclaimer = VITAWILD_DEFAULT_PROMO
        rank_index += 1

        # Read body until first rating line.
        body_lines: list[str] = []
        while i < n:
            p2 = paras[i]
            t = text_runs_to_markdown(p2)
            txt = p2.text.strip()
            if RATING_RE.match(txt):
                break
            if is_heading(p2, 2):
                break
            i += 1
            if not t or is_placeholder(p2.text) or t.strip() == "Visit Site":
                continue
            if is_list_paragraph(p2):
                body_lines.append(f"- {t}")
            elif is_heading(p2, 3):
                body_lines.append(f"### {t}")
            else:
                body_lines.append(t)
        rank.body_paragraphs = body_lines

        # Read ratings block: pattern is "Criterion: Rated X/10" then optional list paragraphs.
        ratings_pulled = []
        current_rating: Rating | None = None
        while i < n:
            p2 = paras[i]
            txt = p2.text.strip()
            if is_heading(p2, 2):
                break
            i += 1
            if not txt or is_placeholder(p2.text) or txt == "Visit Site":
                continue
            m = RATING_RE.match(txt)
            if m:
                if current_rating is not None:
                    ratings_pulled.append(current_rating)
                current_rating = Rating(
                    criterion=m.group("criterion").strip(),
                    score=float(m.group("score")),
                )
                continue
            if txt.lower().startswith("hydration authority says"):
                if current_rating is not None:
                    ratings_pulled.append(current_rating)
                    current_rating = None
                # Next non-empty para is the HA Says body
                while i < n:
                    p3 = paras[i]
                    say = text_runs_to_markdown(p3)
                    i += 1
                    if not say or is_placeholder(p3.text):
                        continue
                    if p3.text.strip() == "Visit Site":
                        continue
                    rank.ha_says = say
                    break
                continue
            if txt.startswith("*") and "VitaWild" in txt:
                rank.promo_disclaimer = re.sub(r"^\*|\*$", "", txt).strip()
                continue
            if current_rating is not None and is_list_paragraph(p2):
                current_rating.notes.append(text_runs_to_markdown(p2))
            elif current_rating is not None:
                # Continuation paragraph for the current criterion
                current_rating.notes.append(text_runs_to_markdown(p2))
            # else: stray paragraph — ignore.
        if current_rating is not None:
            ratings_pulled.append(current_rating)
        rank.ratings = ratings_pulled

        # Pick a score: average of ratings rounded to 1dp.
        if rank.ratings:
            rank.score = round(sum(r.score for r in rank.ratings) / len(rank.ratings), 1)

        art.rankings.append(rank)
        last_ranking = rank

    # 7) Description: take first ~155 chars of first intro paragraph (excluding markdown).
    if art.intro_paragraphs:
        first = re.sub(r"[*#`]", "", art.intro_paragraphs[0])
        first = first.strip()
        art.description = (first[:152].rsplit(" ", 1)[0] + "…") if len(first) > 155 else first

    return art


def derive_slug(path: str) -> str:
    name = os.path.basename(path)
    # HA_07_family-safe-listicle_2026-05-12.docx → family-safe-listicle
    m = re.match(r"^HA_\d+_(.+?)_\d{4}-\d{2}-\d{2}\.docx$", name)
    if m:
        return m.group(1)
    return slugify(os.path.splitext(name)[0])


# --- MDX rendering ----------------------------------------------------------

def yaml_escape(s: str) -> str:
    if not isinstance(s, str):
        return s
    # Double-quote and escape inner double-quotes + backslashes
    s = s.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{s}"'


def yaml_block(text: str, indent: int = 6) -> str:
    """Render a multi-line markdown string as a literal block scalar (|)."""
    pad = " " * indent
    lines = text.split("\n")
    return "|\n" + "\n".join(f"{pad}{l}" if l else "" for l in lines)


def render_mdx(art: Article) -> str:
    fm: list[str] = ["---"]
    fm.append(f"title: {yaml_escape(art.title)}")
    fm.append(f"kicker: {yaml_escape(art.kicker)}")
    fm.append(f"author: {yaml_escape(art.author)}")
    fm.append(f"updated: {yaml_escape(art.updated)}")
    fm.append(f"description: {yaml_escape(art.description)}")
    fm.append(f"heroImage: {yaml_escape(art.hero_image)}")

    fm.append("rankings:")
    for r in art.rankings:
        fm.append(f"  - rank: {r.rank}")
        fm.append(f"    brand: {yaml_escape(r.brand)}")
        fm.append(f"    productName: {yaml_escape(r.product_name)}")
        if r.product_logo:
            fm.append(f"    productLogo: {yaml_escape(r.product_logo)}")
        fm.append(f"    score: {r.score}")
        body = "\n\n".join(r.body_paragraphs).strip()
        fm.append(f"    body: {yaml_block(body, indent=6)}")
        fm.append("    ratings:")
        for rt in r.ratings:
            fm.append(f"      - criterion: {yaml_escape(rt.criterion)}")
            fm.append(f"        score: {rt.score}")
            fm.append("        notes:")
            for note in rt.notes:
                fm.append(f"          - {yaml_escape(note)}")
        fm.append(f"    haSays: {yaml_escape(r.ha_says)}")
        fm.append(f"    ctaUrl: {yaml_escape(r.cta_url)}")
        if r.promo_disclaimer:
            fm.append(f"    promoDisclaimer: {yaml_escape(r.promo_disclaimer)}")
        if r.interlude_after_paragraphs:
            block = "\n\n".join(r.interlude_after_paragraphs).strip()
            fm.append(f"    interludeAfter: {yaml_block(block, indent=6)}")

    if art.conclusion_wrap_title or art.conclusion_paragraphs:
        fm.append("conclusion:")
        fm.append(f"  wrapTitle: {yaml_escape(art.conclusion_wrap_title or 'Why VitaWild Stands Out')}")
        body = "\n\n".join(art.conclusion_paragraphs).strip()
        fm.append(f"  body: {yaml_block(body, indent=4)}")

    if art.final_choice_summary:
        fm.append("finalChoice:")
        fm.append(f"  productName: {yaml_escape(art.final_choice_product)}")
        if art.final_choice_use_case:
            fm.append(f"  useCase: {yaml_escape(art.final_choice_use_case)}")
        fm.append(f"  summary: {yaml_escape(art.final_choice_summary)}")
        fm.append(f"  ctaUrl: {yaml_escape('https://vitawild.co/products/vitawild-premium-daily-hydration')}")

    fm.append("---")
    fm.append("")
    fm.append("\n\n".join(art.intro_paragraphs).strip())
    fm.append("")
    return "\n".join(fm)


# --- CLI --------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("docx", nargs="+", help="Path(s) to HA_*.docx files")
    ap.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parent.parent / "src" / "content" / "articles"),
        help="Output directory for .mdx files",
    )
    ap.add_argument("--dry-run", action="store_true", help="Print summary, don't write")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    for path in args.docx:
        art = parse_article(path)
        mdx = render_mdx(art)
        target = out_dir / f"{art.slug}.mdx"
        print(f"{path}")
        print(f"  → slug: {art.slug}")
        print(f"  → title: {art.title}")
        print(f"  → byline: {art.author} · {art.updated}")
        print(f"  → rankings: {len(art.rankings)}")
        for r in art.rankings:
            print(f"      #{r.rank}  {r.product_name}  (score {r.score}, {len(r.ratings)} criteria, {len(r.interlude_after_paragraphs)} interlude blocks)")
        print(f"  → conclusion: {'yes' if art.conclusion_paragraphs else 'no'}")
        print(f"  → final-choice: {'yes' if art.final_choice_summary else 'no'}")
        if not args.dry_run:
            target.write_text(mdx, encoding="utf-8")
            print(f"  ✓ wrote {target}")
        print()


if __name__ == "__main__":
    main()
