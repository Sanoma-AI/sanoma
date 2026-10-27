// What the Apps page's Add and Update say in the chat (through C7's `useChatPrompt().open`, lane A5's): the agent then
// takes or updates the app in its draft with `take_app` and `update_app`, as a change.

/** The chat's prompt to take the app whose source repository is at `source`, its https URL. */
export const takeAppPrompt = (source: string) =>
  `Take the app from ${source} into this company with take_app, resolve any conflicts, and run the checks.`;

/** The chat's prompt to merge the new commits of the source of the app in `apps/<folder>/`. */
export const updateAppPrompt = (folder: string) =>
  `Update the app in apps/${folder}/ from its source with update_app, resolve any conflicts, and run the checks.`;
