// Feeds PreToolUse payloads to guard.mjs and checks what it decides. Run: node --test
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const GUARD = join(import.meta.dirname, "guard.mjs");
const HOME = homedir();
const ME = join(HOME, "me");
const TMPDIR = "/var/folders/zz/test/T/";
const BASH_ENTRY = ["--fail-closed"]; // what settings.json's Bash entry passes

// "pass" when the guard stays out of it, else its permissionDecision.
function decision(command, { cwd = ME, tool = "Bash", input, env = process.env } = {}) {
  const payload = { tool_name: tool, tool_input: input ?? { command }, cwd };
  const run = spawnSync(process.execPath, [GUARD, ...(tool === "Bash" ? BASH_ENTRY : [])], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...env, TMPDIR },
  });
  assert.equal(run.status, 0, run.stderr);
  if (!run.stdout) return "pass";
  return JSON.parse(run.stdout).hookSpecificOutput.permissionDecision;
}

function reason(command, cwd = ME, env = process.env) {
  const run = spawnSync(process.execPath, [GUARD, ...BASH_ENTRY], {
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

// The GitHub API can force-move or delete main without git: any call that writes to it asks.
cases("ask", [
  "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true",
  "gh api -X DELETE repos/o/r/git/refs/heads/main",
  "gh api --method=DELETE /repos/o/r/git/refs/heads/master",
  "gh api -XPATCH repos/{owner}/{repo}/git/refs/heads/main -f sha=abc",
  "gh api repos/o/r/git/refs/heads/main -f sha=abc",
  "gh api repos/o/r/git/refs/heads/main --input body.json",
  `gh api graphql -f query='mutation { deleteRef(input: {refId: "x"}) { clientMutationId } }'`,
  `gh api graphql -f query='mutation { updateRefs(input: {}) { clientMutationId } }'`,
  'gh api -X DELETE "repos/o/r/git/refs/heads/$B"',
]);
cases("pass", [
  "gh api repos/o/r/git/refs/heads/main",
  "gh api -X GET repos/o/r/git/refs/heads/main -f per_page=1",
  "gh api -X DELETE repos/o/r/git/refs/heads/feature",
  "gh api graphql -f query='{ viewer { login } }'",
  "gh api repos/o/r/pulls -f title=x",
]);

// A wrapper's option can take the next word as its value, so the command it runs can start
// at any later word. After env -C or sudo -D the working folder isn't known.
cases("ask", [
  "nice -n 5 git push --force origin main",
  "env -u X git push --force origin main",
  "sudo -u root git push -f origin main",
  "sudo -u root nice -n 5 diskutil eraseDisk APFS X disk4",
  "exec -a x dd if=x.img of=/dev/disk4",
  "nice -n 5 gh repo delete a/b",
  "env -S 'git push --force origin main'",
  "env -Sgit push --force origin main",
]);
cases("deny", [
  "nice -n 5 rm -rf ~/Documents",
  "env -u X rm -rf ~/Documents",
  "sudo -u root nice -n 5 rm -rf /Users",
  "exec -a x rm -rf ~/Documents",
  "env -S 'rm -rf ~/Documents'",
  "env -Srm -rf ~/Documents",
  "command cd ~ && rm -rf Documents",
  "env -C ~ rm -rf Documents",
  "sudo -D / rm -rf Users",
  "env -C ~ git push --force",
  "sudo -D / git push --force",
]);
cases("pass", ["nice -n 5 rm -rf /tmp/x", "sudo -u root ls -la", "env -u X npm test", "time make", "nice -n 5 git push --force origin feature"]);

// The time keyword, with a NAME=value prefix, -p or -- after it, never hides the command it times.
cases("ask", [
  "time -p git push -f origin main",
  "time -- git push -f origin main",
  "time -p X=1 git push -f origin main",
  "time X=1 git push -f origin main",
  "if time -p git push -f origin main; then :; fi",
  'time -p bash -c "git push -f origin main"',
  "time -p X=$(echo hi) diskutil eraseDisk APFS x disk4",
  "time -p gh repo delete a/b",
]);
cases("deny", ["time -p env -C ~ rm -rf Documents", "time -- rm -rf ~", "time { rm -rf ~; }"]);

// Nesting past the guard's depth is refused, never let through unchecked.
cases("deny", [
  "eval eval eval eval eval eval eval eval git push --force origin main",
  "eval eval eval eval eval eval eval eval echo hi",
  "echo $(echo $(echo $(echo $(echo $(echo $(echo $(echo $(git push --force origin main))))))))",
  "bash -c 'eval eval eval eval eval eval eval diskutil eraseDisk APFS x disk4'",
]);
cases("pass", ["eval eval echo hi", "echo $(echo $(echo hi))", "eval eval eval eval eval eval eval echo hi"]);

// Pushes, judged in real repos: one on main, one on a feature branch, a folder outside any
// repo, and a repo on main in a folder named push inside the feature one.
describe("git push", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-push-"));
  // Setup runs git without my own config, so no commit is signed and no hook runs.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => spawnSync("git", args, { encoding: "utf8", env });
  const COMMIT = ["-c", "user.name=guard", "-c", "user.email=guard@example.invalid", "commit", "-q", "--allow-empty", "-m", "start"];
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
      "git --shallow-file push -C push push --force",
      "git --shallow-file=x -C push push --force",
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
  // unquoted one could split or vanish and move every word after it. In a push that forces
  // or deletes it's refused; in one that doesn't, the guard asks.
  at(
    "deny",
    [
      "git $(echo push) --force origin main",
      "X=; git -C push $X push --force",
      "X=; git --git-dir $X status push --force origin main",
      "git -C $(echo push) push --force origin feature",
      "git push --force origin pus*",
      'git push --force origin "$BRANCH"',
      "git push --force-with-lease origin $BRANCH",
      'git push origin --delete "$BRANCH"',
      'git push -f origin "$(cat branch.txt)"',
      'git push origin ":$BRANCH"',
      'git push origin "+$BRANCH"',
    ],
    FEATURE,
  );
  at(
    "ask",
    [
      "git push origin $(echo +main)",
      'git push origin "$(echo +main)"',
      "git push $(echo --force) origin main",
      'X="push --force"; git $X origin main',
      "git $(echo push) origin main",
      'git push origin "$BRANCH"',
      'git push -u origin "$(cat branch.txt)"',
      "for b in $(git branch --format='%(refname:short)'); do git push origin $b; done",
      "git -C $X status",
    ],
    FEATURE,
  );
  at("pass", ['git -C "$(echo push)" status', "git push origin feature", "D=push; git -C $D status", 'git commit -m "$(cat msg.txt)"'], FEATURE);

  // The branch a repo is on, from git itself, is worked out the way the shell would: agents
  // push the branch they're on this way all the time. A branch can be named +main, which
  // makes the push a forced one.
  git("-C", MAIN, ...COMMIT);
  git("-C", FEATURE, ...COMMIT);
  const PLUS = join(root, "plus");
  git("init", "-q", "-b", "+main", PLUS);
  const pushHere = [
    'git push -u origin "$(git rev-parse --abbrev-ref HEAD)"',
    "git push -u origin $(git branch --show-current)",
    'B=$(git symbolic-ref --short HEAD); git push origin "$B"',
  ];
  at("pass", [...pushHere, 'git push --force origin "$(git rev-parse --abbrev-ref HEAD)"', 'git -C push push -u origin "$(git branch --show-current)"'], FEATURE);
  at("pass", pushHere, MAIN);
  at("ask", ['git push --force origin "$(git rev-parse --abbrev-ref HEAD)"', "git push -f origin $(git -C . branch --show-current)"], MAIN);
  at("ask", ['git push -u origin "$(git branch --show-current)"', 'git push origin "$(git symbolic-ref --short HEAD)"'], PLUS);
  at("ask", [`B=$(git -C ${MAIN} branch --show-current); git push --force origin $B`]);
  at("pass", [`B=$(git -C ${FEATURE} branch --show-current); git push --force origin $B`]);
  at("ask", ['git push -u origin "$(git branch --show-current)"']);
  at("deny", ['git push --force origin "$(git branch --show-current)"']);

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

  // --prune deletes every remote branch with no local one, main included, and send-pack
  // pushes the way git push does.
  at("ask", [
    "git push --all --prune origin",
    "git push --prune origin 'refs/heads/*:refs/heads/*'",
    "git push --prune origin 'refs/heads/nothing/*:refs/heads/*'",
    "git push --prune origin",
    "git push --pru origin",
    `git -C ${FEATURE} send-pack --force origin main`,
    `git -C ${FEATURE} send-pack --force origin`,
    `git -C ${FEATURE} send-pack origin +main`,
    `git -C ${FEATURE} send-pack --all --force origin`,
  ]);
  at("deny", [`git -C ${FEATURE} send-pack --force --stdin origin`]);
  at("pass", ["git push --prune origin feature", "git push --no-prune origin", "git send-pack origin feature", "git send-pack --force origin feature"], FEATURE);
  at("deny", [
    `R=$(echo ${MAIN}); cd $R && git push --force`,
    `cd "$(echo ${MAIN})" && git push --force`,
    `git -C "$(echo ${MAIN})" push --force`,
    `GIT_DIR=${MAIN}/.git git push --force`,
    `export GIT_DIR=${MAIN}/.git; git push --force`,
    `env GIT_WORK_TREE=${MAIN} git push --force`,
    `git --git-dir=${MAIN}/.git push --force`,
    `git --work-tree ${MAIN} push --force`,
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
    assert.match(reason("git push --force origin $(echo +main)", FEATURE), /can't tell what git does with \$\(echo \+main\).*Write it out literally/);
    assert.match(reason('git push origin "$BRANCH"', FEATURE), /git push with \$BRANCH, which the guard can't read/);
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

// Failing closed, for Bash only. Claude Code lets a call through when a hook passes its
// 10 s timeout or exits with a status other than 0 or 2, unless the hook's entry says
// onFailure "block". A Bash call has to be refused when the guard breaks; every other tool
// keeps going through a broken guard, so a session can always repair it with Edit.
const HOOK_TIMEOUT_MS = 10_000;

// Runs the guard the way Claude Code does, killing it at the hook timeout. stdin null
// leaves stdin open. decision is "pass" when there's no answer.
function hook(stdin, { args = [], env = process.env } = {}) {
  const started = Date.now();
  const child = spawn(process.execPath, [GUARD, ...args], { env: { ...env, TMPDIR } });
  const timeout = setTimeout(() => child.kill("SIGKILL"), HOOK_TIMEOUT_MS);
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
  child.stderr.resume();
  if (stdin !== null) child.stdin.end(stdin);
  return new Promise((done) =>
    child.on("close", (status) => {
      clearTimeout(timeout);
      child.stdin.destroy();
      const output = stdout ? JSON.parse(stdout).hookSpecificOutput : {};
      done({ status, ms: Date.now() - started, decision: output.permissionDecision ?? "pass", reason: output.permissionDecisionReason });
    }),
  );
}

const payload = (tool, input, cwd = ME) => JSON.stringify({ tool_name: tool, tool_input: input, cwd });
const refused = /^guard: .*, so this call is refused rather than let through unchecked/;

// A guard killed at the hook timeout comes back with status null, so the status checks
// below are also the time checks. The slow ones wait in parallel.
describe("failing closed", { concurrency: true }, () => {
  test("ordinary calls still pass, quickly", async () => {
    for (const [stdin, args] of [
      [payload("Bash", { command: "ls -la" }), BASH_ENTRY],
      [payload("Bash", { command: "ls -la" }), []],
      [payload("Edit", { file_path: "/tmp/x.txt" }), []],
    ]) {
      const run = await hook(stdin, { args });
      assert.deepEqual([run.status, run.decision], [0, "pass"], stdin);
    }
  });

  test("a guard that throws refuses Bash", async () => {
    // tool_input null throws on reading the command; a cwd that isn't a folder name throws
    // deep inside the checks.
    for (const [stdin, args] of [
      [payload("Bash", null), BASH_ENTRY],
      [payload("Bash", null), []],
      [payload("Bash", { command: "cd build && rm -rf dist" }, 5), BASH_ENTRY],
    ]) {
      const run = await hook(stdin, { args });
      assert.deepEqual([run.status, run.decision], [0, "deny"], stdin);
      assert.match(run.reason, /^guard: failed \(.+\), so this call is refused/);
    }
  });

  test("a malformed payload refuses Bash", async () => {
    for (const [stdin, args] of [
      ["", BASH_ENTRY],
      ["not json", BASH_ENTRY],
      ["null", BASH_ENTRY],
      [JSON.stringify({ tool_input: { command: "ls" } }), BASH_ENTRY],
      [payload("Bash", {}), BASH_ENTRY],
      [payload("Bash", { command: 5 }), []],
      [payload("Bash", "rm -rf ~"), []],
    ]) {
      const run = await hook(stdin, { args });
      assert.deepEqual([run.status, run.decision], [0, "deny"], stdin);
      assert.match(run.reason, refused);
    }
  });

  test("a guard that throws on Edit, or gets a payload it can't read, lets the call through", async () => {
    // Exit status 1 is a hook failure, which Claude Code lets through on an entry without
    // onFailure "block", as on main before the guard failed closed.
    for (const stdin of [payload("Edit", null), payload("Write", null), "not json", ""]) {
      const run = await hook(stdin);
      assert.deepEqual([run.status, run.decision], [1, "pass"], stdin);
    }
  });

  test("a git that never answers is refused before the hook times out", async (t) => {
    const bin = mkdtempSync(join(tmpdir(), "guard-git-"));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 });
    // Only the fake git is on PATH, so the real one can't answer instead.
    const run = await hook(payload("Bash", { command: "git push --force" }), { args: BASH_ENTRY, env: { ...process.env, PATH: bin } });
    assert.deepEqual([run.status, run.decision], [0, "deny"]);
    assert.match(run.reason, /can't tell which branch .* is on \(git didn't say within 3 s\)/);
  });

  // Each git answer here comes in time, but four in a row don't. The process has to end by
  // the deadline, not only print its refusal: Claude Code reads the answer when the process
  // exits, and one still waiting on git at the hook timeout counts as a timeout.
  test("a chain of slow git calls ends within the deadline and is refused", async (t) => {
    const bin = mkdtempSync(join(tmpdir(), "guard-git-"));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, "git"), "#!/bin/sh\n/bin/sleep 2.3\necho feature\n", { mode: 0o755 });
    const command = Array(4).fill("git push --force").join("; ");
    const run = await hook(payload("Bash", { command }), { args: BASH_ENTRY, env: { ...process.env, PATH: bin } });
    assert.deepEqual([run.status, run.decision], [0, "deny"]);
    assert.match(run.reason, /can't tell which branch .* is on \((git didn't say within [\d.]+ s, the time the guard had left|the guard ran out of time before asking git)\)/);
  });

  test("a guard that runs past its deadline refuses Bash", async () => {
    const run = await hook(null, { args: BASH_ENTRY });
    assert.deepEqual([run.status, run.decision], [0, "deny"]);
    assert.match(run.reason, /didn't finish within 7 s, so this call is refused/);
    assert.ok(run.ms >= 7_000, `took ${run.ms} ms`);
  });

  test("a guard that runs past its deadline on any other tool doesn't refuse it", async () => {
    // Killed at the hook timeout with no answer, which Claude Code lets through.
    const run = await hook(null);
    assert.deepEqual([run.status, run.decision], [null, "pass"]);
  });
});

test("settings.json blocks a failed guard on Bash only", () => {
  const settings = JSON.parse(readFileSync(join(import.meta.dirname, "..", "settings.json"), "utf8"));
  const entries = settings.hooks.PreToolUse.flatMap(({ matcher, hooks }) =>
    hooks.filter((h) => h.command.includes("guard.mjs")).map((h) => ({ matcher, ...h })),
  );
  const matches = (tool) => entries.filter((e) => new RegExp(`^(?:${e.matcher})$`).test(tool));
  const [bash] = matches("Bash");
  assert.equal(matches("Bash").length, 1);
  assert.equal(bash.onFailure, "block");
  assert.ok(bash.command.endsWith(` ${BASH_ENTRY.join(" ")}`), bash.command);
  for (const tool of ["Read", "Edit", "Write", "mcp__claude_ai_Gmail__send_message"]) {
    const [entry, ...more] = matches(tool);
    assert.deepEqual([more.length, entry.onFailure, entry.command.includes("--fail-closed")], [0, undefined, false], tool);
  }
});
