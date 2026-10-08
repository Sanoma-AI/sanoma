import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "#/components/ui/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { useActor } from "../actor.ts";

/**
 * There is no login. The name is kept in this browser and sent with every change. Rendered (and
 * loaded) only while no name is stored.
 */
export default function WhoAreYou() {
  const { setActor } = useActor();
  const [name, setName] = useState("");
  return (
    // No way out but a name: every change needs one.
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setActor(name.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Who are you?</DialogTitle>
            <DialogDescription>
              Runs you start and approvals you decide are recorded under this name. Use the name approvals ask for, such
              as <code>marketing-lead</code>. There is no login: this is a local tool.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="who-name">Your name</FieldLabel>
              <Input
                id="who-name"
                autoFocus
                autoComplete="username"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="marketing-lead"
              />
            </Field>
            <Button type="submit" disabled={!name.trim()}>
              Continue
            </Button>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
