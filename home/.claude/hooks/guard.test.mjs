// Feeds PreToolUse payloads to guard.mjs and checks what it decides. Run: node --test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const GUARD = join(import.meta.dirname, "guard.mjs");
const HOME = homedir();
const ME = join(HOME, "me");
const TMPDIR = "/var/folders/zz/test/T/";

// "pass" when the guard stays out of it, else its permissionDecision.
function decision(command, { cwd = ME, tool = "Bash", input } = {}) {
  const payload = { tool_name: tool, tool_input: input ?? { command }, cwd };
  const run = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, TMPDIR },
  });
  assert.equal(run.status, 0, run.stderr);
  if (!run.stdout) return "pass";
  return JSON.parse(run.stdout).hookSpecificOutput.permissionDecision;
}

function reason(command, cwd = ME) {
  const run = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
    encoding: "utf8",
    env: { ...process.env, TMPDIR },
  });
  return JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason;
}

const cases = (expected, commands, opts) => {
  for (const command of commands) test(`${expected}: ${command}`, () => assert.equal(decision(command, opts), expected));
};

// The four commands that stalled agents for hours, run from ~/me.
cases("deny", ["rm -r $D", "rm -r $S/dist-owner", "rm -r $A", "rm -r $D/t3.xcresult"]);
cases("pass", [
  "D=$(mktemp -d); rm -r $D",
  'S="$HOME/coding/noah-os"; cd $S && npm run build && rm -r $S/dist-owner',
  "A=/tmp/agent-a && rm -r $A",
  'export D="$TMPDIR/xcode"; xcodebuild test; rm -r $D/t3.xcresult',
]);

test("a refusal says how to fix the command", () => {
  assert.match(reason("rm -r $S/dist-owner"), /\$S isn't known.*Write the path out literally, or assign the variable/);
});

// Known paths at the top keep asking.
cases("ask", [
  "rm -rf ~/Documents",
  "rm -rf ~",
  "rm -rf /",
  "rm -rf /Users",
  "rm -rf $HOME",
  'rm -rf "$HOME/Documents"',
  "rm -r .",
  "rm -rf *",
  "rm -rf ~/*",
  "D=~/Documents; rm -rf $D",
  'D=; rm -rf "$D/"',
  "cd ~ && rm -rf Documents",
  "cd / && rm -rf Users",
  "D=/tmp/x; unset D; rm -rf $D/Users",
  "(cd /tmp && true); rm -rf *",
  "for d in /tmp/a ~/Documents; do rm -rf $d; done",
  "bash -c 'rm -rf ~/Documents'",
  "sudo rm -rf /Applications",
  "/bin/rm -rf ~/Library",
  "rm -rf -- ~/Desktop",
  "D=$(mktemp -d ~/scratch.XXXX) && rm -rf $D",
  "true $(rm -rf ~/Documents)",
]);

// Temp folders and ordinary project folders are fine.
cases("pass", [
  "rm -rf /tmp/x",
  "rm -rf /private/tmp/claude-501/scratch",
  "rm -rf /var/folders/ab/cd/T/thing",
  'rm -rf "$TMPDIR/build"',
  "rm -rf $TMPDIR/*",
  "rm -rf /tmp/*",
  "D=$(mktemp -d); rm -rf $D",
  'D="$(mktemp -d -t guard)"; rm -rf "$D"',
  "D=`mktemp -d`; rm -rf $D",
  'D="${TMPDIR:-/tmp}/x"; rm -rf "${D:?}"',
  'D=/tmp/x; rm -rf "${D:?D is not set}/sub"',
  "for d in /tmp/a /tmp/b; do rm -rf $d; done",
  "cd /tmp && rm -rf build",
  "rm -rf build node_modules",
  "rm -rf ./dist",
  "rm -f ~/Documents",
  "D=/tmp/x bash -c 'rm -rf $D'",
  "cat > script.sh <<'EOF'\nrm -rf \"$D\"\nEOF\nchmod +x script.sh",
  "echo 'rm -rf ~' && echo \"rm -rf $HOME\"",
  "git push origin main",
  "git push --force origin feature",
]);

// Unresolvable targets are refused rather than asked about.
cases("deny", [
  "rm -rf $UNKNOWN",
  'rm -rf "${UNKNOWN:?}"',
  'rm -rf "$(git rev-parse --show-toplevel)/dist"',
  "D=$(something); rm -rf $D",
  "find . -name x | while read f; do rm -rf $f; done",
  "D=/tmp/x; bash -c 'rm -rf $D/y'",
  "cd $SOMEWHERE && rm -rf build",
]);

// The other protections are unchanged.
cases("ask", [
  "git push --force origin main",
  "git push -f origin master",
  "git push origin +main",
  "gh repo delete SwiftlyNoah/x --yes",
  "diskutil eraseDisk APFS X disk4",
  "dd if=x.img of=/dev/disk4",
]);
cases("deny", ["cat ~/.config/claude-pool/age-identity"]);

test("mail sends and Drive shares still ask", () => {
  assert.equal(decision(null, { tool: "mcp__claude_ai_Gmail__send_message", input: {} }), "ask");
  assert.equal(decision(null, { tool: "mcp__claude_ai_Google_Drive__share_file", input: {} }), "ask");
  assert.equal(decision(null, { tool: "Read", input: { file_path: `${HOME}/.config/claude-pool/age-identity` } }), "deny");
  assert.equal(decision(null, { tool: "Read", input: { file_path: `${HOME}/notes.txt` } }), "pass");
});
