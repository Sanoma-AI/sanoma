// What a site imports for its UI, as `sanoma/ui`: how a page looks, so a site looks like the app.
// An explicit list, nothing else of the app is public: the shadcn primitives the app is built
// from, the kit's own pieces (./components/kit.tsx), `toast` and `useDensity`. Presentational
// only: nothing here reaches the running app (test/ui.test.ts); what talks to it is
// `sanoma/site`'s. Source, loaded only by Vite in a company's build; browser code.

export { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
export {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "./components/ui/avatar.tsx";
export { Badge } from "./components/ui/badge.tsx";
export {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./components/ui/breadcrumb.tsx";
export { Button } from "./components/ui/button.tsx";
export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from "./components/ui/button-group.tsx";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card.tsx";
export { Checkbox } from "./components/ui/checkbox.tsx";
export { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible.tsx";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.tsx";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.tsx";
export { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./components/ui/empty.tsx";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./components/ui/field.tsx";
export { Input } from "./components/ui/input.tsx";
export {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "./components/ui/item.tsx";
export { Label } from "./components/ui/label.tsx";
export { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "./components/ui/native-select.tsx";
export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./components/ui/popover.tsx";
export { Separator } from "./components/ui/separator.tsx";
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/ui/sheet.tsx";
export { Skeleton } from "./components/ui/skeleton.tsx";
export { Slider } from "./components/ui/slider.tsx";
export { Spinner } from "./components/ui/spinner.tsx";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table.tsx";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
export { Textarea } from "./components/ui/textarea.tsx";
export { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";
// The app's root holds the Toaster: a site's toast shows where the app's do.
export { toast } from "sonner";

export {
  ButtonLink,
  effectBadge,
  Fact,
  Facts,
  Nothing,
  Notice,
  PageHeader,
  Region,
  StatusDot,
  Tip,
  ToneBadge,
  toneBadge,
} from "./components/kit.tsx";
export type { Tone } from "./lib/tone.ts";
export { useDensity } from "./components/density.tsx";
