import type { MovePhase, StoreMove, StoreMovePlan } from "sanoma/workflows";
import { ACTIVE_MOVE_PHASES, errorMessage, MIGRATE_STORE_WORKFLOW } from "sanoma/workflows/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import type { Tone } from "#/lib/tone.ts";
import { errorBodyOf } from "../api.ts";
import type { UntypedApi } from "../api-client.ts";
import { api, runLink, storeMovesQuery, useStartRun } from "../queries.ts";
import { Fact, Facts, Notice, ToneBadge } from "./kit.tsx";
import { UtcTime } from "./common.tsx";

// The Secret storage panel's Move: a move of the secrets from the selected store to one the
// config names in `secrets.stores`, run by the built-in `migrate-store` workflow. The page shows
// its plan first (names, sizes, kinds; never a value), starts the run, then follows the copy,
// the read-back, the wait for the code change that selects the destination, the cutover, the
// rollback window and the retirement of the old copies.

type Stores = Record<string, { store: string; namespace: string }>;

const PHASES: Record<MovePhase, { label: string; tone: Tone }> = {
  prepared: { label: "Destination checked", tone: "active" },
  transferring: { label: "Copying", tone: "active" },
  verified: { label: "Copies verified · waiting for the switch", tone: "waiting" },
  cut_over: { label: "Switched · rollback window", tone: "waiting" },
  retired: { label: "Done · old copies retired", tone: "ok" },
  cancelled: { label: "Cancelled", tone: "off" },
};
const ACTIONS: Record<StoreMovePlan["items"][number]["action"], string> = {
  copy: "Copy",
  kept: "Keep the destination's",
  external: "Managed externally · not moved",
  bound: "Not in the store · not moved",
  missing: "No value · nothing to copy",
};
const UNDER_WAY: ReadonlySet<MovePhase> = new Set(ACTIVE_MOVE_PHASES);
/** The move's operations a person calls directly: the plan, and cancelling. */
const storeMigration = (api as UntypedApi).sanoma.storeMigration;

/** The Move part of the Secret storage panel, when the config names other stores. */
export function StoreMoves({ actor, stores }: { actor: string; stores: Stores }) {
  const [started, setStarted] = useState<{ runId: string; at: number }>();
  const moves = useQuery(storeMovesQuery(actor, started));
  const latest = moves.data?.[0];
  // A run that ends before its prepare records the move has no row: its page tells why.
  const starting = started && moves.data && !moves.data.some((m) => m.id === started.runId);
  return (
    <div className="flex flex-col gap-3">
      {starting && (
        <Notice>
          Starting the move.{" "}
          <Link {...runLink({ workflow: MIGRATE_STORE_WORKFLOW, runId: started.runId })} className="underline">
            Open the run
          </Link>{" "}
          if it does not show here.
        </Notice>
      )}
      {latest && <MoveProgress move={latest} stores={stores} />}
      {moves.data && (!latest || !UNDER_WAY.has(latest.phase)) && (
        <NewMove stores={stores} onStarted={(runId) => setStarted({ runId, at: Date.now() })} />
      )}
      {moves.error && <Notice variant="destructive">{failure(moves.error)}</Notice>}
    </div>
  );
}

