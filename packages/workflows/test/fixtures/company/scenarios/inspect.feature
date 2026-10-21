Feature: Inspect a repository and a product
  The policy keeps secret repositories private, and has finance say before a person reads a
  product (steps.test.ts gives this fixture that policy).
  GitHub's fake holds the repositories its replies were recorded with (sanoma, provider-bridge).

  Scenario: A secret repository is refused
    When inspect runs with
      | repository | secret-plans        |
      | product    | prod_SanomaTest0001 |
    Then github.repository.import was denied
    And stripe.product.import was not called
    And the run fails with "policy_denied"

  Scenario: A product is read once finance says so
    When inspect runs with
      | repository | sanoma              |
      | product    | prod_SanomaTest0001 |
    And "Read a product" is approved by finance
    Then stripe.product.import was held for finance
    And stripe.product.import was called
    And the run succeeds

  Scenario: A repository GitHub no longer has ends the inspection
    Given github.repository "sanoma" is gone
    When inspect runs with
      | repository | sanoma              |
      | product    | prod_SanomaTest0001 |
    Then github.repository.import was called
    And stripe.product.import was not called
    And the run succeeds

  Scenario: A repository as someone edited it at GitHub
    Given github.repository "sanoma" has
      | description | Edited at GitHub |
    When inspect runs with
      | repository | sanoma              |
      | product    | prod_SanomaTest0001 |
    And "Read a product" is approved by finance
    Then github.repository.import was called with
      | id | sanoma |
    And the run succeeds
