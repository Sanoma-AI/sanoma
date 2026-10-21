import type { ConfigDescription, SiteCall, WorkflowEntry } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { configQuery, opsById } from "../queries.ts";
import { BUILTIN_ICON, ItemHeading, Json, LinkItem, None, Notice, OpItem, Section } from "./common.tsx";

// A workflow's pieces, as a workflow's own page shows them.

/** Where a pane of a retired workflow's page would be: the config no longer has it, but its runs remain. */
export function Retired({ name }: { name: string }) {
  return (
    <Notice>
      This config has no workflow named <code>{name}</code>. Its past runs are in the panel.
    </Notice>
  );
}

/** What a workflow may call, the built-ins it uses, its input and the sites' pages that call it, one section each. */
export const WorkflowSections = memo(function WorkflowSections({ workflow }: { workflow: WorkflowEntry }) {
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
  const { data: callers } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => siteCallers(config, "workflow", workflow.name),
  });
  const fields = useMemo(() => fieldsOf(workflow.input), [workflow.input]);
  return (
    <>
      <Section title="Operations it may call">
        {workflow.ops.length === 0 ? (
          <None />
        ) : (
          <ItemGroup>
            {workflow.ops.map((id) => (
              <OpItem key={id} id={id} op={ops.get(id)} />
            ))}
          </ItemGroup>
        )}
      </Section>
      <Separator />
      <Section title="Built-ins">
        {workflow.builtins.length ? (
          <div className="flex flex-wrap gap-1.5">
            {workflow.builtins.map((b) => {
              const Icon = BUILTIN_ICON[b];
              return (
                <Badge key={b} variant="outline">
                  <Icon data-icon="inline-start" />
                  {b}
                </Badge>
              );
            })}
          </div>
        ) : (
          <None />
        )}
      </Section>
      <Separator />
      <Section title="Input">
        {fields ? (
          fields.length === 0 ? (
            <None>No fields.</None>
          ) : (
            <InputFields fields={fields} />
          )
        ) : (
          <Json value={workflow.input} />
        )}
      </Section>
      <Separator />
      <Section title="Used by">
        <SiteCallers callers={callers} />
      </Section>
    </>
  );
});

/** A site's file that calls something, and how: its page, when the file is one. */
export interface SiteCaller {
  /** The site's title, else its name. */
  site: string;
  file: string;
  page?: string;
  via: SiteCall["via"][];
}

/** The sites' files that call the workflow, collection or operation, each once, in the sites' order. */
export function siteCallers(config: ConfigDescription, kind: SiteCall["kind"], target: string): SiteCaller[] {
  const byFile = new Map<string, SiteCaller>();
  for (const site of config.sites) {
    for (const { kind: k, target: t, via, file, page } of site.calls) {
      if (k !== kind || t !== target) continue;
      const caller = byFile.get(file) ?? { site: site.title ?? site.name, file, ...(page && { page }), via: [] };
      if (!caller.via.includes(via)) caller.via.push(via);
      byFile.set(file, caller);
    }
  }
  return [...byFile.values()];
}

/**
 * Each site's file that calls something, under the site's title: a page links to itself (but one
 * with a path parameter, which has no one URL); a component's file names the file.
 */
export function SiteCallers({ callers }: { callers: SiteCaller[] }) {
  if (!callers.length) return <None>No site calls it.</None>;
  return (
    <ItemGroup>
      {callers.map(({ site, file, page, via }) => {
        const content = (
          <ItemContent>
            <ItemTitle>
              {site}
              <code className="font-normal text-muted-foreground">{page ?? file}</code>
            </ItemTitle>
            <ItemDescription>through {via.join(" and ")}</ItemDescription>
          </ItemContent>
        );
        return page && !page.includes("$") ? (
          <LinkItem key={file} variant="outline" size="xs">
            <Link to={page}>
              {content}
              <ItemActions>
                <ChevronRightIcon className="size-4" />
              </ItemActions>
            </Link>
          </LinkItem>
        ) : (
          <Item key={file} role="listitem" variant="outline" size="xs">
            {content}
          </Item>
        );
      })}
    </ItemGroup>
  );
}

const kindName = (f: Field): string =>
  f.kind === "array" ? `list of ${kindName(f.item)}` : f.kind === "json" ? "JSON" : f.kind;

function InputFields({ fields }: { fields: Field[] }) {
  return (
    <ItemGroup>
      {fields.map((field) => (
        <Item key={field.key} role="listitem" variant="outline" size="xs">
          <ItemContent>
            <ItemHeading>
              <code>{field.key}</code>
              <span className="font-normal text-muted-foreground">{kindName(field)}</span>
              {field.required && <Badge variant="outline">required</Badge>}
            </ItemHeading>
            {(field.description || field.default !== undefined) && (
              <ItemDescription>
                {[field.description, field.default !== undefined && `default ${JSON.stringify(field.default)}`]
                  .filter(Boolean)
                  .join(" · ")}
              </ItemDescription>
            )}
            {field.kind === "object" && <InputFields fields={field.fields} />}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}
