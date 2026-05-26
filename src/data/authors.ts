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
    avatar: '/images/authors/maya-chen.png',
  },
  'Jamie Reeves': {
    name: 'Jamie Reeves',
    avatar: '/images/authors/jamie-reeves.png',
  },
  'Hannah Wright': {
    name: 'Hannah Wright',
    avatar: '/images/authors/hannah-wright.png',
  },
  'Dr. Riya Patel': {
    name: 'Dr. Riya Patel',
    avatar: '/images/authors/dr-riya-patel.png',
  },
  'Adam Wagner': {
    name: 'Adam Wagner',
    avatar: '/images/authors/adam-wagner.jpg',
  },
};

export function getAuthor(name: string): Author {
  return authors[name] ?? { name };
}
