import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Driver } from "@sanoma/workflows";

export interface FakeCall {
  op: string;
  input: unknown;
  at: string;
}

interface FakeState {
  seq: number;
  calls: FakeCall[];
  posts: Record<string, { id: string; title: string; html: string; slug: string; status: "draft" | "published"; publishedAt: string | null }>;
  broadcasts: Record<string, { id: string; audience: string; subject: string; html: string; status: "draft" | "sent" }>;
  social: { uri: string; text: string }[];
}

const empty = (): FakeState => ({ seq: 0, calls: [], posts: {}, broadcasts: {}, social: [] });

/**
 * In-memory Ghost, Resend and Bluesky. Pass `file` to keep their state on disk,
 * so it survives a worker restart and another process can inspect it.
 */
export function fakeMarketingVendors(options: { file?: string } = {}) {
  const load = (): FakeState =>
    options.file && existsSync(options.file) ? JSON.parse(readFileSync(options.file, "utf8")) : empty();
  let state = load();
  const save = () => {
    if (!options.file) return;
    mkdirSync(dirname(options.file), { recursive: true });
    writeFileSync(options.file, JSON.stringify(state, null, 2));
  };
  // With a file, re-read before each call so another process's changes are seen.
  const refresh = () => {
    if (options.file) state = load();
  };
  const record = (op: string, input: unknown) => {
    refresh();
    state.calls.push({ op, input, at: new Date().toISOString() });
  };
  const nextId = (prefix: string) => `${prefix}_${String(++state.seq).padStart(4, "0")}`;
  const postOut = (p: FakeState["posts"][string]) => ({
    id: p.id,
    url: `https://blog.example.test/${p.slug}/`,
    slug: p.slug,
    status: p.status,
    publishedAt: p.publishedAt,
  });

  const drivers: Driver[] = [
    {
      vendor: "ghost",
      ops: {
        "post.create": async (input: { title: string; html: string }) => {
          record("ghost.post.create", input);
          const id = nextId("post");
          const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          state.posts[id] = { id, title: input.title, html: input.html, slug, status: "draft", publishedAt: null };
          save();
          return postOut(state.posts[id]);
        },
        "post.publish": async (input: { id: string }) => {
          record("ghost.post.publish", input);
          const post = state.posts[input.id];
          if (!post) throw new Error(`ghost: no post ${input.id}`);
          if (post.status !== "published") Object.assign(post, { status: "published", publishedAt: new Date().toISOString() });
          save();
          return postOut(post);
        },
      },
    },
    {
      vendor: "resend",
      ops: {
        "broadcast.create": async (input: { audience: string; subject: string; html: string }) => {
          record("resend.broadcast.create", input);
          const id = nextId("bc");
          state.broadcasts[id] = { id, ...input, status: "draft" };
          save();
          return { id };
        },
        "broadcast.send": async (input: { id: string }) => {
          record("resend.broadcast.send", input);
          const bc = state.broadcasts[input.id];
          if (!bc) throw new Error(`resend: no broadcast ${input.id}`);
          if (bc.status === "sent") throw new Error(`resend: broadcast ${input.id} was already sent`);
          bc.status = "sent";
          save();
          return { id: bc.id, status: "queued" as const };
        },
      },
    },
    {
      vendor: "bluesky",
      ops: {
        "post.create": async (input: { text: string }) => {
          record("bluesky.post.create", input);
          const rkey = nextId("3k");
          const uri = `at://did:plc:fake/app.bsky.feed.post/${rkey}`;
          state.social.push({ uri, text: input.text });
          save();
          return { uri, cid: `cid-${rkey}`, url: `https://bsky.app/profile/fake.test/post/${rkey}` };
        },
      },
    },
  ];

  return {
    drivers,
    /** The current state, re-read from disk when a file is used. */
    get state() {
      refresh();
      return state;
    },
    reset() {
      state = empty();
      save();
    },
  };
}