function NewMove({ stores, onStarted }: { stores: Stores; onStarted: (runId: string) => void }) {
  const names = Object.keys(stores);
  const [to, setTo] = useState(names[0]!);
  const [retainHours, setRetainHours] = useState(24 * 7);
  const [plan, setPlan] = useState<StoreMovePlan>();
  const review = useMutation({
    mutationFn: () => storeMigration.plan({ to }) as Promise<StoreMovePlan>,
    onSuccess: setPlan,
  });
  const start = useStartRun({ navigate: false });
  const queryClient = useQueryClient();
  const begin = () =>
    start.mutate(
      { workflow: MIGRATE_STORE_WORKFLOW, input: { to, retainHours } },
      {
        onSuccess: ({ runId }) => {
          setPlan(undefined);
          onStarted(runId);
          void queryClient.invalidateQueries({ queryKey: ["store-moves"] });
        },
      },
    );
  const error = review.error ?? start.error;
  return (
    <form
      className="flex flex-col gap-3"
      aria-label="Move secrets"
      onSubmit={(e) => {
        e.preventDefault();
        if (plan) begin();
        else review.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-fit">
          <FieldLabel htmlFor="move-to">Move secrets to</FieldLabel>
          <NativeSelect
            id="move-to"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPlan(undefined);
            }}
          >
            {names.map((name) => (
              <NativeSelectOption key={name} value={name}>
                {name} · {stores[name]!.store} · {stores[name]!.namespace}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <Field className="w-40">
          <FieldLabel htmlFor="move-retain">Rollback window (hours)</FieldLabel>
          <Input
            id="move-retain"
            type="number"
            min={0}
            max={24 * 366}
            value={retainHours}
            onChange={(e) => setRetainHours(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
          />
        </Field>
        <Button type="submit" disabled={review.isPending || start.isPending || (!!plan && plan.problems.length > 0)}>
          {plan ? "Start move" : "Review plan"}
        </Button>
      </div>
      <FieldDescription>
        Sanoma copies each value it manages, reads every copy back, and switches only once your code selects the
        destination. The old copies stay for the rollback window, then are deleted.
      </FieldDescription>
      {plan && <PlanReview plan={plan} />}
      {error && <Notice variant="destructive">{failure(error)}</Notice>}
    </form>
  );
}

function PlanReview({ plan }: { plan: StoreMovePlan }) {
  const copies = plan.items.filter((i) => i.action === "copy").length;
  return (
    <div className="flex flex-col gap-2" aria-label="Plan">
      <p className="text-sm">
        {copies} {copies === 1 ? "secret" : "secrets"} to copy from <strong>{plan.source.store}</strong> ·{" "}
        <code>{plan.source.namespace}</code> to <strong>{plan.destination.store}</strong> ·{" "}
        <code>{plan.destination.namespace}</code>. Writes to the current store pause while values move.
      </p>
      {plan.problems.length > 0 && (
        <Notice variant="destructive">The destination cannot take these secrets yet: {plan.problems.join("; ")}</Notice>
      )}
      <ItemTable
        items={plan.items.map((item) => ({
          name: item.name,
          kind: item.kind,
          note: ACTIONS[item.action],
          size: item.bytes,
          reauthorize: item.reauthorize,
          connections: item.connections,
        }))}
      />
    </div>
  );
}

function MoveProgress({ move, stores }: { move: StoreMove; stores: Stores }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => storeMigration.cancel({ move: move.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["store-moves"] }),
  });
  const phase = PHASES[move.phase];
  const copies = move.items.filter((i) => i.action === "copy");
  const verified = copies.filter((i) => i.state !== "pending" && i.state !== "stale" && i.state !== "copied").length;
  const sourceName = Object.entries(stores).find(
    ([, s]) => s.store === move.source.store && s.namespace === move.source.namespace,
  )?.[0];
  return (
    <div className="flex flex-col gap-3" aria-label="Store move">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={phase.tone} dot>
          {phase.label}
        </ToneBadge>
        <span className="text-sm">
          {move.source.store} · <code>{move.source.namespace}</code> → <strong>{move.destinationName}</strong> (
          {move.destination.store} · <code>{move.destination.namespace}</code>)
        </span>
        <Link {...runLink({ workflow: MIGRATE_STORE_WORKFLOW, runId: move.id })} className="text-sm underline">
          Open the run
        </Link>
      </div>
      <Facts>
        <Fact label="Started">
          <UtcTime at={move.createdAt} /> by {move.startedBy}
        </Fact>
        <Fact label="Verified">
          {verified} of {copies.length}
        </Fact>
        {move.cutoverAt && (
          <Fact label="Switched">
            <UtcTime at={move.cutoverAt} />
          </Fact>
        )}
        {move.retainUntil && move.phase === "cut_over" && (
          <Fact label="Retires old copies">
            after <UtcTime at={move.retainUntil} />
          </Fact>
        )}
        {move.retiredAt && (
          <Fact label="Retired">
            <UtcTime at={move.retiredAt} />
          </Fact>
        )}
      </Facts>
      {move.fenced && UNDER_WAY.has(move.phase) && (
        <Notice>Writes to the current store are paused while values move. Reads keep working.</Notice>
      )}
      {move.phase === "verified" && (
        <Notice>
          Every copy reads back equal. To switch, change <code>secrets</code> in <code>sanoma.config.ts</code> so it
          selects <code>{move.destinationName}</code>&apos;s store and lists the current one under <code>stores</code>
          {sourceName ? (
            <>
              {" "}
              (as <code>{sourceName}</code>)
            </>
          ) : null}
          , then publish the change. The move cuts over once the deployed code selects it.
          <pre className="mt-2 text-xs">{`secrets: {
  store: /* ${move.destinationName}'s store */,
  namespace: "${move.destination.namespace}",
  stores: { ${sourceName ?? "previous"}: { /* the current store */ namespace: "${move.source.namespace}" } },
}`}</pre>
        </Notice>
      )}
      {move.items.some((i) => i.reauthorize) && (
        <Notice>
          Some connections were authorized with an OAuth application the destination does not share. Reconnect them
          after the switch.
        </Notice>
      )}
      <ItemTable
        items={move.items.map((item) => ({
          name: item.name,
          kind: item.kind,
          note: item.action === "copy" || item.action === "kept" ? item.state : ACTIONS[item.action],
          size: item.bytes,
          reauthorize: item.reauthorize,
        }))}
      />
      {UNDER_WAY.has(move.phase) && (
        <div>
          <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel move
          </Button>
        </div>
      )}
      {cancel.error && <Notice variant="destructive">{failure(cancel.error)}</Notice>}
    </div>
  );
}

function ItemTable({
  items,
}: {
  items: {
    name: string;
    kind: string;
    note: string;
    size?: number | undefined;
    reauthorize?: string | undefined;
    connections?: string[];
  }[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Secret</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>What happens</TableHead>
          <TableHead className="text-right">Size</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.name}>
            <TableCell className="font-mono">{item.name}</TableCell>
            <TableCell>
              {item.kind}
              {item.connections?.length ? ` · ${item.connections.join(", ")}` : ""}
            </TableCell>
            <TableCell>
              {item.note}
              {item.reauthorize && " · reconnect after the switch"}
            </TableCell>
            <TableCell className="text-right">{item.size === undefined ? "" : `${item.size} B`}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const failure = (error: unknown) => errorBodyOf(error)?.error ?? errorMessage(error);
