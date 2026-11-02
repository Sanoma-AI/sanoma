Feature: Resend sending domains
  A domain is created and asked to verify, read, imported by its name, planned and deleted. Each
  scenario runs on the fake and on replies written from Resend's API reference (test/fixtures/,
  named after the scenario). A Given domain is seeded as apply makes it: created, then asked to
  verify, which leaves it pending until its DNS records are found.

  Scenario: Create a domain
    When resend.domain.create is called with
      """
      { "desired": { "name": "example.com" } }
      """
    Then it returns
      """
      {
        "state": {
          "name": "example.com",
          "region": "us-east-1",
          "custom_return_path": "send",
          "status": "pending"
        }
      }
      """

  Scenario: Create a domain twice
    Given a Resend domain "example.com"
    When resend.domain.create is called with
      """
      { "desired": { "name": "example.com" } }
      """
    Then it returns
      """
      { "state": { "name": "example.com", "status": "pending" } }
      """

  Scenario: Read a domain
    Given a Resend domain "example.com"
    When resend.domain.read is called with
      | id | $domain.id |
    Then it returns
      """
      { "gone": false, "state": { "name": "example.com", "region": "us-east-1", "status": "pending" } }
      """

  Scenario: Import a domain by its name
    Given a Resend domain "example.com"
    When resend.domain.import is called with
      | id | example.com |
    Then it returns
      """
      { "gone": false, "state": { "name": "example.com", "status": "pending" } }
      """

  Scenario: Plan a domain Resend has not verified
    Given a Resend domain "example.com"
    When resend.domain.plan is called with
      """
      { "id": "$domain.id", "desired": { "name": "example.com" } }
      """
    Then it returns
      """
      { "action": "update", "unknown": ["status", "records"], "replace": [] }
      """

  Scenario: Move a domain to another region
    Given a Resend domain "example.com"
    When resend.domain.plan is called with
      """
      { "id": "$domain.id", "desired": { "name": "example.com", "region": "eu-west-1" } }
      """
    Then it returns
      """
      { "action": "replace", "replace": ["region"] }
      """

  Scenario: Delete a domain
    Given a Resend domain "example.com"
    When resend.domain.delete is called with
      | id | $domain.id |
    And resend.domain.read is called with
      | id | $domain.id |
    Then it returns
      | gone | true |
