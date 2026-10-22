import { createFileRoute } from "@tanstack/react-router";
import { content, Link } from "sanoma/site";

/** The posts in content/posts, from the build. */
export const Route = createFileRoute("/sites/hello/posts/")({
  loader: () => content.posts.list(),
  component: Posts,
});

function Posts() {
  return (
    <ul>
      {Route.useLoaderData().map((post) => (
        <li key={post.slug}>
          <Link to="/sites/hello/posts/$slug" params={{ slug: post.slug }}>
            {post.data.title}
          </Link>
          <p>{post.data.description}</p>
        </li>
      ))}
    </ul>
  );
}
