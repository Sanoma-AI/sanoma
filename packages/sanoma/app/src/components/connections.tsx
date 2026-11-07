import type {
  AttemptStatus,
  ConnectionCard,
  ConnectionReview,
  ConnectionTarget,
  RenewalOutcome,
  SecretLocation,
} from "sanoma/workflows";
import { CALL_WORKFLOW, CONNECT_WORKFLOW, STORAGE_ADVICE, STORAGE_PROBLEMS } from "sanoma/workflows/shared";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
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
import { CALLBACK_ERRORS, type CallbackErrorReason, type ConnectionsResponse, errorBodyOf } from "../api.ts";
import {
  authorizeConnectionFn,
  connectConnectionFn,
  connectionAttemptFn,
  disconnectConnectionFn,
  previewConnectionFn,
  testConnectionFn,
} from "../functions.ts";
import { configQuery, connectionsQuery, runLink } from "../queries.ts";
import { secureFields, secureInput } from "../form/secure-fields.ts";
import { ItemHeading, Notice, Region, ToneBadge, When } from "./common.tsx";
import { StoreMoves } from "./store-move.tsx";

/** Where an OAuth callback sent the person back to: the attempt to follow, or why it ended. */
export interface CallbackOutcome {
  connection?: string;
  attempt?: string;
  error?: CallbackErrorReason;
}

/** Accounts and secure input are scoped to the current actor, including the query cache. */
export function Connections({ vendor, callback }: { vendor?: string; callback?: CallbackOutcome }) {
  const { actor } = useActor();
  if (!actor) return <Notice>Sign in to manage connections.</Notice>;
  return <ConnectionList key={actor} vendor={vendor} actor={actor} callback={callback} />;
}

/** How each authentication kind is named on the page. */
const KIND_LABELS: Record<string, string> = {
  "api-key": "API key",
  fields: "credentials",
  signed: "signing key",
  oauth2: "OAuth consent",
};

