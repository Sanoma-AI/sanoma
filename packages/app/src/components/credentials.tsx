import { type CredentialStatus, credentialReady, errorMessage } from "@sanoma-ai/workflows/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from "#/components/ui/item.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { errorBodyOf } from "../api.ts";
import { clearCredentialFn, setCredentialFn } from "../functions.ts";
import { credentialsFor, credentialsQuery } from "../queries.ts";
import { ItemHeading, Region, ToneBadge, When } from "./common.tsx";

// A connector's credentials as its page shows them: each variable's manual and status, and the
// controls that set and clear a stored value. A value goes to the server and is never read back.

/** The environment variables the vendor's drivers read; nothing when they declare none. */
export function Credentials({ vendor }: { vendor: string }) {
  const { data: credentials } = useSuspenseQuery({ ...credentialsQuery(), select: credentialsFor(vendor) });
  if (!credentials) return null;
  return (
    <Region title="Credentials">
      <ItemGroup>
        {credentials.map((c) => (
          <CredentialRow key={c.name} credential={c} />
        ))}
      </ItemGroup>
    </Region>
  );
}

/**
 * One variable: its status and manual, and who set a stored value and when. The environment's
 * value wins, so a variable it sets has no controls; any other has Set (Replace once set), and
 * Clear when a value is stored.
 */
function CredentialRow({ credential: c }: { credential: CredentialStatus }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const clear = useServerFn(clearCredentialFn);
  const clearing = useMutation({
    mutationFn: () => clear({ data: { name: c.name } }),
    onSuccess: async () => {
      toast.success(`${c.name} cleared`);
      await queryClient.invalidateQueries({ queryKey: credentialsQuery().queryKey });
    },
    onError: (err) => toast.error(errorMessage(err).trim() || `Could not clear ${c.name}, and no reason was given`),
  });
  return (
    <Item role="listitem" variant="outline" size="xs">
      <ItemContent>
        <ItemHeading>
          <code>{c.name}</code>
          <ToneBadge tone={!credentialReady(c) ? "bad" : c.status === "set" ? "ok" : "off"}>
            {c.status === "invalid" ? `invalid: ${c.problem}` : c.status}
          </ToneBadge>
          {c.optional && <Badge variant="outline">optional</Badge>}
        </ItemHeading>
        {/* Under the name: its manual, in full, then where its value comes from: the environment,
            or who stored it and when. */}
        {c.description && <ItemDescription className="line-clamp-none">{c.description}</ItemDescription>}
        {c.source === "environment" && <ItemDescription>set in the environment</ItemDescription>}
        {c.source === "stored" && c.setBy && c.setAt && (
          <ItemDescription>
            set by {c.setBy} · <When at={Date.parse(c.setAt)} />
          </ItemDescription>
        )}
      </ItemContent>
      {c.source !== "environment" && (
        <ItemActions>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
            {c.status === "set" ? "Replace" : "Set"}
          </Button>
          {c.source === "stored" && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={clearing.isPending}
              onClick={() => clearing.mutate()}
            >
              {clearing.isPending && <Spinner data-icon="inline-start" />}
              Clear
            </Button>
          )}
          <SetDialog credential={c} open={open} onClose={() => setOpen(false)} />
        </ItemActions>
      )}
    </Item>
  );
}

/**
 * A password field for the variable's value, with its manual. The value lives in this form's
 * state only until it closes, and reaches the mutation through its function, not as its
 * variables, so the mutation cache never holds it.
 */
function SetDialog({
  credential,
  open,
  onClose,
}: {
  credential: CredentialStatus;
  open: boolean;
  onClose: () => void;
}) {
  const { name } = credential;
  const [value, setValue] = useState("");
  const queryClient = useQueryClient();
  const set = useServerFn(setCredentialFn);
  const mutation = useMutation({
    mutationFn: () => set({ data: { name, value } }),
    // Dropped from the cache at once, with the closure that holds the value.
    gcTime: 0,
    onSuccess: async () => {
      toast.success(`${name} set`);
      setValue("");
      mutation.reset();
      onClose();
      await queryClient.invalidateQueries({ queryKey: credentialsQuery().queryKey });
    },
  });
  // The schema's reason sits under the field; anything else (the network, a bug) too, as it is.
  const body = errorBodyOf(mutation.error);
  const error = mutation.error ? (body?.issues?.[0]?.message ?? body?.error ?? mutation.error.message) : undefined;
  const id = `credential-${name}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !mutation.isPending) {
          mutation.reset();
          setValue("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {credential.status === "set" ? "Replace" : "Set"} {name}
            </DialogTitle>
            <DialogDescription>
              {credential.description ?? "An environment variable its driver reads."}
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={id}>Value</FieldLabel>
            <Input
              id={id}
              type="password"
              // What browsers and password managers honour: nothing to fill in, nothing to save.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={mutation.isPending}
              aria-invalid={error ? true : undefined}
            />
            <FieldDescription>
              Stored in the runtime's database; running workers pick it up without a restart. It is never shown again.
            </FieldDescription>
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={mutation.isPending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
