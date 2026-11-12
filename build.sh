#!/bin/zsh
set -euo pipefail
cd -- "${0:A:h}"
project="$PWD"
notices="$project/ThirdParty/Notices"
app_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Sources/Info.plist)
version=24.22.2
archive="node-v$version-darwin-arm64.tar.xz"
node_sha=1f5ac075be50bed4780ea3be19a007fda95ea4d527d28d76d0b91de47d915115
mkdir -p .build/runtime Release
if [[ ! -f .build/runtime/node.tar.xz ]]; then
  curl -fsSL --retry 2 "https://nodejs.org/dist/v$version/$archive" -o .build/runtime/node.tar.xz.part
  mv .build/runtime/node.tar.xz.part .build/runtime/node.tar.xz
fi
printf '%s  %s\n' "$node_sha" '.build/runtime/node.tar.xz' | shasum -a 256 -c
tar -xJf .build/runtime/node.tar.xz -C .build/runtime --strip-components=1 \
  "node-v$version-darwin-arm64/bin/node" "node-v$version-darwin-arm64/LICENSE"
go_archive=.build/go-toolchain/go1.26.0.darwin-arm64.tar.gz
go_sha=b1640525dfe68f066d56f200bef7bf4dce955a1a893bd061de6754c211431023
if [[ ! -x .build/go-toolchain/go/bin/go ]]; then
  mkdir -p .build/go-toolchain
  if [[ ! -f "$go_archive" ]]; then
    curl -fsSL --retry 2 'https://go.dev/dl/go1.26.0.darwin-arm64.tar.gz' -o "$go_archive.part"
    mv "$go_archive.part" "$go_archive"
  fi
  printf '%s  %s\n' "$go_sha" "$go_archive" | shasum -a 256 -c
  tar -xzf "$go_archive" -C .build/go-toolchain
fi
stage=$(mktemp -d "$project/.build/stage.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
app="$stage/Responses API.app"
macos="$app/Contents/MacOS"
resource="$app/Contents/Resources"
gateway="$resource/Gateway"
licenses="$resource/Licenses"
mkdir -p "$macos" "$gateway/scripts" "$gateway/src" "$licenses/CLIProxyAPI"
cp Sources/Info.plist "$app/Contents/Info.plist"
cp Sources/AppIcon.icns "$resource/AppIcon.icns"
for language in en es pt fr de ja zh-Hans; do
  mkdir -p "$resource/$language.lproj"
  cp "Sources/Resources/$language.lproj/Localizable.strings" "$resource/$language.lproj/"
done
xcrun swiftc -parse-as-library -swift-version 5 -O -target arm64-apple-macosx15.0 \
  -module-name ResponsesGateway -o "$macos/ResponsesGateway" Sources/App.swift Sources/Localization.swift
install -m 755 .build/runtime/bin/node "$macos/node"
.build/runtime/bin/node Proxy/build.mjs
install -m 755 .build/selectable-proxy/cliproxyapi "$macos/cliproxyapi"
python3 - "$macos/cliproxyapi" .build/selectable-proxy/receipt.json <<'PY'
import hashlib, json, sys
from pathlib import Path
binary, receipt = map(Path, sys.argv[1:])
assert hashlib.sha256(binary.read_bytes()).hexdigest() == json.loads(receipt.read_text())["binarySha256"], "Proxy checksum mismatch"
PY
for file in compat config connections main model-settings policy proxy server service sse store; do
  cp "Gateway/src/$file.mjs" "$gateway/src/"
done
cp Gateway/src/model-catalog{,-source}.json "$gateway/src/"
for file in desktop desktop-entry managed-child run-stack stack-child; do
  cp "Gateway/scripts/$file.mjs" "$gateway/scripts/"
done
cp .build/runtime/LICENSE "$licenses/Node.js-LICENSE.txt"
cp "$notices/CLIProxyAPI/"{LICENSE.CLIProxyAPI,LICENSE.responses-proxy,THIRD_PARTY_NOTICES.md} "$licenses/CLIProxyAPI/"
cp LICENSE "$licenses/Responses-API-LICENSE.txt"
cp "$notices/THIRD_PARTY_NOTICES.md" "$licenses/THIRD_PARTY_NOTICES.md"
python3 - "$notices/Go" "$licenses/Go" <<'PY'
import shutil, sys
from pathlib import Path
source, target = map(Path, sys.argv[1:])
for file in source.rglob("*"):
    if file.is_symlink():
        raise SystemExit("Unexpected symlink in notice directory")
    if file.is_file() and not file.name.startswith("."):
        destination = target / file.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, destination)
PY
cat > "$licenses/Runtime.txt" <<TXT
This app includes Node.js $version for macOS arm64 from the official Node.js distribution.
See Node.js-LICENSE.txt for Node.js and its bundled dependency notices.
The CLIProxyAPI notes describe the original release layout. This app stores its proxy
binary under Contents/MacOS and Go notices under Contents/Resources/Licenses/Go.
GPT-6 and newer Codex registry metadata comes from github.com/router-for-me/models.
The exact source revision and checksum are recorded in Gateway/proxy-build.json.
TXT
python3 - "$macos/cliproxyapi" .build/selectable-proxy/receipt.json "$gateway/proxy-build.json" <<'PY'
import hashlib, json, sys
from pathlib import Path
binary, original, output = map(Path, sys.argv[1:])
receipt = json.loads(original.read_text())
fields = ("targetOS", "targetArch", "sourceCommit", "catalogSha256", "registryCommit", "registrySha256", "goVersion", "patchId")
release = {key: receipt[key] for key in fields}
release["sourceBinarySha256"] = receipt["binarySha256"]
release["binarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
output.write_text(json.dumps(release, indent=2) + "\n")
PY
xattr -cr "$app"
ln -s /Applications "$stage/Applications"
output="${1:-$project/Release/Responses-API-$app_version-arm64.dmg}"
[[ ! -e "$output" ]] || { print -u2 "Release already exists"; exit 1; }
hdiutil create -srcfolder "$stage" -volname 'Responses API' -format UDZO "$output"
hdiutil verify "$output"
(cd "${output:h}" && shasum -a 256 "${output:t}" > "${output:t}.sha256")
