import { allow, approve, definePolicy, deny } from "../../../../src/index.ts";

/**
 * The company's policy for an inspection: a secret repository is never read, and a product is
 * read once finance says so. Any other run, the drift check included, is let through.
 */
export default definePolicy((call) => {
  if (call.run.workflow !== "inspect") return allow();
  if (call.op.id === "github.repository.import" && call.target?.startsWith("secret")) {
    return deny("secret repositories stay private");
  }
  if (call.op.id === "stripe.product.import") return approve("finance", { title: "Read a product" });
  return allow();
});
