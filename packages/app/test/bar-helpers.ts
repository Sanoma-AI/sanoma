// What the app's tests read the bar by, in the server's HTML.

/** The bar's sections: its `<nav>`'s contents. */
const barOf = (html: string) => html.match(/<nav aria-label="Sections"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";

/** The bar's items, in its groups: each group's links, `[href, label]`, in order. */
export const barGroups = (html: string): [string, string][][] =>
  barOf(html)
    .split("</ul>")
    .map((group) =>
      [...group.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*>([^<>]+)<\/a>/g)].map(
        ([, href, label]): [string, string] => [href!, label!],
      ),
    )
    .filter((links) => links.length > 0);

/** The bar's labels, in its groups. */
export const barLabels = (html: string): string[][] => barGroups(html).map((group) => group.map(([, label]) => label));

/** The opening tag of the bar's link to `to`. */
export const barLink = (html: string, to: string): string | undefined =>
  barOf(html).match(new RegExp(`<a [^>]*href="${to}"[^>]*>`))?.[0];
