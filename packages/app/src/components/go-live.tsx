import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  useQueryErrorResetBoundary,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { CatchBoundary, type ErrorComponentProps, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { APPLY_WORKFLOW, errorMessage, isEnded, siteDir } from "@sanoma-ai/workflows/shared";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { UploadIcon } from "@phosphor-icons/react/dist/csr/Upload";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import {
  errorBodyOf,
  INFRA,
  type GoLiveChoices,
  type GoLiveRequest,
  type GoLiveRun,
  SETUP_VENDORS,
  type SetupStatus,
} from "../api.ts";
import { goLiveFn, goLiveHostFn, goLiveSignInFn } from "../functions.ts";
import { RUN_TONE } from "../lib/tone.ts";
import {
  goLiveChoicesQuery,
  goLiveProgressQuery,
  RUNS_KEY,
  runLink,
  setupStatusQuery,
  useStartRun,
} from "../queries.ts";
import { ApplyPlanView } from "./apply-plan.tsx";
import { ButtonLink, ItemHeading, Notice, Region, ToneBadge } from "./common.tsx";

/**
 * What `GoLive` reads, into the query client: for the loader of the page that shows it. A query
 * that fails is left failed, for `GoLive` to say, never the page.
 */
export const loadGoLive = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.prefetchQuery({ ...setupStatusQuery(), staleTime: "static" }),
    queryClient.prefetchQuery({ ...goLiveProgressQuery(), staleTime: "static" }),
  ]);

/**
 * Going live, on Hosting while no host and no database are declared, or once its repository is
 * bound until its host is: connect GitHub and the config's vendors, choose where the company goes,
 * then apply the repository and the database, push this repository to the new one, and apply the
 * host. Each step shows once the one before is done; it reads how far it is from the files, the
 * lockfile and the runs, so it picks up where it was. What it cannot read fails it alone, said in
 * its place, with the rest of the page as it is.
 */
export function GoLive() {
  return (
    <CatchBoundary getResetKey={() => "go-live"} errorComponent={GoLiveFailed}>
      <Suspense fallback={<Skeleton className="h-48 w-full" />}>
        <GoLiveSteps />
      </Suspense>
    </CatchBoundary>
  );
}

/** Going live's place when how far it is could not be read. */
function GoLiveFailed({ error, reset }: ErrorComponentProps) {
  const { reset: refetch } = useQueryErrorResetBoundary();
  return (
    <Notice variant="destructive">
      Could not read how far going live is: {errorMessage(error)}{" "}
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          refetch();
          reset();
        }}
      >
        Try again
      </Button>
    </Notice>
  );
}

