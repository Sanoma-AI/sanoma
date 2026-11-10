// Who may do what. Everything a login admits is allowed unless a `forbid` here refuses it: one
// with @hold waits for that group's (or person's) approval, with @title as the Inbox's title;
// one without is denied, with @reason as the message. Every operation call and run start is
// decided here. Write against .sanoma/schema.cedarschema, which `sanoma check` writes: the
// actions (each operation's id, in its effect's group, and `workflow:<name>`), the groups
// resources/people.ts declares, and each operation's input as `context.input`.
// A `permit` is only for a public site's visitors: its principal `in Sanoma::Group::"visitors"` or `== Sanoma::Principal::"anonymous"`.

// Sending or publishing waits for someone in admin, unless someone in admin asked for it, or it
// is a sign-in code the runtime's agent `login` sends (the built-in `login-code` workflow).
@id("admin-reviews")
@hold("admin")
@title("Review before it goes out")
forbid (
  principal,
  action in [Sanoma::Action::"effect:publish", Sanoma::Action::"effect:send"],
  resource
)
unless { principal in Sanoma::Group::"admin" || principal == Sanoma::Principal::"login" };
