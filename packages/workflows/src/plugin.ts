import { readDataFile } from "./datafile.ts";

// An oxlint JS plugin with one rule, `sanoma/data-file`: the data-file subset `readResources`
// reads, the same check as `lintResources`, on the tree oxlint has already parsed. The
// package's `oxlint.json` turns it on for `resources/**`. Typed here by the little it uses, so
// the package needs no oxlint types.

interface Context {
  filename: string;
  report(diagnostic: { message: string; node: { range: [number, number] } }): void;
}

const plugin = {
  meta: { name: "sanoma" },
  rules: {
    "data-file": {
      meta: {
        type: "problem",
        docs: {
          description:
            "A data file under resources/ holds only imports, `export const <name> = <vendor>.<type>({ … })` with literal fields, and `export default [ … ]`",
        },
      },
      create(context: Context) {
        return {
          Program(program: unknown) {
            for (const { start, end, message } of readDataFile(program, context.filename).problems) {
              context.report({ message, node: { range: [start, end] } });
            }
          },
        };
      },
    },
  },
};

export default plugin;
