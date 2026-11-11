import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { RocketIcon } from "@phosphor-icons/react/dist/csr/Rocket";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { type AppConfig, type CloudAddress, CloudSlug, errorBodyOf, INFRA } from "../api.ts";
import { startSanomaSignInFn } from "../functions.ts";
import { appApi, cloudAddressQuery, configQuery, RUNS_KEY, sanomaSignInQuery } from "../queries.ts";
import { ButtonLink, Notice, Region, ToneBadge } from "./common.tsx";

/** What the panel reads of the config: the company's name and the slug `infra.ts` declares for its host. */
const selectReady = (config: AppConfig) => {
  const name = config.resources.find((r) => r.id === `${INFRA}#host`)?.desired.name;
  return { company: config.name, slug: typeof name === "string" ? name : "" };
};

/** How an address's check reads beside the field. */
const ADDRESS_WORDS: Record<CloudAddress["status"], { tone: "ok" | "bad"; words: string }> = {
  available: { tone: "ok", words: "available" },
  yours: { tone: "ok", words: "yours already" },
  taken: { tone: "bad", words: "taken" },
};

/** `value`, once it has stayed the same for `ms`: so a field's check waits for the typing to stop. */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Hosting's panel while the company is Local and `infra.ts` declares Sanoma Cloud: what going live
 * makes, the company's address (checked at the Cloud once signed in: available, yours already, or
 * taken), whether this app is signed in to Sanoma, and one Go live. Without a Cloud token, Go live
 * signs in first, in the browser, and goes live once the token is back; the page asks every 2 s
 * while it waits. A Cloud token can be pasted instead, or the company taken live on accounts of
 * its own. With `retry`, under Go live failed: the same, its button Retry.
 */
export function ReadyToGoLive({ retry = false }: { retry?: boolean }) {
  const { data } = useSuspenseQuery({ ...configQuery(), select: selectReady });
  const { data: signIn } = useSuspenseQuery(sanomaSignInQuery());
  const [address, setAddress] = useState(data.slug);
  const [waiting, setWaiting] = useState(false);
  const valid = CloudSlug.safeParse(address).success;
  const settled = useSettled(address);
  const check = useQuery({
    ...cloudAddressQuery(settled),
    enabled: signIn.signedIn && CloudSlug.safeParse(settled).success,
  });
  const checked = check.data?.slug === address ? check.data.status : undefined;
  const queryClient = useQueryClient();
  const start = useServerFn(startSanomaSignInFn);
  const changed = address !== data.slug ? { address } : {};

  const goLive = useMutation({
    // Started, not waited for: the run ends once the host is live, which Hosting follows by its state.
    mutationFn: () => appApi.goLiveCloud.start(changed),
    onSuccess: async () => {
      toast.success("Going live on Sanoma Cloud");
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: (err) => toast.error(errorBodyOf(err)?.error ?? err.message),
  });
  const signInFirst = useMutation({
    // The tab opens on the click, so no popup blocker stops it, and is sent to Sanoma once the URL is made.
    mutationFn: async (tab: Window | null) => ({ tab, ...(await start({ data: changed })) }),
    onSuccess: async ({ tab, url }) => {
      if (tab) tab.location.href = url;
      else window.open(url, "_blank", "noopener");
      setWaiting(true);
      await queryClient.invalidateQueries({ queryKey: sanomaSignInQuery().queryKey });
    },
    onError: (err, tab) => {
      tab?.close();
      toast.error(errorBodyOf(err)?.error ?? err.message);
    },
  });

  // Back from signing in: go live, once the address is checked and can be the company's.
  const ready = signIn.signedIn && valid && (checked === "available" || checked === "yours");
  useEffect(() => {
    if (!waiting || !ready || goLive.isPending) return;
    setWaiting(false);
    goLive.mutate();
  }, [waiting, ready, goLive]);

  const onGoLive = () => {
    if (signIn.signedIn) return goLive.mutate();
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    signInFirst.mutate(tab);
  };
  const busy = goLive.isPending || signInFirst.isPending || (waiting && signIn.pending);
  return (
    <Region title={retry ? "Try again" : "Ready to go live"}>
      {!retry && (
        <p>
          Going live puts {data.company} on Sanoma Cloud: a private GitHub repository in your account, which this
          computer pushes the company to, and its database and host in Sanoma&apos;s accounts. Nothing is made until
          then, and it runs on this computer.
        </p>
      )}
      <FieldGroup className="max-w-xl">
        <Field data-invalid={!valid || checked === "taken" ? true : undefined}>
          <FieldLabel htmlFor="go-live-address">Address</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id="go-live-address"
              className="w-56"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim().toLowerCase())}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-muted-foreground">.sanoma.work</span>
            {checked && <ToneBadge tone={ADDRESS_WORDS[checked].tone}>{ADDRESS_WORDS[checked].words}</ToneBadge>}
            {signIn.signedIn && valid && !checked && check.isFetching && <Spinner aria-label="Checking" />}
          </div>
          <FieldDescription>
            {signIn.signedIn
              ? "Where the company answers once it is live, and its repository's name."
              : "Where the company answers once it is live, and its repository's name. It is checked once you are signed in."}
          </FieldDescription>
          <FieldError>
            {!valid
              ? "Use lower case letters, digits and dashes, with no dash at either end: one of them, or 3 to 40."
              : checked === "taken"
                ? "Someone else has this address: choose another."
                : check.error
                  ? (errorBodyOf(check.error)?.error ?? check.error.message)
                  : undefined}
          </FieldError>
        </Field>
        <Field>
          <FieldLabel>Sanoma account</FieldLabel>
          <span className="flex flex-wrap items-center gap-2">
            {signIn.signedIn ? (
              <>
                <CheckIcon aria-hidden="true" className="size-4 text-tone-ok-foreground" />
                Signed in to Sanoma
                {signIn.source === "environment" && (
                  <span className="text-muted-foreground">, with the Cloud token in this company&apos;s .env</span>
                )}
              </>
            ) : signIn.pending ? (
              <>
                <Spinner aria-hidden="true" />
                Finish signing in to Sanoma in your browser
              </>
            ) : (
              "Not signed in: Go live opens Sanoma in your browser first"
            )}
          </span>
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onGoLive} disabled={busy || !valid || checked === "taken" || (signIn.signedIn && !ready)}>
          {busy ? <Spinner data-icon="inline-start" /> : <RocketIcon aria-hidden="true" data-icon="inline-start" />}
          {retry ? "Retry" : "Go live"}
        </Button>
        <ButtonLink variant="ghost">
          <Link to="/hosting/connect">Paste a Cloud token</Link>
        </ButtonLink>
        <ButtonLink variant="ghost">
          <Link to="/hosting" search={{ own: true }}>
            Use your own accounts instead…
          </Link>
        </ButtonLink>
      </div>
      {waiting && !signIn.pending && !signIn.signedIn && (
        <Notice>
          Signing in did not finish. Press {retry ? "Retry" : "Go live"} to sign in again, or paste a Cloud token.
        </Notice>
      )}
    </Region>
  );
}
