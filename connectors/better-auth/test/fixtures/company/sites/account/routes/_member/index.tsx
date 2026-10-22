import { Button, Fact, Facts, toast } from "sanoma/ui";
import { createFileRoute } from "@tanstack/react-router";
import { api, useActor } from "sanoma/site";

/** Who the visitor is, as the app says: `visitor:better-auth:<id>`, in `visitors`. */
export const Route = createFileRoute("/sites/account/_member/")({ component: Account });

function Account() {
  const { actor, groups, signOut } = useActor();
  async function greet() {
    const { runId } = await api.hello.start({ who: actor ?? "a visitor" });
    toast(`Started ${runId}`);
  }
  async function leave() {
    if (signOut) await fetch(signOut, { method: "POST" });
    window.location.reload();
  }
  return (
    <>
      <Facts>
        <Fact label="Signed in as">{actor}</Fact>
        <Fact label="Groups">{groups.join(", ")}</Fact>
      </Facts>
      <Button onClick={() => void greet()}>Say hello</Button>
      <Button variant="outline" onClick={() => void leave()}>
        Sign out
      </Button>
    </>
  );
}
