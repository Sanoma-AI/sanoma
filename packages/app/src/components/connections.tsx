import type { ConnectionCard, ConnectionReview, ConnectionTarget } from "@sanoma-ai/workflows";
import { CALL_WORKFLOW } from "@sanoma-ai/workflows/shared";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import { useActor } from "../actor.ts";
import { type ConnectionsResponse, errorBodyOf } from "../api.ts";
import { connectConnectionFn, disconnectConnectionFn, previewConnectionFn, testConnectionFn } from "../functions.ts";
import { configQuery, connectionsQuery, runLink } from "../queries.ts";
import { secureFields, secureInput } from "../form/secure-fields.ts";
import { ItemHeading, Notice, Region, ToneBadge, When } from "./common.tsx";

/** Accounts and secure input are scoped to the current actor, including the query cache. */
export function Connections({ vendor }: { vendor: string }) {
  const { actor } = useActor();
  if (!actor) return <Notice>Sign in to manage connections.</Notice>;
  return <ConnectionList key={actor} vendor={vendor} actor={actor} />;
}

function ConnectionList({ vendor, actor }: { vendor: string; actor: string }) {
  const query = useQuery({ ...connectionsQuery(), queryKey: ["connections", actor] });
  const [creating, setCreating] = useState<string>();
  if (query.error) return <ConnectionFailure error={query.error} />;
  if (!query.data) return <Notice>Loading connections…</Notice>;
  const data = query.data;
  const cards = data.cards.filter((card) => card.vendor === vendor);
  const rules = data.rules.filter((rule) => rule.vendor === vendor);
  if (!cards.length && !rules.length) return null;
  return (
    <Region title="Connections">
      <p className="text-muted-foreground">
        Accounts and requirements are declared in code. Actions follow your company’s policies.
      </p>
      <ItemGroup>
        {cards.map((card) => (
          <ConnectionRow key={card.id} card={card} data={data} />
        ))}
      </ItemGroup>
      {rules.map((rule) => (
        <div key={rule.id}>
          <Button variant="outline" onClick={() => setCreating(rule.id)}>
            Connect account · {rule.name}
          </Button>
          {creating === rule.id && (
            <ConnectionDialog
              name={rule.name}
              target={{ rule: rule.id }}
              method={data.methods[vendor]?.[rule.method]}
              store={data.store}
              onClose={() => setCreating(undefined)}
            />
          )}
        </div>
      ))}
      <p className="text-sm text-muted-foreground">
        Workflows using this connector may select these accounts. Each call checks the selected account and its
        permissions.
      </p>
    </Region>
  );
}

