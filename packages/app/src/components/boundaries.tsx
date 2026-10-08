import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { CircleAlertIcon, RotateCwIcon } from "lucide-react";
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
      <CircleAlertIcon />
      <AlertTitle>This page could not load</AlertTitle>
      {/* The router types a boundary's error as unknown: anything can be thrown. */}
      <AlertDescription>{error instanceof Error ? error.message : String(error)}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="xs" onClick={() => void router.invalidate()}>
          <RotateCwIcon data-icon="inline-start" />
          Try again
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function NotFound() {
  return <Notice variant="destructive">There is no page here.</Notice>;
}

/** A page still loading, after a second: the router waits that long before showing it. */
export function PagePending() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
