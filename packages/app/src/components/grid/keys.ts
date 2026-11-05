import type { CellSelectionDirection } from "@tanstack/react-table";
import { type UseHotkeyDefinition, useHotkeys } from "@tanstack/react-hotkeys";

// The grid's keyboard, scoped to the grid's body, so a heading's sort link keeps Tab, the arrows
// and Space. Typing a character on a cell starts editing it with that character: the grid's own
// key handler reads it (`typedCharacter`), as no hotkey names every key.

/** What the keys do: the grid's to say. */
interface GridKeys {
  /** Whether a cell is being edited: its editor has the keys, but Enter, Esc and Tab. */
  editing: boolean;
  /** Moves the selection a cell, answering whether it moved. */
  move: (direction: CellSelectionDirection) => boolean;
  extend: (direction: CellSelectionDirection) => void;
  edit: () => void;
  /** Saves the edit, then moves the selection, when told where. */
  commit: (then?: CellSelectionDirection) => void;
  cancel: () => void;
  expand: () => void;
  copy: () => void;
}

const ARROWS = [
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
] as const;

const TABS = [
  ["Tab", "right"],
  ["Shift+Tab", "left"],
] as const;

/** Registers the grid's keys on `target`, the grid's body (none while it is not mounted). */
export function useGridKeys(target: HTMLElement | null, keys: GridKeys) {
  const browsing = { enabled: !keys.editing };
  // An editor is a text field, select or checkbox, whose own keys the hotkeys leave to it unless told.
  const editing = { enabled: keys.editing, ignoreInputs: false };
  const definitions: UseHotkeyDefinition[] = [
    ...ARROWS.flatMap(([key, direction]) => [
      { hotkey: key, callback: () => void keys.move(direction), options: browsing },
      { hotkey: `Shift+${key}` as const, callback: () => keys.extend(direction), options: browsing },
    ]),
    { hotkey: "Enter", callback: keys.edit, options: browsing },
    { hotkey: "F2", callback: keys.edit, options: browsing },
    { hotkey: "Space", callback: keys.expand, options: browsing },
    { hotkey: "Mod+C", callback: keys.copy, options: browsing },
    { hotkey: "Enter", callback: () => keys.commit(), options: editing },
    { hotkey: "Escape", callback: keys.cancel, options: editing },
    ...TABS.flatMap(([key, direction]) => [
      // Past the last cell, the browser's own Tab takes the focus out of the grid: never a trap.
      {
        hotkey: key,
        callback: (event: KeyboardEvent) => {
          if (keys.move(direction)) event.preventDefault();
        },
        options: { ...browsing, preventDefault: false },
      },
      { hotkey: key, callback: () => keys.commit(direction), options: editing },
    ]),
  ];
  useHotkeys(definitions, { target, conflictBehavior: "allow" });
}

/**
 * The character a key press types, when it starts an edit: one printable character without
 * Ctrl, Cmd or Alt (Shift is part of the character), and not Space, which expands the record.
 */
export function typedCharacter(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  return [...event.key].length === 1 && event.key !== " " ? event.key : undefined;
}
