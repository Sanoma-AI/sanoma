import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { type ConnectExistingRequest, errorBodyOf, PASSWORD_NOTE } from "../../api.ts";
import { CrumbHeader, Notice, pageTitle, Region } from "../../components/common.tsx";
import { connectExistingFn } from "../../functions.ts";

export const Route = createFileRoute("/hosting/existing")({
  staticData: { crumb: "Connect an existing repository or database" },
  head: ({ match }) => pageTitle(match.staticData.crumb),
  component: ExistingPage,
});

/**
 * Going live with what the company has already: a GitHub repository and/or a Supabase project,
 * read, declared in `resources/sanoma/infra.ts` and bound by an apply that creates nothing.
 */
function ExistingPage() {
  const [repository, setRepository] = useState("");
  const [project, setProject] = useState("");
  const connect = useServerFn(connectExistingFn);
  const mutation = useMutation({
    mutationFn: (data: ConnectExistingRequest) => connect({ data }),
  });
  const body = errorBodyOf(mutation.error);
  const issue = (field: string) => body?.issues?.find((i) => i.path[0] === field)?.message;
  const error =
    mutation.error && !body?.issues?.some((i) => i.path.length) ? (body?.error ?? mutation.error.message) : undefined;
  const done = mutation.data;
  return (
    <>
      <CrumbHeader />
      <p className="max-w-prose text-sm text-muted-foreground">
        Sanoma reads each one, declares it in <code>resources/sanoma/infra.ts</code> as it is now, and binds it in the
        lockfile through an apply that creates and changes nothing. In a repository with a remote, the file waits on a
        branch for you to merge.
      </p>
      <form
        className="flex max-w-md flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({ repository: repository.trim() || undefined, project: project.trim() || undefined });
        }}
      >
        <FieldGroup>
          <Field data-invalid={issue("repository") ? true : undefined}>
            <FieldLabel htmlFor="existing-repository">GitHub repository</FieldLabel>
            <Input
              id="existing-repository"
              placeholder="owner/name"
              autoComplete="off"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              disabled={mutation.isPending}
            />
            {issue("repository") && <FieldError>{issue("repository")}</FieldError>}
          </Field>
          <Field data-invalid={issue("project") ? true : undefined}>
            <FieldLabel htmlFor="existing-project">Supabase project</FieldLabel>
            <Input
              id="existing-project"
              placeholder="project ref"
              autoComplete="off"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              disabled={mutation.isPending}
            />
            <FieldDescription>The ref in the project's dashboard address, after /project/.</FieldDescription>
            {issue("project") && <FieldError>{issue("project")}</FieldError>}
          </Field>
        </FieldGroup>
        {error && <Notice variant="destructive">{error}</Notice>}
        <div>
          <Button type="submit" disabled={mutation.isPending || done !== undefined}>
            {mutation.isPending && <Spinner data-icon="inline-start" />}
            Connect
          </Button>
        </div>
      </form>
      {done && (
        <Region title="Connected">
          <Notice>
            {done.branch ? (
              <>
                Committed <code>{done.file}</code> on the branch <code>{done.branch}</code>, now checked out: merge it
                to approve the change. Apply commits the lockfile's bindings there too.
              </>
            ) : (
              <>
                Wrote <code>{done.file}</code>
                {done.revision && (
                  <>
                    , committed as <code>{done.revision.slice(0, 7)}</code>
                  </>
                )}
                . Apply commits the lockfile's bindings next.
              </>
            )}{" "}
            <Link to="/runs/$id" params={{ id: done.runId }} className="underline underline-offset-4">
              See the apply run
            </Link>
          </Notice>
          {mutation.variables?.project && <Notice>{PASSWORD_NOTE.join(" ")}</Notice>}
          <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">
            {done.diff ?? done.text}
          </pre>
        </Region>
      )}
    </>
  );
}
