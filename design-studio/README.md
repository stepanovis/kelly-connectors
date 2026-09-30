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

### Recovery of the .8 desktop incompatibility

The arm64 .9 candidate preserves the calendar-aware .8 upstream commit and
native modules, restores the complete managed writer v2, and applies the
accepted embedded-web overlay. Changing only the runtime version constant is
not a valid recovery. The builder verifies the entire pinned .8 base and all
overlay inputs before copying; the installed base is read-only.

```sh
node design-studio/embedded-web.mjs "$PINNED_UPSTREAM" "$WEB_PROVENANCE"
node design-studio/rebuild-recovery-package.mjs "$VERIFIED_ALPHA8_PAYLOAD" \
  "$PINNED_UPSTREAM/apps/web/out" "$WEB_PROVENANCE" "$NEW_OUTPUT_DIRECTORY"
```

Before shipping, run the candidate with the target desktop's `managed-host.mjs`
and file writer on disposable data, including .8 project/chat preservation and
protected file writes. Standalone smoke alone does not verify this contract.
The desktop validates the trusted manifest and runs that same managed host
before switching `active.json`. The component archive and manifest hashes must
be pinned together in the desktop catalog; publish the component before the
matching desktop. These scripts do not publish either artifact.

The standalone packaging smoke invokes `payload/bin/node payload/launcher.mjs`. It must provide an
absolute `OD_DATA_DIR` outside the versioned payload with an existing parent,
and an available `OD_PORT` between 1024 and 65535. The launcher uses loopback
only, does not open a browser, and resolves resources from its own package.
`--check-native` verifies SQLite and PTY loading without starting the service.

The desktop integration instead starts its own `managed-host.mjs` with the
payload's Node and an IPC channel. It requires managed runtime contract v2,
adds a private HTTP capability and a per-project CLI sandbox, and fails closed
if a candidate does not enforce its HTTP boundary. Host policy resources and
their notices ship with Kelly; upstream runtime bytes ship in this component.

## Managed file writer (0.1.0-alpha.7)

The managed startup contract requires Kelly's file-writer callback. Pinned
adapters route project files, uploads, history, live artifacts, run staging and
generated media bytes through that callback. The upstream data schema is unchanged.
This component must be delivered together with the desktop contract v2; an older
desktop does not implicitly gain compatibility with the new startup interface.

`rebuild-managed-package.mjs` derives the component from the independently checked
.6 archive and a verified .4 native payload. It checks both trusted SHA-256 pins,
validates the entire base, reuses identical APFS file data, and restores changed
leaves from the exact .6 archive. A second complete manifest check must match .6
before the writer overlay is applied. Only the pinned daemon transforms change;
the native dependencies, Node, static UI and resources must remain identical.

```sh
node design-studio/rebuild-managed-package.mjs "$ALPHA4_ARM64_PAYLOAD" \
  "$ALPHA6_ARCHIVE" arm64 "$NEW_OUTPUT_DIRECTORY"
```

Use `x64` with the checked .6 x64 archive for the other component architecture.
This reuse does not run native compilation or alter the installed component.
Failed output is retained for diagnosis; a subsequent build requires a new path.
Archive and manifest hashes are recorded in `archive.json` and pinned by desktop.
The desktop Alpha/Beta remain arm64-only. The UID lifetime experiment is not part
of the component or an installation prerequisite. Full profile namespace
coordination, native resume and the remaining external processor paths are not
claimed as completed by this Alpha component.

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

## Kelly embedded project UI (0.1.0-alpha.6)

`embedded-web.patch` modifies the pinned React source before compilation.
`embedded-web.json` pins both the patch and each original source file. The
builder rejects unknown input; the wrapper reverses its patch after success or
failure. Use a dedicated clean upstream checkout. A hard interruption may leave
it dirty, which the next full build rejects. Do not reuse that checkout for a
concurrent build. Verify the controls separately with:

```sh
node design-studio/verify-embedded-web.mjs "$UPSTREAM_CHECKOUT"
node design-studio/embedded-web.mjs "$UPSTREAM_CHECKOUT" "$EVIDENCE/embedded-web.json"
```

