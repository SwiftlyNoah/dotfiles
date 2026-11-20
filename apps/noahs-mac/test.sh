#!/bin/zsh
# Builds Noah's Mac into a temporary folder (never installing or restarting it) and runs the
# Room tests (Tests/) against a fake `noah` (Tests/fake-noah) that answers from the room
# fixtures in Fixtures/room, which are copied from noah-os's test/fixtures/room.
set -euo pipefail
export PATH="/etc/profiles/per-user/$USER/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

here=${0:A:h}
stage=$(mktemp -d "${TMPDIR:-/tmp}/noahs-mac-test.XXXXXX")
trap 'rm -rf "$stage"' EXIT
target="$(uname -m)-apple-macos15.0"

# The whole app, as build.sh compiles it.
swiftc -parse-as-library -swift-version 6 -warnings-as-errors -target "$target" \
  -o "$stage/NoahsMac" "$here"/Sources/*.swift

# The room's model and CLI client with the tests, without AppKit.
swiftc -parse-as-library -swift-version 6 -warnings-as-errors -target "$target" \
  -o "$stage/room-tests" "$here/Sources/Room.swift" "$here/Sources/RoomCLI.swift" "$here"/Tests/*.swift

ROOM_FIXTURES="$here/Fixtures/room" FAKE_NOAH="$here/Tests/fake-noah" TEST_SCRATCH="$stage" "$stage/room-tests"
