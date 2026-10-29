import { collection } from "sanoma/data";

/** A dog walker's clients: whose dog, this month's walks and the rate, and where the invoice is. */
export const clients = collection({
  name: "clients",
  title: "Clients",
  key: "client",
  fields: {
    client: "text",
    dog: "text",
    email: "text",
    walks: "number",
    rate: "number",
    invoice: { enum: ["to send", "sent", "paid"] },
  },
});
