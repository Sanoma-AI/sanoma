import { createFileRoute } from "@tanstack/react-router";
import { content, notFound } from "sanoma/site";

/** One post, its body rendered at build. */
export const Route = createFileRoute("/sites/hello/posts/$slug")({
  loader: async ({ params }) => {
    const post = await content.posts.get(params.slug);
    if (!post) throw notFound();
    return post;
  },
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
