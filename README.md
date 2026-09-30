# sanoma

Open core of Sanoma. Business as Code keeps a company's operational configuration (card limits, time-off policies, access, onboarding steps) in typed code and applies it to vendors like Mercury, Gusto and Okta, with a generated UI over every resource. An agent drafts each change, policies decide who must approve, and a ledger records what happened. This TypeScript monorepo holds the open parts: schema, planner, Cedar policies, ledger format, MCP server, local studio, CLI, first-party connectors and modules.

Status: repository skeleton only; no code yet.

## Contents

- `packages/schema`
- `packages/sdk`
- `packages/planner`
- `packages/policy` (TypeScript policies compiled to Cedar)
- `packages/ledger` (record format and local store)
- `packages/workflows`
- `packages/mcp` (MCP server)
- `packages/ui`
- `packages/studio` (local studio)
- `packages/cli`
- `packages/testing`
- `connectors/` (first-party connectors)
- `modules/`

Community connectors live in their authors' own repos (`sanoma-connector-<vendor>`) and are listed in [`Sanoma-AI/registry`](https://github.com/Sanoma-AI/registry).

## License

[Apache License 2.0](LICENSE).

## Contributing

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). Sign off every commit with `git commit -s`. See the org-wide contributing guide, code of conduct and security policy in [`Sanoma-AI/.github`](https://github.com/Sanoma-AI/.github).
