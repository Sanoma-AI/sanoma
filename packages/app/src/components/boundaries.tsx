import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { useEffect } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Notice } from "./common.tsx";

// What a route shows in place of its page: the router's defaults (router.tsx). They render
// inside the sidebar's layout, so the rest of the app stays where it was.

/** A page that failed to load, and a retry that loads it again. */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const { reset } = useQueryErrorResetBoundary();
  // A query that failed into this boundary fetches again on the retry, rather than throwing its old error.
  useEffect(() => reset(), [reset]);
  return (
    <Alert variant="destructive">
      <WarningCircleIcon aria-hidden="true" />
      <AlertTitle>This page could not load</AlertTitle>
      {/* The router types a boundary's error as unknown: anything can be thrown. */}
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="xs" onClick={() => void router.invalidate()}>
          <ArrowClockwiseIcon aria-hidden="true" data-icon="inline-start" />
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function NotFound() {
  return <Notice variant="destructive">There is no page here.</Notice>;
}

// On a public site's host, where the app's stylesheet is not, plain pages: the site's own
// notFoundComponent and errorComponent replace them.

const Plain = ({ title, text }: { title: string; text: string }) => (
  <main>
    <h1>{title}</h1>
    <p>{text}</p>
  </main>
);

/** A path no page has, or a loader's notFound() that no route of the site draws; titled so by the root's head. */
export const SiteNotFound = () => <Plain title="Page not found" text="There is no page here." />;

/** A page that failed: what failed stays in the server's log, not on a visitor's page. */
export const SiteError = () => <Plain title="This page could not load" text="Try again later." />;

/** A page still loading, after a second: the router waits that long before showing it. */
export function PagePending() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
