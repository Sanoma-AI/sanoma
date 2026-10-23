import { useLocales } from "sanoma/site";

/** The page in each of the site's languages, the one on screen marked. */
export function Switcher() {
  return (
    <nav aria-label="Language">
      {useLocales().map(({ locale, href, current }) => (
        <a key={locale} href={href} hrefLang={locale} aria-current={current ? "page" : undefined}>
          {locale}
        </a>
      ))}
    </nav>
  );
}
