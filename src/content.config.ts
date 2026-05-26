import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const ratingSchema = z.object({
  criterion: z.string(),
  score: z.number(),
  notes: z.array(z.string()),
});

const rankingSchema = z.object({
  rank: z.number(),
  brand: z.string(),
  productName: z.string(),
  productLogo: z.string().optional(),
  productImage: z.string().optional(),
  score: z.number(),
  stars: z.number().default(5),
  body: z.string(),
  ratings: z.array(ratingSchema),
  haSays: z.string(),
  ctaUrl: z.string().url(),
  promoDisclaimer: z.string().optional(),
  interludeAfter: z.string().optional(),
});

const articles = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(),
    kicker: z.string(),
    author: z.string(),
    updated: z.string(),
    description: z.string(),
    heroImage: z.string(),
    topicBanner: z.string().optional(),
    rankings: z.array(rankingSchema),
    conclusion: z
      .object({
        wrapTitle: z.string(),
        body: z.string(),
      })
      .optional(),
    finalChoice: z
      .object({
        productName: z.string(),
        useCase: z.string().optional(),
        summary: z.string(),
        ctaUrl: z.string().url(),
      })
      .optional(),
  }),
});

export const collections = { articles };
