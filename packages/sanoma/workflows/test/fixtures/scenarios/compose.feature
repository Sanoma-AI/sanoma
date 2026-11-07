Feature: Announce, in the connectors' own steps
  Steps from Ghost's, Resend's and Bluesky's packages in one scenario, beside the generic ones.

  Scenario: The newsletter fails to send
    Given a Ghost draft titled "Old news"
    And Resend fails to send once
    When announce runs with
      | title    | Acme Pro             |
      | launchAt | 2030-01-01T09:00:00Z |
    And "Review launch copy" is approved by marketing-lead
    Then the Ghost post "Acme Pro" is published
    And bluesky.post.create was not called
    And the run fails
