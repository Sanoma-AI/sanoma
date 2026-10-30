import type { DriftField } from "@sanoma-ai/workflows";
import { errorMessage } from "@sanoma-ai/workflows/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { toast } from "sonner";
import { Button } from "#/components/ui/button.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "#/components/ui/table.tsx";
import { errorBodyOf } from "../api.ts";
import { adoptFn, startRunFn } from "../functions.ts";
import { configQuery, RUNS_KEY, sourceQuery } from "../queries.ts";

/** The drift run whose report the page shows, which Adopt writes the vendor's values from, and the workflow that checks again. */
export interface Adopt {
  runId: string;
  drift: string;
}

/** Each declared field that differs: what the data file declares, what the vendor holds, and a button to adopt that. */
export function FieldDiff({ id, fields, adopt }: { id: string; fields: DriftField[]; adopt?: Adopt }) {
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          <TableHead>Field</TableHead>
          <TableHead>Declared</TableHead>
          <TableHead>At the vendor</TableHead>
          {adopt && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map((field) => (
          <TableRow key={field.path}>
            <TableCell>
              <code>{field.path}</code>
            </TableCell>
            <TableCell className="whitespace-pre-wrap">
              <code>{JSON.stringify(field.desired)}</code>
            </TableCell>
            <TableCell className="whitespace-pre-wrap">
              <code>{JSON.stringify(field.actual)}</code>
            </TableCell>
            {adopt && (
              <TableCell className="text-right">
                <AdoptButton adopt={adopt} id={id} path={field.path} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Writes what the vendor holds for one field into its data file (committed, when the app has a source), then checks for drift again. */
function AdoptButton({ adopt: { runId, drift }, id, path }: { adopt: Adopt; id: string; path: string }) {
  const queryClient = useQueryClient();
  const adoptField = useServerFn(adoptFn);
  const start = useServerFn(startRunFn);
  const mutation = useMutation({
    mutationFn: () => adoptField({ data: { runId, id, paths: [path] } }),
    onSuccess: async ({ file, revision }) => {
      toast.success(`Wrote ${path} into ${file}${revision ? `, committed as ${revision.slice(0, 7)}` : ""}`);
      await Promise.all(
        [sourceQuery(file).queryKey, configQuery().queryKey].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
      // Then checks again, which reads the file as it now is: a failure here leaves the adopt done.
      try {
        await start({ data: { workflow: drift, input: {} } });
      } catch (err) {
        toast.error(`Could not check for drift again: ${errorBodyOf(err)?.error ?? errorMessage(err)}`);
      }
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: (err) => toast.error(errorBodyOf(err)?.error ?? err.message),
  });
  return (
    <Button
      variant="outline"
      size="xs"
      title="Write the vendor's value into the data file"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
    >
      {mutation.isPending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <NotePencilIcon aria-hidden="true" data-icon="inline-start" />
      )}
      Adopt
    </Button>
  );
}
