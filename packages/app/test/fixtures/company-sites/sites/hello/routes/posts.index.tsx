import { createFileRoute } from "@tanstack/react-router";
import { content, Link, siteUrl } from "sanoma/site";

/** The posts in content/posts, from the build, with the index's canonical link (its path ends in a slash). */
export const Route = createFileRoute("/sites/hello/posts/")({
  loader: () => content.posts.list(),
  head: ({ match }) => ({ links: [{ rel: "canonical", href: siteUrl(match.pathname) }] }),
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
