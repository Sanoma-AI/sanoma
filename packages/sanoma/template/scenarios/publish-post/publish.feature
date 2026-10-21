Feature: Publish a post
  The post is drafted and published. The policy holds the publish for the editor group, unless
  someone in editor started the run. A scenario runs as the agent `scenarios` unless it says who
  is acting.

  Scenario: The editor approves
    When publish-post runs with
      | title | Hello from us          |
      | html  | <p>Our first post.</p> |
    And "Review before it goes out" is approved by reviewer
    Then ghost.post.publish was held for group "editor"
    And a post titled "Hello from us" is created
    And step "Publish the post" ran 1 time
    And the run succeeds

  Scenario: The editor rejects
    When publish-post runs with
      | title | Hello from us |
    And "Review before it goes out" is rejected by reviewer
    Then ghost.post.publish was not called
    And the run fails with "approval_rejected"

  Scenario: An editor publishes without a review
    Given reviewer is acting
    When publish-post runs with
      | title | Hello from us |
    Then ghost.post.publish was called
    And the run succeeds
