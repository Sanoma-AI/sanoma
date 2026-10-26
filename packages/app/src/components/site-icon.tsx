import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { DynamicIcon } from "lucide-react/dynamic";
import type { IconName } from "lucide-react/dynamic";

/** A site's default icon by its kind: a globe for a public site, a window for one in the app. */
const PublicIcon = () => <GlobeIcon aria-hidden="true" />;
const AppIcon = () => <BrowserIcon aria-hidden="true" />;

/**
 * A site's icon, sized by what holds it (`[&_svg]:size-*`): the Lucide icon its `site.ts` names,
 * which `DynamicIcon` loads in the browser as a chunk of its own, so the server, and the browser
 * until then, draw the default for its kind (as for a site that names none, or a name Lucide does
 * not have). Its stroke is Phosphor's regular weight's, as the app's own icons beside it.
 */
export function SiteIcon({ icon, public: isPublic }: { icon?: IconName; public: boolean }) {
  const Default = isPublic ? PublicIcon : AppIcon;
  if (!icon) return <Default />;
  return <DynamicIcon name={icon} fallback={Default} strokeWidth={1.5} aria-hidden="true" />;
}
