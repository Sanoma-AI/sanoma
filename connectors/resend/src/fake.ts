import { DriverError } from "@sanoma/workflows";
import { defineFake, type FakeOptions } from "@sanoma/workflows/fake";
import { resend } from "./index.ts";

export interface FakeResendBroadcast {
  id: string;
  audience: string;
  from?: string;
  subject: string;
  html: string;
  status: "draft" | "sent";
}

export interface FakeResendState extends Record<string, unknown> {
  seq: number;
  broadcasts: Record<string, FakeResendBroadcast>;
}

/**
 * An in-memory Resend for tests: broadcasts live in `state.broadcasts`, and nothing is
 * emailed. Pass `{ file }` to keep the state on disk.
 */
export function fakeResend(options: FakeOptions = {}) {
  return defineFake(
    resend,
    {
      initial: (): FakeResendState => ({ seq: 0, broadcasts: {} }),
      ops: (state) => ({
        broadcast: {
          create: async (input) => {
            const id = `bc_${String(++state.seq).padStart(4, "0")}`;
            state.broadcasts[id] = { id, ...input, status: "draft" };
            return { id };
          },
          send: async ({ id }) => {
            const bc = state.broadcasts[id];
            if (!bc) throw new DriverError(`resend: no broadcast ${id}`, { retryable: false, status: 404 });
            if (bc.status === "sent") {
              throw new DriverError(`resend: broadcast ${id} was already sent`, { retryable: false, status: 422 });
            }
            bc.status = "sent";
            return { id, status: "queued" as const };
          },
        },
      }),
    },
    options,
  );
}
