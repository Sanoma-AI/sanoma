import { defineFake, DriverError, type FakeOptions } from "@sanoma/workflows";
import { ghost } from "./index.ts";

export interface FakeGhostPost {
  id: string;
  title: string;
  html: string;
  slug: string;
  status: "draft" | "scheduled" | "published";
  publishedAt: string | null;
}

export interface FakeGhostState extends Record<string, unknown> {
  seq: number;
  posts: Record<string, FakeGhostPost>;
}

const out = (p: FakeGhostPost) => ({
  id: p.id,
  url: `https://blog.example.test/${p.slug}/`,
  slug: p.slug,
  status: p.status,
  publishedAt: p.publishedAt,
});

/**
 * An in-memory Ghost for tests: posts live in `state.posts`, and their URLs are on
 * `blog.example.test`. Pass `{ file }` to keep the state on disk.
 */
export function fakeGhost(options: FakeOptions = {}) {
  return defineFake(
    ghost,
    {
      initial: (): FakeGhostState => ({ seq: 0, posts: {} }),
      ops: (state) => ({
        post: {
          create: async ({ title, html, status }) => {
            const id = `post_${String(++state.seq).padStart(4, "0")}`;
            const slug = title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
            state.posts[id] = { id, title, html, slug, status, publishedAt: null };
            return out(state.posts[id]);
          },
          publish: async ({ id }) => {
            const post = state.posts[id];
            if (!post) throw new DriverError(`ghost: no post ${id}`, { retryable: false, status: 404 });
            if (post.status !== "published") {
              post.status = "published";
              post.publishedAt = new Date().toISOString();
            }
            return out(post);
          },
        },
      }),
    },
    options,
  );
}
