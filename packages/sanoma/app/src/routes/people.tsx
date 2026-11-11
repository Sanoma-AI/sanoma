import type { ConfigDescription, DeclaredResource } from "sanoma/workflows/describe";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useServerFn } from "@tanstack/react-start";
import { ADMIN, AGENTS } from "sanoma/workflows/shared";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { CardAction, CardContent, CardDescription, CardHeader } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { firstWordOf } from "#/lib/names.ts";
import { cn } from "#/lib/utils.ts";
import {
  ButtonLink,
  CardHeading,
  CrumbHeader,
  Fact,
  Facts,
  FLOAT,
  FloatHost,
  FloatingCard,
  LinkTab,
  LinkTabs,
  Nothing,
  pageTitle,
  Problems,
  Tip,
  When,
} from "../components/common.tsx";
import { useActor } from "../actor.ts";
import { DeclarationForm } from "../components/declaration-form.tsx";
import { errorBodyOf } from "../api.ts";
import { inviteFn } from "../functions.ts";
import { configQuery, isPeople, PEOPLE_VIEWS, PeopleSearch, peopleSignInsQuery, type PeopleView } from "../queries.ts";

export const Route = createFileRoute("/people")({
  validateSearch: PeopleSearch,
  // The list beside the one open takes the width there is.
  staticData: { crumb: "People", wide: true },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  // Who signed in when: a failed read leaves the column blank, never the page.
  loader: ({ context: { queryClient } }) => queryClient.prefetchQuery({ ...peopleSignInsQuery(), staleTime: "static" }),
  component: PeoplePage,
});

/** Where the runtime's people are declared when nothing else says: a problem there is People's too. */
const PEOPLE_FILE = "resources/people.ts";

/** A problem with a declaration of the runtime's people types, as the loader words it (`sanoma.person: …`). */
const PEOPLE_PROBLEM = /^sanoma\.(?:person|agent|group)\b/;

/** A group's members as declared: the names of the people and agents it lists. */
const membersOf = (group: DeclaredResource): string[] =>
  Array.isArray(group.desired.members) ? group.desired.members.filter((m) => typeof m === "string") : [];

/**
 * Who may act, from the description: the people, groups and agents the data files declare, each
 * person's and agent's groups (written on each group, read back here by its members), the
 * problems in the files that declare them or with a declaration of theirs (its resources left
 * out, so its file may declare none), and the runtime's three types.
 */
function directory(config: ConfigDescription) {
  const all = config.resources.filter(isPeople);
  const byType = (type: string) => all.filter((r) => r.type === type);
  const groups = byType("group");
  const groupsOf = new Map<string, string[]>();
  for (const group of groups) {
    for (const member of membersOf(group)) groupsOf.set(member, [...(groupsOf.get(member) ?? []), group.name]);
  }
  const files = new Set([PEOPLE_FILE, ...all.map((r) => r.file)]);
  return {
    views: { people: byType("person"), groups, agents: byType("agent") } satisfies Record<PeopleView, unknown>,
    groupsOf,
    problems: config.problems.filter(
      (p) => (p.file !== undefined && files.has(p.file)) || PEOPLE_PROBLEM.test(p.message),
    ),
    types: config.resourceTypes.filter((t) => t.vendor === "sanoma"),
  };
}
type Directory = ReturnType<typeof directory>;

/**
 * People: how many are declared, the tabs People, Groups and Agents (`?show=`) with how many
 * each, what is wrong in the files that declare them, then one card listing the tab's, and over
 * its right the one open (`?person=`) with its declaration's form.
 */
function PeoplePage() {
  const { show = "people", person } = Route.useSearch();
  const { data } = useSuspenseQuery({ ...configQuery(), select: directory });
  const rows = data.views[show];
  const open = person === undefined ? undefined : rows.find((r) => r.name === person);
  const invite = useInviteCard(`${show}/${person ?? ""}`);
  return (
    <>
      <CrumbHeader count={data.views.people.length} />
      <LinkTabs label="Show" value={show}>
        {PEOPLE_VIEWS.map((view) => (
          <LinkTab
            key={view}
            value={view}
            link={<Link to="/people" search={{ show: view }} />}
            count={data.views[view].length}
          >
            {VIEW_LABEL[view]}
          </LinkTab>
        ))}
      </LinkTabs>
      {data.problems.length > 0 && <Problems problems={data.problems} />}
      <FloatHost
        float={
          invite.card ??
          (open && <Opened key={open.id} resource={open} show={show} people={data} onInvite={invite.start} />)
        }
      >
        <p className="border-b p-3 text-sm text-muted-foreground">
          Declared in data files under <code>resources/</code>. Signing in admits these people and nobody else; a change
          to them waits for someone in <code>admin</code>.
        </p>
        {rows.length === 0 && (show !== "groups" || data.views.agents.length === 0) ? (
          <Nothing className="border-0" title={`No ${show} declared`}>
            {EMPTY[show]}
          </Nothing>
        ) : show === "groups" ? (
          <GroupsTable groups={rows} agents={data.views.agents} open={open?.id} />
        ) : show === "agents" ? (
          <AgentsTable agents={rows} groupsOf={data.groupsOf} open={open?.id} />
        ) : (
          <PeopleTable
            people={rows}
            groupsOf={data.groupsOf}
            open={(invite.person ?? open)?.id}
            onInvite={invite.start}
          />
        )}
      </FloatHost>
    </>
  );
}

