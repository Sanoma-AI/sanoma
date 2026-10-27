Feature: Call an operation directly
  A sandbox run of call has the built-in drivers that read only the repository (sanoma.apps.list)
  beside its fakes: it is not refused for them, and may call them.

  Scenario: Apps listed directly
    When call runs with
      """
      { "op": "sanoma.apps.list", "input": {} }
      """
    Then sanoma.apps.list was called
    And the run succeeds
