import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type AppConfig, INFRA } from "../api.ts";
import { configQuery } from "../queries.ts";
import { ButtonLink, Notice, Region } from "./common.tsx";

/** What the panel reads of the config: the company's name and the hostname `infra.ts` declares for its host. */
const selectReady = (config: AppConfig) => {
  const hostname = config.resources.find((r) => r.id === `${INFRA}#host`)?.desired.hostname;
  return { name: config.name, hostname: typeof hostname === "string" ? hostname : undefined };
};

/**
 * Hosting's panel while the company is Local and `infra.ts` declares Sanoma Cloud: what going
 * live makes and where it will answer, and the way to go live on accounts of the company's own
 * instead (`?own`). Signing in to Sanoma and going live on Sanoma Cloud from here are not built yet.
 */
export function ReadyToGoLive() {
  const { data } = useSuspenseQuery({ ...configQuery(), select: selectReady });
  return (
    <Region title="Ready to go live">
      <p>
        Going live puts {data.name} on Sanoma Cloud: its database and its host, in Sanoma&apos;s accounts
        {data.hostname && (
          <>
            , answering at <code>{data.hostname}</code>
          </>
        )}
        . Nothing is made until then, and it runs on this computer.
      </p>
      <Notice>
        Going live on Sanoma Cloud from this app is not ready yet. You can go live on accounts of your own instead:
        GitHub, a database and a host.
      </Notice>
      <div>
        <ButtonLink variant="outline">
          <Link to="/hosting" search={{ own: true }}>
            Use your own accounts instead…
          </Link>
        </ButtonLink>
      </div>
    </Region>
  );
}
