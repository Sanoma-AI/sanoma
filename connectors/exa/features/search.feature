Feature: Exa search
  A search of the web, and the pages like a page. Each scenario runs on the fake and on Exa's
  replies (test/fixtures/, named after the scenario), unless tagged @fake-only.

  Scenario: Search the web
    When exa.web.search is called with
      """
      { "query": "workflow automation for small businesses", "numResults": 2, "contents": { "text": { "maxCharacters": 200 } } }
      """
    Then Exa was searched for "workflow automation"

  Scenario: Find similar pages
    When exa.web.findSimilar is called with
      """
      { "url": "https://exa.ai/", "numResults": 2, "excludeSourceDomain": true }
      """
    Then exa.web.findSimilar was called

  @fake-only
  Scenario: Search while rate limited
    Given exa.web.search is rate limited once
    When exa.web.search is called with
      | query | anything |
    Then it fails with status 429
