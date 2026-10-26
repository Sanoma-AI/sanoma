Feature: Neon branches and computes
  A branch of a project is made for a preview, and a project's compute is suspended. Each
  scenario runs on the fake and on Neon's replies (test/fixtures/, named after the scenario).

  Scenario: Branch a project
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.branch.create is called with
      | project | $project.id |
      | name    | preview-42  |
    Then a Neon branch "preview-42" was created

  Scenario: Suspend a project's compute
    Given a Neon project "acme-ops" in "aws-us-east-1"
    When neon.endpoint.suspend is called with
      | project | $project.id                       |
      | id      | $project.state.default_endpoint_id |
    Then it returns
      | state | idle |
