Feature: Resend emails
  One email, to an address or a list of them. Each scenario runs on the fake and on Resend's
  recorded replies (test/fixtures/, named after the scenario), unless tagged @fake-only.

  Scenario: Send an email
    When resend.emails.send is called with
      | to      | delivered@resend.dev                |
      | from    | Sanoma test <onboarding@resend.dev> |
      | subject | Following up                        |
      | html    | <p>Hello</p>                        |
      | text    | Hello                               |
    Then a Resend email to "delivered@resend.dev" is sent

  @fake-only
  Scenario: Send an email to a list
    When resend.emails.send is called with
      """
      { "to": ["ada@example.com", "grace@example.com"], "subject": "Following up", "text": "Hello" }
      """
    Then a Resend email to "grace@example.com" is sent
