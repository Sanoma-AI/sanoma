Feature: Neon projects
  A project is created, read, waited for, planned against a new declaration and deleted. Each
  scenario runs on the fake and on Neon's recorded replies (test/fixtures/, named after the
  scenario). A Given project is seeded as apply makes it: its compute has started.

  Scenario: Create a project
    When neon.project.create is called with
      """
      { "desired": { "name": "acme-ops", "region": "aws-us-east-1" } }
      """
    Then it returns
      """
      { "state": { "name": "acme-ops", "region": "aws-us-east-1", "size": "0.25" } }
      """

  Scenario: Read a project
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.project.read is called with
      | id | $project.id |
    Then it returns
      """
      { "gone": false, "state": { "name": "acme-ops", "region": "aws-us-east-1", "size": "0.25" } }
      """

  Scenario: Wait for a project's compute
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.project.health is called with
      | id | $project.id |
    Then it returns
      """
      { "healthy": true, "state": "active" }
      """

  Scenario: Resize a project
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.project.plan is called with
      """
      { "id": "$project.id", "desired": { "name": "acme-ops", "region": "aws-us-east-1", "size": "1" } }
      """
    Then it returns
      """
      { "action": "update", "replace": [], "planned": { "size": "1" } }
      """

  Scenario: Move a project to another region
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.project.plan is called with
      """
      { "id": "$project.id", "desired": { "name": "acme-ops", "region": "aws-eu-central-1" } }
      """
    Then it returns
      """
      { "action": "replace", "replace": ["region"] }
      """

  Scenario: Delete a project
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.project.delete is called with
      | id | $project.id |
    And neon.project.read is called with
      | id | $project.id |
    Then it returns
      | gone | true |

  Scenario: Create a project in a region Neon has not
    When neon.project.create is called with
      """
      { "desired": { "name": "acme-ops", "region": "aws-mars-1" } }
      """
    Then it fails with status 404
