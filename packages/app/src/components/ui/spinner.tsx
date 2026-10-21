import { cn } from "cn";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <CircleNotchIcon
      aria-hidden="false"
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
