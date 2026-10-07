import { defineFake, type FakeOptions } from "@sanoma/workflows/fake";
import { bluesky } from "./index.ts";

export interface FakeBlueskyPost {
  uri: string;
  cid: string;
  url: string;
  text: string;
}

export interface FakeBlueskyState extends Record<string, unknown> {
  seq: number;
  posts: FakeBlueskyPost[];
}

/**
 * An in-memory Bluesky for tests: posts live in `state.posts`, in the order posted.
 * Pass `{ file }` to keep the state on disk.
 */
export function fakeBluesky(options: FakeOptions = {}) {
  return defineFake(
    bluesky,
    {
      initial: (): FakeBlueskyState => ({ seq: 0, posts: [] }),
      ops: (state) => ({
        post: {
          create: async ({ text }) => {
            const rkey = `3k${String(++state.seq).padStart(4, "0")}`;
            const post = {
              uri: `at://did:plc:fake/app.bsky.feed.post/${rkey}`,
              cid: `cid-${rkey}`,
              url: `https://bsky.app/profile/fake.test/post/${rkey}`,
              text,
            };
            state.posts.push(post);
            return { uri: post.uri, cid: post.cid, url: post.url };
          },
        },
      }),
    },
    options,
  );
}
