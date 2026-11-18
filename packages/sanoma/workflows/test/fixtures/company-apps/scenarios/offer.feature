Feature: Offer a quote

  Scenario: A shop customer the CRM knows gets the lower price and a score
    Given data.shop.customers "c1" has
      | email | ada@acme.test |
    And data.crm.customers "ada@acme.test" has
      | name | Ada |
    When offer runs with
      | id    | c1 |
      | items | 3  |
    Then operations.quote.run was called with
      """
      { "id": "c1", "items": 3 }
      """
    And data.crm.customers.get was called with
      """
      { "key": "ada@acme.test" }
      """
    And the run succeeds
