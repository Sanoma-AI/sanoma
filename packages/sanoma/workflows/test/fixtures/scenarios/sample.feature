Feature: Take a sample
  The lab has a driver, and a fake that implements none of its operations, so a sandbox run cannot run it.

  Scenario: Sampled
    When sample runs
    Then lab.sample.take was called
