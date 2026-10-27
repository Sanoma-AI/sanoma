import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import type { ConfigDescription, SiteEntry } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Card } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { usePublicAddress, useSites } from "#/lib/sites.ts";
import { CrumbHeader, Nothing, pageTitle } from "../components/common.tsx";
import { SiteIcon } from "../components/site-icon.tsx";
import { configQuery } from "../queries.ts";

// `/sites` itself, the one path there no site can take (a site's pages are `/sites/<name>/…`):
// the app's page listing them. Nothing else here may claim a path under `/sites`.
export const Route = createFileRoute("/sites/")({
  staticData: { crumb: "Sites" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: SitesPage,
});

/** The config's public sites, by name. */
const publicSitesByName = (config: ConfigDescription) =>
  new Map(config.sites.filter((site) => site.public).map((site) => [site.name, site]));

/**
 * The company's sites, with how many, as a table in one card: each site under its icon, title
 * and folder, its pages (those with no path parameter, its home first), a public site's own
 * address, where visitors see it at the root of its host, and its languages.
 */
function SitesPage() {
  const sites = useSites();
  const { data: publicSites } = useSuspenseQuery({
    ...configQuery(),
    select: publicSitesByName,
  });
  return (
    <>
      <CrumbHeader count={sites.length} />
      <Card className="gap-0 py-0">
        {sites.length === 0 ? (
          <Nothing className="border-0" title="This repo has no sites">
            A site is a folder of pages, <code>sites/&lt;name&gt;/routes/</code>, beside the config.
          </Nothing>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Pages</TableHead>
                <TableHead>Public at</TableHead>
                <TableHead>Languages</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sites.map(({ name, title, icon, pages }) => (
                <TableRow key={name}>
                  <TableCell className="align-top font-medium">
                    <div className="flex items-center gap-2 [&_svg]:size-4">
                      <SiteIcon icon={icon} public={publicSites.has(name)} />
                      {pages[0] ? <Link to={pages[0].to}>{title}</Link> : title}
                      <code className="text-xs font-normal text-muted-foreground">sites/{name}</code>
                    </div>
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <ul aria-label={`${title}'s pages`} className="flex flex-wrap gap-x-3 gap-y-1">
                      {pages.map(({ to, label }) => (
                        <li key={to}>
                          <Link to={to}>{label}</Link>
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="align-top">
                    {publicSites.has(name) ? (
                      <PublicAddress site={publicSites.get(name)!} />
                    ) : (
                      <span className="text-muted-foreground">In the app only</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Languages locales={publicSites.get(name)?.locales} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}

/**
 * A public site's own address and its sitemap, each in a new tab; its domain alone while the server
 * renders (`usePublicAddress`).
 */
function PublicAddress({ site }: { site: SiteEntry }) {
  const href = usePublicAddress(site);
  if (!href) return <span className="text-muted-foreground">Public</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
        {new URL(href).host}
        <ArrowSquareOutIcon aria-hidden="true" className="size-3.5" />
      </a>
      <a href={new URL("sitemap.xml", href).href} target="_blank" rel="noreferrer" className="text-muted-foreground">
        Sitemap
      </a>
    </div>
  );
}

/**
 * A public site's languages (`defineSite({ locales })`), its default first and so marked, each the
 * prefix its pages answer under but the default's; one, unsaid, for a site that names none.
 */
function Languages({ locales }: { locales: string[] | undefined }) {
  if (!locales) return <span className="text-muted-foreground">One</span>;
  return (
    <ul aria-label="Languages" className="flex flex-wrap gap-x-3 gap-y-1">
      {locales.map((locale, i) => (
        <li key={locale}>
          <code>{locale}</code>
          {i === 0 && <span className="text-muted-foreground"> default</span>}
        </li>
      ))}
    </ul>
  );
}