function ConnectionList({ vendor, actor, callback }: { vendor?: string; actor: string; callback?: CallbackOutcome }) {
  const query = useQuery({ ...connectionsQuery(), queryKey: ["connections", actor] });
  const [creating, setCreating] = useState<string>();
  const [started, setStarted] = useState<{ rule: string; attempt: string }>();
  const [dismissed, setDismissed] = useState(false);
  if (query.error) return <ConnectionFailure error={query.error} />;
  if (!query.data) return <Notice>Loading connections…</Notice>;
  const data = query.data;
  const cards = data.cards.filter((card) => !vendor || card.vendor === vendor);
  const rules = data.rules.filter((rule) => !vendor || rule.vendor === vendor);
  if (!cards.length && !rules.length) return null;
  const methods = vendor ? Object.entries(data.methods[vendor] ?? {}) : [];
  // A callback for an account a rule creates: no card holds it until the exchange stores it.
  const unheld =
    callback?.attempt && !dismissed && !cards.some((card) => card.id === callback.connection)
      ? callback.attempt
      : undefined;
  return (
    <Region title="Connections">
      <p className="text-muted-foreground">
        Accounts and requirements are declared in code. Actions follow your company’s policies.
      </p>
      {methods.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Ways to connect:{" "}
          {methods.map(([name, method], index) => (
            <span key={name}>
              {index > 0 && ", "}
              <code>{name}</code> ({KIND_LABELS[method.kind] ?? method.kind})
            </span>
          ))}
        </p>
      )}
      {callback?.error && <Notice variant="destructive">{CALLBACK_ERRORS[callback.error]}</Notice>}
      {unheld && (
        <AttemptProgress
          attempt={unheld}
          vendor={vendor ?? callback?.connection?.split("/")[0] ?? "the provider"}
          onDismiss={() => setDismissed(true)}
        />
      )}
      <ItemGroup>
        {cards.map((card) => (
          <ConnectionRow
            key={card.id}
            card={card}
            data={data}
            attempt={callback?.connection === card.id ? callback.attempt : undefined}
          />
        ))}
      </ItemGroup>
      {rules.map((rule) => (
        <div key={rule.id}>
          <Button variant="outline" disabled={!canWrite(data.store)} onClick={() => setCreating(rule.id)}>
            Connect account · {rule.name}
          </Button>
          {!canWrite(data.store) && (
            <p className="text-sm text-muted-foreground">
              This store cannot safely create account credentials. Declare a named connection with an external binding
              to review an existing account.
            </p>
          )}
          {creating === rule.id &&
            (data.methods[rule.vendor]?.[rule.method]?.kind === "oauth2" ? (
              <ConsentDialog
                name={rule.name}
                vendor={rule.vendor}
                target={{ rule: rule.id }}
                onStarted={(attempt) => setStarted({ rule: rule.id, attempt })}
                onClose={() => setCreating(undefined)}
              />
            ) : (
              <ConnectionDialog
                name={rule.name}
                target={{ rule: rule.id }}
                method={data.methods[rule.vendor]?.[rule.method]}
                store={data.store}
                onClose={() => setCreating(undefined)}
              />
            ))}
          {started?.rule === rule.id && (
            <AttemptProgress attempt={started.attempt} vendor={rule.vendor} onDismiss={() => setStarted(undefined)} />
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
  const stores = selected.stores ?? {};
  return (
    <Region title="Secret storage">
      <p>
        <strong>{selected.store}</strong> · namespace <code>{selected.namespace}</code>
      </p>
      <p className="text-sm text-muted-foreground">
        The store, namespace and bindings come from your company’s code. Change them there to select another provider.
        {Object.keys(stores).length > 0
          ? " To take the values along, move them to one of the other stores it names first."
          : " To take the values along, name the new store under secrets.stores and move them."}
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
      {query.data && (
        <ul className="text-sm text-muted-foreground">
          {query.data.bootstrap.map((key) => (
            <li key={key.name}>
              <code>{key.name}</code>:{" "}
              {key.ready
                ? `ready · ${key.delivery}`
                : `needs configuration · supply either ${key.name} or ${key.name}_FILE`}
            </li>
          ))}
        </ul>
      )}
      {!actor && <Notice>Sign in to check store access.</Notice>}
      {actor && Object.keys(stores).length > 0 && <StoreMoves actor={actor} stores={stores} />}
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

/** Health and renewal states only a new consent fixes. */
const RECONNECT: ReadonlySet<string> = new Set(["expired", "revoked", "rejected", "uncertain", "missing"]);
/** Why a renewal failed, as the card says it: never the provider's words. */
const RENEWAL_PROBLEMS: Partial<Record<RenewalOutcome, string>> = {
  revoked: "the provider no longer accepts the refresh token",
  rejected: "the provider refused the renewal",
  expired: "the grant has no refresh token",
  unavailable: "the provider could not be reached; it is tried again",
  uncertain: "the provider may have renewed the grant and it was not stored",
};
const canWrite = (store: ConnectionsResponse["store"]) =>
  store.capabilities.writable && store.capabilities.conditionalWrites !== "none";

function ConnectionRow({
  card,
  data,
  attempt: returned,
}: {
  card: ConnectionsResponse["cards"][number];
  data: ConnectionsResponse;
  attempt?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [attempt, setAttempt] = useState(returned);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [request, setRequest] = useState<{ action: string; id: string }>();
  const queryClient = useQueryClient();
  const test = useServerFn(testConnectionFn);
  const disconnect = useServerFn(disconnectConnectionFn);
  const method = data.methods[card.vendor]?.[card.method];
  const external = card.location?.management === "external" || !data.store.capabilities.writable;
  const oauth = method?.kind === "oauth2";
  const unsupportedWrite = !external && !canWrite(data.store);
  const state = card.status === "connected" ? (card.health?.state ?? "connected") : card.status;
  const renewalProblem = card.renewal?.outcome !== "refreshed" ? card.renewal?.outcome : undefined;
  // Only a new consent helps: the grant is gone at the provider, or may have been renewed and not kept.
  const needsReconnect =
    oauth && card.status !== "disconnected" && (RECONNECT.has(state) || RECONNECT.has(renewalProblem ?? ""));
  const disconnectable = oauth && !!card.revision && card.status !== "disconnected";
  async function act(action: "test" | "disconnect" | "revoke") {
    setBusy(true);
    setError(undefined);
    const requestId = request?.action === action ? request.id : crypto.randomUUID();
    setRequest({ action, id: requestId });
    const connection = { vendor: card.vendor, $connection: card.id };
    try {
      if (action === "test") await test({ data: { connection, requestId } });
      else
        await disconnect({
          data: { connection, expectedRevision: card.revision!, requestId, revoke: action === "revoke" },
        });
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
          <ToneBadge tone={state === "connected" && !needsReconnect ? "ok" : "off"}>
            {needsReconnect ? "needs reconnect" : state.replaceAll("_", " ")}
          </ToneBadge>
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
        {card.boundLocation && changedLocation(card.boundLocation, card.location) && (
          <ItemDescription className="line-clamp-none">
            Previously bound to {locationLabel(card.boundLocation)}. Review the new destination before reconnecting.
          </ItemDescription>
        )}
        {external && (
          <ItemDescription className="line-clamp-none">
            Replace or renew credentials at the management location above, then Test. Disconnect does not delete the
            external value.
          </ItemDescription>
        )}
        {oauth && external && (
          <ItemDescription className="line-clamp-none">
            OAuth needs a store Sanoma can write, with conditional writes, to keep each grant. This connection’s store
            is read-only: select a writable store in code to connect it.
          </ItemDescription>
        )}
        {card.health && (
          <ItemDescription>
            Last checked <When at={Date.parse(card.health.checkedAt)} />
            {card.health.externallyRenewed && " · Externally renewed"}
            {card.health.expiresAt && (
              <>
                {" "}
                · Valid until{" "}
                <time dateTime={card.health.expiresAt}>{new Date(card.health.expiresAt).toLocaleString()}</time>
              </>
            )}
          </ItemDescription>
        )}
        {card.renewal?.refreshedAt && (
          <ItemDescription>
            Renewed <When at={Date.parse(card.renewal.refreshedAt)} />
            {card.renewal.dueAt && (
              <>
                {" "}
                · Next renewal{" "}
                <time dateTime={card.renewal.dueAt}>{new Date(card.renewal.dueAt).toLocaleString()}</time>
              </>
            )}
          </ItemDescription>
        )}
        {renewalProblem && card.status === "connected" && !needsReconnect && (
          <ItemDescription className="line-clamp-none">
            The last renewal failed: {RENEWAL_PROBLEMS[renewalProblem] ?? renewalProblem.replaceAll("_", " ")}.
          </ItemDescription>
        )}
        {card.storageProblem && (
          <ItemDescription className="line-clamp-none">
            This method {STORAGE_PROBLEMS[card.storageProblem]}. Before connecting, change your company’s code:{" "}
            {STORAGE_ADVICE[card.storageProblem]}.
          </ItemDescription>
        )}
        {oauth && card.status === "uncertain" && (
          <ItemDescription className="line-clamp-none">
            The provider may have issued or renewed a grant that was not stored, so Sanoma stopped using this account.
            Reconnect to authorize a new one.
          </ItemDescription>
        )}
        {needsReconnect && card.status !== "uncertain" && (
          <ItemDescription className="line-clamp-none">
            {renewalProblem && RENEWAL_PROBLEMS[renewalProblem]
              ? `The last renewal failed: ${RENEWAL_PROBLEMS[renewalProblem]}.`
              : "The provider no longer accepts this grant."}{" "}
            Reconnect to authorize a new one.
          </ItemDescription>
        )}
        {disconnectable && (
          <ItemDescription className="line-clamp-none">
            Disconnect deletes the grant Sanoma keeps and leaves the OAuth application for other accounts.
            {method?.revocable
              ? " Revoke also asks the provider to end the authorization."
              : " The provider’s own authorization stays: revoke it in the provider’s settings."}{" "}
            Calls already sent are not undone.
          </ItemDescription>
        )}
        {attempt && <AttemptProgress attempt={attempt} vendor={card.vendor} onDismiss={() => setAttempt(undefined)} />}
        {unsupportedWrite && !card.storageProblem && (
          <ItemDescription className="line-clamp-none">
            This store lacks conditional writes. Use an external binding or select a store that supports safe credential
            replacement.
          </ItemDescription>
        )}
        {card.updatedBy && card.updatedAt && (
          <ItemDescription>
            Changed by {card.updatedBy} · <When at={Date.parse(card.updatedAt)} />
          </ItemDescription>
        )}
        <div className="text-sm text-muted-foreground">
          {card.workflows.length ? (
            <>
              <span>Workflows: </span>
              {card.workflows.map((workflow, index) => (
                <span key={workflow.name}>
                  {index > 0 && ", "}
                  <Link to="/workflows/$name" params={{ name: workflow.name }} className="underline">
                    {workflow.title}
                  </Link>
                  {workflow.selection === "possible" && " (account chosen at runtime)"}
                </span>
              ))}
            </>
          ) : (
            "No workflow dependencies found in code."
          )}
        </div>
        {error !== undefined && <ConnectionFailure error={error} />}
      </ItemContent>
      <ItemActions>
        <Button
          variant="outline"
          disabled={
            busy ||
            !method?.verifiable ||
            !data.store.ready ||
            (oauth && external) ||
            unsupportedWrite ||
            !!card.storageProblem
          }
          onClick={() => setEditing(true)}
        >
          {external
            ? "Review connection"
            : oauth
              ? card.account
                ? "Reconnect"
                : "Connect account"
              : card.account
                ? "Replace credentials"
                : "Connect"}
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
        {disconnectable && method?.revocable && (
          <Button variant="ghost" disabled={busy} onClick={() => void act("revoke")}>
            Revoke
          </Button>
        )}
      </ItemActions>
      {editing &&
        (oauth ? (
          <ConsentDialog
            name={card.name}
            vendor={card.vendor}
            target={{ connection: { vendor: card.vendor, $connection: card.id } }}
            onStarted={setAttempt}
            onClose={() => setEditing(false)}
          />
        ) : (
          <ConnectionDialog
            name={card.name}
            target={{ connection: { vendor: card.vendor, $connection: card.id } }}
            method={method}
            card={card}
            store={data.store}
            onClose={() => setEditing(false)}
          />
        ))}
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
  const enter = !external;
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
                : "Enter credentials securely. They are never included in an approval or workflow history."}
            </DialogDescription>
          </DialogHeader>
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
                  : "No secret store is configured"}
              </p>
              {review.previousLocation && changedLocation(review.previousLocation, review.location) && (
                <Notice>
                  Changes storage from {locationLabel(review.previousLocation)} to {locationLabel(review.location)}. The
                  previous stored value is retained; this action does not transfer or delete it.
                </Notice>
              )}
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
            <Button type="submit" disabled={busy || !method?.verifiable || !store.ready}>
              {busy ? "Checking…" : review ? "Save connection" : "Verify and review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * OAuth Connect and Reconnect: the company's OAuth application, entered here when it is new or
 * replaced (kept in this mounted form only, as any credential), then the provider's consent in a
 * new tab. The attempt's progress shows on the card; the tab comes back to this page.
 */
function ConsentDialog({
  name,
  vendor,
  target,
  onStarted,
  onClose,
}: {
  name: string;
  vendor: string;
  target: ConnectionTarget;
  onStarted(attempt: string): void;
  onClose(): void;
}) {
  // One request per input: a retry reuses it (an approval holds it), new credentials are a new one.
  const [request, setRequest] = useState<{ id: string; replaces: boolean }>();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const authorize = useServerFn(authorizeConnectionFn);
  const close = () => {
    setClientSecret("");
    onClose();
  };
  async function submit() {
    setBusy(true);
    setError(undefined);
    // Opened in the click, so no popup blocker stops it; pointed at the provider once the attempt exists.
    const tab = window.open("", "_blank");
    try {
      const replaces = Boolean(clientId || clientSecret);
      const requestId = request?.replaces === replaces ? request.id : crypto.randomUUID();
      setRequest({ id: requestId, replaces });
      const entered = replaces ? { client: { clientId, clientSecret } } : {};
      const { url, attempt } = await authorize({ data: { target, requestId, ...entered } });
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.location.assign(url);
      onStarted(attempt);
      close();
    } catch (failure) {
      tab?.close();
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && close()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Connect · {name}</DialogTitle>
            <DialogDescription>
              You approve access at {vendor} in a new tab, then come back here. The grant goes to the secret store,
              never into an approval or workflow history.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="oauth-client-id">Client ID</FieldLabel>
            <Input
              id="oauth-client-id"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              required={!!clientSecret}
              disabled={busy}
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="oauth-client-secret">Client secret</FieldLabel>
            <Input
              id="oauth-client-secret"
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              spellCheck={false}
              required={!!clientId}
              disabled={busy}
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
            />
            <FieldDescription>
              Your company’s OAuth application at {vendor}. Leave both empty to use the one already stored.
            </FieldDescription>
          </Field>
          {error !== undefined && <ConnectionFailure error={error} />}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Starting…" : `Continue to ${vendor}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What an attempt's problem means to the person. Never the provider's own words. */
const ATTEMPT_PROBLEMS: Record<NonNullable<AttemptStatus["problem"]>, string> = {
  approval_pending: "Waiting for approval to store the grant.",
  declined: "Consent was declined at the provider. Nothing changed.",
  rejected:
    "The provider refused the code or the OAuth application’s credentials. Check the application, then connect again.",
  wrong_account: "The provider authorized an account this connection does not allow. Connect again with the right one.",
  scope_changed: "The grant lacks a scope this connection requires. Grant it, then connect again.",
  uncertain: "The provider may have issued a grant that was not stored. Reconnect to authorize a new one.",
  expired: "The attempt expired before it finished. Connect again.",
  missing: "The OAuth application’s client ID and secret are not stored. Connect again and enter them.",
  revoked: "The provider revoked the grant. Connect again.",
  unavailable: "The connection could not be completed. Connect again.",
  unsupported: "This connection cannot connect by OAuth.",
};

const ended = (status?: AttemptStatus) => status?.state === "connected" || status?.state === "failed";

/**
 * An OAuth attempt's progress, polled until it ends: waiting for consent, exchanging, connected
 * or failed. The connections are read again once, when it ends.
 */
function AttemptProgress({ attempt, vendor, onDismiss }: { attempt: string; vendor: string; onDismiss(): void }) {
  const check = useServerFn(connectionAttemptFn);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["connection-attempt", attempt],
    queryFn: () => check({ data: { attempt } }),
    refetchInterval: (q) => (ended(q.state.data) ? false : 1_500),
  });
  const status = query.data;
  const done = ended(status);
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ["connections"] });
  }, [done, queryClient]);
  if (query.error) return <ConnectionFailure error={query.error} />;
  if (!status) return <ItemDescription>Checking the connection attempt…</ItemDescription>;
  const problem = status.problem && ATTEMPT_PROBLEMS[status.problem];
  return (
    <div role="status" className="flex flex-col gap-1 text-sm">
      {status.state === "waiting" && <p>Waiting for you to approve access at {vendor} in the other tab…</p>}
      {status.state === "exchanging" && (
        <p>
          {problem ?? "Storing the grant and verifying the account…"}
          {status.runId && status.problem === "approval_pending" && (
            <>
              {" "}
              <Link
                {...runLink({ workflow: CONNECT_WORKFLOW, runId: status.runId })}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Review the request
              </Link>
            </>
          )}
        </p>
      )}
      {status.state === "connected" && <p>Connected. The account is verified.</p>}
      {status.state === "failed" && <Notice variant="destructive">{problem ?? ATTEMPT_PROBLEMS.unavailable}</Notice>}
      {(status.state === "connected" || status.state === "failed") && (
        <Button variant="ghost" size="sm" className="self-start" onClick={onDismiss}>
          Dismiss
        </Button>
      )}
    </div>
  );
}

const locationLabel = (location?: SecretLocation) =>
  location
    ? `${location.store} · ${location.namespace} · ${location.path} · ${location.management === "external" ? "managed externally" : "managed by Sanoma"}`
    : "no secret store configured";
const changedLocation = (before: SecretLocation, after?: SecretLocation) =>
  !after || (["store", "namespace", "path", "management"] as const).some((key) => before[key] !== after[key]);

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
