import { createFileRoute } from "@tanstack/react-router";
import { content } from "sanoma/site";

export const Route = createFileRoute("/sites/hello/post")({
  loader: () => content.posts.get("hello"),
  component: Post,
});

function Post() {
  const post = Route.useLoaderData();
  if (!post) return <p>No post</p>;
  return (
    <>
      <h3>{post.data.title}</h3>
      <article dangerouslySetInnerHTML={{ __html: post.html }} />
    </>
  );
}
