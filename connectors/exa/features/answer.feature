Feature: Exa answers
  A question answered from a search, with its sources. Each scenario runs on the fake and on
  Exa's replies (test/fixtures/, named after the scenario), unless tagged @fake-only.

  Scenario: Answer a question
    When exa.web.answer is called with
      | query | What does Exa do? |
    Then Exa was asked "What does Exa do"
