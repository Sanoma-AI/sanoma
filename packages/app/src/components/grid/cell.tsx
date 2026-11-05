import { Checkbox } from "#/components/ui/checkbox.tsx";
import { Input } from "#/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "#/components/ui/native-select.tsx";
import { buildInput, initialValue, type ScalarField, type ScalarValue } from "../../form/schema.ts";

// A cell's editor, by its field's kind (`fieldsOf(collection.record)`): text and a number in an
// input, a date in a date input, yes or no a checkbox, an enum's values and the declared people
// a select. What it holds is the form's own value for the field (`ScalarValue`), so the record
// it saves is read as the record form reads it (`buildInput`).

/** The kinds a typed character starts with: what is typed into a text input. */
const TYPED = new Set<ScalarField["kind"]>(["string", "number", "integer", "json"]);

/** A date alone, as a date input holds it; a date a workflow saved with a time is edited as text. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What the editor starts with: the character typed on the cell, for a field typed into (a
 * person's id too while no people are declared to choose from), or else the cell's value as the
 * form holds it.
 */
export function draftOf(
  field: ScalarField,
  value: unknown,
  typed: string | undefined,
  people: readonly string[],
): ScalarValue {
  const typedInto = TYPED.has(field.kind) || (field.kind === "person" && people.length === 0);
  return typed !== undefined && typedInto ? typed : (initialValue(field, value) as ScalarValue);
}

/**
 * The record with the field as edited: the field left out when the edit empties an optional one,
 * or what the edit cannot be read as (a number that is not one).
 */
export function recordWith(
  field: ScalarField,
  base: Record<string, unknown>,
  draft: ScalarValue,
): { record: Record<string, unknown> } | { error: string } {
  const { input, errors } = buildInput([field], { [field.key]: draft });
  const error = errors[field.key];
  if (error) return { error };
  return { record: withValue(base, field.key, input[field.key]) };
}

/**
 * `record` with `field` set to `value`, or left out when `value` is undefined: in the record's
 * own order, so an edit that changes nothing reads as the record it was.
 */
export function withValue(record: Record<string, unknown>, field: string, value: unknown): Record<string, unknown> {
  const next = { ...record };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next;
}

/** Focuses an editor once it mounts, its caret after the text. */
function focusEditor(element: HTMLElement | null) {
  element?.focus();
  if (element instanceof HTMLInputElement && element.type === "text") {
    element.setSelectionRange(element.value.length, element.value.length);
  }
}

/**
 * The editor of a cell being edited, focused as it mounts. `people` are the ids a person field
 * chooses from. Enter, Esc and Tab are the grid's (`keys.ts`); leaving it (`onBlur`) commits.
 */
export function CellEditor({
  field,
  draft,
  people,
  label,
  onDraft,
  onBlur,
}: {
  field: ScalarField;
  draft: ScalarValue;
  people: readonly string[];
  /** What the editor is called: the field and the record's key. */
  label: string;
  onDraft: (draft: ScalarValue) => void;
  onBlur: () => void;
}) {
  const text = typeof draft === "string" ? draft : "";
  const common = { ref: focusEditor, "aria-label": label, onBlur };
  const onText = (e: { target: { value: string } }) => onDraft(e.target.value);
  switch (field.kind) {
    case "boolean":
      return <Checkbox {...common} checked={draft === true} onCheckedChange={(checked) => onDraft(checked === true)} />;
    case "enum":
    case "person": {
      // A person is a choice of the people while some are declared, whoever the record names
      // among them, declared or not; else their id, typed.
      if (field.kind === "person" && people.length === 0) break;
      const values: readonly unknown[] =
        field.kind === "enum"
          ? (field.options ?? [])
          : people.includes(text) || text === ""
            ? people
            : [text, ...people];
      return (
        <NativeSelect {...common} size="sm" className="w-full" value={text} onChange={onText}>
          <NativeSelectOption value="" disabled={field.required}>
            {field.required ? "Choose…" : "(none)"}
          </NativeSelectOption>
          {values.map((value, i) => (
            <NativeSelectOption key={String(value)} value={field.kind === "enum" ? String(i) : String(value)}>
              {String(value)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      );
    }
    case "date":
      if (text === "" || DATE_ONLY.test(text)) {
        return <Input {...common} type="date" className="h-7" value={text} onChange={onText} />;
      }
      break;
  }
  return (
    <Input
      {...common}
      type="text"
      autoComplete="off"
      inputMode={field.kind === "number" || field.kind === "integer" ? "decimal" : undefined}
      className="h-7"
      value={text}
      onChange={onText}
    />
  );
}
