import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
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
import { TipButton } from "./common.tsx";

// New workflow: for now, how to add a workflow to the repo. The agent that drafts one from a
// description, behind the design's fields (start from, what it should do, the apps it uses, who
// approves), is a separate issue.

/**
 * Connects every New workflow button to the one dialog, which the root renders: a button in the
 * sidebar's peek would unmount, with its dialog, as the peek closes.
 */
const handle = DialogPrimitive.createHandle();

/** The dialog New workflow opens, rendered once, beside the sidebar. */
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
          <li>
            List it in <code>sanoma.config.ts</code>, under <code>workflows</code>.
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

/** New workflow as a button, `size` sm by default. */
export function NewWorkflowButton(props: Omit<ComponentProps<typeof Button>, "children">) {
  return (
    <DialogTrigger handle={handle} render={<Button size="sm" {...props} />}>
      <PlusIcon data-icon="inline-start" />
      New workflow
    </DialogTrigger>
  );
}

/** New workflow as an icon button with its tooltip, for a panel's header. */
export function NewWorkflowIconButton() {
  return (
    <DialogTrigger handle={handle} render={<TipButton tip="New workflow" size="icon-sm" />}>
      <PlusIcon />
    </DialogTrigger>
  );
}
