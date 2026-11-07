import { createCn } from "cn/engine";
import tables from "./cn-tables.ts";

/**
 * shadcn's `cn` (components.json's `utils`), bound to merge tables compiled from this app's own
 * classes: cn/vite rewrites cn-tables.ts from src/**\/*.tsx and style.css's theme on every build.
 * vite.config.ts resolves `cn` to this module, so the generated components, which import `cn`
 * from "cn", use it too.
 */
export const cn = createCn(tables);

/** `n` and `word`, plural unless `n` is one ("3 groups"). */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
