import { defineMessages } from "sanoma/site";
import site from "./site.ts";

/** The site's own strings, in English and French: a key missing in one fails the check. */
export const messages = defineMessages(site, {
  en: { welcome: "Welcome to the intl site", read: (title: string) => `Read “${title}”` },
  fr: { welcome: "Bienvenue sur le site intl", read: (title: string) => `Lire « ${title} »` },
});
