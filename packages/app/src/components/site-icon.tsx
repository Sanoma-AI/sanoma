import { BrowserIcon } from "@phosphor-icons/react/dist/csr/Browser";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import type { IconName } from "lucide-react/dynamic";
import ICONS from "virtual:sanoma/icons";

/**
 * A site's icon, sized by what holds it (`[&_svg]:size-*`): the Lucide icon its `site.ts` names,
 * one of those the build bundles (`virtual:sanoma/icons`), so the server draws it too; else the
 * default for its kind, a globe for a public site and a window for one in the app (as for a site
 * that names none, or a name Lucide does not have). Its stroke is Phosphor's regular weight's, as
 * the app's own icons beside it.
 */
export function SiteIcon({ icon, public: isPublic }: { icon?: IconName; public: boolean }) {
  const Icon = icon === undefined ? undefined : ICONS.get(icon);
  if (Icon) return <Icon strokeWidth={1.5} aria-hidden="true" />;
  return isPublic ? <GlobeIcon aria-hidden="true" /> : <BrowserIcon aria-hidden="true" />;
}
