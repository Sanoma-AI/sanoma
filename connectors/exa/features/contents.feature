Feature: Exa contents
  Pages read by URL. Each scenario runs on the fake and on Exa's replies (test/fixtures/, named
  after the scenario), unless tagged @fake-only.

  Scenario: Read a page
    When exa.web.getContents is called with
      """
      { "urls": ["https://exa.ai/"], "text": true }
      """
    Then it returns
      | statuses | [{ "id": "https://exa.ai/", "status": "success" }] |

  Scenario: A page that cannot be read
    When exa.web.getContents is called with
      """
      { "urls": ["https://gone.invalid/page"] }
      """
    Then it returns
      | statuses | [{ "id": "https://gone.invalid/page", "status": "error", "error": { "tag": "CRAWL_NOT_FOUND", "httpStatusCode": 404 } }] |
