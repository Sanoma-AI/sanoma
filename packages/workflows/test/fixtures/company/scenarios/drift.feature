Feature: Drift in the company's resources
  The fakes hold only what their replies were recorded with, none of it declared in resources/,
  so a scenario puts what the vendor holds of a declared resource before the check runs.

  Scenario: A repository setting changed at GitHub
    Given github.repository "website" has
      | name        | website              |
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
      | name        | docs                  |
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
