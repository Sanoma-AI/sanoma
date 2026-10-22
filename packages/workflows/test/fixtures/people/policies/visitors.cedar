// A visitor of a public site, signed in or not, may ask for a refund; inside the run,
// refunds.cedar holds as for anyone.
permit (principal in Sanoma::Group::"visitors", action == Sanoma::Action::"workflow:refund", resource);
permit (principal == Sanoma::Principal::"anonymous", action == Sanoma::Action::"workflow:refund", resource);
