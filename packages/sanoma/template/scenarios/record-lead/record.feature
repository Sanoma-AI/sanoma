Feature: Record a lead
  A new lead goes on the Outbound board at its first stage. A scenario runs as the agent
  `scenarios` unless it says who is acting.

  Scenario: A lead is recorded
    When record-lead runs with
      | company | Acme      |
      | contact | Sam Jones |
    Then data.outbound.save was called with
      """
      { "record": { "company": "Acme", "contact": "Sam Jones", "stage": "researched" } }
      """
    And step "Record the lead" ran 1 time
    And the run succeeds
