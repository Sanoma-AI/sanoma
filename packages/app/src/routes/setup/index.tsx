import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { APPLY_WORKFLOW, isEnded } from "@sanoma-ai/workflows/shared";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { PlayIcon } from "@phosphor-icons/react/dist/csr/Play";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { UploadIcon } from "@phosphor-icons/react/dist/csr/Upload";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { errorBodyOf, INFRA, type GoLiveChoices, type GoLiveRequest, type GoLiveRun } from "../../api.ts";
import { ApplyPlanView } from "../../components/apply-plan.tsx";
import {
  ButtonLink,
  CrumbHeader,
  ItemHeading,
  Notice,
  pageTitle,
  Region,
  ToneBadge,
} from "../../components/common.tsx";
import { goLiveFn, goLiveHostFn } from "../../functions.ts";
import { RUN_TONE } from "../../lib/tone.ts";
import {
  goLiveChoicesQuery,
  goLiveProgressQuery,
  RUNS_KEY,
  runLink,
  setupStatusQuery,
  useStartRun,
} from "../../queries.ts";

export const Route = createFileRoute("/setup/")({
  staticData: { crumb: "Go live" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.query({ ...setupStatusQuery(), staleTime: "static" }),
      queryClient.query({ ...goLiveProgressQuery(), staleTime: "static" }),
    ]),
  component: GoLivePage,
});

/**
 * Going live: connect GitHub and Supabase, choose where the company goes, then apply the
 * repository and the database, push this repository to the new one, and apply the host. Each
 * step shows once the one before is done; the page reads how far it is from the files, the
 * lockfile and the runs, so it picks up where it was.
 */
function GoLivePage() {
  const { data: status } = useSuspenseQuery(setupStatusQuery());
  const { data: progress } = useSuspenseQuery(goLiveProgressQuery());
  const isSet = (name: string) => status.tokens.some((t) => t.name === name && t.status === "set");
  const github = status.githubApp !== null || isSet("GITHUB_TOKEN");
  const supabase = isSet("SUPABASE_ACCESS_TOKEN");
  // Only when the config declares the sanoma-ops connector, whose step is optional.
  const sanomaOps = status.tokens.some((t) => t.name === "SANOMA_OPS_TOKEN");
  const { run, bound } = progress;
  const data = bound.repo && bound.store;
  // The latest run is the host's once it is past the repository and database, or still going.
  const hostRun = run && data && (!isEnded(run.status) || run.results?.some((r) => r.id === `${INFRA}#host`));
  return (
    <>
      <CrumbHeader />
      <Region title="1. Connect GitHub and Supabase">
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
          <Item role="listitem" variant="outline" size="xs">
            <ItemContent>
              <ItemHeading>
                Supabase
                <ToneBadge tone={supabase ? "ok" : "off"}>{supabase ? "connected" : "not connected"}</ToneBadge>
              </ItemHeading>
              <ItemDescription>An access token, which lists and creates projects.</ItemDescription>
            </ItemContent>
          </Item>
          {sanomaOps && (
            <Item role="listitem" variant="outline" size="xs">
              <ItemContent>
                <ItemHeading>
                  sanoma-ops
                  <ToneBadge tone={isSet("SANOMA_OPS_TOKEN") ? "ok" : "off"}>
                    {isSet("SANOMA_OPS_TOKEN") ? "connected" : "not connected"}
                  </ToneBadge>
                </ItemHeading>
                <ItemDescription>
                  Optional: a wakeup account, so the host stops when nothing is due and starts again in time.
                </ItemDescription>
              </ItemContent>
            </Item>
          )}
        </ItemGroup>
        <div>
          <ButtonLink variant="outline">
            <Link to="/setup/connect">Connect…</Link>
          </ButtonLink>
        </div>
      </Region>
      <Region title="2. Choose where it goes">
        {progress.infra !== null ? (
          <>
            <p className="text-muted-foreground">
              <code>resources/sanoma/infra.ts</code> declares the repository, the database and the host:
            </p>
            <pre className="overflow-x-auto rounded-lg border p-3 text-xs">{progress.infra}</pre>
          </>
        ) : github && supabase ? (
          <ChooseForm />
        ) : (
          <p className="text-muted-foreground">Connect GitHub and Supabase first.</p>
        )}
      </Region>
      <Region title="3. Create the repository and the database">
        {data ? (
          <p>The repository and the database are made, and bound in the lockfile.</p>
        ) : run && progress.infra !== null ? (
          <>
            <RunStatus run={run} />
            {isEnded(run.status) && <ApplyAgain />}
          </>
        ) : (
          <p className="text-muted-foreground">Apply creates them once the file is written.</p>
        )}
      </Region>
      <Region title="4. Push and start the host">
        {!data ? (
          <p className="text-muted-foreground">Once the repository is made, this repository is pushed to it.</p>
        ) : progress.host ? (
          <HostAnswer host={progress.host} />
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
  const [form, setForm] = useState<GoLiveRequest>({
    owner: choices.owners[0]?.login ?? "",
    name: choices.name,
    organization: choices.organizations[0]?.id ?? "",
    region: "us-east-1",
    port: 8080,
  });
  const set = (field: keyof GoLiveRequest) => (e: { target: { value: string } }) =>
    setForm({ ...form, [field]: field === "port" ? Number(e.target.value) : e.target.value });
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
          <FieldDescription>The repository's, the Supabase project's and the host's.</FieldDescription>
          <FieldError>{issue("name")}</FieldError>
        </Field>
        <Field data-invalid={issue("organization") ? true : undefined}>
          <FieldLabel htmlFor="go-live-organization">Supabase organization</FieldLabel>
          <NativeSelect id="go-live-organization" value={form.organization} onChange={set("organization")}>
            {choices.organizations.map((o) => (
              <NativeSelectOption key={o.id} value={o.id}>
                {o.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldError>{issue("organization")}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="go-live-region">Region</FieldLabel>
          <NativeSelect id="go-live-region" value={form.region} onChange={set("region")}>
            {choices.regions.map((r) => (
              <NativeSelectOption key={r} value={r}>
                {r}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field data-invalid={issue("port") ? true : undefined}>
          <FieldLabel htmlFor="go-live-port">Host</FieldLabel>
          <div className="flex items-center gap-2">
            <span>{choices.host?.title ?? "None"} on this machine, port</span>
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
            It runs this company from the repository's <code>main</code>, answering at{" "}
            <code>http://127.0.0.1:{form.port}</code>.
          </FieldDescription>
          <FieldError>{issue("port")}</FieldError>
        </Field>
      </FieldGroup>
      {error && <Notice variant="destructive">{error}</Notice>}
      <div>
        <Button type="submit" disabled={mutation.isPending || choices.missing.length > 0}>
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

/** Starts apply on the repository and the database again, as Resources' Apply would, on these two. */
function ApplyAgain() {
  const start = useStartRun();
  const only = [`${INFRA}#repo`, `${INFRA}#store`];
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

/** Where the host answers, once it does. */
function HostAnswer({ host }: { host: { url: string; healthy: boolean } }) {
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
        {host.healthy && (
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
