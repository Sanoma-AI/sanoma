import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useLoaderData, useMatches } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { DensityProvider } from "#/components/density.tsx";
import { NewWorkflowDialog } from "#/components/new-workflow.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { TooltipProvider } from "#/components/ui/tooltip.tsx";
import { ActorContext, useActorState } from "../actor.ts";
import { actorQuery } from "../queries.ts";
import { Bar, PhoneBar } from "./shell/bar.tsx";
import { ChatColumn } from "./shell/chat.tsx";
import { BESIDE_PAGE, CHAT_COOKIE, rememberPref } from "./shell/prefs.ts";

// The app's chrome around every page on the app's host: the bar, the chat column, the page, who
// you are. The root loads it lazily, so a public site's host never does.

/** Asked once per browser, so loaded only when no name is stored. */
const WhoAreYou = lazy(() => import("./who-are-you.tsx"));

/**
 * The chrome: the bar, the chat column beside it (while open), then the page on the paper, and
 * the dialogs. The bar and the column stay as the page scrolls; on a phone the bar is a sheet
 * behind a menu button, and there is no column.
 */
export default function Root() {
  const { data: server } = useSuspenseQuery(actorQuery());
  const actor = useActorState(server);
  // With the default login, a name chosen here is asked about again: who the server admits it as.
  const queryClient = useQueryClient();
  const said = server.actor?.id ?? null;
  useEffect(() => {
    if (!actor.fromServer && actor.actor && actor.actor !== said)
      void queryClient.invalidateQueries({ queryKey: actorQuery().queryKey });
  }, [actor.fromServer, actor.actor, said, queryClient]);
  // Only these fields: the root's loader data is new on every navigation, a field is not. Each is
  // taken once, as the chrome mounts (hydration has the server's answer, from the cookie).
  const chatPref = useLoaderData({ from: "__root__", select: (data) => data?.chat });
  const compact = useLoaderData({ from: "__root__", select: (data) => data?.compact ?? false });
  const [chat, setChat] = useState(chatPref !== "closed");
  // Never set: open beside the page, and folded where it would lie over it, following the
  // window's width until Chat is used (the server cannot know it, so the column hides there by
  // CSS until this folds it).
  const [unset, setUnset] = useState(chatPref === undefined);
  useEffect(() => {
    if (!unset) return;
    const beside = matchMedia(BESIDE_PAGE);
    const follow = () => setChat(beside.matches);
    follow();
    beside.addEventListener("change", follow);
    return () => beside.removeEventListener("change", follow);
  }, [unset]);
  const toggleChat = () => {
    rememberPref(CHAT_COOKIE, chat ? "closed" : "open");
    setChat(!chat);
    setUnset(false);
  };
  // A page that asks for it (a workflow's, for its graph) takes the full width.
  const wide = useMatches({ select: (matches) => matches.some((match) => match.staticData.wide) });
  return (
    <ActorContext value={actor}>
      {/* One provider for every tooltip: the bar's, and any a page shows. */}
      <TooltipProvider>
        <DensityProvider defaultCompact={compact}>
          <div className="flex min-h-svh">
            <Bar chat={{ open: chat, toggle: toggleChat }} className="sticky top-0 hidden h-svh self-start md:flex" />
            {chat && <ChatColumn besidePageOnly={unset} />}
            {/* The page: its frame (title row, tabs, one card) is its children, the region gap apart. */}
            <main data-slot="page" className="flex min-w-0 flex-1 flex-col">
              <PhoneBar />
              <div
                data-wide={wide || undefined}
                className="mx-auto flex w-full max-w-6xl flex-col gap-(--gap-region) p-4 data-wide:max-w-none sm:px-6"
              >
                <Outlet />
              </div>
            </main>
          </div>
          <NewWorkflowDialog />
          {!actor.fromServer && actor.actor === null && (
            <Suspense fallback={null}>
              <WhoAreYou />
            </Suspense>
          )}
          <Toaster />
        </DensityProvider>
      </TooltipProvider>
    </ActorContext>
  );
}
