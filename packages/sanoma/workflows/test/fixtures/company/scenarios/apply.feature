Feature: Apply the company's resources
  A sandbox run applies to fakes of its own, which hold none of the bound objects, and keeps the
  lockfile it would write in memory: the lockfile in resources/ stays as it is.

  Scenario: A rule GitHub has is bound, and a repository GitHub lost is made again
    Given github.branch_protection "docs:main" has
      | id            | BPR_docs:main |
      | repository_id | R_docs        |
      | pattern       | main          |
    When apply runs with
      | answers | {"resources/identity/github.ts#docs": "recreate"} |
    Then resources/identity/rules.ts#docsMain is bound to "BPR_docs:main"
    And apply creates resources/identity/github.ts#docs
    And github.repository.create was called
    And the run succeeds
