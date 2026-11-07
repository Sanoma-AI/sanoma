import { api } from "sanoma/site";

/** Starts hello for `who`: once by its name, and once by a name not written out, which Used by skips. */
export function Greet({ who }: { who: string }) {
  const name = "hello" as const;
  return (
    <>
      <button type="button" onClick={() => void api.hello.start({ who })}>
        Greet {who}
      </button>
      <button type="button" onClick={() => void api[name].start({ who })}>
        Greet {who} again
      </button>
    </>
  );
}
