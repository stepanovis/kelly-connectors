#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${1:?Usage: build.sh <upstream-checkout> <node-prefix> <new-output-directory> <evidence-directory>}"
NODE_PREFIX="${2:?Node prefix containing bin/node and LICENSE is required}"
OUTPUT="${3:?A new output directory is required}"
EVIDENCE="${4:?An evidence directory is required}"
SOURCE="$(cd "$SOURCE" && pwd)"
NODE_PREFIX="$(cd "$NODE_PREFIX" && pwd)"
NODE="$NODE_PREFIX/bin/node"
export PATH="$NODE_PREFIX/bin:$PATH"
export CI=1
export NEXT_TELEMETRY_DISABLED=1

EXPECTED_COMMIT="$("$NODE" -p 'require(process.argv[1]).upstreamCommit' "$SCRIPT_DIR/upstream.json")"
EXPECTED_NODE="$("$NODE" -p 'require(process.argv[1]).nodeVersion' "$SCRIPT_DIR/upstream.json")"
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$EXPECTED_COMMIT"
test -z "$(git -C "$SOURCE" status --porcelain)"
test "$($NODE -p 'process.versions.node')" = "$EXPECTED_NODE"
test "$($NODE -p 'process.platform')" = darwin
"$NODE" "$SCRIPT_DIR/portable-node.mjs" "$NODE"
test ! -e "$OUTPUT"
mkdir -p "$(dirname "$OUTPUT")"
OUTPUT="$(cd "$(dirname "$OUTPUT")" && pwd)/$(basename "$OUTPUT")"
STAGING="$(mktemp -d "$(dirname "$OUTPUT")/.design-studio-build.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT
PAYLOAD="$STAGING/payload"
mkdir -p "$PAYLOAD/apps" "$PAYLOAD/bin" "$PAYLOAD/resources"

cd "$SOURCE"
pnpm install --frozen-lockfile --ignore-scripts --filter '@open-design/daemon...' --filter '@open-design/web...'
pnpm rebuild esbuild
pnpm --filter '@open-design/daemon...' --filter '@open-design/web^...' --workspace-concurrency=2 -r run build
env -u OD_WEB_OUTPUT_MODE pnpm --filter @open-design/web run build
npm_config_ignore_scripts=true pnpm --filter @open-design/daemon deploy --legacy --prod "$PAYLOAD/apps/daemon"
for native in better-sqlite3 node-pty; do
  NATIVE_ROOT="$($NODE -e 'const path=require("node:path"); const resolver=require("node:module").createRequire(path.join(process.argv[1],"package.json")); process.stdout.write(path.dirname(resolver.resolve(process.argv[2]+"/package.json")));' "$PAYLOAD/apps/daemon" "$native")"
  npm run install --prefix "$NATIVE_ROOT"
done
mkdir -p "$PAYLOAD/apps/web"
cp -R apps/web/out "$PAYLOAD/apps/web/out"
for resource in skills design-templates design-systems craft prompt-templates; do
  cp -R "$resource" "$PAYLOAD/resources/$resource"
done
mkdir -p "$PAYLOAD/resources/plugins" "$PAYLOAD/resources/data"
cp -R plugins/_official plugins/registry "$PAYLOAD/resources/plugins/"
cp -R assets/frames assets/community-pets "$PAYLOAD/resources/"
cp -R data/plugin-previews "$PAYLOAD/resources/data/"
cp LICENSE "$PAYLOAD/LICENSE"
cp "$NODE_PREFIX/LICENSE" "$PAYLOAD/NODE-LICENSE"
cp "$NODE" "$PAYLOAD/bin/node"
cp "$SCRIPT_DIR/launcher.mjs" "$PAYLOAD/launcher.mjs"
"$NODE" -e 'const fs=require("node:fs"); const pin=require(process.argv[1]); fs.writeFileSync(process.argv[2], JSON.stringify({name:"open-design",version:pin.upstreamVersion,type:"module"}));' "$SCRIPT_DIR/upstream.json" "$PAYLOAD/package.json"
"$NODE" -e 'const fs=require("node:fs"); const pin=require(process.argv[1]); fs.writeFileSync(process.argv[2], JSON.stringify({version:pin.version,upstreamCommit:pin.upstreamCommit,upstreamVersion:pin.upstreamVersion,platform:process.platform,arch:process.arch,nodeVersion:process.versions.node}));' "$SCRIPT_DIR/upstream.json" "$STAGING/metadata.json"
"$NODE" "$SCRIPT_DIR/package.mjs" prepare "$PAYLOAD" "$SOURCE"
NATIVE_REPORT="$("$PAYLOAD/bin/node" "$PAYLOAD/launcher.mjs" --check-native)"
printf '%s\n' "$NATIVE_REPORT"
while IFS= read -r native; do
  "$NODE" "$SCRIPT_DIR/portable-node.mjs" "$native"
done < <("$NODE" -e 'for(const filename of JSON.parse(process.argv[1]).nativeModules) console.log(filename)' "$NATIVE_REPORT")
"$NODE" "$SCRIPT_DIR/package.mjs" create "$PAYLOAD" "$STAGING/metadata.json"
"$NODE" "$SCRIPT_DIR/package.mjs" verify "$PAYLOAD"
"$NODE" "$SCRIPT_DIR/smoke.mjs" "$PAYLOAD" "$EVIDENCE"
"$NODE" "$SCRIPT_DIR/archive-space.mjs" "$PAYLOAD"
mkdir "$STAGING/result"
ARCH="$($NODE -p 'process.arch')"
COPYFILE_DISABLE=1 tar -czf "$STAGING/result/design-studio-darwin-$ARCH.tar.gz" -C "$PAYLOAD" .
cp "$PAYLOAD/component.json" "$STAGING/result/component.json"
(cd "$STAGING/result" && shasum -a 256 "design-studio-darwin-$ARCH.tar.gz" > archive.sha256)
mv "$PAYLOAD" "$STAGING/result/payload"
mv "$STAGING/result" "$OUTPUT"
printf 'Design Studio candidate: %s\n' "$OUTPUT"
