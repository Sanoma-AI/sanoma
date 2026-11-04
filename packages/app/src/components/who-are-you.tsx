import { personsOf, principalOf } from "@sanoma-ai/workflows/shared";
import type { ConfigDescription } from "@sanoma-ai/workflows/describe";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Avatar, AvatarFallback } from "#/components/ui/avatar.tsx";
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
import { Item, ItemContent, ItemMedia, ItemTitle } from "#/components/ui/item.tsx";
import { initialsOf } from "#/lib/names.ts";
import { useActor } from "../actor.ts";
import { configQuery } from "../queries.ts";

/** The declared people, each with the groups that list them, from the config. */
const selectPeople = (config: ConfigDescription) =>
  personsOf(config.resources).map((person) => ({
    id: person.id,
    name: person.name ?? person.id,
    groups: principalOf(person.id, config.resources)?.groups ?? [],
  }));

/** What the picker says under it: there is no login here. */
const NO_SIGN_IN = "On this machine, whoever is here is the company. No sign-in.";

/**
 * There is no login with the default resolver. The name is kept in this browser and sent with
 * every change. Rendered (and loaded) only under that resolver, while no name is stored. When
 * the data files declare people, you pick one of them, as only they are let in; until then, any
 * name goes.
 */
export default function WhoAreYou() {
  const { setActor } = useActor();
  const { data: people } = useSuspenseQuery({ ...configQuery(), select: selectPeople });
  return (
    // No way out but a name: every change needs one. Open, with no onOpenChange, so neither
    // Escape nor a press outside closes it.
    <Dialog open>
      <DialogContent showCloseButton={false}>
        {people.length > 0 ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Who are you?</DialogTitle>
              <DialogDescription>
                Runs you start and approvals you decide are recorded as you: one of the people{" "}
                <code>resources/people.ts</code> declares.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              {people.map((person) => (
                <Item
                  key={person.id}
                  variant="outline"
                  size="sm"
                  className="text-left hover:bg-muted"
                  render={<button type="button" onClick={() => setActor(person.id)} />}
                >
                  <ItemMedia>
                    <Avatar size="sm">
                      <AvatarFallback className="text-xs font-semibold">{initialsOf(person.name)}</AvatarFallback>
                    </Avatar>
                  </ItemMedia>
                  <ItemContent className="flex-row flex-wrap gap-1">
                    <ItemTitle>{person.name}</ItemTitle>
                    {person.groups.length > 0 && (
                      <span className="text-muted-foreground">· {person.groups.join(", ")}</span>
                    )}
                  </ItemContent>
                </Item>
              ))}
            </div>
            <p className="border-t pt-3 text-xs text-muted-foreground">{NO_SIGN_IN}</p>
          </div>
        ) : (
          <NameForm onName={setActor} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Any name, while the data files declare nobody: the one approvals ask for. */
function NameForm({ onName }: { onName: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onName(name.trim());
      }}
    >
      <DialogHeader>
        <DialogTitle>Who are you?</DialogTitle>
        <DialogDescription>
          Runs you start and approvals you decide are recorded under this name. Use the name approvals ask for, such as{" "}
          <code>marketing-lead</code>; people declared in <code>resources/people.ts</code> make this a choice of them.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="who-name">Your name</FieldLabel>
          <Input
            id="who-name"
            autoFocus
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="marketing-lead"
          />
        </Field>
      </FieldGroup>
      <p className="border-t pt-3 text-xs text-muted-foreground">{NO_SIGN_IN}</p>
      <DialogFooter>
        <Button type="submit" disabled={!name.trim()}>
          Continue
        </Button>
      </DialogFooter>
    </form>
  );
}
