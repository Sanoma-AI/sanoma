import { useActor } from "@sanoma-ai/app/ui";
import { createFileRoute } from "@tanstack/react-router";
import { Link, Outlet } from "sanoma/site";

/** The pages for a signed-in visitor: anyone else is asked to sign in. */
export const Route = createFileRoute("/sites/account/_member")({ component: Member });

function Member() {
  const { actor } = useActor();
  if (!actor) {
    return (
      <p>
        <Link to="/sites/account/sign-in">Sign in</Link> or <Link to="/sites/account/sign-up">sign up</Link> to see your
        account.
      </p>
    );
  }
  return <Outlet />;
}