The dedicated Kelly origin (`https://design-studio.localhost`) and initial
project route enable this presentation mode for the lifetime of the view.
Home, global project tabs/selector and the duplicate editable project heading
are not mounted. The chat heading identifies the selected conversation; history,
new conversation, collapse/restore, files, Code and Preview remain. The router
rejects navigation outside the initial project; the existing desktop session
and `StudioProjectSurface` still own authorization. Standalone origins retain
upstream navigation. This is not a user preference because the hosting Kelly
view already owns project selection.

For this UI-only release, `rebuild-web-package.mjs` also accepts the verified
released 0.1.0-alpha.2, 0.1.0-alpha.3 or 0.1.0-alpha.4 native payloads. It checks their trusted manifest digests,
all payload files, and the web-output digest from the completed build. It then
replaces only `apps/web/out`, normalizes static file/directory modes to 0644/0755,
writes the new manifest and archives the candidate. Normalizing modes prevents
a build with umask 002 from failing integrity checks after extraction with 022.
It asserts that every native/runtime/resource entry remains byte-identical.
This is the artifact derivation used for alpha.5:

```sh
node design-studio/rebuild-web-package.mjs "$ALPHA4_PAYLOAD" \
  "$UPSTREAM_CHECKOUT/apps/web/out" "$EVIDENCE/embedded-web.json" "$NEW_OUTPUT"
```

The source build remains available through `build.sh`; native compilation and
tar metadata need not produce byte-identical archives. Record the exact archive
size/SHA-256 and manifest SHA-256 in the desktop artifact catalog before release.
The web build receipt binds the patch, upstream commit and actual static output.

Desktop explicitly permits alpha.2, alpha.3 and alpha.4 data for alpha.5 only when upstream commit
and architecture match. Discovery offers a download; it never downloads or runs
old executable bytes automatically. Explicit installation preserves data and the
old active pointer until the new archive passes integrity/native checks. Unknown
versions/commits/architectures and undeclared rollbacks remain rejected. Publish
the component and verify its public archives before publishing the desktop that
pins them. Task #1051 remains the record for review, integration and release.

## Project execution settings

In the Kelly embedded origin, the model menu's existing execution-settings
action expands an in-place CLI chooser. It uses the existing `onAgentChange`
callback and `/api/app-config` project preferences, then returns to that CLI's
model list. The new selection is applied after the project preference write
succeeds. A rejected write retains the old choice and displays an error;
retry stays in the same menu. Saving disables duplicate choices, and catalogue
loading is visible. Unavailable CLIs are disabled. Mouse and Enter activate the same
buttons; Escape closes the popover and returns focus. The project view stays
mounted, retaining its conversation, composer and files. Standalone Studio
still opens its ordinary execution settings page. Route and API authorization
are unchanged. No shared daemon settings or credentials are edited.

`AvatarMenu.kelly.test.tsx` covers this entry, switching, disabled choices and
focus; existing standalone AvatarMenu and embedded-router tests run alongside
it. Native desktop acceptance is in `scripts/verify-design-studio-settings.ts`
of the Kelly repository. Its optional catalogue replay tests UI selection, not
model execution or account access.

## Menu correction .5

The embedded selection error uses a dedicated typed locale key. RU and EN follow
the approved retry wording; other locales use the same English fallback. The
standalone settings error is unchanged. Kelly's desktop appearance adapter owns
the opaque menu surface; the component retains its native controls and geometry.
The UI-only repacker accepts the exact released .4 manifests in addition to .2/.3
and still verifies every native/runtime/resource entry before and after repacking.

## Kelly divider preference (#1086)

The reviewed web overlay persists only the chat/preview ratio through the
project-scoped `/api/app-config` endpoint. Desktop validates `chatPanelRatio`
as a finite number strictly between 0 and 1, stores it with existing project
preferences, and ignores invalid stored values. Resizing the window clamps the
rendered panels without saving that temporary clamp. Standalone OpenDesign
keeps its original localStorage path. No data migration is introduced.

Component .6 retains the .5 selection error translations. Its native runtime
and resources are verified byte-for-byte against the trusted .4 payload.
The desktop source catalog and both archive hashes must agree before release;
a local component smoke does not prove delivery in a signed Kelly Alpha.
