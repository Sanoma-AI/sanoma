import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import type { ConfigDescription } from "sanoma/workflows/describe";
import { FunctionIcon } from "@phosphor-icons/react/dist/csr/Function";
import { useCallback, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { ItemGroup } from "#/components/ui/item.tsx";
import {
  CodePanel,
  CrumbHeader,
  effectBadge,
  Json,
  loadCode,
  None,
  Notice,
  OpItem,
  PanelCard,
  pageTitle,
  Region,
  UsedBy,
} from "../../components/common.tsx";
import { InputFields } from "../../components/workflow.tsx";
import { fieldsOf } from "../../form/schema.ts";
import {
  callersOf,
  companyOpNamed,
  configQuery,
  operationFile,
  opsById,
  siteCallers,
  sourceQuery,
} from "../../queries.ts";

// `/connectors/operations/<name>`: one of the company's own operations (`defineOperation`), listed
// under Yours on the Connectors page. The runtime refuses a connector of the vendor `operations`,
// so no `$vendor` page can be at this path.
export const Route = createFileRoute("/connectors/operations/$name")({
  // The page reads the config and the operation's file from the query client.
  loader: async ({ context: { queryClient }, params }) => {
    if (!import.meta.env.SSR) void loadCode();
    const config = await queryClient.query({ ...configQuery(), staleTime: "static" });
    const op = companyOpNamed(params.name)(config);
    if (!op) throw notFound();
    if (op.file !== undefined) await queryClient.query({ ...sourceQuery(op.file), staleTime: "static" });
    return { crumb: op.name };
  },
  head: ({ params }) => pageTitle(params.name),
  component: OperationPage,
  notFoundComponent: () => <Notice variant="destructive">No operation {Route.useParams().name}.</Notice>,
});

/**
 * One of the company's own operations, on one page: who may call it and from where, what it takes
 * and returns, what it calls (each linking to where it is shown), its code, and what calls it.
 */
function OperationPage() {
  const { name } = Route.useParams();
  const select = useCallback(
    (config: ConfigDescription) => {
      const op = companyOpNamed(name)(config)!;
      const ops = opsById(config);
      return {
        op,
        calls: (op.ops ?? []).map((id) => ({ id, entry: ops.get(id) })),
        callers: { ...callersOf(config, [op.id]), sites: siteCallers(config, "op", op.id) },
      };
    },
    [name],
  );
  const {
    data: { op, calls, callers },
  } = useSuspenseQuery({ ...configQuery(), select });
  // What keeps it from a page: the calls inside it that may not be made from one.
  const workflowOnly = calls.filter((call) => call.entry?.direct === false).map((call) => call.id);
  return (
    <>
      <CrumbHeader icon={<FunctionIcon aria-hidden="true" className="size-7 text-muted-foreground" />}>
        <code className="text-muted-foreground">{op.id}</code>
        <Badge className={effectBadge({ effect: op.effect })}>{op.effect}</Badge>
      </CrumbHeader>
      <p>
        {op.direct ? (
          "Pages and workflows can call it."
        ) : (
          <>
            Only workflows can call it
            {workflowOnly.length > 0 && (
              <>
                : it calls{" "}
                {workflowOnly.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <code>{id}</code>
                  </span>
                ))}
              </>
            )}
            .
          </>
        )}{" "}
        Who may call it is set in{" "}
        <Link
          to="/permissions"
          search={op.app === undefined ? {} : { app: op.app }}
          // A direct operation has a row of its own there; one only workflows call is under each.
          hash={op.direct ? op.id : undefined}
        >
          Permissions
        </Link>
        .
      </p>
      {op.description && <p className="text-muted-foreground">{op.description}</p>}
      <Region title="Takes">
        <Fields schema={op.input} />
      </Region>
      <Region title="Returns">
        <Fields schema={op.output} />
      </Region>
      <Region title="Calls">
        {calls.length === 0 ? (
          <None />
        ) : (
          <ItemGroup>
            {calls.map(({ id, entry }) => (
              <OpItem key={id} id={id} op={entry} link />
            ))}
          </ItemGroup>
        )}
      </Region>
      {op.file !== undefined && <Code file={op.file} shown={operationFile(op)} />}
      <UsedBy {...callers} />
    </>
  );
}

/**
 * A JSON Schema's fields, each with its kind; the schema itself when it is not an object's, and
 * "Not declared." when it says nothing (an operation with no `output`).
 */
function Fields({ schema }: { schema: Record<string, unknown> }) {
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  if (Object.keys(schema).every((key) => key === "$schema")) return <None>Not declared.</None>;
  if (!fields) return <Json value={schema} />;
  return fields.length === 0 ? <None>No fields.</None> : <InputFields fields={fields} />;
}

/** The operation's file, as it is now, under its path from the company's root. */
function Code({ file, shown }: { file: string; shown: string }) {
  const { data } = useSuspenseQuery(sourceQuery(file));
  return (
    <Region
      title={
        <>
          Code <code className="font-normal text-muted-foreground">{shown}</code>
        </>
      }
    >
      {data.source === null ? (
        <Notice variant="destructive">{shown} can no longer be read.</Notice>
      ) : (
        <PanelCard>
          <CodePanel source={data.source} />
        </PanelCard>
      )}
    </Region>
  );
}
