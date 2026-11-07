import { sanoma } from "@sanoma-ai/workflows/resources";

export const ada = sanoma.person({ id: "ada", name: "Ada Lovelace" });
export const bo = sanoma.person({ id: "bo" });
export const refundBot = sanoma.agent({ id: "refund-bot", onBehalfOf: bo });
export const finance = sanoma.group({ name: "finance", members: [ada] });
