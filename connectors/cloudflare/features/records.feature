Feature: Cloudflare DNS records
  A set of DNS records in a zone, `<zone>/<name>`, each record marked with the comment
  `sanoma:<zone>/<name>`, is created, read, planned, updated and deleted. Each scenario runs on
  the fake and on the replies in test/fixtures/, named after the scenario (written from
  Cloudflare's API reference until the first live run records them).

  Background:
    When cloudflare.records.create is called with
      """
      {
        "desired": {
          "zone": "sanoma.work",
          "name": "check",
          "records": [
            { "type": "TXT", "name": "check-dkim._domainkey.sanoma.work", "content": "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcheck" },
            { "type": "MX", "name": "check-send.sanoma.work", "content": "feedback-smtp.us-east-1.amazonses.com", "priority": 10 },
            { "type": "TXT", "name": "check-send.sanoma.work", "content": "v=spf1 include:amazonses.com ~all" }
          ]
        }
      }
      """

  Scenario: Records create
    Then it returns
      """
      {
        "id": "sanoma.work/check",
        "state": {
          "zone": "sanoma.work",
          "name": "check",
          "records": [
            { "type": "MX", "name": "check-send.sanoma.work", "content": "feedback-smtp.us-east-1.amazonses.com", "priority": 10, "ttl": 1 },
            { "type": "TXT", "name": "check-dkim._domainkey.sanoma.work", "content": "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcheck", "ttl": 1 },
            { "type": "TXT", "name": "check-send.sanoma.work", "content": "v=spf1 include:amazonses.com ~all", "ttl": 1 }
          ]
        }
      }
      """

  Scenario: Records read
    When cloudflare.records.read is called with
      | id | sanoma.work/check |
    Then it returns
      """
      {
        "gone": false,
        "state": {
          "zone": "sanoma.work",
          "name": "check",
          "records": [
            { "type": "MX", "name": "check-send.sanoma.work", "content": "feedback-smtp.us-east-1.amazonses.com", "priority": 10, "ttl": 1 },
            { "type": "TXT", "name": "check-dkim._domainkey.sanoma.work", "content": "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcheck", "ttl": 1 },
            { "type": "TXT", "name": "check-send.sanoma.work", "content": "v=spf1 include:amazonses.com ~all", "ttl": 1 }
          ]
        }
      }
      """

  Scenario: Records plan none
    When cloudflare.records.plan is called with
      """
      {
        "id": "sanoma.work/check",
        "desired": {
          "zone": "sanoma.work",
          "name": "check",
          "records": [
            { "type": "TXT", "name": "check-send.sanoma.work", "content": "v=spf1 include:amazonses.com ~all" },
            { "type": "MX", "name": "check-send.sanoma.work", "content": "feedback-smtp.us-east-1.amazonses.com", "priority": 10, "ttl": 1 },
            { "type": "TXT", "name": "check-dkim._domainkey.sanoma.work", "content": "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCcheck" }
          ]
        }
      }
      """
    Then it returns
      """
      { "action": "none", "unknown": [], "replace": [] }
      """

  Scenario: Records update
    When cloudflare.records.update is called with
      """
      {
        "id": "sanoma.work/check",
        "desired": {
          "zone": "sanoma.work",
          "name": "check",
          "records": [
            { "type": "MX", "name": "check-send.sanoma.work", "content": "feedback-smtp.us-east-1.amazonses.com", "priority": 10 },
            { "type": "TXT", "name": "check-send.sanoma.work", "content": "v=spf1 include:amazonses.com -all" }
          ]
        }
      }
      """
    Then it returns
      """
      {
        "id": "sanoma.work/check",
        "state": {
          "records": [
            { "type": "MX", "name": "check-send.sanoma.work", "content": "feedback-smtp.us-east-1.amazonses.com", "priority": 10, "ttl": 1 },
            { "type": "TXT", "name": "check-send.sanoma.work", "content": "v=spf1 include:amazonses.com -all", "ttl": 1 }
          ]
        }
      }
      """

  Scenario: Records delete
    When cloudflare.records.delete is called with
      | id | sanoma.work/check |
    And cloudflare.records.read is called with
      | id | sanoma.work/check |
    Then it returns
      | gone | true |
