/**
 * Author / persona registry.
 *
 * Each entry maps an author display name (as it appears in MDX frontmatter
 * `author:` field) to optional metadata: avatar image path (under /public)
 * and a one-line bio.
 *
 * Drop a new headshot into /public/images/authors/<slug>.jpg, add an entry
 * here keyed by exact name, and the byline + article header will render it
 * automatically. Articles whose author is not in this registry render without
 * an avatar (text-only byline).
 */

export interface Author {
  name: string;
  avatar?: string;
  bio?: string;
}

export const authors: Record<string, Author> = {
  'Thea Mullins': {
    name: 'Thea Mullins',
    avatar: '/images/authors/thea-mullins.jpg',
  },
  'Maya Chen': {
    name: 'Maya Chen',
  },
  'Jamie Reeves': {
    name: 'Jamie Reeves',
  },
  'Hannah Wright': {
    name: 'Hannah Wright',
  },
  'Dr. Riya Patel': {
    name: 'Dr. Riya Patel',
  },
  'Adam Wagner': {
    name: 'Adam Wagner',
  },
};

export function getAuthor(name: string): Author {
  return authors[name] ?? { name };
}
