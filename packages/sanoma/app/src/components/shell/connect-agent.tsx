import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "#/components/ui/collapsible.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "#/components/ui/item.tsx";
import { ENGINE_NAMES, type EngineName, MODEL_CONNECTOR, ownEngine } from "../../lib/chat.ts";
import { configQuery } from "../../queries.ts";
import { ButtonLink } from "../common.tsx";

// The empty chat while the person's agent is not connected, and when the menu's Agent… opens it:
// the ways to connect it, as cards, the person's own Claude plan first.

/** The agents with a card of their own: the rest of a person's own are under More agents. */
const CLAUDE = "claude-code";
const CODEX = "codex";

/**
 * The cards: Your Claude plan (its sign-in starts at once), Your ChatGPT plan through Codex (on a
 * live instance, where OpenAI's plan sign-in does not reach, an OpenAI API key, which is not
 * offered yet), an API key on the model's connector page (`vendor`'s, else the Anthropic connector
 * to add), and More agents. An agent has its card only when a connector of the company gives it
 * on a person's own plan (`ConfigDescription.agents`): a turn on any other fails. `onChoose` gets
 * the engine chosen: the chat opens on it and keeps it for the person's new chats.
 */
export function ConnectAgent({ vendor, onChoose }: { vendor?: string; onChoose: (engine: EngineName) => void }) {
  const { data: live } = useQuery({ ...configQuery(), select: (config) => config.place === "live" });
  const { data: own = [] } = useQuery({
    ...configQuery(),
    // The engines the chat knows, of the agents the company's connectors give on a person's own plan.
    select: (config) => config.agents.filter((agent) => agent.own && Object.hasOwn(ENGINE_NAMES, ownEngine(agent.id))),
  });
  const has = (id: string) => own.some((agent) => agent.id === id);
  const more = own.filter((agent) => agent.id !== CLAUDE && agent.id !== CODEX);
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
        {has(CLAUDE) && (
          <Item variant="outline" className="border-primary bg-card">
            <ItemContent>
              <ItemTitle>
                Your Claude plan <Badge variant="secondary">Recommended</Badge>
              </ItemTitle>
              <ItemDescription>Pro or Max. Sign in once in your browser; nothing extra to pay.</ItemDescription>
            </ItemContent>
            <Button className="w-full" onClick={() => onChoose("acp-claude-code")}>
              Sign in with Claude
            </Button>
          </Item>
        )}
        {!has(CODEX) ? null : live ? (
          <Item variant="outline" className="bg-card">
            <ItemContent>
              <ItemTitle>An OpenAI API key</ItemTitle>
              <ItemDescription>
                For Codex: not offered here yet. Your ChatGPT plan signs in on your computer.
              </ItemDescription>
            </ItemContent>
          </Item>
        ) : (
          <Item variant="outline" className="bg-card">
            <ItemContent>
              <ItemTitle>Your ChatGPT plan</ItemTitle>
              <ItemDescription>Plus or Pro, through Codex</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => onChoose("acp-codex")}>
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
              Other agents ({more.map((agent) => agent.title).join(", ")}) are under{" "}
              <CollapsibleTrigger className="underline underline-offset-4">More agents</CollapsibleTrigger>.{" "}
            </>
          )}
          Change it any time under Agent… in your menu.
        </p>
        <CollapsibleContent>
          <ItemGroup className="gap-2">
            {more.map((agent) => (
              <Item key={agent.id} variant="outline" size="xs" className="bg-card">
                <ItemContent>
                  <ItemTitle>{agent.title}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm" onClick={() => onChoose(ownEngine(agent.id) as EngineName)}>
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
