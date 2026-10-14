Feature: Bluesky posts
  Each scenario runs on the fake and on Bluesky's recorded replies (test/fixtures/, named after
  the scenario), unless tagged @fake-only.

  Scenario: Post
    When bluesky.post.create is called with
      | text | Hello from a test https://example.com |
    Then Bluesky has a post with "Hello from a test"

  Scenario: Two posts
    When bluesky.post.create is called with
      | text | First |
    And bluesky.post.create is called with
      | text | Second |
    Then Bluesky has a post with "First"
    And Bluesky has a post with "Second"

  @fake-only
  Scenario: Rate limited
    Given bluesky.post.create is rate limited once
    When bluesky.post.create is called with
      | text | Too soon |
    Then it fails with status 429