function GoLiveSteps() {
  const { data: status } = useSuspenseQuery(setupStatusQuery());
  const { data: progress } = useSuspenseQuery(goLiveProgressQuery());
  const isSet = (name: string) => status.tokens.some((t) => t.name === name && t.status === "set");
  const github = status.githubApp !== null || isSet("GITHUB_TOKEN");
  // The vendors the config asks tokens of, each connected once its tokens are stored.
  const asked = new Set(status.tokens.map((t) => t.name));
  const vendors = SETUP_VENDORS.filter((v) => v.tokens.some((name) => asked.has(name))).map((v) => ({
    ...v,
    connected: v.tokens.every(isSet),
  }));
  const { run, bound } = progress;
  const data = bound.beforeHost;
  // The latest run is the host's once it is past the repository and database, or still going.
  const hostRun = run && data && (!isEnded(run.status) || run.results?.some((r) => r.id === `${INFRA}#host`));
  return (
    <>
      <Region title="1. Connect">
        <ItemGroup>
          <Item role="listitem" variant="outline" size="xs">
            <ItemContent>
              <ItemHeading>
                GitHub
                <ToneBadge tone={github ? "ok" : "off"}>{github ? "connected" : "not connected"}</ToneBadge>
              </ItemHeading>
              <ItemDescription>
                {status.githubApp ? `The App ${status.githubApp.slug}` : "No App"}
                {isSet("GITHUB_TOKEN") ? ", and a token of your own" : ""}.
              </ItemDescription>
            </ItemContent>
          </Item>
          <SignInItem signIn={status.signIn} app={status.githubApp} />
          {vendors.map((v) => (
            <Item key={v.title} role="listitem" variant="outline" size="xs">
              <ItemContent>
                <ItemHeading>
                  {v.title}
                  <ToneBadge tone={v.connected ? "ok" : "off"}>{v.connected ? "connected" : "not connected"}</ToneBadge>
                </ItemHeading>
                <ItemDescription>{v.about}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
        <div>
          <ButtonLink variant="outline">
            <Link to="/hosting/connect">Connect…</Link>
          </ButtonLink>
        </div>
      </Region>
      <Region title="2. Choose where it goes">
        {progress.infra !== null ? (
          <>
            <p className="text-muted-foreground">
              <code>resources/sanoma/infra.ts</code> declares the repository, its deploy key, the database and the host:
            </p>
            <pre className="overflow-x-auto rounded-lg border p-3 text-xs">{progress.infra}</pre>
          </>
        ) : github ? (
          <ChooseForm />
        ) : (
          <p className="text-muted-foreground">Connect GitHub first.</p>
        )}
      </Region>
      <Region title="3. Create the repository, its deploy key and the database">
        {data ? (
          <p>The repository, its deploy key and the database are made, and bound in the lockfile.</p>
        ) : run && progress.infra !== null ? (
          <>
            <RunStatus run={run} />
            {isEnded(run.status) && <ApplyAgain only={progress.beforeHost} />}
          </>
        ) : (
          <p className="text-muted-foreground">Apply creates them once the file is written.</p>
        )}
      </Region>
      <Region title="4. Push and start the host">
        {!data ? (
          <p className="text-muted-foreground">Once the repository is made, this repository is pushed to it.</p>
        ) : progress.host ? (
          <HostAnswer host={progress.host} you={status.signIn.you} />
        ) : hostRun ? (
          <>
            <RunStatus run={run} />
            {isEnded(run.status) && <PushButton />}
          </>
        ) : (
          <PushButton />
        )}
      </Region>
    </>
  );
}

/** The choices, and the button that writes `infra.ts` and starts apply on the repository and the database. */
function ChooseForm() {
  const { data: choices, isPending } = useQuery(goLiveChoicesQuery());
  if (isPending || !choices) return <Spinner />;
  return <ChooseFields choices={choices} />;
}

function ChooseFields({ choices }: { choices: GoLiveChoices }) {
  const { database, host, organizations } = choices;
  const regions = database?.regions ?? null;
  const [form, setForm] = useState<GoLiveRequest>({
    owner: choices.owners[0]?.login ?? "",
    name: choices.name,
    ...(organizations?.[0] && { organization: organizations[0].id }),
    region: regions?.includes("us-east-1") ? "us-east-1" : (regions?.[0] ?? ""),
    ...(database && { database: database.type }),
    ...(host && { host: host.type }),
    port: 8080,
  });
  const set = (field: keyof GoLiveRequest) => (e: { target: { value: string } }) => {
    const { value } = e.target;
    // An empty size is the vendor's default: left out.
    setForm({ ...form, [field]: field === "port" ? Number(value) : field === "size" && !value ? undefined : value });
  };
  const queryClient = useQueryClient();
  const goLive = useServerFn(goLiveFn);
  const mutation = useMutation({
    mutationFn: () => goLive({ data: form }),
    onSuccess: async () => {
      toast.success("Wrote infra.ts and started apply");
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
  const body = errorBodyOf(mutation.error);
  const issue = (field: string) => body?.issues?.find((i) => i.path[0] === field)?.message;
  const error = mutation.error && !body?.issues?.length ? (body?.error ?? mutation.error.message) : undefined;
  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
    >
      {choices.missing.length > 0 && (
        <Notice variant="destructive">
          The config's connectors declare no {choices.missing.join(", ")}: add their connectors to{" "}
          <code>sanoma.config.ts</code>.
        </Notice>
      )}
      {choices.connect.length > 0 && (
        <Notice variant="destructive">
          Connect {choices.connect.join(" and ")} first: going live makes what this page shows with{" "}
          {choices.connect.length > 1 ? "them" : "it"}.
        </Notice>
      )}
      {choices.errors.map((e) => (
        <Notice key={e} variant="destructive">
          {e}
        </Notice>
      ))}
      <FieldGroup>
        <Field data-invalid={issue("owner") ? true : undefined}>
          <FieldLabel htmlFor="go-live-owner">GitHub account</FieldLabel>
          <NativeSelect id="go-live-owner" value={form.owner} onChange={set("owner")}>
            {choices.owners.map((o) => (
              <NativeSelectOption key={o.login} value={o.login}>
                {o.login} ({o.kind}
                {o.via === "app" ? ", through the App" : ""})
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>The new private repository is made here.</FieldDescription>
          <FieldError>{issue("owner")}</FieldError>
        </Field>
        <Field data-invalid={issue("name") ? true : undefined}>
          <FieldLabel htmlFor="go-live-name">Name</FieldLabel>
          <Input id="go-live-name" value={form.name} onChange={set("name")} autoComplete="off" />
          <FieldDescription>The repository's, the database's and the host's.</FieldDescription>
          <FieldError>{issue("name")}</FieldError>
        </Field>
        <Field>
          <FieldLabel>Database</FieldLabel>
          <span>{database?.title ?? "None"}</span>
          <FieldDescription>The company's records, its runs and its ledger are kept here.</FieldDescription>
        </Field>
        {organizations && (
          <Field data-invalid={issue("organization") ? true : undefined}>
            <FieldLabel htmlFor="go-live-organization">Supabase organization</FieldLabel>
            <NativeSelect id="go-live-organization" value={form.organization ?? ""} onChange={set("organization")}>
              {organizations.map((o) => (
                <NativeSelectOption key={o.id} value={o.id}>
                  {o.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldError>{issue("organization")}</FieldError>
          </Field>
        )}
        <Field data-invalid={issue("region") ? true : undefined}>
          <FieldLabel htmlFor="go-live-region">Region</FieldLabel>
          {regions ? (
            <NativeSelect id="go-live-region" value={form.region} onChange={set("region")}>
              {regions.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {r}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : (
            <Input id="go-live-region" value={form.region} onChange={set("region")} autoComplete="off" />
          )}
          <FieldError>{issue("region")}</FieldError>
        </Field>
        {database?.size && (
          <Field data-invalid={issue("size") ? true : undefined}>
            <FieldLabel htmlFor="go-live-size">Size</FieldLabel>
            <Input id="go-live-size" value={form.size ?? ""} onChange={set("size")} autoComplete="off" />
            <FieldDescription>
              The database's compute size, as {database.title} names it; empty for its default.
            </FieldDescription>
            <FieldError>{issue("size")}</FieldError>
          </Field>
        )}
        <Field data-invalid={issue("port") ? true : undefined}>
          <FieldLabel htmlFor="go-live-port">Host</FieldLabel>
          <div className="flex items-center gap-2">
            <span>
              {host?.title ?? "None"}
              {host && !host.publicUrl ? " on this machine" : ""}, port
            </span>
            <Input
              id="go-live-port"
              className="w-24"
              type="number"
              value={form.port}
              onChange={set("port")}
              aria-invalid={issue("port") ? true : undefined}
            />
          </div>
          <FieldDescription>
            It runs this company from the repository's <code>main</code>
            {host && !host.publicUrl ? (
              <>
                , answering at <code>http://127.0.0.1:{form.port}</code>
              </>
            ) : (
              ", listening on this port"
            )}
            .
          </FieldDescription>
          <FieldError>{issue("port")}</FieldError>
        </Field>
      </FieldGroup>
      {error && <Notice variant="destructive">{error}</Notice>}
      <div>
        <Button type="submit" disabled={mutation.isPending || choices.missing.length > 0 || choices.connect.length > 0}>
          {mutation.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RocketIcon aria-hidden="true" data-icon="inline-start" />
          )}
          Write infra.ts and apply
        </Button>
      </div>
    </form>
  );
}

/** An apply run as going live follows it: what it waits on (with its plan), what failed, or its status. */
function RunStatus({ run }: { run: GoLiveRun }) {
  const failed = run.results?.filter((r) => r.status === "failed") ?? [];
  return (
    <div className="flex flex-col gap-3">
      <p className="flex flex-wrap items-center gap-2">
        Apply is <ToneBadge tone={failed.length ? "bad" : RUN_TONE[run.status]}>{run.status}</ToneBadge>
        <Link {...runLink({ runId: run.runId, workflow: "apply" })}>Open the run</Link>
      </p>
      {run.pending && (
        <>
          <Notice>
            It waits for a person to approve these changes in the{" "}
            <Link to="/inbox" search={{ approval: run.pending.approvalId }}>
              Inbox
            </Link>
            .
          </Notice>
          {run.pending.plan && <ApplyPlanView plan={run.pending.plan} />}
        </>
      )}
      {run.error && <Notice variant="destructive">{run.error}</Notice>}
      {failed.map((r) => (
        <Notice key={r.id} variant="destructive">
          {r.id}: {r.error}
        </Notice>
      ))}
    </div>
  );
}

/** Starts apply again on what the first apply makes (`only`), as Hosting's Apply would on those. */
function ApplyAgain({ only }: { only: string[] }) {
  const start = useStartRun();
  return (
    <div>
      <Button
        variant="outline"
        onClick={() => start.mutate({ workflow: APPLY_WORKFLOW, input: { only } })}
        disabled={start.isPending}
      >
        {start.isPending ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <PlayIcon aria-hidden="true" data-icon="inline-start" />
        )}
        Apply again
      </Button>
    </div>
  );
}

/** Pushes this repository to the new one, then starts apply on the host. */
function PushButton() {
  const queryClient = useQueryClient();
  const push = useServerFn(goLiveHostFn);
  const mutation = useMutation({
    mutationFn: () => push(),
    onSuccess: async () => {
      toast.success("Pushed, and started apply on the host");
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: (err) => toast.error(errorBodyOf(err)?.error ?? err.message),
  });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        This repository's <code>main</code>, with <code>infra.ts</code> and the lockfile, goes to the new repository;
        the host then runs it.
      </p>
      <div>
        <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <UploadIcon aria-hidden="true" data-icon="inline-start" />
          )}
          Push and start the host
        </Button>
      </div>
    </div>
  );
}

/**
 * How people will sign in on the host: by an email code through the config's sender, by GitHub
 * through the App, and always by invite links. With neither a connected sender nor GitHub, a
 * warning that does not block going live, and the two fixes. With GitHub, the public sites whose
 * visitors can sign in with it too, and the callback URL each needs on the App; and, when the App
 * may not read email addresses (one made elsewhere), the permission to add.
 */
function SignInItem({ signIn, app }: { signIn: SetupStatus["signIn"]; app: SetupStatus["githubApp"] }) {
  const code = signIn.sender !== null && signIn.senderConnected;
  const ways = [code && "an email code", signIn.github && "GitHub", "invite links"].filter(Boolean).join(", ");
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemHeading>
          Sign-in
          {code || signIn.github ? (
            <ToneBadge tone="ok">{ways}</ToneBadge>
          ) : (
            <ToneBadge tone="waiting">warning · not blocking</ToneBadge>
          )}
        </ItemHeading>
        <ItemDescription>
          {code || signIn.github ? (
            <>People sign in on the host with {ways}.</>
          ) : (
            <>
              On the host, people can sign in only by an invite link someone signed in there makes. To let them sign in
              themselves:{" "}
              {signIn.sender === null ? (
                <>
                  name a sender in <code>sanoma.config.ts</code>, such as{" "}
                  <code>login: {'{ sender: resend.emails.send, from: "Acme <login@acme.example>" }'}</code>, and connect
                  it
                </>
              ) : (
                <>
                  connect <code>{signIn.sender.split(".")[0]}</code>, the sender
                </>
              )}
              , for an email code; or create the GitHub App, for Sign in with GitHub.
            </>
          )}
          {signIn.github && signIn.githubEmails === false && (
            <>
              {" "}
              The App{app ? <code> {app.slug}</code> : null} may not read email addresses, which Sign in with GitHub
              needs when someone&apos;s GitHub email is private: in its settings on GitHub, under Permissions &amp;
              events, set the account permission <strong>Email addresses</strong> to Read-only, then accept the update
              on its installation.
            </>
          )}
          {signIn.github && signIn.sites.length > 0 && (
            <>
              {" "}
              Visitors on {signIn.sites.map((site) => siteDir(site.name)).join(", ")} can sign in with GitHub too, once
              the App lists{" "}
              <code>
                {[
                  ...new Set(signIn.sites.map((site) => `https://<site host>/auth/${site.login}/callback/github`)),
                ].join(", ")}
              </code>{" "}
              among its callback URLs, for each site&apos;s host.
            </>
          )}
          {signIn.you === null && (
            <> Declare your email in the people file to be signed in on the host when it first answers.</>
          )}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** Where the host answers, once it does: Open signs the person in there by an invite when their email is declared. */
function HostAnswer({ host, you }: { host: { url: string; healthy: boolean }; you: string | null }) {
  const signIn = useServerFn(goLiveSignInFn);
  const mutation = useMutation({
    // The tab opens on the click, so no popup blocker stops it, and is sent to the link once minted.
    mutationFn: async (tab: Window | null) => ({ tab, ...(await signIn()) }),
    onSuccess: ({ tab, url }) => {
      if (tab) tab.location.href = url;
      else window.location.assign(url);
    },
    onError: (err, tab) => {
      tab?.close();
      toast.error(errorBodyOf(err)?.error ?? err.message);
    },
  });
  const open = () => {
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    mutation.mutate(tab);
  };
  return (
    <ItemGroup>
      <Item role="listitem" variant="outline" size="xs">
        <ItemContent>
          <ItemHeading>
            {host.healthy ? "Live" : "Starting"}
            <ToneBadge tone={host.healthy ? "ok" : "off"}>{host.healthy ? "healthy" : "not answering yet"}</ToneBadge>
          </ItemHeading>
          <ItemDescription>
            <code>{host.url}</code>
          </ItemDescription>
        </ItemContent>
        {host.healthy && you !== null && (
          <ItemActions>
            <Button variant="outline" size="sm" onClick={open} disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Open, signed in as {you}
              <ArrowSquareOutIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          </ItemActions>
        )}
        {host.healthy && you === null && (
          <ItemActions>
            <ButtonLink variant="outline" size="sm">
              <a href={host.url} target="_blank" rel="noreferrer">
                Open
                <ArrowSquareOutIcon aria-hidden="true" data-icon="inline-end" />
              </a>
            </ButtonLink>
          </ItemActions>
        )}
      </Item>
    </ItemGroup>
  );
}
