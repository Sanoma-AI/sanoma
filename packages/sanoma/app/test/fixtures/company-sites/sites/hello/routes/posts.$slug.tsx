import { createFileRoute } from "@tanstack/react-router";
import { content, notFound, siteOrigin, siteUrl } from "sanoma/site";

/** One post, its body rendered at build, with its absolute URL and image for crawlers. */
export const Route = createFileRoute("/sites/hello/posts/$slug")({
  loader: async ({ params }) => {
    const post = await content.posts.get(params.slug);
    if (!post) throw notFound();
    return post;
  },
  head: ({ match }) => ({
    meta: [
      { property: "og:url", content: siteUrl(match.pathname) },
      { property: "og:image", content: new URL("/og.png", siteOrigin()).href },
    ],
    links: [{ rel: "canonical", href: siteUrl(match.pathname) }],
  }),
  component: Post,
});

function Post() {
  const post = Route.useLoaderData();
  return (
    <>
      <h1>{post.data.title}</h1>
      <article className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />
    </>
  );
}
