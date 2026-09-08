# Design Studio packaging

This directory is the packaging work in progress for Kelly task #1051. It is
separate from the messenger connector contract: it does not add a messenger
bridge or change `build.sh` at the repository root.

## Build inputs

- A clean checkout at the commit pinned in `upstream.json`.
- pnpm 10.33.2 and an official Node 24.1.0 macOS distribution for the build
  architecture. Verify its archive against Node's published SHASUMS256.txt.
  A Homebrew Node executable is rejected because it requires machine-local
  libraries even if it starts with an empty PATH.
- Enough free space for the build, payload and archive. The archive preflight
  reserves its uncompressed upper bound plus 512 MiB for the system.

```sh
node --test design-studio/*.test.mjs
bash design-studio/build.sh "$UPSTREAM_CHECKOUT" "$NODE_DISTRIBUTION" \
  "$NEW_OUTPUT_DIRECTORY" "$EVIDENCE_DIRECTORY"
```

The builder compiles the daemon dependency graph and static Studio UI, deploys
production dependencies, builds native SQLite/PTY modules with the selected
Node, includes upstream resources and license files, and creates a manifest.
The known pnpm legacy-deploy self-reference is redirected to the deployed
daemon; every other link escaping the payload is rejected.
Before native installation, `production-lock.mjs` checks the deployed daemon
dependency graph against the source lockfile: external resolutions and peer
snapshots, workspace identities and production edges. A difference fails the
build; source and deployed lockfile hashes are saved with the evidence.
`managed-api.mjs` then applies the Kelly integration hooks to the exact pinned
daemon bundle. Unknown input bytes or patch anchors fail the build. The hooks
let the Kelly-owned host authorize HTTP requests and enclose every native model
launch in its project policy without replacing the upstream generation engine.

Successful output contains `payload/`, `component.json`, an architecture-named
tar.gz and its SHA-256. `smoke.mjs` starts the payload with an isolated temporary
HOME/data directory and a PATH without Node, verifies `/api/health` and the
static UI, then stops its owned process group, including background CLI probes.
It never stops processes by name or port. Evidence remains outside staging even on failure.
Failed build staging is removed; a failed archive does not leave a candidate.

## Runtime boundary

The standalone packaging smoke invokes `payload/bin/node payload/launcher.mjs`. It must provide an
absolute `OD_DATA_DIR` outside the versioned payload with an existing parent,
and an available `OD_PORT` between 1024 and 65535. The launcher uses loopback
only, does not open a browser, and resolves resources from its own package.
`--check-native` verifies SQLite and PTY loading without starting the service.

The desktop integration instead starts its own `managed-host.mjs` with the
payload's Node and an IPC channel. It requires managed runtime contract v1,
adds a private HTTP capability and a per-project CLI sandbox, and fails closed
if a candidate does not enforce its HTTP boundary. Host policy resources and
their notices ship with Kelly; upstream runtime bytes ship in this component.

No release is uploaded
by these scripts. The manifest detects corruption, not publisher authenticity;
the trusted download/compatibility contract belongs to the Kelly integration.
The initial ARM64 and x64 candidates passed native SQLite/PTY loading, daemon
health and static UI smoke after archive relocation with access to upstream,
the original output and Homebrew denied. x64 ran through Rosetta on an ARM Mac;
this does not cover a separate Intel machine or Gatekeeper download behavior.
macOS signing, clean-machine compatibility, project isolation, visual generation
and the in-app user path remain release gates. Matching the production graph
does not assert byte-identical archives or native compilation output.
