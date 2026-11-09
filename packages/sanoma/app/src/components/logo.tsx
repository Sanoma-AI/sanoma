import { cn } from "#/lib/utils.ts";

/**
 * A logo, 16 px unless `className` sizes it: `src`, and `dark` instead under the dark theme. Only
 * ever an `<img>`, where an SVG's scripts and external references never run or load.
 */
export function Logo({
  src,
  dark,
  alt,
  className,
}: {
  src: string;
  dark?: string | undefined;
  alt: string;
  className?: string | undefined;
}) {
  // A hidden <img> is out of the accessibility tree: one name is read either way.
  return (
    <>
      <img src={src} alt={alt} className={cn("size-4 shrink-0", dark && "dark:hidden", className)} />
      {dark && <img src={dark} alt={alt} className={cn("hidden size-4 shrink-0 dark:block", className)} />}
    </>
  );
}
