import type { WorkflowEntry } from "@sanoma/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { type ComponentProps, memo, useMemo } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Item, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import { Separator } from "#/components/ui/separator.tsx";
import { type Field, fieldsOf } from "../form/schema.ts";
import { configQuery, opsById } from "../queries.ts";
import { BUILTIN_ICON, ItemHeading, Json, None, Notice, OpItem, Section } from "./common.tsx";

// A workflow's pieces, as the workflows page's cards and a workflow's own page show them.

/** Run: opens the workflow's page with its New run panel (`?new`). A Button otherwise, styled as given. */
export function RunButton({
  name,
  ...props
}: { name: string } & Omit<ComponentProps<typeof Button>, "asChild" | "children">) {
  return (
    <Button asChild {...props}>
      <Link to="/workflows/$name" params={{ name }} search={{ new: true }}>
        <PlayIcon data-icon="inline-start" />
        Run
      </Link>
    </Button>
  );
}

/** Where a pane of a retired workflow's page would be: the config no longer has it, but its runs remain. */
export function Retired({ name }: { name: string }) {
  return (
    <Notice>
      This config has no workflow named <code>{name}</code>. Its past runs are in the rail.
    </Notice>
  );
}

/** What a workflow may call, the built-ins it uses and its input, one section each. */
export const WorkflowSections = memo(function WorkflowSections({ workflow }: { workflow: WorkflowEntry }) {
  const { data: ops } = useSuspenseQuery({ ...configQuery(), select: opsById });
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
    </>
  );
});

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
