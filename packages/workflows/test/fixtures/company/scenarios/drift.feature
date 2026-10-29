Feature: Drift in the company's resources
  The fakes hold only what their replies were recorded with, none of it declared in resources/,
  so a scenario puts what the vendor holds of a declared resource before the check runs. The
  lockfile binds website, docs and websiteMain by their node ids, and pro by Stripe's id; docsMain
  and events are unbound.

  Scenario: A repository setting changed at GitHub
    Given github.repository "website" has
      | full_name   | Sanoma-AI/website    |
      | name        | website              |
      | node_id     | R_website            |
      | description | The company website  |
      | visibility  | public               |
      | has_wiki    | true                 |
      | topics      | ["website", "astro"] |
    When drift runs
    Then resources/identity/github.ts#website is drifted in has_wiki

  Scenario: A repository GitHub no longer has
    Given github.repository "docs" is gone
    When drift runs
    Then resources/identity/github.ts#docs is gone

  Scenario: A repository and a product as declared
    Given github.repository "docs" has
      | full_name   | Sanoma-AI/docs        |
      | name        | docs                  |
      | node_id     | R_docs                |
      | description | Product documentation |
      | visibility  | public                |
      | has_issues  | true                  |
    And stripe.product "prod_SanomaFixturePro" has
      | name     | Sanoma Pro      |
      | active   | true            |
      | metadata | {"tier": "pro"} |
    When drift runs
    Then resources/identity/github.ts#docs is clean
    And resources/billing/stripe.ts#pro is clean
    And resources/identity/github.ts#website is gone

  Scenario: Declarations the lockfile does not bind
    When drift runs
    Then resources/identity/rules.ts#docsMain is absent
    And resources/billing/stripe.ts#events is absent
