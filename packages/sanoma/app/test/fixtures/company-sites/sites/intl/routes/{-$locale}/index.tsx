import { createFileRoute } from "@tanstack/react-router";
import { content, Link, useLocale, useMessages } from "sanoma/site";
import { messages } from "../../messages.ts";

/** The home page, in the URL's language, linking to each post in it. */
export const Route = createFileRoute("/sites/intl/{-$locale}/")({
  loader: ({ params }) => content.posts.list({ locale: params.locale }),
  head: ({ params }) => ({ meta: [{ title: messages.get(params.locale).welcome }] }),
  component: Home,
});

function Home() {
  const t = useMessages(messages);
  const locale = useLocale();
  return (
    <main>
      <h1>{t.welcome}</h1>
      <p>locale: {locale}</p>
      {Route.useLoaderData().map((post) => (
        <Link key={post.slug} to="/sites/intl/{-$locale}/posts/$slug" params={{ slug: post.slug }}>
          {t.read(String(post.data.title))}
        </Link>
      ))}
    </main>
  );
}
