// The app bundle of a Worker made before its first bundle was built (a create's first uploads,
// as `app/index.js`): the worker builds the bundle once its container runs, and the create
// uploads the Worker with it. Nothing was served here before, so a visitor is told to come back.
export default {
  fetch: () =>
    new Response("The company's app is being set up: try again in a minute.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "30" },
    }),
};