/** Each view's tab. */
const VIEW_LABEL: Record<PeopleView, string> = { people: "People", groups: "Groups", agents: "Agents" };

/** What an empty view says to do. */
const EMPTY: Record<PeopleView, ReactNode> = {
  people: (
    <>
      Declare people in a data file under <code>resources/</code>, each with <code>sanoma.person()</code> from{" "}
      <code>sanoma/resources</code>.
    </>
  ),
  groups: (
    <>
      Declare a group with <code>sanoma.group({"{ name, members }"})</code>, its members the people and agents in it.
    </>
  ),
  agents: (
    <>
      Declare an agent with <code>sanoma.agent({"{ id, onBehalfOf, client }"})</code>: acting for someone, it may do no
      more than they may, nor more than its own groups let it; its <code>client</code> names the OAuth client it stands
      for.
    </>
  ),
};

/** A row's name, opening it over the list, the tab kept. */
function OpenLink({ resource, show }: { resource: DeclaredResource; show: PeopleView }) {
  const title = typeof resource.desired.name === "string" && show !== "groups" ? resource.desired.name : resource.name;
  return (
    <Link
      to="/people"
      search={{ show, person: resource.name }}
      resetScroll={false}
      className="font-medium underline-offset-4 hover:underline"
    >
      {title}
    </Link>
  );
}

/** Where it is declared, opening there in its file on Hosting. */
const DeclaredIn = ({ resource }: { resource: DeclaredResource }) => (
  <Link
    to="/hosting"
    search={{ resource: resource.id }}
    className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
  >
    {resource.id}
  </Link>
);

/** Names as badges, then `builtIn` (groups the runtime gives, declared nowhere) muted; a muted line when there are none. */
function Names({ names, builtIn = [], none }: { names: string[]; builtIn?: string[]; none: string }) {
  if (names.length === 0 && builtIn.length === 0) return <span className="text-muted-foreground">{none}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Badge key={name} variant="secondary">
          {name}
        </Badge>
      ))}
      {builtIn.map((name) => (
        <BuiltIn key={name} name={name} />
      ))}
    </span>
  );
}

/** A group the runtime gives every agent, which no file declares. */
const BuiltIn = ({ name }: { name: string }) => (
  <Badge variant="outline" className="text-muted-foreground" title="The runtime puts every agent in it">
    {name} (built in)
  </Badge>
);

/** The groups the runtime gives a principal of this type, beside those declared: `agents` to every agent. */
const builtInGroups = (type: string): string[] => (type === "agent" ? [AGENTS] : []);

/** A person's declared email, what a sign-in code goes to and an invite is for. */
const emailOf = (person: DeclaredResource): string | undefined =>
  typeof person.desired.email === "string" ? person.desired.email : undefined;

/** Opens a person's invite card, minting their link (`useInviteCard`). */
type OnInvite = (person: DeclaredResource) => void;

/** Why a person has no invite link: nothing to send its code to. */
const NO_EMAIL = "Declare an email to make an invite link for them";

/** A person's declared name, else their id. */
const nameOf = (person: DeclaredResource): string =>
  typeof person.desired.name === "string" ? person.desired.name : person.name;

