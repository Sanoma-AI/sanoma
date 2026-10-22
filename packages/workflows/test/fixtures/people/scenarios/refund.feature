Feature: Refunds
  A refund over 10,000 waits for finance, and an agent refunds nothing, whoever it acts for.

  Scenario: A large refund waits for finance
    Given bo is acting
    When refund runs with
      | amount | 2000000 |
    And "Refund over 10,000" is approved by ada
    Then shop.refunds.create was held for group "finance"
    And shop.refunds.create was called
    And the run succeeds

  Scenario: An agent refunds nothing
    Given refund-bot is acting
    When refund runs with
      | amount | 500 |
    Then shop.refunds.create was denied with "Agents do not refund"
    And the run fails

  Scenario: A visitor refunds, as the policy permits
    Given a visitor is acting
    When refund runs with
      | amount | 500 |
    Then shop.refunds.create was called
    And the run succeeds

  Scenario: Anonymous's large refund waits for finance too
    Given anonymous is acting
    When refund runs with
      | amount | 2000000 |
    And "Refund over 10,000" is approved by ada
    Then shop.refunds.create was held for group "finance"
    And the run succeeds
