import { describe, expect, it, vi } from "vitest";

// `sanoma/ui` (`src/ui.ts`) is how a page looks: its module graph reaches nothing of the running
// app. Whatever talks to the app does it through one of these (the server functions are Start's,
// the queries Query's, the router state Router's, the wire types and the actor's cookie `api.ts`'s,
// the build's content `content.ts`'s, imported there only when called), so each loads here as a
// mock that throws: a kit module that imports one, at any depth, fails to load. A type import is
// erased, so it stays free.
const { refuse } = vi.hoisted(() => ({
  refuse: (what: string) => () => {
    throw new Error(`sanoma/ui reaches ${what}`);
  },
}));
vi.mock("@tanstack/react-start", refuse("@tanstack/react-start"));
vi.mock("@tanstack/react-query", refuse("@tanstack/react-query"));
vi.mock("@tanstack/react-router", refuse("@tanstack/react-router"));
vi.mock("../src/api.ts", refuse("the app's api.ts"));
vi.mock("../src/content.ts", refuse("the app's content"));

// By a path TypeScript does not follow: the kit is JSX and DOM, checked by typecheck:ui.
const load = (path: string) => import(new URL(path, import.meta.url).href) as Promise<Record<string, unknown>>;
/** An error's message and its causes', however Vitest wraps a mock's failure. */
const messages = (error: unknown): string[] =>
  error instanceof Error ? [error.message, ...messages(error.cause)] : [];

describe("sanoma/ui", () => {
  it("loads without the running app, and exports the kit's list and nothing else, so each addition is deliberate", async () => {
    // What talks to the app does not load here: the mocks bite.
    const refused = await load("../src/form/run-form.tsx").then(() => undefined, messages);
    expect(refused).toContainEqual(expect.stringMatching(/^sanoma\/ui reaches /));
    const ui = await load("../src/ui.ts");
    expect(Object.keys(ui).toSorted()).toMatchInlineSnapshot(`
      [
        "Alert",
        "AlertAction",
        "AlertDescription",
        "AlertTitle",
        "Avatar",
        "AvatarBadge",
        "AvatarFallback",
        "AvatarGroup",
        "AvatarGroupCount",
        "AvatarImage",
        "Badge",
        "Breadcrumb",
        "BreadcrumbEllipsis",
        "BreadcrumbItem",
        "BreadcrumbLink",
        "BreadcrumbList",
        "BreadcrumbPage",
        "BreadcrumbSeparator",
        "Button",
        "ButtonGroup",
        "ButtonGroupSeparator",
        "ButtonGroupText",
        "ButtonLink",
        "Card",
        "CardAction",
        "CardContent",
        "CardDescription",
        "CardFooter",
        "CardHeader",
        "CardTitle",
        "Checkbox",
        "Collapsible",
        "CollapsibleContent",
        "CollapsibleTrigger",
        "Dialog",
        "DialogClose",
        "DialogContent",
        "DialogDescription",
        "DialogFooter",
        "DialogHeader",
        "DialogTitle",
        "DialogTrigger",
        "DropdownMenu",
        "DropdownMenuCheckboxItem",
        "DropdownMenuContent",
        "DropdownMenuGroup",
        "DropdownMenuItem",
        "DropdownMenuLabel",
        "DropdownMenuRadioGroup",
        "DropdownMenuRadioItem",
        "DropdownMenuSeparator",
        "DropdownMenuShortcut",
        "DropdownMenuSub",
        "DropdownMenuSubContent",
        "DropdownMenuSubTrigger",
        "DropdownMenuTrigger",
        "Empty",
        "EmptyContent",
        "EmptyDescription",
        "EmptyHeader",
        "EmptyMedia",
        "EmptyTitle",
        "Fact",
        "Facts",
        "Field",
        "FieldContent",
        "FieldDescription",
        "FieldError",
        "FieldGroup",
        "FieldLabel",
        "FieldLegend",
        "FieldSeparator",
        "FieldSet",
        "FieldTitle",
        "Input",
        "Item",
        "ItemActions",
        "ItemContent",
        "ItemDescription",
        "ItemFooter",
        "ItemGroup",
        "ItemHeader",
        "ItemMedia",
        "ItemSeparator",
        "ItemTitle",
        "Label",
        "NativeSelect",
        "NativeSelectOptGroup",
        "NativeSelectOption",
        "Nothing",
        "Notice",
        "PageHeader",
        "Popover",
        "PopoverContent",
        "PopoverDescription",
        "PopoverHeader",
        "PopoverTitle",
        "PopoverTrigger",
        "Region",
        "Separator",
        "Sheet",
        "SheetClose",
        "SheetContent",
        "SheetDescription",
        "SheetFooter",
        "SheetHeader",
        "SheetTitle",
        "SheetTrigger",
        "Skeleton",
        "Slider",
        "Spinner",
        "StatusDot",
        "Table",
        "TableBody",
        "TableCaption",
        "TableCell",
        "TableFooter",
        "TableHead",
        "TableHeader",
        "TableRow",
        "Tabs",
        "TabsContent",
        "TabsList",
        "TabsTrigger",
        "Textarea",
        "Tip",
        "ToneBadge",
        "Tooltip",
        "TooltipContent",
        "TooltipTrigger",
        "effectBadge",
        "toast",
        "toneBadge",
        "useDensity",
      ]
    `);
  });
});
