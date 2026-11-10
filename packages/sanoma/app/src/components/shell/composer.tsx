import { ArrowUpIcon } from "@phosphor-icons/react/dist/csr/ArrowUp";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Badge } from "#/components/ui/badge.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "#/components/ui/input-group.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import type { EngineOption } from "../../lib/chat.ts";
import { EngineMark } from "./engine-mark.tsx";

/** Focuses a text box with its caret after its text: where a prompt's words go on. */
const focusAtEnd = (box: HTMLTextAreaElement | null) => {
  if (!box) return;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
};

/** An engine as the composer's choice. */
const engineOption = (engine: EngineOption) => (
  <DropdownMenuRadioItem key={engine.name} closeOnClick value={engine.name}>
    <EngineMark engine={engine} />
    {engine.label}
  </DropdownMenuRadioItem>
);

/**
 * The composer: the page you are on as a chip (`page`), the message (starting as `draft`, focused at its end, when a
 * page opened the chat with it), the engine a new chat opens on (`engine`, only then, of its
 * `options`: ours on the company's key, then a person's own plans in a group of their own), Send
 * (Enter; Shift+Enter for a new line), and while there is a `note` (where to connect a model), the
 * note, Send off.
 */
export function Composer({
  page,
  busy,
  onSend,
  draft,
  engine,
  note,
}: {
  page?: string;
  busy: boolean;
  onSend: (text: string) => void;
  draft?: string;
  engine?: { value: string; set: (engine: string) => void; options: EngineOption[] };
  note?: ReactNode;
}) {
  const [text, setText] = useState(draft ?? "");
  const noteId = useId();
  const chosen = engine?.options.find((option) => option.name === engine.value);
  const own = engine?.options.filter((option) => option.plan === "own") ?? [];

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || note || !text.trim()) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form onSubmit={submit}>
      <InputGroup className="rounded-xl">
        {page && (
          <InputGroupAddon align="block-start" className="pt-3">
            <Badge variant="outline" className="max-w-full">
              <span className="truncate">{page}</span>
            </Badge>
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          rows={2}
          ref={draft ? focusAtEnd : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
          }}
          aria-label="Message the agent"
          placeholder="Ask anything…"
          className="min-h-0 px-3"
        />
        {note && (
          <div id={noteId} className="w-full px-3">
            {note}
          </div>
        )}
        <InputGroupAddon align="block-end" className="px-3 pb-3">
          {engine && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <InputGroupButton
                    size="sm"
                    aria-label={`Engine: ${chosen?.label ?? engine.value}`}
                    className="-ml-2 text-xs"
                  />
                }
              >
                {chosen && <EngineMark engine={chosen} />}
                {chosen?.label ?? engine.value}
                <CaretDownIcon aria-hidden="true" data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56">
                <DropdownMenuRadioGroup value={engine.value} onValueChange={engine.set}>
                  <DropdownMenuGroup>
                    {engine.options.filter((option) => option.plan === "onKey").map(engineOption)}
                  </DropdownMenuGroup>
                  {own.length > 0 && (
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Your own plan</DropdownMenuLabel>
                      {own.map(engineOption)}
                    </DropdownMenuGroup>
                  )}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <InputGroupButton
            type="submit"
            size="icon-sm"
            variant="secondary"
            className="ml-auto"
            disabled={busy || !!note || !text.trim()}
            aria-label="Send"
            aria-describedby={note ? noteId : undefined}
          >
            {busy ? <Spinner /> : <ArrowUpIcon aria-hidden="true" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
