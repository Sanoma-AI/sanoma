Feature: Follow up with a customer

  Scenario: A customer is followed up
    Given data.crm.customers "ada@acme.test" has
      | name | Ada |
    When crm.follow-up runs with
      | email | ada@acme.test |
    Then data.crm.customers.save was called with
      """
      { "record": { "email": "ada@acme.test", "name": "Ada", "followedUp": true } }
      """
    And the run succeeds

  Scenario: Someone unknown is left alone
    Given data.crm.customers "bo@acme.test" is gone
    When crm.follow-up runs with
      | email | bo@acme.test |
    Then data.crm.customers.save was not called
    And the run succeeds
