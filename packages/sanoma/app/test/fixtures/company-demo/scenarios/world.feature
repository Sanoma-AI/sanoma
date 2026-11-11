Feature: The company a demo opens on
  Dana's business has one client and a draft invoice for her, ready to send.

  Scenario: Dana's Pet Care
    Given data.clients "Ada Ortiz" has
      | email | ada@example.com |
    And data.invoicing.invoices "draft-1" has
      | client | Ada Ortiz |
      | status | draft     |
      | total  | $50.00    |
