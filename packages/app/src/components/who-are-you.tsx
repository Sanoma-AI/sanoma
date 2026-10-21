import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { useActor } from "../actor.ts";
import { declaredPeople } from "../api.ts";
import { configQuery } from "../queries.ts";

/**
 * There is no login with the default resolver. The name is kept in this browser and sent with
 * every change. Rendered (and loaded) only under that resolver, while no name is stored. When
 * the data files declare people, you pick one of them, as only they are let in; until then, any
 * name goes.
 */
export default function WhoAreYou() {
  const { setActor } = useActor();
  const { data: people } = useSuspenseQuery({
    ...configQuery(),
    select: (config) => declaredPeople(config.resources),
  });
  const [name, setName] = useState("");
  return (
    // No way out but a name: every change needs one. Open, with no onOpenChange, so neither
    // Escape nor a press outside closes it.
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) setActor(name.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Who are you?</DialogTitle>
            {people.length > 0 ? (
              <DialogDescription>
                Runs you start and approvals you decide are recorded as you, and the policy decides as you. The people
                are those <code>resources/people.ts</code> declares. There is no login: this is a local tool.
              </DialogDescription>
            ) : (
              <DialogDescription>
                Runs you start and approvals you decide are recorded under this name. Use the name approvals ask for,
                such as <code>marketing-lead</code>. There is no login: this is a local tool. Declaring people in{" "}
                <code>resources/people.ts</code> makes this a choice of them.
              </DialogDescription>
            )}
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="who-name">{people.length > 0 ? "You are" : "Your name"}</FieldLabel>
              {people.length > 0 ? (
                <NativeSelect
                  id="who-name"
                  className="w-full"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                >
                  <NativeSelectOption value="" disabled>
                    Choose a person
                  </NativeSelectOption>
                  {people.map((person) => (
                    <NativeSelectOption key={person.id} value={person.id}>
                      {person.name === undefined ? person.id : `${person.name} (${person.id})`}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id="who-name"
                  autoFocus
                  autoComplete="off"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="marketing-lead"
                />
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
