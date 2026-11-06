#!/bin/bash
# Builds, signs and publishes a Cineon release on GitHub.
#
#   scripts/release.sh 1.1.0             # build, tag v1.1.0, publish the release
#   scripts/release.sh 1.1.0 --dry-run   # build and package only, into dist/release
#
# Before running it, add a "## [1.1.0]" section to CHANGELOG.md. Its text becomes the release
# notes on GitHub and in the update window.
#
# The release carries a DMG for people installing by hand, a zip for Sparkle, and appcast.xml,
# which installed copies read through releases/latest/download/appcast.xml. The zip is signed with
# the EdDSA key in ~/.config/cineon/sparkle-private-key (override with CINEON_SPARKLE_KEY). Losing
# that key means installed copies can no longer update, so keep a copy somewhere safe.
set -euo pipefail

REPO="mineo71/Cineon"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
DRY_RUN=0
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1
KEY="${CINEON_SPARKLE_KEY:-$HOME/.config/cineon/sparkle-private-key}"
OUT="dist/release"
SPARKLE_BIN="build/SourcePackages/artifacts/sparkle/Sparkle/bin"

fail() { echo "release: $*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "give a version like 1.2.0"
[[ -f "$KEY" ]] || fail "no signing key at $KEY"
grep -q "^## \[$VERSION\]" CHANGELOG.md || fail "CHANGELOG.md has no '## [$VERSION]' section"

if [[ $DRY_RUN == 0 ]]; then
    [[ -z "$(git status --porcelain)" ]] || fail "commit or stash your changes first"
    [[ "$(git branch --show-current)" == "main" ]] || fail "release from main"
    git fetch --tags --quiet origin
    ! git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null || fail "v$VERSION is already released"
    gh auth status >/dev/null 2>&1 || fail "log in with gh auth login"
fi

# Version numbers. Sparkle compares the build number, so every release gets a higher one.
current_version=$(sed -n 's/^ *MARKETING_VERSION: "\(.*\)"/\1/p' project.yml)
current_build=$(sed -n 's/^ *CURRENT_PROJECT_VERSION: "\(.*\)"/\1/p' project.yml)
if git rev-parse -q --verify "refs/tags/v$current_version" >/dev/null; then
    build=$((current_build + 1))
else
    build=$current_build    # the version in project.yml was never released, so reuse its build
fi
sed -i '' -E "s/^( *MARKETING_VERSION: )\".*\"/\1\"$VERSION\"/" project.yml
sed -i '' -E "s/^( *CURRENT_PROJECT_VERSION: )\".*\"/\1\"$build\"/" project.yml
# Until the release commit exists, put the version files back however this ends.
committed=0
restore() { [[ $committed == 1 ]] || git checkout --quiet -- project.yml Casks/cineon.rb 2>/dev/null || true; }
trap restore EXIT

echo "Building Cineon $VERSION ($build)…"
make project >/dev/null
xcodebuild -project Cineon.xcodeproj -scheme Cineon -configuration Release \
    -derivedDataPath build -destination 'generic/platform=macOS' -quiet build
APP="build/Build/Products/Release/Cineon.app"

plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist"; }
[[ "$(plist CFBundleShortVersionString)" == "$VERSION" ]] || fail "built app has the wrong version"
[[ "$(plist CFBundleVersion)" == "$build" ]] || fail "built app has the wrong build number"
[[ -n "$(plist SUPublicEDKey)" ]] || fail "built app has no update key"
codesign --verify --deep --strict "$APP" || fail "the app's signature doesn't verify"
lipo -archs "$APP/Contents/MacOS/Cineon" | grep -q x86_64 || fail "not a universal build"

rm -rf "$OUT"; mkdir -p "$OUT"
ZIP="$OUT/Cineon-$VERSION.zip"
DMG="$OUT/Cineon-$VERSION.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/Cineon.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Cineon $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
rm -rf "$STAGE"

# Release notes: the CHANGELOG section, as Markdown for GitHub and HTML for the update window.
awk -v v="$VERSION" '
    $0 ~ "^## \\[" v "\\]" { on = 1; next }
    on && /^## / { exit }
    on { print }
' CHANGELOG.md | sed -e '/./,$!d' > "$OUT/notes.md"
python3 - "$OUT/notes.md" "$OUT/notes.html" <<'PY'
import html, re, sys
lines, out, in_list = open(sys.argv[1]).read().splitlines(), [], False
def inline(text):
    text = html.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    return re.sub(r"`(.+?)`", r"<code>\1</code>", text)
for line in lines:
    if line.startswith("- "):
        if not in_list: out.append("<ul>"); in_list = True
        out.append(f"<li>{inline(line[2:])}</li>")
        continue
    if line.startswith("  ") and in_list and out:
        out[-1] = out[-1][:-5] + " " + inline(line.strip()) + "</li>"
        continue
    if in_list: out.append("</ul>"); in_list = False
    if line.startswith("### "): out.append(f"<h3>{inline(line[4:])}</h3>")
    elif line.strip(): out.append(f"<p>{inline(line)}</p>")
if in_list: out.append("</ul>")
open(sys.argv[2], "w").write("\n".join(out) + "\n")
PY

SIGNATURE=$("$SPARKLE_BIN/sign_update" --ed-key-file "$KEY" "$ZIP")
cat > "$OUT/appcast.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Cineon</title>
    <link>https://github.com/$REPO</link>
    <item>
      <title>Cineon $VERSION</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$build</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$(plist LSMinimumSystemVersion)</sparkle:minimumSystemVersion>
      <description><![CDATA[
$(cat "$OUT/notes.html")
      ]]></description>
      <enclosure url="https://github.com/$REPO/releases/download/v$VERSION/Cineon-$VERSION.zip" $SIGNATURE type="application/octet-stream"/>
    </item>
  </channel>
</rss>
XML
xmllint --noout "$OUT/appcast.xml"

# The Homebrew cask points at the DMG.
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
sed -i '' -E "s/^( *version )\".*\"/\1\"$VERSION\"/; s/^( *sha256 )\".*\"/\1\"$SHA\"/" Casks/cineon.rb

echo "Packaged in $OUT:"
ls -lh "$OUT" | tail -n +2

if [[ $DRY_RUN == 1 ]]; then
    echo "Dry run: nothing committed or published."
    exit 0
fi

git add project.yml Casks/cineon.rb
git commit --quiet -m "Release $VERSION"
committed=1
git tag -a "v$VERSION" -m "Cineon $VERSION"
git push --quiet origin main "v$VERSION"

gh release create "v$VERSION" "$DMG" "$ZIP" "$OUT/appcast.xml" \
    --repo "$REPO" --title "Cineon $VERSION" --notes-file "$OUT/notes.md" --verify-tag
echo "Released https://github.com/$REPO/releases/tag/v$VERSION"
