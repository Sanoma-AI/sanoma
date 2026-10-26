Feature: sanoma-ops wakeups
  An instance of the wakeup service is created for a host, read, registered with and deleted.
  Each scenario runs on the fake and on the service's recorded replies (test/fixtures/, named
  after the scenario), unless tagged @fake-only.

  Scenario: Create
    When sanomaOps.wakeup.create is called with
      """
      { "desired": { "host": "https://company.example.test/" } }
      """
    Then it returns
      """
      { "state": { "host": "https://company.example.test", "generation": 0, "at": null } }
      """

  Scenario: Read
    Given a sanoma-ops wakeup for "https://company.example.test"
    When sanomaOps.wakeup.read is called with
      | id | $wakeup.id |
    Then it returns
      """
      { "gone": false, "state": { "host": "https://company.example.test" } }
      """

  Scenario: Plan a new host
    Given a sanoma-ops wakeup for "https://company.example.test"
    When sanomaOps.wakeup.plan is called with
      """
      { "id": "$wakeup.id", "desired": { "host": "https://elsewhere.example.test" } }
      """
    Then it returns
      """
      { "action": "replace", "replace": ["host"] }
      """

  Scenario: Register
    Given a sanoma-ops wakeup for "https://company.example.test"
    When sanomaOps.wakeup.register is called with
      | at         | 2099-01-01T00:00:00Z |
      | generation | 1                    |
    And sanomaOps.wakeup.read is called with
      | id | $wakeup.id |
    Then a sanoma-ops wake is registered with generation 1
    And it returns
      """
      { "state": { "at": "2099-01-01T00:00:00.000Z", "generation": 1 } }
      """

  Scenario: Register an older generation
    Given a sanoma-ops wakeup for "https://company.example.test"
    When sanomaOps.wakeup.register is called with
      | at         | 2099-01-01T00:00:00Z |
      | generation | 2                    |
    And sanomaOps.wakeup.register is called with
      | at         | 2098-01-01T00:00:00Z |
      | generation | 1                    |
    And sanomaOps.wakeup.read is called with
      | id | $wakeup.id |
    Then it returns
      """
      { "state": { "at": "2099-01-01T00:00:00.000Z", "generation": 2 } }
      """

  Scenario: Delete
    Given a sanoma-ops wakeup for "https://company.example.test"
    When sanomaOps.wakeup.delete is called with
      | id | $wakeup.id |
    And sanomaOps.wakeup.read is called with
      | id | $wakeup.id |
    Then it returns
      | gone | true |

  Scenario: Create for a URL with a query
    When sanomaOps.wakeup.create is called with
      """
      { "desired": { "host": "https://company.example.test/?x=1" } }
      """
    Then it fails with status 400
