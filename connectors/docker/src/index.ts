import { withSetup } from "@sanoma-ai/workflows";
import { dockerOps } from "./connector.ts";
import { dockerDriver } from "./driver.ts";
import { fakeDocker } from "./fake.ts";

/**
 * Containers on the local Docker daemon: `docker.container.read` and `.import`, effect `read`,
 * and the change operations apply calls (`plan`, `create`, `update`, `delete`), through the
 * `kreuzwerker/docker` OpenTofu provider. A container is a host (`Host`): it runs the company. It
 * carries its live driver (`dockerDriver`, on the default bridge) and its fake (`fakeDocker`), of
 * which each sandbox run makes its own.
 */
export const docker = withSetup(dockerOps, { driver: dockerDriver, fake: fakeDocker });