/** The selected deployment store, not a second mutable settings source. Shared with onboarding. */
export function SecretStorage() {
  const { actor } = useActor();
  const { data: config } = useSuspenseQuery(configQuery());
  const query = useQuery({ ...connectionsQuery(), queryKey: ["connections", actor ?? ""], enabled: !!actor });
  const selected = config.secrets;
  if (!selected) return null;
  return (
    <Region title="Secret storage">
      <p>
        <strong>{selected.store}</strong> · namespace <code>{selected.namespace}</code>
      </p>
      <p className="text-sm text-muted-foreground">
        The store, namespace and bindings come from your company’s code. Change them there to select another provider.
        Moving existing values requires an explicit transfer.
      </p>
      {query.data && (
        <p>
          {query.data.store.ready ? "Store access checked" : `Store needs attention: ${query.data.store.problem}`} ·{" "}
          {query.data.store.capabilities.writable
            ? "Sanoma can manage values"
            : "Read-only store; values are managed externally"}
        </p>
      )}
      {query.error && <ConnectionFailure error={query.error} />}
      {!actor && <Notice>Sign in to check store access.</Notice>}
      {selected.store === "postgres" && (
        <p className="text-sm text-muted-foreground">
          The built-in store encrypts credentials in your database. Local setup creates its protection key
          automatically; hosted deployments supply it separately as SANOMA_SECRETS_KEY or SANOMA_SECRETS_KEY_FILE.
        </p>
      )}
      {Object.entries(selected.bindings).length > 0 && (
        <dl className="grid gap-2 text-sm">
          {Object.entries(selected.bindings).map(([name, binding]) => (
            <div key={name}>
              <dt className="font-mono">{name}</dt>
              <dd>
                {binding.store} · {binding.path} ·{" "}
                {binding.management === "external" ? "Managed externally" : "Managed by Sanoma"}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Region>
  );
}

type Method = ConnectionsResponse["methods"][string][string] | undefined;

function ConnectionRow({ card, data }: { card: ConnectionCard; data: ConnectionsResponse }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [request, setRequest] = useState<{ action: string; id: string }>();
  const queryClient = useQueryClient();
  const test = useServerFn(testConnectionFn);
  const disconnect = useServerFn(disconnectConnectionFn);
  const method = data.methods[card.vendor]?.[card.method];
  const external = card.location?.management === "external" || !data.store.capabilities.writable;
  const state = card.status === "connected" ? (card.health?.state ?? "connected") : card.status;
  async function act(action: "test" | "disconnect") {
    setBusy(true);
    setError(undefined);
    const requestId = request?.action === action ? request.id : crypto.randomUUID();
    setRequest({ action, id: requestId });
    const connection = { vendor: card.vendor, $connection: card.id };
    try {
      if (action === "test") await test({ data: { connection, requestId } });
      else await disconnect({ data: { connection, expectedRevision: card.revision!, requestId } });
      setRequest(undefined);
      await queryClient.invalidateQueries({ queryKey: ["connections"] });
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Item variant="outline" role="listitem">
      <ItemContent>
        <ItemHeading>
          <code>{card.name}</code>
          <ToneBadge tone={state === "connected" ? "ok" : "off"}>{state.replaceAll("_", " ")}</ToneBadge>
        </ItemHeading>
        <ItemDescription className="line-clamp-none">
          {card.account ? `Account: ${card.account}` : "No verified account"} · {card.method} ·{" "}
          {card.owner ? `Owned by ${card.owner}` : "Company connection"}
        </ItemDescription>
        <ItemDescription>
          Granted scopes: {card.scopes.join(", ") || "none reported"}. Required:{" "}
          {card.requiredScopes.join(", ") || "none"}.
        </ItemDescription>
        {card.location && (
          <ItemDescription className="line-clamp-none">
            {card.location.store} · {card.location.namespace} · {card.location.path} ·{" "}
            {external ? "Managed externally" : "Managed by Sanoma"}
          </ItemDescription>
        )}
        {external && (
          <ItemDescription>
            Replace or renew credentials at the management location above, then Test. Disconnect does not delete the
            external value.
          </ItemDescription>
        )}
        {card.health && (
          <ItemDescription>
            Last checked <When at={Date.parse(card.health.checkedAt)} />
            {card.health.externallyRenewed && " · Externally renewed"}
          </ItemDescription>
        )}
        {card.updatedBy && card.updatedAt && (
          <ItemDescription>
            Changed by {card.updatedBy} · <When at={Date.parse(card.updatedAt)} />
          </ItemDescription>
        )}
        {error !== undefined && <ConnectionFailure error={error} />}
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          disabled={busy || !method?.verifiable || !data.store.ready}
          onClick={() => setEditing(true)}
        >
          {external ? "Review connection" : card.account ? "Replace credentials" : "Connect"}
        </Button>
        {method?.verifiable && (
          <Button variant="outline" disabled={busy} onClick={() => void act("test")}>
            Test
          </Button>
        )}
        {card.revision && card.status !== "disconnected" && (
          <Button variant="ghost" disabled={busy} onClick={() => void act("disconnect")}>
            Disconnect
          </Button>
        )}
      </ItemActions>
      {editing && (
        <ConnectionDialog
          name={card.name}
          target={{ connection: { vendor: card.vendor, $connection: card.id } }}
          method={method}
          card={card}
          store={data.store}
          onClose={() => setEditing(false)}
        />
      )}
    </Item>
  );
}

/** Values live only in this mounted form. No query/mutation cache, URL, browser storage or chat. */
function ConnectionDialog({
  name,
  target,
  method,
  card,
  store,
  onClose,
}: {
  name: string;
  target: ConnectionTarget;
  method: Method;
  card?: ConnectionCard;
  store: ConnectionsResponse["store"];
  onClose(): void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>({});
  const [review, setReview] = useState<ConnectionReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const preview = useServerFn(previewConnectionFn);
  const connect = useServerFn(connectConnectionFn);
  const queryClient = useQueryClient();
  const external = card?.location?.management === "external" || !store.capabilities.writable;
  const identity = method?.kind === "workload-identity";
  const oauth = method?.kind === "oauth2";
  const enter = !external && !identity && !oauth;
  const fields = secureFields(method?.schema ?? {});
  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const credentials = enter ? secureInput(fields, values) : undefined;
      if (review) {
        await connect({ data: { review, credentials } });
        setValues({});
        onClose();
        await queryClient.invalidateQueries({ queryKey: ["connections"] });
      } else setReview(await preview({ data: { target, credentials, requestId } }));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          setValues({});
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {review ? "Review connection" : "Connect"} · {name}
            </DialogTitle>
            <DialogDescription>
              {external
                ? "Read the existing credentials from the declared management location and verify the account."
                : identity
                  ? "Verify the deployment’s workload identity."
                  : "Enter credentials securely. They are never included in an approval or workflow history."}
            </DialogDescription>
          </DialogHeader>
          {oauth && !external && (
            <Notice>
              This method needs an OAuth consent flow. Connect and Reconnect will be available when this connector
              supplies that capability.
            </Notice>
          )}
          {!method?.verifiable && <Notice>This authentication method does not supply account verification.</Notice>}
          {enter &&
            fields.map((field) => (
              <Field key={field.key}>
                <FieldLabel htmlFor={`connection-${field.key}`}>
                  {field.label}
                  {field.required ? " *" : ""}
                </FieldLabel>
                <Input
                  id={`connection-${field.key}`}
                  type="password"
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  spellCheck={false}
                  required={field.required}
                  disabled={busy || !!review}
                  value={values[field.key] ?? ""}
                  onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
                />
                {field.description && <FieldDescription>{field.description}</FieldDescription>}
                {field.json && <FieldDescription>Enter this field as JSON.</FieldDescription>}
              </Field>
            ))}
          {review && (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                <strong>Verified account:</strong> {review.account}
              </p>
              {review.previousAccount && review.previousAccount !== review.account && (
                <Notice>
                  Changes account from {review.previousAccount} to {review.account}. Workflows selecting this connection
                  will use the new account.
                </Notice>
              )}
              <p>
                <strong>Granted scopes:</strong> {review.scopes.join(", ") || "none reported"}
              </p>
              <p>
                <strong>Destination:</strong>{" "}
                {review.location
                  ? `${review.location.store} · ${review.location.namespace} · ${review.location.path}`
                  : "Deployment identity; no stored credential"}
              </p>
              <p>
                {external
                  ? "Uses the existing value; Sanoma will not replace or delete it."
                  : "Saving pauses this connection until the stored credentials are verified and activation is authorized."}
              </p>
            </div>
          )}
          {error !== undefined && <ConnectionFailure error={error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setValues({});
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !method?.verifiable || (oauth && !external) || !store.ready}>
              {busy ? "Checking…" : review ? "Save connection" : "Verify and review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionFailure({ error }: { error: unknown }) {
  const body = errorBodyOf(error);
  return (
    <Notice variant="destructive">
      {body?.code === "approval_pending" && body.runId ? (
        <>
          Waiting for approval.{" "}
          <Link
            {...runLink({ workflow: CALL_WORKFLOW, runId: body.runId })}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Review the request
          </Link>
          , then retry this action. Credentials stay in this form only while it is open.
        </>
      ) : (
        (body?.error ?? (error instanceof Error ? error.message : "Could not complete this connection action"))
      )}
    </Notice>
  );
}
