Feature: Two reviews
  Legal reviews first, then the boss does a final check.

  Scenario: Decided by title
    When review-twice runs
    And "Final check" is approved by boss
    And "Legal review" is approved by legal
    Then the run succeeds

  Scenario: Decided in order
    When review-twice runs
    And "the first one" is approved by legal
    And "the second one" is approved by boss
    Then the run succeeds

  Scenario: Missing a decision
    When review-twice runs
    And "Legal review" is approved by legal
    Then the run succeeds
