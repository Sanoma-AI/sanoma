// The CRM's own rule, named with its app: nobody deletes a customer.
@id("crm-keeps-customers")
@reason("The CRM keeps every customer")
forbid (principal, action == Sanoma::Action::"data.crm.customers.delete", resource);
