// A refund over 10,000.00, in minor units, waits for finance.
@hold("finance")
@title("Refund over 10,000")
forbid (principal, action == Sanoma::Action::"shop.refunds.create", resource)
when { context.input.amount > 1000000 }
unless { principal in Sanoma::Group::"finance" };

@id("no-agent-refunds")
@reason("Agents do not refund")
forbid (principal in Sanoma::Group::"agents", action in Sanoma::Action::"effect:money", resource);
