Feature: Generate an invoice PDF
  The driver and scenario fake both execute the real local generator.

  Scenario: Invoice pet visits
    When invoices.pdf.generate is called with
      """
      { "options": {}, "document": { "kind": "pet-sitting", "invoice": { "number": "PET-001", "issuedOn": "2026-10-30", "currency": "USD", "issuer": { "name": "Clover Pet Care" }, "recipient": { "name": "Alex Morgan" }, "pets": ["Milo"], "services": [{ "service": "visit", "quantity": "5", "unitPrice": "25" }] } } }
      """
    Then an invoice PDF was generated for "PET-001"
    And it returns
      | mediaType           | application/pdf |

  Scenario: Invoice home cleaning
    When invoices.pdf.generate is called with
      """
      { "options": {}, "document": { "kind": "cleaning", "invoice": { "number": "HOME-001", "issuedOn": "2026-10-30", "currency": "USD", "issuer": { "name": "Clover Cleaning" }, "recipient": { "name": "Alex Morgan" }, "property": "Two-bedroom home", "services": [{ "service": "deep", "quantity": "1", "unitPrice": "180" }, { "service": "oven", "quantity": "1", "unitPrice": "35" }] } } }
      """
    Then an invoice PDF was generated for "HOME-001"
    And it returns
      | mediaType           | application/pdf |

  Scenario: Refuse an overpayment
    When invoices.pdf.generate is called with
      """
      { "options": {}, "document": { "kind": "cleaning", "invoice": { "number": "HOME-002", "issuedOn": "2026-10-30", "currency": "USD", "issuer": { "name": "Clover Cleaning" }, "recipient": { "name": "Alex Morgan" }, "paid": "100", "services": [{ "service": "standard", "quantity": "1", "unitPrice": "80" }] } } }
      """
    Then it fails with status 422
