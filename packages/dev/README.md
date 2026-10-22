# @sanoma-ai/dev

The kit for developing [sanoma](https://github.com/Sanoma-AI/sanoma): run a Sanoma repo of your own (a company you dogfood sanoma with) on a sanoma checkout, undo that before you commit, and move the repo to each release. It is for people working on sanoma; a company's repo does not need it, and the template never mentions it.

## Install

In the repo you dogfood with, as a devDependency:

```sh
pnpm add -D @sanoma-ai/dev
```

Run each command from the repo's root, the directory holding `sanoma.config.ts`. Each prints what it did and what to do next; it exits 2 when called wrong or not in a Sanoma repo, and 1 when something it runs fails.

## `sanoma-dev link [<checkout>]`

Links the repo to a sanoma checkout, `../sanoma` beside the repo unless you name one. It checks that the directory is a checkout (`packages/sanoma/package.json` named `sanoma`), runs `pnpm install --frozen-lockfile` and `pnpm build` there when `packages/sanoma` has no `dist/`, then runs one `pnpm link` of `sanoma` and every `@sanoma-ai/*` package the repo's `package.json` declares (`dependencies` or `devDependencies`, but this kit) that the checkout has: `packages/<name>`, or `connectors/<name>` for `@sanoma-ai/connector-<name>`. A declared package the checkout lacks, such as a connector of your own, is named and left installed.

`pnpm dev` (`sanoma`) is then [the launcher's dev mode](../sanoma/README.md#dev-mode): it runs the watch build of the linked packages and of the runtime, the app and the bridge they reach in the checkout, and restarts on a new build.

`package.json` is never changed: only declared packages are linked, since linking a package the repo does not declare makes pnpm add a `link:` dependency that `pnpm unlink` can leave behind. The link is an `overrides` entry pnpm writes to `pnpm-workspace.yaml`, with the lockfile to match.

## `sanoma-dev unlink`

Runs `pnpm unlink` for the same packages, then fails, naming each line, when `package.json` or `pnpm-workspace.yaml` still holds a `link:`. When it passes, the repo is ready to commit.

## `sanoma-dev update`

Refuses while the repo is linked. Otherwise runs `pnpm update --latest sanoma "@sanoma-ai/*"`, then `sanoma check` (`pnpm exec sanoma check`), and exits with its code.

A fresh release is younger than pnpm's minimum release age; let the update take it with the bare patterns in the repo's `pnpm-workspace.yaml`:

```yaml
minimumReleaseAgeExclude:
  - sanoma
  - "@sanoma-ai/*"
```