/** The people's table: name, email, groups, how they sign in, when they last did, and their invite link. */
function PeopleTable({
  people,
  groupsOf,
  open,
  onInvite,
}: {
  people: DeclaredResource[];
  groupsOf: Directory["groupsOf"];
  open: string | undefined;
  onInvite: OnInvite;
}) {
  // Invite links are the host's staff login's: on this machine the picker signs anyone in.
  const { data } = useQuery(peopleSignInsQuery());
  const invites = data?.invites === true;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Groups</TableHead>
          <TableHead>Signs in</TableHead>
          <TableHead>Last signed in</TableHead>
          {invites && (
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.map((row) => (
          <TableRow key={row.id} data-state={row.id === open ? "selected" : undefined}>
            <TableCell>
              <OpenLink resource={row} show="people" />
            </TableCell>
            <TableCell>{emailOf(row) ?? <span className="text-muted-foreground">none</span>}</TableCell>
            <TableCell>
              <Names names={groupsOf.get(row.name) ?? []} none="none" />
            </TableCell>
            <TableCell>
              <SignsIn person={row} />
            </TableCell>
            <TableCell>
              <LastSignIn person={row.name} />
            </TableCell>
            {invites && (
              <TableCell className="text-right">
                <InviteButton person={row} onInvite={onInvite} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The agents' table: name, whom each acts for, the client it stands for, groups, declaration. */
function AgentsTable({
  agents,
  groupsOf,
  open,
}: {
  agents: DeclaredResource[];
  groupsOf: Directory["groupsOf"];
  open: string | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Acts for</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Groups</TableHead>
          <TableHead>Declared in</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((row) => (
          <TableRow key={row.id} data-state={row.id === open ? "selected" : undefined}>
            <TableCell>
              <OpenLink resource={row} show="agents" />
            </TableCell>
            <TableCell>
              {typeof row.desired.onBehalfOf === "string" ? (
                row.desired.onBehalfOf
              ) : (
                <span className="text-muted-foreground">whoever names it</span>
              )}
            </TableCell>
            <TableCell>
              {typeof row.desired.client === "string" ? (
                <code>{row.desired.client}</code>
              ) : (
                <span className="text-muted-foreground">none</span>
              )}
            </TableCell>
            <TableCell>
              <Names names={groupsOf.get(row.name) ?? []} builtIn={builtInGroups(row.type)} none="none" />
            </TableCell>
            <TableCell>
              <DeclaredIn resource={row} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** When the person last signed in on this app and how, from the ledger; `Never` until they do. */
function LastSignIn({ person }: { person: string }) {
  const { data } = useQuery(peopleSignInsQuery());
  const last = data?.last[person];
  if (!last) return <span className="text-muted-foreground">{data ? "Never" : ""}</span>;
  return (
    <span>
      <When at={last.at} />{" "}
      <span className="text-muted-foreground">· {SIGN_IN_METHOD[last.method] ?? last.method}</span>
    </span>
  );
}

/** How a sign-in was made, as the column says it. */
const SIGN_IN_METHOD: Record<string, string> = {
  code: "email code",
  github: "GitHub",
  invite: "invite",
};

/** How a person may sign in, by what their declaration gives a sign-in to match: their email (shortened), their GitHub login. */
function SignsIn({ person }: { person: DeclaredResource }) {
  const email = emailOf(person);
  const { github } = person.desired;
  if (email === undefined && typeof github !== "string") {
    return <span className="text-muted-foreground">cannot sign in</span>;
  }
  return (
    <span className="flex flex-col">
      {email !== undefined && (
        <span>
          Email code · <span className="text-muted-foreground">{email.replace(/@.*$/, "@…")}</span>
        </span>
      )}
      {typeof github === "string" && (
        <span>
          GitHub · <code className="text-xs">{github}</code>
        </span>
      )}
    </span>
  );
}

/**
 * Minting a person's invite link, and the card that shows it over the list: `start` mints one
 * (each replacing that person's last), `person` is whom the card is for while it is open, and
 * `card` the card. The card belongs to the view it was opened in (`where`, the page's search):
 * opening someone else or another tab puts it away. A refusal is a toast, and the card closes.
 */
function useInviteCard(where: string) {
  const invite = useServerFn(inviteFn);
  const mutation = useMutation({
    mutationFn: ({ person }: { person: DeclaredResource; where: string }) => invite({ data: { person: person.name } }),
    onError: (err) => toast.error(errorBodyOf(err)?.error ?? err.message),
  });
  const shown = mutation.isError || mutation.variables?.where !== where ? undefined : mutation.variables;
  const person = shown?.person;
  return {
    start: (whom: DeclaredResource) => mutation.mutate({ person: whom, where }),
    person,
    card: person && <InviteCard key={person.id} person={person} url={mutation.data?.url} onClose={mutation.reset} />,
  };
}

/**
 * A person's Invite link button: for someone in `admin` (the server refuses anyone else too), and
 * a person with an email declared; otherwise disabled, with why as its tip.
 */
function InviteButton({
  person,
  onInvite,
  size = "xs",
}: {
  person: DeclaredResource;
  onInvite: OnInvite;
  size?: "xs" | "sm";
}) {
  const { groups } = useActor();
  const why = !groups.includes(ADMIN)
    ? `Only someone in ${ADMIN} makes an invite link`
    : emailOf(person) === undefined
      ? NO_EMAIL
      : undefined;
  const button = (
    <Button
      variant="outline"
      size={size}
      disabled={why !== undefined}
      focusableWhenDisabled
      className="data-disabled:opacity-50"
      onClick={() => onInvite(person)}
    >
      <LinkIcon aria-hidden="true" data-icon="inline-start" />
      Invite link
    </Button>
  );
  return why === undefined ? button : <Tip tip={why}>{button}</Tip>;
}

/**
 * The invite link just minted for `person`, over the list: a one-use link that signs them in, for
 * 24 hours, to send however you like, with Copy; `url` is undefined while it is being made.
 */
function InviteCard({
  person,
  url,
  onClose,
}: {
  person: DeclaredResource;
  url: string | undefined;
  onClose: () => void;
}) {
  const name = nameOf(person);
  const first = firstWordOf(name);
  const title = `Invite link for ${name}`;
  const copy = (link: string) =>
    navigator.clipboard.writeText(link).then(
      () => toast.success(`Copied ${first}'s invite link`),
      () => toast.error("Could not copy: select the link and copy it"),
    );
  return (
    <FloatingCard role="region" aria-label={title} className={cn(FLOAT, "order-first")}>
      <CardHeader>
        <CardHeading>{title}</CardHeading>
        <CardDescription>Works once, 24 hours.</CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <XIcon aria-hidden="true" />
            <span className="sr-only">Close</span>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field>
          <FieldLabel htmlFor="invite-url">Link</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="invite-url"
              readOnly
              value={url ?? ""}
              placeholder="Making the link…"
              className="min-w-0 flex-1 font-mono text-xs"
              onFocus={(e) => e.target.select()}
            />
            <Button disabled={url === undefined} onClick={() => url !== undefined && copy(url)}>
              {url === undefined ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <CopyIcon aria-hidden="true" data-icon="inline-start" />
              )}
              Copy
            </Button>
          </div>
        </Field>
        <p className="text-sm text-muted-foreground">Send it any way you like: text, Slack, email.</p>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          Opening it signs {first} in as {emailOf(person)}. A new link replaces this one.
        </p>
      </CardContent>
    </FloatingCard>
  );
}

/** The groups' table: name, members, declaration; last, while there are agents, the `agents` group the runtime gives them. */
function GroupsTable({
  groups,
  agents,
  open,
}: {
  groups: DeclaredResource[];
  agents: DeclaredResource[];
  open: string | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Members</TableHead>
          <TableHead>Declared in</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group) => (
          <TableRow key={group.id} data-state={group.id === open ? "selected" : undefined}>
            <TableCell>
              <OpenLink resource={group} show="groups" />
            </TableCell>
            <TableCell className="whitespace-normal">
              <Names names={membersOf(group)} none="nobody" />
            </TableCell>
            <TableCell>
              <DeclaredIn resource={group} />
            </TableCell>
          </TableRow>
        ))}
        {agents.length > 0 && (
          <TableRow>
            <TableCell>
              <BuiltIn name={AGENTS} />
            </TableCell>
            <TableCell className="whitespace-normal">
              <Names names={agents.map((agent) => agent.name)} none="nobody" />
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">the runtime: every agent</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/**
 * The one open, over the list: its name, its file and export, its groups (written on each group,
 * not here), and its declaration's form (its identity read-only: `DeclarationForm`).
 */
function Opened({
  resource,
  show,
  people,
  onInvite,
}: {
  resource: DeclaredResource;
  show: PeopleView;
  people: Directory;
  onInvite: OnInvite;
}) {
  const type = people.types.find((t) => t.type === resource.type);
  const groups = people.groupsOf.get(resource.name) ?? [];
  return (
    <FloatingCard role="region" aria-label={resource.name} className={cn(FLOAT, "order-first")}>
      <CardHeader className="border-b">
        <CardHeading>{resource.name}</CardHeading>
        <CardDescription>
          <Link
            to="/hosting"
            search={{ resource: resource.id }}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {resource.at.file} · export {resource.at.export}
          </Link>
        </CardDescription>
        <CardAction>
          <ButtonLink variant="ghost" size="icon-sm">
            <Link to="/people" search={{ show }} resetScroll={false}>
              <XIcon aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Link>
          </ButtonLink>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        {resource.type !== "group" && (
          <div className="flex flex-col gap-1">
            <Facts>
              <Fact label="Groups">
                <Names names={groups} builtIn={builtInGroups(resource.type)} none="none" />
              </Fact>
            </Facts>
            <p className="text-sm text-muted-foreground">Written on each group: open it under Groups to change it.</p>
          </div>
        )}
        {resource.type === "person" && <InviteEntry person={resource} onInvite={onInvite} />}
        <DeclarationForm resource={resource} type={type} />
      </CardContent>
    </FloatingCard>
  );
}

/** The open person's Invite link, where this app mints them: it opens the same card as the row's. */
function InviteEntry({ person, onInvite }: { person: DeclaredResource; onInvite: OnInvite }) {
  const { data } = useQuery(peopleSignInsQuery());
  if (!data?.invites) return null;
  if (emailOf(person) === undefined) {
    return <p className="text-sm text-muted-foreground">{NO_EMAIL}.</p>;
  }
  return (
    <div>
      <InviteButton person={person} onInvite={onInvite} size="sm" />
    </div>
  );
}
