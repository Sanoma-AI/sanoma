Feature: Ghost posts
  Drafts are created, then published. Each scenario runs on the fake and on Ghost's recorded
  replies (test/fixtures/, named after the scenario), unless tagged @fake-only.

  Scenario: Create
    When ghost.post.create is called with
      | title | Launch         |
      | html  | <p>Hello</p>   |
    Then it returns
      | status | draft |

  Scenario: Publish draft
    Given a Ghost draft titled "Launch"
    When ghost.post.publish is called with
      | id | $draft.id |
    Then it returns
      | status | published |
    And the Ghost post "Launch" is published

  Scenario: Publish again
    Given a Ghost draft titled "Launch"
    When ghost.post.publish is called with
      | id | $draft.id |
    And ghost.post.publish is called with
      | id | $draft.id |
    Then it returns
      | status | published |

  @fake-only
  Scenario: Publish a post that is not there
    When ghost.post.publish is called with
      | id | missing |
    Then it fails with status 404
