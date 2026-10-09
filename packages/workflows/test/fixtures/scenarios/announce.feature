Feature: Announce a launch
  The blog post and the newsletter are drafted, the copy approved, and at the launch time
  both go out with a post on Bluesky.

  Scenario: Launch on time
    Given a post titled "Old news" exists
    When announce runs with
      """
      { "title": "Acme Pro", "launchAt": "2030-01-01T09:00:00Z" }
      """
    And "Review launch copy" is approved by marketing-lead with note "ship it"
    Then a post titled "Acme Pro" is created
    And post "post_0002" is published
    And resend.broadcast.send was called
    And "Acme Pro https://blog.example.test/acme-pro/" is posted to Bluesky
    And the run succeeds

  Scenario: Publish retried
    Given ghost.post.publish fails once
    When announce runs with
      | title    | Retry                |
      | launchAt | 2030-01-01T09:00:00Z |
    And "Review launch copy" is approved by marketing-lead
    Then post "post_0001" is published
    And the run succeeds
