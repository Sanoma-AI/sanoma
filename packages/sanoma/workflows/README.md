# sanoma/workflows

Business processes as TypeScript functions, run durably on [DBOS](https://dbos.dev) with Postgres. Each vendor call is a recorded step, and approvals and sleeps survive worker restarts. An oxlint config and `lintWorkflow` guard workflow code against accidental non-determinism and accidental ways around the policy. They are lint, not a sandbox: code written to get around them can.

## Usage

Moved to the docs: [Writing workflows](../docs/workflows/writing-workflows.md).

### Apps

Moved to the docs: [Apps](../docs/start/apps.md#apps).

### People

Moved to the docs: [People](../docs/policies/people.md).

#### Signing in on a host

Moved to the docs: [People](../docs/policies/people.md#signing-in-on-a-host).

### Policies

Moved to the docs: [Policies](../docs/policies/policies.md).

### Ledger

Moved to the docs: [The ledger](../docs/workflows/ledger.md).

### Approvals

Moved to the docs: [Approvals](../docs/workflows/approvals.md).

### Changes

Moved to the docs: [Changes](../docs/workflows/changes.md).

### The app's actions

Moved to the docs: [Changes](../docs/workflows/changes.md#the-apps-actions).

### Calls run one at a time

Moved to the docs: [Direct calls](../docs/workflows/direct-calls.md#calls-run-one-at-a-time).

### Built-ins

Moved to the docs: [Built-ins](../docs/workflows/built-ins.md).

#### The runtime's own operations

Moved to the docs: [Built-ins](../docs/workflows/built-ins.md#the-runtimes-own-operations).

#### Step names

Moved to the docs: [Built-ins](../docs/workflows/built-ins.md#step-names).

### Drivers

Moved to the docs: [Drivers](../docs/workflows/connectors.md).

### Credentials

Moved to the docs: [Credentials](../docs/workflows/credentials.md).

#### Secret store configuration

Moved to the docs: [Credentials](../docs/workflows/credentials.md#secret-store-configuration).

#### Moving between stores

Moved to the docs: [Credentials](../docs/workflows/credentials.md#moving-between-stores).

#### Named connections

Moved to the docs: [Credentials](../docs/workflows/credentials.md#named-connections).

#### Connecting and managing accounts

Moved to the docs: [Credentials](../docs/workflows/credentials.md#connecting-and-managing-accounts).

#### Connecting by OAuth consent

Moved to the docs: [Credentials](../docs/workflows/credentials.md#connecting-by-oauth-consent).

#### Renewal, Reconnect, Disconnect and Revoke

Moved to the docs: [Credentials](../docs/workflows/credentials.md#renewal-reconnect-disconnect-and-revoke).

#### Bootstrap keys

Moved to the docs: [Credentials](../docs/workflows/credentials.md#bootstrap-keys).

### Resources

Moved to the docs: [Resources and data files](../docs/workflows/resources.md).

### Collections

Moved to the docs: [Collections](../docs/workflows/collections.md).

#### Batches

Moved to the docs: [Collections](../docs/workflows/collections.md#batches).

#### A column change

Moved to the docs: [Collections](../docs/workflows/collections.md#a-column-change).

#### Importing a sheet

Moved to the docs: [Collections](../docs/workflows/collections.md#importing-a-sheet).

### Direct calls

Moved to the docs: [Direct calls](../docs/workflows/direct-calls.md).

### Data files

Moved to the docs: [Resources and data files](../docs/workflows/resources.md#data-files).

#### Bindings

Moved to the docs: [Resources and data files](../docs/workflows/resources.md#bindings).

#### Writing a data file

Moved to the docs: [Resources and data files](../docs/workflows/resources.md#writing-a-data-file).

#### Where Sanoma parses instead

Moved to the docs: [Resources and data files](../docs/workflows/resources.md#where-sanoma-parses-instead).

### Drift

Moved to the docs: [Resources and data files](../docs/workflows/resources.md#drift).

### Apply

Moved to the docs: [Resources and data files](../docs/workflows/resources.md#apply).

### Hosts

Moved to the docs: [Hosts, databases and sandboxes](../docs/hosting/hosts.md).

#### The wakeup service

Moved to the docs: [Hosts, databases and sandboxes](../docs/hosting/hosts.md#the-wakeup-service).

### Databases

Moved to the docs: [Hosts, databases and sandboxes](../docs/hosting/hosts.md#databases).

### Sandboxes

Moved to the docs: [Hosts, databases and sandboxes](../docs/hosting/hosts.md#sandboxes).

### Secrets

Moved to the docs: [Secrets](../docs/hosting/secrets.md#secrets).

### Versions

Moved to the docs: [Versions](../docs/hosting/versions.md).

## Keeping workflows replay-safe

Moved to the docs: [Keeping workflows replay-safe](../docs/workflows/replay-safety.md).

## Fakes for tests

Moved to the docs: [Fake vendors and replay](../docs/testing/fakes.md).

## Runs in a page

Moved to the docs: [Building your own UI](../docs/workflows/your-own-ui.md#runs-in-a-page).

## Scenarios and sandbox runs

Moved to the docs: [Scenarios and sandbox runs](../docs/testing/scenarios.md).

### The world

Moved to the docs: [Scenarios and sandbox runs](../docs/testing/scenarios.md#the-world).

### Steps a connector ships

Moved to the docs: [Scenarios and sandbox runs](../docs/testing/scenarios.md#steps-a-connector-ships).

## Building your own UI

Moved to the docs: [Building your own UI](../docs/workflows/your-own-ui.md).

### Outline

Moved to the docs: [Building your own UI](../docs/workflows/your-own-ui.md#outline).

## Changes

Moved to the docs: [Changes](../docs/workflows/changes.md#changes).
