// Feeds PreToolUse payloads to guard.mjs and checks what it decides. Run: node --test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const GUARD = join(import.meta.dirname, "guard.mjs");
const HOME = homedir();
const ME = join(HOME, "me");
const TMPDIR = "/var/folders/zz/test/T/";

// "pass" when the guard stays out of it, else its permissionDecision.
function decision(command, { cwd = ME, tool = "Bash", input, env = process.env } = {}) {
  const payload = { tool_name: tool, tool_input: input ?? { command }, cwd };
  const run = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...env, TMPDIR },
  });
  assert.equal(run.status, 0, run.stderr);
  if (!run.stdout) return "pass";
  return JSON.parse(run.stdout).hookSpecificOutput.permissionDecision;
}

function reason(command, cwd = ME, env = process.env) {
  const run = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
    encoding: "utf8",
    env: { ...env, TMPDIR },
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

// Known paths at the top are refused outright (2026-11-16 incident): no session can approve them.
cases("deny", [
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
  "D=/tmp/x bash -c 'rm -rf $D'",
  "cat > script.sh <<'EOF'\nrm -rf \"$D\"\nEOF\nchmod +x script.sh",
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

// Pushes, judged in real repos: one on main, one on a feature branch, a folder outside any
// repo, and a repo on main in a folder named push inside the feature one.
describe("git push", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-push-"));
  const git = (...args) => spawnSync("git", args, { encoding: "utf8" });
  const MAIN = join(root, "main");
  const FEATURE = join(root, "feature");
  const OUTSIDE = join(root, "outside");
  const NESTED = join(FEATURE, "push");
  git("init", "-q", "-b", "main", MAIN);
  git("init", "-q", "-b", "feature", FEATURE);
  git("init", "-q", "-b", "main", NESTED);
  mkdirSync(OUTSIDE);
  after(() => rmSync(root, { recursive: true, force: true }));

  const at = (expected, commands, cwd = OUTSIDE) => {
    for (const command of commands) test(`${expected}: ${command}`, () => assert.equal(decision(command, { cwd }), expected));
  };

  // git's own options come before its command, and some take a value: in
  // git -C push push --force, the first "push" is a folder.
  at(
    "ask",
    [
      "git -C push push --force",
      "git -C push push --force origin",
      "git -C push push -f",
      "git -c core.quotepath=off -C push push --force",
      "git --namespace push -C push push --force",
    ],
    FEATURE,
  );
  at("pass", ["git -C push status", "git -C push push --force origin feature", "git commit -m push --force"], FEATURE);

  // git push reads its options the way git does: values, shortened names, anywhere.
  at(
    "ask",
    [
      "git push --recurse-submodules no --force origin",
      "git push --recurse no --force origin",
      "git push --recurse-submodules=no --force origin",
      "git push --force-w origin",
      "git push --force-with-lease=main:abc origin",
      "git push -o ci.skip -f origin",
      "git push -uf origin",
      "git push origin --force",
      "git push --force origin HEAD:heads/main",
      "git push origin :main",
      "git push origin --delete main",
      "git push -d origin master",
      "git push --force -- origin main",
    ],
    MAIN,
  );
  at(
    "pass",
    [
      "git push --follow-tags origin",
      "git push -u origin feature",
      "git push --no-force origin main",
      "git push --force-with-lease origin feature",
      "git push -o -f origin feature",
      "git push --push-option --force origin feature",
      "B=feature; git push --force origin $B",
    ],
    MAIN,
  );

  // Config given on the command line, or in git's environment, can send a push somewhere
  // else or force it with no flag, or turn another command into a push (an alias).
  at(
    "deny",
    [
      "git -c remote.origin.push=+HEAD:refs/heads/main push origin",
      "git -c Remote.origin.PUSH=+HEAD:refs/heads/main push origin",
      "git -c remote.origin.mirror=true push origin",
      "git --config-env remote.origin.push=SPEC push origin",
      "git --config-env=remote.origin.push=SPEC push origin",
      "git -c push.default=matching push --force origin",
      "git -c push.default=upstream push --force",
      "git --config-env push.default=MODE push --force",
      "git -c alias.p='push --force' p origin main",
      "git -c include.path=/tmp/x push origin",
      "git -c includeIf.gitdir:/.path=/tmp/x push origin",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=+HEAD:refs/heads/main git push origin",
      "export GIT_CONFIG_PARAMETERS=x; git push origin",
      "env GIT_CONFIG_GLOBAL=/tmp/x git push origin",
    ],
    FEATURE,
  );
  at("ask", ["git -c push.default=simple push --force", "git -c push.default=current push --force"], MAIN);

  // A word whose value the guard can't work out could be push, --force or +main, and an
  // unquoted one could split or vanish and move every word after it.
  at(
    "deny",
    [
      "git push origin $(echo +main)",
      'git push origin "$(echo +main)"',
      "git push $(echo --force) origin main",
      "git $(echo push) --force origin main",
      'X="push --force"; git $X origin main',
      "X=; git -C push $X push --force",
      "X=; git --git-dir $X status push --force origin main",
      "git -C $(echo push) push --force origin feature",
      "git push --force origin pus*",
    ],
    FEATURE,
  );
  at("pass", ['git -C "$(echo push)" status', "git push origin feature", "D=push; git -C $D status"], FEATURE);

  // A force push with no branch named, or to HEAD, goes to the branch its repo is on, so the
  // guard asks git. When it can't tell which repo that is, or git can't answer, it refuses:
  // reading that as "not main" would let a force push to main through.
  at("ask", [
    `cd ${MAIN} && git push --force`,
    `git -C ${MAIN} push --force`,
    `git -c push.default=current -C ${MAIN} push -f origin`,
    `/usr/bin/git -C ${MAIN} push --force`,
    `git -C ${MAIN} push --force origin HEAD`,
    `git -C ${MAIN} push --force origin @`,
    `git -C ${FEATURE} push --force --all`,
    `git -C ${FEATURE} push --mirror --force`,
    `git -C ${FEATURE} push --force origin :`,
    `git push --force origin 'refs/heads/*:refs/heads/*'`,
  ]);
  at("ask", ["git push --force", "git push --force -o ci.skip origin"], MAIN);
  at("pass", [
    `cd ${FEATURE} && git push --force`,
    `git -C ${FEATURE} push --force origin HEAD`,
    `cd $(echo ${MAIN}) && git push --force origin feature`,
    `GIT_DIR=${MAIN}/.git git push --force origin feature`,
  ]);
  at("pass", ["git push --force"], FEATURE);
  at("deny", [
    `R=$(echo ${MAIN}); cd $R && git push --force`,
    `cd "$(echo ${MAIN})" && git push --force`,
    `git -C "$(echo ${MAIN})" push --force`,
    `GIT_DIR=${MAIN}/.git git push --force`,
    `export GIT_DIR=${MAIN}/.git; git push --force`,
    `env GIT_WORK_TREE=${MAIN} git push --force`,
    `git --git-dir=${MAIN}/.git push --force`,
    `git --work-tree ${MAIN} push --force`,
    `B=$(git -C ${MAIN} branch --show-current); git push --force origin $B`,
    "git push --force",
  ]);

  test("a git that fails is refused, not read as some other branch", (t) => {
    const bin = mkdtempSync(join(tmpdir(), "guard-git-"));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n", { mode: 0o755 });
    // Only the fake git is on PATH, so the real one can't answer instead.
    const env = { ...process.env, PATH: bin };
    assert.equal(decision("git push --force", { cwd: MAIN, env }), "deny");
    assert.match(reason("git push --force", MAIN, env), /can't tell which branch .* is on \(git couldn't say: exit 128\).*Name the branch/);
  });

  test("an unknown repo is refused with how to fix the command", () => {
    assert.match(reason("cd $R && git push --force", OUTSIDE), /can't tell which repo this force push runs in.*Name the branch/);
  });

  test("a git refusal says how to fix the command", () => {
    assert.match(reason("git push origin $(echo +main)", FEATURE), /can't tell what git does with \$\(echo \+main\).*Write it out literally/);
    assert.match(reason("X=; git -C push $X push --force", FEATURE), /could split into several words, vanish or match files.*Quote it \("\$X"\)/);
    assert.match(reason("git -c remote.origin.push=+HEAD:main push", FEATURE), /git -c remote\.origin\.push=\+HEAD:main can change .* Leave it out/);
  });
});

// The 2026-11-16 incident and its relatives: refused even inside quotes, here-documents and backticks.
cases("deny", [
  'swarm report me-agent "s" <<EOF\nexample: `rm -rf ~`\nEOF',
  'cat <<EOF\nnow $(date)\nEOF',
  'echo "`rm -rf ~`"',
  "echo 'rm -rf ~' && echo \"rm -rf $HOME\"",
  'git commit -m "rm -rf ~/Library"',
  "rm -f ~/Documents",
  "find ~ -name x -delete",
  "rm -rf /Users/x/../../",
]);
cases("pass", [
  "cat <<'EOF'\nliteral `backticks` and $(subs)\nEOF",
  "cat <<EOF\nplain $HOME text\nEOF",
  "rm -rf ~/coding/claude-pool/build",
  "rm -f ~/me/academics/notes.txt",
]);

test("mail sends and Drive shares still ask", () => {
  assert.equal(decision(null, { tool: "mcp__claude_ai_Gmail__send_message", input: {} }), "ask");
  assert.equal(decision(null, { tool: "mcp__claude_ai_Google_Drive__share_file", input: {} }), "ask");
  assert.equal(decision(null, { tool: "Read", input: { file_path: `${HOME}/.config/claude-pool/age-identity` } }), "deny");
  assert.equal(decision(null, { tool: "Read", input: { file_path: `${HOME}/notes.txt` } }), "pass");
});
