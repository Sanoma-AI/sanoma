Feature: sanoma.wakeup
  An instance of the wakeup service is created for a host, read, registered with and deleted.
  Each scenario runs on the fake and on the service's recorded replies (test/fixtures/wakeup/,
  named after the scenario), unless tagged @fake-only.

  Scenario: Create an instance
    When sanoma.wakeup.create is called with
      """
      { "desired": { "host": "https://company.example.test/" } }
      """
    Then it returns
      """
      { "state": { "host": "https://company.example.test", "at": null } }
      """

  Scenario: Read
    Given a sanoma wakeup for "https://company.example.test"
    When sanoma.wakeup.read is called with
      | id | $wakeup.id |
    Then it returns
      """
      { "gone": false, "state": { "host": "https://company.example.test" } }
      """

  Scenario: Plan a new host
    Given a sanoma wakeup for "https://company.example.test"
    When sanoma.wakeup.plan is called with
      """
      { "id": "$wakeup.id", "desired": { "host": "https://elsewhere.example.test" } }
      """
    Then it returns
      """
      { "action": "update", "replace": [] }
      """

  Scenario: Register a wake
    Given a sanoma wakeup for "https://company.example.test"
    When sanoma.wakeup.register is called with
      | at | 2099-01-01T00:00:00Z |
    And sanoma.wakeup.read is called with
      | id | $wakeup.id |
    Then sanoma.wakeup.register was called with
      | at | 2099-01-01T00:00:00Z |
    And it returns
      """
      { "state": { "at": "2099-01-01T00:00:00.000Z" } }
      """

  Scenario: Register again
    Given a sanoma wakeup for "https://company.example.test"
    When sanoma.wakeup.register is called with
      | at | 2099-01-01T00:00:00Z |
    And sanoma.wakeup.register is called with
      | at | 2098-01-01T00:00:00Z |
    And sanoma.wakeup.read is called with
      | id | $wakeup.id |
    Then it returns
      """
      { "state": { "at": "2098-01-01T00:00:00.000Z" } }
      """

  Scenario: Register after a delete
    Given a sanoma wakeup for "https://company.example.test"
    When sanoma.wakeup.delete is called with
      | id | $wakeup.id |
    And sanoma.wakeup.register is called with
      | at | 2099-01-01T00:00:00Z |
    Then it fails with status 401

  Scenario: Delete
    Given a sanoma wakeup for "https://company.example.test"
    When sanoma.wakeup.delete is called with
      | id | $wakeup.id |
    And sanoma.wakeup.read is called with
      | id | $wakeup.id |
    Then it returns
      | gone | true |

  Scenario: Create for a URL with a query
    When sanoma.wakeup.create is called with
      """
      { "desired": { "host": "https://company.example.test/?x=1" } }
      """
    Then it fails with status 400
