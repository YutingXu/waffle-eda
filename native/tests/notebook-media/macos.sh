#!/bin/sh
set -eu
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$here/../../.." && pwd)
temp=$(mktemp -d "${TMPDIR:-/tmp}/waffle-notebook-media.XXXXXXXX")
trap 'rm -rf "$temp"' EXIT
xcrun swift "$here/pdf-fixture.swift" "$temp/source.pdf"
xcrun swiftc -swift-version 5 -O "$root/native/macos/FolderTransactions.swift" "$root/native/macos/NotebookMedia.swift" "$root/native/macos/NotebookFolderMedia.swift" "$here/main.swift" -o "$temp/probe"
"$temp/probe" "$temp/source.pdf"
