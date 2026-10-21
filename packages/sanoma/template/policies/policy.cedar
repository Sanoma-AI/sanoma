// Who may do what. Everything a login admits is allowed unless a `forbid` here refuses it: one
// with @hold waits for that group's (or person's) approval, with @title as the Inbox's title;
// one without is denied, with @reason as the message. Every operation call and run start is
// decided here. Write against .sanoma/schema.cedarschema, which `sanoma check` writes: the
// actions (each operation's id, in its effect's group, and `workflow:<name>`), the groups
// resources/people.ts declares, and each operation's input as `context.input`.

// Publishing or sending waits for someone in editor, unless someone in editor asked for it.
@id("editor-reviews")
@hold("editor")
@title("Review before it goes out")
forbid (
  principal,
  action in [Sanoma::Action::"effect:publish", Sanoma::Action::"effect:send"],
  resource
)
unless { principal in Sanoma::Group::"editor" };
