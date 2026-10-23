# @sanoma-ai/dev

The kit for developing [sanoma](https://github.com/Sanoma-AI/sanoma): run a Sanoma repo of your own (a company you dogfood sanoma with) on a sanoma checkout, undo that before you commit, and move the repo to each release. It is for people working on sanoma; a company's repo does not need it, and the template never mentions it.

## Install

In the repo you dogfood with, as a devDependency:

```sh
pnpm add -D @sanoma-ai/dev
```

Run each command from the repo's root, the directory holding `sanoma.config.ts`. Each prints what it did and what to do next; it exits 2 when called wrong or when what it finds stops it (not a Sanoma repo, not a checkout, nothing to link, `update` while linked), and 1 when something it runs fails.

## `sanoma-dev link [<checkout>]`

Links the repo to a sanoma checkout, `../sanoma` beside the repo unless you name one. It checks that the directory is a checkout (`packages/sanoma/package.json` named `sanoma`) and runs `pnpm install --frozen-lockfile` and `pnpm build` in it, every time (about a minute), so the link never runs a stale build. It then removes the repo's `.sanoma/app` (see [Generated files](#generated-files)) and links `sanoma` and every `@sanoma-ai/*` package the repo's `package.json` declares (`dependencies` or `devDependencies`, but this kit) that the checkout has: `packages/<name>`, or `connectors/<name>` for `@sanoma-ai/connector-<name>`, one `pnpm link` per package. A declared package the checkout lacks, such as a connector of your own, is named and left installed. It then checks each link (a `link:` override in `pnpm-workspace.yaml`, and `node_modules/<name>` resolving to the package's directory in the checkout), links a failure once more, and exits 1 naming any still unlinked; `sanoma-dev unlink` undoes the links that did take.

`pnpm dev` (`sanoma`) is then [the launcher's dev mode](../sanoma/README.md#dev-mode): it runs the watch build of the linked packages and of the runtime, the app and the bridge they reach in the checkout, and restarts on a new build.

`package.json` is never changed: only declared packages are linked, since linking a package the repo does not declare makes pnpm add a `link:` dependency that `pnpm unlink` can leave behind. The link is an `overrides` entry pnpm writes to `pnpm-workspace.yaml`, with the lockfile to match.

## `sanoma-dev unlink`

Runs `pnpm unlink` for the same packages (and this kit, should you have linked it) and removes the repo's `.sanoma/app` (see [Generated files](#generated-files)), then fails, naming each line, when `package.json` or `pnpm-workspace.yaml` still holds a `link:` of `sanoma` or a `@sanoma-ai/*` package (the repo's links of its own packages are left alone). When it passes, no link is left to commit; pnpm may still have rewritten `pnpm-workspace.yaml` or the lockfile, so check `git status`.

## Generated files

Everything under the repo's `.sanoma/app` (the app's builds, its route tree, its `tsconfig.json`, the generator's and Vite's caches) is written by the sanoma that last built the repo's app, with paths into its own install or checkout. `link`, before it links, and `unlink`, after it unlinks, remove the directory and say so in one line, so a checkout never reuses what the installed sanoma wrote, nor the installed sanoma what the checkout wrote; the next `sanoma` or `sanoma check` writes it again. A running [dev mode](../sanoma/README.md#dev-mode) stops by itself once the repo no longer links the checkout, so its server does not write the directory again.

## `sanoma-dev update`

Refuses while the repo is linked (a `link:` of `sanoma` or a `@sanoma-ai/*` package). Otherwise runs `pnpm update --latest sanoma "@sanoma-ai/*"`, then `sanoma check` (`pnpm exec sanoma check`), and exits with its code.

A fresh release is younger than pnpm's minimum release age; let the update take it with the bare patterns in the repo's `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - sanoma
  - "@sanoma-ai/*"
```
