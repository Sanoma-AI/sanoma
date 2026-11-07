import { Button, Field, FieldError, FieldGroup, FieldLabel, Input } from "sanoma/ui";
import { type FormEvent, useState } from "react";
import { useRouter } from "sanoma/site";

/**
 * Posts the form as JSON to one of Better Auth's routes (`sign-in/email` or `sign-up/email`), then
 * loads the account page afresh, so the app reads the new session cookie.
 */
export function CredentialsForm({ route, withName, submit }: { route: string; withName?: boolean; submit: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`/auth/better-auth/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))),
    });
    if (response.ok) window.location.assign(router.buildLocation({ to: "/sites/account" }).href);
    else setError(((await response.json().catch(() => ({}))) as { message?: string }).message ?? response.statusText);
  }
  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <FieldGroup>
        {withName && (
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input id="name" name="name" autoComplete="name" required />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete={withName ? "new-password" : "current-password"}
            minLength={8}
            required
          />
        </Field>
        <FieldError>{error}</FieldError>
        <Button type="submit">{submit}</Button>
      </FieldGroup>
    </form>
  );
}
