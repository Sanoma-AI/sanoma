// Sanoma's claims (`sanoma/claims`): the tier, review and blocks Sanoma records about connectors
// and apps, and the solutions, each a kind of customer with its apps and demo. Data, changed by a
// pull request to the sanoma repository. A company's sites import it statically, as sanoma.ai's
// solution pages do; the listing of apps on GitHub (`sanoma.apps.list`) joins it at run time.
export {
  appClaim,
  appTier,
  type AppClaim,
  type Claims,
  claims,
  connectorTier,
  type ConnectorClaim,
  SANOMA_ORG,
  type SolutionClaim,
  type Tier,
  TIERS,
} from "@sanoma-ai/workflows/shared";
