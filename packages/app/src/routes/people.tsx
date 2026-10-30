import type { ConfigDescription, DeclaredResource } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { ReactNode } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { CardAction, CardContent, CardDescription, CardHeader } from "#/components/ui/card.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
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
} from "../components/common.tsx";
import { DeclarationForm } from "../components/declaration-form.tsx";
import { configQuery, isPeople, PeopleSearch, type PeopleView } from "../queries.ts";

export const Route = createFileRoute("/people")({
  validateSearch: PeopleSearch,
  // The list beside the one open takes the width there is.
  staticData: { crumb: "People", wide: true },
  head: ({ match }) => pageTitle(match.staticData.crumb),
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
  return (
    <>
      <CrumbHeader count={data.views.people.length} />
      <LinkTabs label="Show" value={show}>
        <LinkTab
          value="people"
          link={<Link to="/people" search={{ show: "people" }} />}
          count={data.views.people.length}
        >
          People
        </LinkTab>
        <LinkTab
          value="groups"
          link={<Link to="/people" search={{ show: "groups" }} />}
          count={data.views.groups.length}
        >
          Groups
        </LinkTab>
        <LinkTab
          value="agents"
          link={<Link to="/people" search={{ show: "agents" }} />}
          count={data.views.agents.length}
        >
          Agents
        </LinkTab>
      </LinkTabs>
      {data.problems.length > 0 && <Problems problems={data.problems} />}
      <FloatHost float={open && <Opened key={open.id} resource={open} show={show} people={data} />}>
        <p className="border-b p-3 text-sm text-muted-foreground">
          Declared in data files under <code>resources/</code>. Signing in admits these people and nobody else; a change
          to them waits for someone in <code>admin</code>.
        </p>
        {rows.length === 0 ? (
          <Nothing className="border-0" title={`No ${show} declared`}>
            {EMPTY[show]}
          </Nothing>
        ) : show === "groups" ? (
          <GroupsTable groups={rows} open={open?.id} />
        ) : (
          <PeopleTable rows={rows} show={show} groupsOf={data.groupsOf} open={open?.id} />
        )}
      </FloatHost>
    </>
  );
}

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
      Declare an agent with <code>sanoma.agent({"{ id, onBehalfOf }"})</code>: it may do what the person it acts for
      may.
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

/** Names as badges, or a muted line when there are none. */
function Names({ names, none }: { names: string[]; none: string }) {
  if (names.length === 0) return <span className="text-muted-foreground">{none}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <Badge key={name} variant="secondary">
          {name}
        </Badge>
      ))}
    </span>
  );
}

/** How a person signs in, by what their declaration gives a sign-in to match: their GitHub login, their email. */
function signsIn(person: DeclaredResource): string[] {
  const { github, email } = person.desired;
  return [
    ...(typeof github === "string" ? [`GitHub · ${github}`] : []),
    ...(typeof email === "string" ? [`Email · ${email}`] : []),
  ];
}

/** The people's or the agents' table: name, id, how they sign in (or whom an agent acts for), groups, declaration. */
function PeopleTable({
  rows,
  show,
  groupsOf,
  open,
}: {
  rows: DeclaredResource[];
  show: "people" | "agents";
  groupsOf: Directory["groupsOf"];
  open: string | undefined;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Id</TableHead>
          <TableHead>{show === "agents" ? "Acts for" : "Signs in with"}</TableHead>
          <TableHead>Groups</TableHead>
          <TableHead>Declared in</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} data-state={row.id === open ? "selected" : undefined}>
            <TableCell>
              <OpenLink resource={row} show={show} />
            </TableCell>
            <TableCell>
              <code className="text-xs">{row.name}</code>
            </TableCell>
            <TableCell>
              {show === "agents" ? (
                typeof row.desired.onBehalfOf === "string" ? (
                  row.desired.onBehalfOf
                ) : (
                  <span className="text-muted-foreground">nobody: itself</span>
                )
              ) : (
                <SignsIn person={row} />
              )}
            </TableCell>
            <TableCell>
              <Names names={groupsOf.get(row.name) ?? []} none="none" />
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

function SignsIn({ person }: { person: DeclaredResource }) {
  const ways = signsIn(person);
  if (ways.length === 0) return <span className="text-muted-foreground">cannot sign in</span>;
  return (
    <span className="flex flex-col">
      {ways.map((way) => (
        <span key={way}>{way}</span>
      ))}
    </span>
  );
}

/** The groups' table: name, members, declaration. */
function GroupsTable({ groups, open }: { groups: DeclaredResource[]; open: string | undefined }) {
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
      </TableBody>
    </Table>
  );
}

/** Why the form leaves who someone is to the file: the policy and the groups name them by it. */
const IDENTITY = "Who it is to the policy and to the groups: change it in the file.";

/**
 * The one open, over the list: its name, its file and export, its groups (written on each group,
 * not here), and its declaration's form, its identity read-only.
 */
function Opened({ resource, show, people }: { resource: DeclaredResource; show: PeopleView; people: Directory }) {
  const type = people.types.find((t) => t.type === resource.type);
  // The field `find` reads it by: `id`, or a group's `name`.
  const identity = type?.identity?.split(":")[0];
  const groups = people.groupsOf.get(resource.name) ?? [];
  return (
    <FloatingCard role="region" aria-label={resource.name} className={cn(FLOAT, "order-first")}>
      <CardHeader className="border-b">
        <CardHeading>{resource.name}</CardHeading>
        <CardDescription>
          <code className="text-xs">
            {resource.at.file} · export {resource.at.export}
          </code>
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
                <Names names={groups} none="none" />
              </Fact>
            </Facts>
            <p className="text-sm text-muted-foreground">Written on each group: open it under Groups to change it.</p>
          </div>
        )}
        <DeclarationForm resource={resource} type={type} fixed={identity ? { [identity]: IDENTITY } : undefined} />
      </CardContent>
    </FloatingCard>
  );
}
