import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog.tsx";

// New workflow: for now, how to add a workflow to the repo. The agent that drafts one from a
// description, behind the design's fields (start from, what it should do, the apps it uses, who
// approves), is a separate issue.

/**
 * Connects every New workflow button to the one dialog, which the chrome renders: a page's button
 * may unmount (its page left) while the dialog stays open.
 */
const handle = DialogPrimitive.createHandle();

/** The dialog New workflow opens, rendered once, in the chrome. */
export function NewWorkflowDialog() {
  return (
    <Dialog handle={handle}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>A workflow is a file in your repo. To add one:</DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          <li>
            Write <code>workflows/&lt;name&gt;.ts</code>: <code>export default defineWorkflow(&#123; … &#125;)</code>.
          </li>
          <li>It appears here, with its graph, once the app restarts.</li>
        </ol>
        <p className="text-muted-foreground">
          Coming: describe what should happen, and Sanoma drafts the workflow for you to check in a sandbox.
        </p>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/** New workflow as a small button. */
export function NewWorkflowButton() {
  return (
    <DialogTrigger handle={handle} render={<Button size="sm" />}>
      <PlusIcon aria-hidden="true" data-icon="inline-start" />
      New workflow
    </DialogTrigger>
  );
}
