# DevSpace runtime artifact

`npm run package:runtime-artifact -- <full-commit>` creates
`.artifacts/devspace-linux-amd64-<full-commit>.tar.gz` and its SHA-256 sidecar.
The archive contains `dist`, production-only `node_modules`, package manifests,
and `artifact.json`. GNU tar and gzip metadata are normalized so repeated runs
for the same committed inputs are byte-identical.

The publish workflow uploads the archive as an immutable Gitea Generic Package
versioned by the full source commit and verifies a read-back digest. It stops
there: the application repository does not currently dispatch or perform
runtime deployment. The former Asgard-hosted `devspace-deployctl` workflow was
retired after the central homelab artifact lane removed its DevSpace-specific
activation and rollback semantics. A replacement rollout strategy must remain a
separate operational concern rather than being inferred from artifact
publication.

`artifact.json` is canonical one-line JSON with schema
`saga-service-artifact/v1`, service ID `devspace`, the full source commit,
package version, `sha256:`-prefixed lockfile and tool-contract hashes, platform
`linux-amd64`, Node major 24, protocol major 1, health path `/healthz`, and:

```json
{"gateway":["node","dist/cli.js","gateway"],"node":["node","dist/cli.js","node"]}
```

The installer appends `--config <absolute-path>` to the selected entrypoint.
The Saga app root is `/opt/saga-services/devspace`; the Asgard user app root is
`$HOME/.local/opt/devspace`. State, worktrees, configuration, OAuth data, and
0600 secret environment files must remain outside those replaceable roots.

The Saga gateway listens on `127.0.0.1:7676`, serves `/healthz`, OAuth, MCP at
`/mcp`, and widgets. The Asgard node listens on `127.0.0.1:7679` and exposes only
authenticated `/internal/v1/hello` and `/internal/v1/call`. Both commands handle
SIGTERM by stopping their HTTP listener before exit. Artifact publication does
not restart either runtime service or any tunnel unit.

The versioned node call envelope is
`{ protocolMajor, toolContractHash, machineId, requestId, tool, arguments }`.
`machineId` is the gateway's configured target ID. The node compares it with
its own configured ID in the same request before invoking any executor and
returns the same ID in successful responses. Identity mismatches fail closed
without executor invocation.
