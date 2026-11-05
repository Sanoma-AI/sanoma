import type { CellSelectionDirection } from "@tanstack/react-table";
import { type UseHotkeyDefinition, useHotkeys } from "@tanstack/react-hotkeys";

// The grid's keyboard, scoped to the grid's body (its cells, not its headings): arrows move the
// selection, Shift and an arrow extend it, Enter starts editing the cell or commits the edit, Esc
// cancels it, Tab moves right (and out of the grid past the last column), Space expands the
// record, Cmd/Ctrl+C copies the selection. Typing a character on a cell starts editing it with that character
// (`typedCharacter`, which the grid's own key handler reads, as no hotkey names every key).

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

/** Tab's move: the browser's own move of the focus, out of the grid, once the selection cannot move. */
const tab = (direction: CellSelectionDirection, move: GridKeys["move"]) => (event: KeyboardEvent) => {
  if (move(direction)) event.preventDefault();
};

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
    // Past the last cell, Tab leaves the grid: never a trap for the keyboard.
    { hotkey: "Tab", callback: tab("right", keys.move), options: { ...browsing, preventDefault: false } },
    { hotkey: "Shift+Tab", callback: tab("left", keys.move), options: { ...browsing, preventDefault: false } },
    { hotkey: "Enter", callback: () => keys.commit(), options: editing },
    { hotkey: "Escape", callback: keys.cancel, options: editing },
    { hotkey: "Tab", callback: () => keys.commit("right"), options: editing },
    { hotkey: "Shift+Tab", callback: () => keys.commit("left"), options: editing },
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
