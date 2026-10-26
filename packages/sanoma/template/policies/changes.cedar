// Every change to this repository waits for admin before it merges: one reviewer for everything
// at the start. Edit or replace it when another group should own part of the repository, with a
// rule on the change's facts, such as `when { resource.touches.contains("resources/finance/") }`
// (an app's files are under apps/<app>/: name `apps/crm/resources/` too for its data).
// A change to policies/, an app's policies/ or the people waits for admin whatever this file says.
@id("changes-wait-for-admin")
@hold("admin")
@title("Every change waits for admin")
forbid (principal, action == Sanoma::Action::"sanoma.change.merge", resource is Sanoma::Change);
