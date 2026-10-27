import { personsOf } from "@sanoma-ai/workflows/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { Button } from "#/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { useActor } from "../actor.ts";
import { type AppConfig, DEMO_AS, type DemoInfo } from "../api.ts";
import { configQuery } from "../queries.ts";
import { ButtonLink } from "./kit.tsx";

/** The people a visitor can be: the declared persons, as the demo login reads them. */
const selectPeople = (config: AppConfig) => personsOf(config.resources);

/** Loads the page again as the person `id`: the demo login keeps them, then drops `?as=`. */
function be(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(DEMO_AS, id);
  window.location.assign(url);
}

/**
 * Atop every page of a demo: who you are, with the people you could be instead (the page loads
 * again as them, `?as=<id>`), that nothing you do is kept, and "Start with these apps" when the
 * config's `demo.start` names where.
 */
export function DemoBanner({ demo }: { demo: DemoInfo }) {
  const { actor } = useActor();
  const { data: people } = useSuspenseQuery({ ...configQuery(), select: selectPeople });
  const you = people.find((p) => p.id === actor);
  return (
    <div
      role="region"
      aria-label="Demo"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted px-4 py-1.5 text-sm sm:px-6"
    >
      <span className="flex items-center gap-1">
        You are
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
            {you?.name ?? actor ?? "nobody"}
            <CaretDownIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Be someone else</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={actor ?? ""} onValueChange={be}>
                {people.map((p) => (
                  <DropdownMenuRadioItem key={p.id} value={p.id}>
                    {p.name ?? p.id}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <span className="text-muted-foreground">
        This is a demo: nothing you do here is saved, and it starts afresh every hour.
      </span>
      {demo.start && (
        <ButtonLink size="sm" className="ml-auto">
          <a href={demo.start}>
            Start with these apps
            <ArrowRightIcon aria-hidden="true" />
          </a>
        </ButtonLink>
      )}
    </div>
  );
}
