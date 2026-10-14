Feature: Resend broadcasts
  A broadcast is created as a draft, then sent. Each scenario runs on the fake and on Resend's
  recorded replies (test/fixtures/, named after the scenario), unless tagged @fake-only.

  Scenario: Create and send
    Given a Resend broadcast "Launch"
    When resend.broadcast.send is called with
      | id | $broadcast.id |
    Then it returns
      | status | queued |
    And the Resend broadcast "Launch" is sent

  @fake-only
  Scenario: Send a broadcast that is not there
    When resend.broadcast.send is called with
      | id | missing |
    Then it fails with status 404
