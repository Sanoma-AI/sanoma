Feature: Say hello

  Scenario: A post goes out
    When hello runs with
      | title | Hello |
    Then a post titled "Hello" is created
    And post "post_0001" is published
    And the run succeeds
