import { defineCollection, z } from "astro:content";

const artists = defineCollection({
  type: "content",
  schema: z.object({}),
});

export const collections = {
  artists,
};

const news = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string().optional(),
    cover: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});