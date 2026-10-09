import { tfConnector } from "@sanoma/bridge/connector";
import { provider, stripe_product, stripe_webhook_endpoint } from "./resources.gen.ts";

/**
 * Stripe's "S" glyph, from simple-icons (https://simpleicons.org/?q=stripe, CC0), in Stripe's
 * blurple, and white on dark backgrounds.
 */
const glyph = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"/></svg>`;

/** Stripe's id of a declared object, which the data file must give: Stripe sets it, so a data file names an object that exists. */
const idOf = ({ id }: { id?: string | null }) => id ?? "";

/**
 * Stripe, through the `stripe/stripe` OpenTofu provider: the generated resource types, found by
 * Stripe's own id, and who Stripe is. The connector, the data-file constructors, the driver and
 * the fake all come from this one record.
 */
export const stripeTf = tfConnector({
  vendor: "stripe",
  provider,
  types: {
    product: { tf: stripe_product, title: "Product", identity: "id", find: idOf },
    webhook_endpoint: { tf: stripe_webhook_endpoint, title: "Webhook endpoint", identity: "id", find: idOf },
  },
  info: {
    title: "Stripe",
    logo: { svg: glyph("#635BFF"), dark: glyph("#FFFFFF") },
    package: "@sanoma/connector-stripe",
    homepage: "https://github.com/Sanoma-AI/sanoma/tree/main/connectors/stripe#readme",
  },
});
