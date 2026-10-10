import { type CredentialStatus, credentialReady } from "@sanoma/workflows/shared";
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
import { Spinner } from "#/components/ui/spinner.tsx";
import { errorBodyOf } from "../api.ts";
import { clearCredentialFn, setCredentialFn } from "../functions.ts";
import { credentialsFor, credentialsQuery } from "../queries.ts";
import { SectionTitle, ToneBadge, When } from "./common.tsx";

// A connector's credentials as its page shows them: each variable's manual and status, and the
// controls that set and clear a stored value. A value goes to the server and is never read back.

/** The environment variables the vendor's drivers read; nothing when they declare none. */
export function Credentials({ vendor }: { vendor: string }) {
  const { data: credentials } = useSuspenseQuery({ ...credentialsQuery(), select: credentialsFor(vendor) });
  if (!credentials) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Credentials</SectionTitle>
      <ul className="flex flex-col gap-1.5">
        {credentials.map((c) => (
          <CredentialRow key={c.name} credential={c} />
        ))}
      </ul>
    </section>
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
    onError: (err) => toast.error(errorBodyOf(err)?.error ?? err.message),
  });
  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <code>{c.name}</code>
      <ToneBadge tone={!credentialReady(c) ? "bad" : c.status === "set" ? "ok" : "off"}>
        {c.status === "invalid" ? `invalid: ${c.problem}` : c.status}
      </ToneBadge>
      {c.source === "stored" && c.setBy && c.setAt && (
        <span className="text-muted-foreground">
          · by {c.setBy} · <When at={Date.parse(c.setAt)} />
        </span>
      )}
      {c.optional && <Badge variant="outline">optional</Badge>}
      {c.description && <span className="text-muted-foreground">{c.description}</span>}
      {c.source === "environment" ? (
        <span className="text-muted-foreground">set in the environment</span>
      ) : (
        <>
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
        </>
      )}
    </li>
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
    onSuccess: async () => {
      toast.success(`${name} set`);
      setValue("");
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
              autoComplete="off"
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
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>
                Cancel
              </Button>
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
