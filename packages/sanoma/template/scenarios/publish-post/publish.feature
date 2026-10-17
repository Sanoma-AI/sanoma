Feature: Publish a post
  The post is drafted, the editor reviews it, and it is published.

  Scenario: The editor approves
    When publish-post runs with
      | title | Hello from us                 |
      | html  | <p>Our first post.</p>        |
    And "Review the post" is approved by editor
    Then a post titled "Hello from us" is created
    And step "Publish the post" ran 1 time
    And the run succeeds

  Scenario: The editor rejects
    When publish-post runs with
      | title | Hello from us |
    And "Review the post" is rejected by editor
    Then ghost.post.publish was not called
    And the run fails with "approval_rejected"
