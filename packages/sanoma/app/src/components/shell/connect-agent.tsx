import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "#/components/ui/item.tsx";
import { DECLARE_BOX } from "../../api.ts";
import { boxless, enginesHere, enginesOf, MODEL_CONNECTOR } from "../../lib/chat.ts";
import { configQuery } from "../../queries.ts";
import { ButtonLink } from "../kit.tsx";
import { EngineMark } from "./engine-mark.tsx";

// The empty chat while the person's agent is not connected, and when the menu's Agent… opens it:
// the ways to connect it, as cards, the person's own Claude plan first.

/** The agents with a card of their own: the rest of a person's own are under More agents. */
const CLAUDE = "claude-code";
const CODEX = "codex";

/**
 * The cards, each with its agent's mark: Your Claude plan (its sign-in starts at once; on a live
 * instance that declares no box, what to declare instead, `DECLARE_BOX`), Your ChatGPT plan
 * through Codex (on a live instance, where OpenAI's plan sign-in does not reach, an OpenAI API key,
 * which is not offered yet), an API key on the model's connector page (`vendor`'s, else the
 * Anthropic connector to add), and More agents, the rest the chat can open on here
 * (`enginesHere`). An agent has its card only when a connector of the company gives it on a
 * person's own plan (`ConfigDescription.agents`): a turn on any other fails. `onChoose` gets the
 * engine chosen: the chat opens on it and keeps it for the person's new chats.
 */
export function ConnectAgent({ vendor, onChoose }: { vendor?: string; onChoose: (engine: string) => void }) {
  const { data: config } = useQuery(configQuery());
  const live = config?.place === "live";
  const noBox = config !== undefined && boxless(config);
  const own = config ? enginesOf(config.agents).filter((engine) => engine.plan === "own") : [];
  const here = new Set(config ? enginesHere(config).map((engine) => engine.name) : []);
  const claude = own.find((engine) => engine.agent === CLAUDE);
  const codex = own.find((engine) => engine.agent === CODEX);
  const more = own.filter((engine) => engine !== claude && engine !== codex && here.has(engine.name));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-2xl">Connect your agent</h2>
        <p className="text-muted-foreground">
          The agent makes every change: you ask in plain words, it drafts the change and checks it, and you save it. It
          runs on a plan you already pay for, or an API key.
        </p>
      </div>
      <ItemGroup className="gap-2">
        {claude && (here.has(claude.name) || noBox) && (
          <Item variant="outline" className="border-primary bg-card">
            <ItemMedia>
              <EngineMark engine={claude} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                Your Claude plan <Badge variant="secondary">Recommended</Badge>
              </ItemTitle>
              <ItemDescription>
                {noBox ? `${DECLARE_BOX}.` : "Pro or Max. Sign in once in your browser; nothing extra to pay."}
              </ItemDescription>
            </ItemContent>
            {!noBox && (
              <Button className="w-full" onClick={() => onChoose(claude.name)}>
                Sign in with Claude
              </Button>
            )}
          </Item>
        )}
        {!codex ? null : live ? (
          <Item variant="outline" className="bg-card">
            <ItemMedia>
              <EngineMark engine={codex} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>An OpenAI API key</ItemTitle>
              <ItemDescription>
                For Codex: not offered here yet. Your ChatGPT plan signs in on your computer.
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : (
          <Item variant="outline" className="bg-card">
            <ItemMedia>
              <EngineMark engine={codex} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Your ChatGPT plan</ItemTitle>
              <ItemDescription>Plus or Pro, through Codex</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => onChoose(codex.name)}>
                Sign in
              </Button>
            </ItemActions>
          </Item>
        )}
        <Item variant="outline" className="bg-card">
          <ItemContent>
            <ItemTitle>An API key</ItemTitle>
            <ItemDescription>Anthropic, billed for what you use</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ButtonLink variant="outline" size="sm">
              {vendor ? (
                <Link to="/connectors/$vendor" params={{ vendor }} onClick={() => onChoose("loop")}>
                  Add key
                </Link>
              ) : (
                <Link to="/connectors" search={{ add: MODEL_CONNECTOR }} onClick={() => onChoose("loop")}>
                  Add key
                </Link>
              )}
            </ButtonLink>
          </ItemActions>
        </Item>
      </ItemGroup>
      <Collapsible className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {more.length > 0 && (
            <>
              Other agents ({more.map((engine) => engine.title).join(", ")}) are under{" "}
              <CollapsibleTrigger className="underline underline-offset-4">More agents</CollapsibleTrigger>.{" "}
            </>
          )}
          Change it any time under Agent… in your menu.
        </p>
        <CollapsibleContent>
          <ItemGroup className="gap-2">
            {more.map((engine) => (
              <Item key={engine.name} variant="outline" size="xs" className="bg-card">
                <ItemMedia>
                  <EngineMark engine={engine} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{engine.title}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm" onClick={() => onChoose(engine.name)}>
                    Sign in
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
