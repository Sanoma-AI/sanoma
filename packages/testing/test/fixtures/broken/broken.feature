Feature: A scenario with a step no rule matches

  Scenario: Launch with a typo
    When announce runs
    Then the blog is on fire
