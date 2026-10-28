Feature: Cloudflare containers and alarms
  A company's Worker is created with its container application, read, planned and deleted; its
  object's alarm is created for it and registered with. Each scenario runs on the fake and on
  replies written from Cloudflare's API reference (test/fixtures/, named after the scenario),
  unless tagged @fake-only.

  Scenario: Create a container
    When cloudflare.container.create is called with
      """
      {
        "desired": {
          "name": "company",
          "image": "registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime:0.7.0",
          "source": "https://github.com/acme/company.git",
          "ref": "main",
          "revision": "abc123",
          "port": 3000
        }
      }
      """
    Then it returns
      """
      { "id": "company", "state": { "name": "company", "revision": "abc123", "port": 3000, "healthy": true } }
      """

  Scenario: Read
    Given a Cloudflare container for "company" at revision "abc123"
    When cloudflare.container.read is called with
      | id | company |
    Then it returns
      """
      {
        "gone": false,
        "state": {
          "name": "company",
          "image": "registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime:0.7.0",
          "source": "https://github.com/acme/company.git",
          "ref": "main",
          "revision": "abc123",
          "port": 3000,
          "healthy": true
        }
      }
      """

  Scenario: Plan a new image
    Given a Cloudflare container for "company" at revision "abc123"
    When cloudflare.container.plan is called with
      """
      {
        "id": "company",
        "desired": {
          "name": "company",
          "image": "registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime:0.8.0",
          "source": "https://github.com/acme/company.git",
          "ref": "main",
          "revision": "abc123",
          "port": 3000,
          "secrets": { "SANOMA_WAKEUP_TOKEN": { "$secret": "SANOMA_WAKEUP_TOKEN" } }
        }
      }
      """
    Then it returns
      """
      { "action": "update", "replace": [], "planned": { "image": "registry.cloudflare.com/0123456789abcdef0123456789abcdef/sanoma-ai-runtime:0.8.0" } }
      """

  Scenario: Delete
    Given a Cloudflare container for "company" at revision "abc123"
    When cloudflare.container.delete is called with
      | id | company |
    And cloudflare.container.read is called with
      | id | company |
    Then it returns
      | gone | true |

  Scenario: Create an alarm
    Given a Cloudflare container for "company" at revision "abc123"
    When cloudflare.alarm.create is called with
      """
      { "desired": { "host": "$host.state.url" } }
      """
    Then it returns
      """
      { "state": { "at": null, "healthy": true } }
      """

  Scenario: Register
    Given a Cloudflare container for "company" at revision "abc123"
    When cloudflare.alarm.create is called with
      """
      { "desired": { "host": "$host.state.url" } }
      """
    And cloudflare.alarm.register is called with
      | at | 2099-01-01T00:00:00Z |
    And cloudflare.alarm.read is called with
      | id | $host.state.url |
    Then cloudflare.alarm.register was called with
      | at | 2099-01-01T00:00:00Z |
    And it returns
      """
      { "state": { "at": "2099-01-01T00:00:00.000Z", "healthy": true } }
      """

  Scenario: Register again
    Given a Cloudflare container for "company" at revision "abc123"
    When cloudflare.alarm.create is called with
      """
      { "desired": { "host": "$host.state.url" } }
      """
    And cloudflare.alarm.register is called with
      | at | 2099-01-01T00:00:00Z |
    And cloudflare.alarm.register is called with
      | at | 2098-01-01T00:00:00Z |
    And cloudflare.alarm.read is called with
      | id | $host.state.url |
    Then it returns
      """
      { "state": { "at": "2098-01-01T00:00:00.000Z" } }
      """
