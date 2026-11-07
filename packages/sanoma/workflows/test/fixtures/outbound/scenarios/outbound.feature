Feature: Move a lead on
  The outbound collection starts empty: each scenario seeds the leads it needs.

  Scenario: A researched lead is contacted
    Given data.outbound "Acme" has
      | contact | ada@acme.test |
      | stage   | researched    |
      | owner   | leon          |
    When outbound-next runs with
      | company | Acme |
    Then data.outbound.get was called with
      | key | Acme |
    And data.outbound.save was called with
      """
      { "record": { "company": "Acme", "contact": "ada@acme.test", "stage": "contacted", "owner": "leon" } }
      """
    And the run succeeds

  Scenario: A company with no lead is left alone
    Given data.outbound "Acme" is gone
    When outbound-next runs with
      | company | Acme |
    Then data.outbound.save was not called
    And the run succeeds
