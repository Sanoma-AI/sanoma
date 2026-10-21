import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { z } from "zod";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import {
  ButtonLink,
  ItemHeading,
  Notice,
  PageHeader,
  pageTitle,
  Region,
  ToneBadge,
  When,
} from "../../components/common.tsx";
import { CredentialRow, type CredentialStore } from "../../components/credentials.tsx";
import { setSetupTokenFn } from "../../functions.ts";
import { setupStatusQuery } from "../../queries.ts";

export const Route = createFileRoute("/setup/connect")({
  // `github` says how creating the App went, as its callback comes back here.
  validateSearch: z.object({ github: z.enum(["connected", "expired", "failed", "bad-org", "nobody"]).optional() }),
  staticData: { crumb: "Connect GitHub and Supabase" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: ({ context: { queryClient } }) => queryClient.query({ ...setupStatusQuery(), staleTime: "static" }),
  component: ConnectPage,
});

/** What the callback came back with, said on the page. */
const OUTCOME = {
  connected:
    "The GitHub App is created and its keys are stored. Install it on the account that will hold the repository; sign-in uses it once the app restarts on a host beyond this machine.",
  expired: "That link from GitHub has expired or did not start here: create the App again.",
  failed:
    "The App's keys were not stored (the app's log says why): delete the App on GitHub if it was created, then create it again.",
  "bad-org": "That is not an organization's login.",
  nobody: "Say who you are first: the App's keys are stored as you.",
} as const;

/** The pasted tokens' rows store through the setup function, which takes these names only; nothing clears them here. */
const SETUP_STORE: CredentialStore = { set: setSetupTokenFn };

/** Going live, step 1: the GitHub App (or a token of your own) and a Supabase token, and what is connected. */
function ConnectPage() {
  const { github } = Route.useSearch();
  const { data: status } = useSuspenseQuery(setupStatusQuery());
  const token = (name: string) => status.tokens.find((t) => t.name === name);
  const githubToken = token("GITHUB_TOKEN");
  const supabaseToken = token("SUPABASE_ACCESS_TOKEN");
  return (
    <>
      <PageHeader />
      {github && <Notice variant={github === "connected" ? "default" : "destructive"}>{OUTCOME[github]}</Notice>}
      <Region title="GitHub">
        <ItemGroup>
          <GithubApp app={status.githubApp} />
          {githubToken && <CredentialRow credential={githubToken} store={SETUP_STORE} />}
        </ItemGroup>
      </Region>
      <Region title="Supabase">
        <ItemGroup>{supabaseToken && <CredentialRow credential={supabaseToken} store={SETUP_STORE} />}</ItemGroup>
      </Region>
      <p className="text-sm text-muted-foreground">
        Have a repository or a database already?{" "}
        <Link to="/setup/existing" className="underline underline-offset-4">
          Connect an existing one
        </Link>
      </p>
    </>
  );
}

/**
 * The company's GitHub App: its slug and Install once created; until then, a form that creates it
 * on GitHub from the app's manifest, in a personal account or an organization.
 */
function GithubApp({ app }: { app: { slug: string; setBy?: string; setAt?: string } | null }) {
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemHeading>
          GitHub App
          {app ? <code>{app.slug}</code> : null}
          <ToneBadge tone={app ? "ok" : "off"}>{app ? "connected" : "not created"}</ToneBadge>
        </ItemHeading>
        <ItemDescription className="line-clamp-none">
          The company's own App: its OAuth client signs people in, and its installation creates and pushes the
          repository.
        </ItemDescription>
        {app?.setBy && app.setAt && (
          <ItemDescription>
            created by {app.setBy} · <When at={Date.parse(app.setAt)} />
          </ItemDescription>
        )}
        {!app && (
          // A document navigation: the manifest route answers with a page that posts to GitHub.
          <form method="get" action="/setup/github/manifest" className="flex flex-wrap items-end gap-2 pt-2">
            <Field className="max-w-64">
              <FieldLabel htmlFor="github-org">Organization</FieldLabel>
              <Input id="github-org" name="org" placeholder="your account" autoComplete="off" />
              <FieldDescription>Leave empty to create it in your personal account.</FieldDescription>
            </Field>
            <Button type="submit">Create GitHub App</Button>
          </form>
        )}
      </ItemContent>
      {app && (
        <ItemActions>
          <ButtonLink variant="outline" size="sm">
            <a href={`https://github.com/apps/${app.slug}/installations/new`} target="_blank" rel="noreferrer">
              Install
              <ExternalLinkIcon data-icon="inline-end" />
            </a>
          </ButtonLink>
        </ItemActions>
      )}
    </Item>
  );
}
