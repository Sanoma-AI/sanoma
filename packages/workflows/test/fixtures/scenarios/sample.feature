Feature: Take a sample
  The lab has a driver but no fake, so a sandbox run cannot run it.

  Scenario: Sampled
    When sample runs
    Then lab.sample.take was called
