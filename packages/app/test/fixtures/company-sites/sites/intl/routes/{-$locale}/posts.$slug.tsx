import { createFileRoute } from "@tanstack/react-router";
import { content, notFound } from "sanoma/site";

/** A post in the URL's language: its translation, else the default's. */
export const Route = createFileRoute("/sites/intl/{-$locale}/posts/$slug")({
  loader: async ({ params }) => {
    const post = await content.posts.get(params.slug, { locale: params.locale });
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData }) => ({ meta: loaderData ? [{ title: String(loaderData.data.title) }] : [] }),
  component: Post,
});

function Post() {
  const post = Route.useLoaderData();
  return (
    <>
      <h1>{post.data.title}</h1>
      <article dangerouslySetInnerHTML={{ __html: post.html }} />
    </>
  );
}
