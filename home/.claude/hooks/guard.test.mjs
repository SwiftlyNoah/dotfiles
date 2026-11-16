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
const BASH_ENTRY = ["--fail-closed"]; // what settings.json's entry for Bash and Monitor passes
const SHELL_TOOLS = ["Bash", "Monitor"]; // the tools that run a shell command

// "pass" when the guard stays out of it, else its permissionDecision.
function decision(command, { cwd = ME, tool = "Bash", input, env = process.env } = {}) {
  const payload = { tool_name: tool, tool_input: input ?? { command }, cwd };
  const run = spawnSync(process.execPath, [GUARD, ...(SHELL_TOOLS.includes(tool) ? BASH_ENTRY : [])], {
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

// A wrapper is known by its name wherever it lives, zsh's precommand words and =command
// count, and a command word the guard can't read could be any command: what comes after
// it is judged as the command too.
cases("ask", [
  "/usr/bin/env git push --force origin main",
  "/usr/bin/sudo git push --force origin main",
  "/usr/bin/nice -n 5 git push --force origin main",
  "/usr/bin/sudo diskutil eraseDisk APFS X disk9",
  "timeout 5 git push --force origin main",
  "timeout -s KILL 5 git push --force origin main",
  "gtimeout 5 diskutil eraseDisk APFS X disk9",
  "caffeinate -i diskutil eraseDisk APFS X disk9",
  "stdbuf -oL git push --force origin main",
  "arch -arm64 git push --force origin main",
  "script -q /dev/null git push --force origin main",
  "xcrun git push --force origin main",
  "noglob git push --force origin main",
  "nocorrect git push --force origin main",
  "- git push --force origin main",
  "=git push --force origin main",
  "coproc git push --force origin main",
  "sudo -s 'git push --force origin main'",
  "sudo -i 'git push --force origin main'",
  "sudo -Es git push --force origin main",
  "sudo --login 'diskutil eraseDisk APFS X disk9'",
  "$X git push --force origin main",
  "${X}git push --force origin main",
  "env $X git push --force origin main",
  "O=-i; env $O git push --force origin main",
  "$X diskutil eraseDisk APFS X disk9",
  "${X}diskutil eraseDisk APFS X disk9",
  'X="git push --force origin main"; $X',
  "X=; $X git push --force origin main",
  "$G push --force origin main",
  "$G -C . push --force origin main",
  "/usr/bin/g?t push --force origin main",
  "/usr/bin/gi[t] push --force origin main",
  "for c in ls git; do $c push -f origin main; done",
  'X=" git"; $X push --force origin main',
  "env -S'git push --force origin main'",
  "env -iS 'git push --force origin main'",
  "bash -c -- 'git push --force origin main'",
  "bash -c -x 'git push --force origin main'",
  "sh -c -e 'git push --force origin main'",
  "bash -c -- 'diskutil eraseDisk APFS X disk9'",
  "zsh -c -- 'git push --force origin main'",
  "bash -o pipefail -c 'git push --force origin main'",
  "bash -eo pipefail -c 'git push --force origin main'",
  "bash -lc 'git push --force origin main'",
  "bash --norc -c 'git push --force origin main'",
]);
cases("deny", [
  "$G push --force",
  "xargs git push --force origin <<< main",
  "xargs -I {} git push --force origin {}",
  "xargs -n 1 git push --force origin",
  "timeout 5 rm -rf $UNKNOWN",
  "$X rm -r $UNKNOWN",
  "r? -r $UNKNOWN",
  "env -S 'git\\_push\\_--force\\_origin\\_main'",
  "env -S 'rm\\_-rf\\_x'",
  "bash -c",
  "bash -x -c",
]);
cases("pass", [
  "timeout 60 npm test",
  "xargs grep foo",
  "find . -name '*.log' | xargs rm -f",
  "$EDITOR notes.txt",
  "noglob ls *",
  "caffeinate -i make",
  "$G push origin feature",
  "bash -c 'echo ok'",
  "bash -c -- 'echo ok'",
  "bash script.sh",
  "bash -x script.sh",
  "env -S 'echo ok'",
]);

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

// A command inside a ${X:-...} operator, an arithmetic expansion or a redirection target
// runs too, so it's checked like any other.
cases("ask", [
  "echo ${X:-$(git push --force origin main)}",
  'echo "${X:-$(git push --force origin main)}"',
  "echo ${X:-`git push --force origin main`}",
  "echo ${X:-${Y:-$(git push --force origin main)}}",
  "echo $(( $(git push --force origin main) ))",
  'echo "$(( 1 + $(diskutil eraseDisk APFS X disk9) ))"',
  'cat < "$(git push --force origin main)"',
  "echo hi > $(diskutil eraseDisk APFS X disk9)",
  "> $(git push --force origin main)",
]);
cases("deny", ["echo ${X:-$(rm -rf $UNKNOWN)}", "echo $(( $(rm -r $UNKNOWN) ))"]);
cases("pass", ["echo ${X:-default}", "echo $((1 + 2))", "echo ${X:-$(date)}", 'echo "$(( $(wc -l < x.txt) + 1 ))"', "echo hi > $(mktemp)"]);

// Brace expansion makes several words from one, the way bash and zsh both do.
cases("deny", [
  "rm -rf {/Users,/tmp/x}",
  "rm -rf {$HOME,/tmp/x}",
  "rm -rf {~,/tmp/x}",
  "rm -rf {/tmp/x,~/Documents}",
  "D=/Users; rm -rf {$D,/tmp/x}",
  "D=/; rm -r {/tmp/a,$D}",
  "rm -r {/tmp/a,.}",
  "rm -r /tmp/x{,/../../Users}",
  "git push --force origin {main,feature}",
  "git push -f origin feature:{main,x}",
]);
// /tmp/{x,/Users} is /tmp/x and /tmp//Users; {feature..main} is no sequence, so it stays as written.
cases("pass", ["rm -rf /tmp/{x,/Users}", "git push -f origin {feature..main}", "rm -rf /tmp/{a,b}", "rm -rf /tmp/x{1..3}", "rm -rf /tmp/{a,b{c,d}}", "D=/tmp; rm -rf {$D/a,$D/b}", "find . -name x -exec ls {} \\;", "echo {a,b}"]);

// A function's body is checked where it's defined, in either form.
cases("ask", [
  "function f { git push -f origin main; }; f",
  "function f { diskutil eraseDisk APFS x disk9; }; f",
  "function f() { git push -f origin main; }; f",
  "f() { git push -f origin main; }; f",
  "function f { time git push -f origin main; }",
]);
cases("deny", ['X=~; function f { rm -rf "$X"; }; f', 'function f { rm -rf "$U"; }']);
cases("pass", ["function f { echo hi; }; f", "function f { git push origin feature; }; f"]);

// $'...' is decoded the way bash and zsh decode it, so an escape can't hide what runs.
cases("ask", [
  "git push origin $'\\x2bmain'",
  "git push -f origin ma$'\\x69'n",
  "git push $'\\x2d\\x2dforce' origin main",
  "diskutil $'\\x65rase'Disk APFS x disk9",
  "$'\\x67it' push -f origin main",
  "git push -f origin $'\\155ain'",
  "git push -f origin $'\\u006dain'",
  "git push -f origin $'\\U0000006dain'",
  "git push origin $'\\053main'",
  "git push -f origin $'main\\0junk'",
]);
cases("deny", ["rm -rf /tmp/$'\\x2e\\x2e'/Users", "rm -rf $'/tmp/\\56\\56/Users'", "git push -f origin $'\\cA'\"$B\""]);
cases("pass", ["echo $'a\\tb\\n'", "git push origin $'feature'", "printf $'%s\\n' x", "git push -f origin $'fe\\x61ture'", "echo $'it\\'s'", "git push -f origin $'\\xZZmain'"]);

// zsh's $=X splits X into words and $~X globs it, so neither is the plain text it looks like.
cases("ask", ["X='-f origin main'; git push $=X", "X='+main'; git push origin $~X", 'git push origin "$=X"', "git push origin $^X"]);
cases("deny", ["X=~; rm -rf $=X", "X=/; rm -rf $~X"]);

// git's own programs in git-core (git-push, git-send-pack...) are read as git with that command.
cases("ask", [
  "/nix/store/x-git-2.54.0/libexec/git-core/git-push --force origin main",
  '"$(git --exec-path)/git-push" --force origin main',
  "$(git --exec-path)/git-push --force origin main",
  "git-push -f origin main",
  "git-push origin :main",
  "/usr/libexec/git-core/git-send-pack --force origin main",
  "git-http-push --force https://example.invalid/r.git main",
  "git http-push --force https://example.invalid/r.git main",
]);
cases("deny", ['git-push --force origin "$B"', "git-config remote.origin.push +HEAD:refs/heads/main", 'cd "$U"; git-push -f']);
cases("pass", ["git-push origin feature", "git-lfs push origin main", "git-receive-pack x"]);

// An ask never ends the checks: a refusal anywhere later in the line still wins, so
// approving the question can't run what the guard refuses.
cases("deny", [
  'B=$(cat .branch); git push origin "$B"; X=~; rm -rf "$X"',
  'git push origin "$B"; rm -rf "$U"',
  'cd "$U"; git frob; X=~; rm -rf "$X"',
  'git push origin "$B"; git push --force origin "$C"',
  'cd "$U" && git push; X=~/Documents; rm -rf "$X"',
  '/usr/bin/g?t push origin "$B"; X=~; rm -rf "$X"',
  'git push --force origin main; X=~; rm -rf "$X"',
  'diskutil eraseDisk APFS X disk9; rm -rf "$U"',
  'gh repo delete a/b && X=~/Library && rm -rf "$X"',
]);
cases("ask", ['git push origin "$B"; git push --force origin main', 'diskutil eraseDisk APFS X disk9; git push origin "$B"']);

test("the question names the first thing asked about", () => {
  assert.match(reason('git push origin "$B"; diskutil eraseDisk APFS X disk9'), /git push with \$B/);
});

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

  // The guard asks git too, with the same config the setup has.
  const at = (expected, commands, cwd = OUTSIDE) => {
    for (const command of commands) test(`${expected}: ${command}`, () => assert.equal(decision(command, { cwd, env }), expected));
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

  // Only a short list of config is safe to set for one command: anything else could run a
  // program (a pager, an ssh command, fsmonitor, hooks) or send a push somewhere else. The
  // same goes for git's environment, where HOME and XDG_CONFIG_HOME choose its config file,
  // for set -a exporting what follows, and for git config writing such keys for later.
  at(
    "deny",
    [
      "git -c 'core.fsmonitor=git push --force origin main #' status",
      "git -c core.pager='git push --force origin main;:' log",
      "git -c core.pager='diskutil eraseDisk APFS X disk9' log",
      "git -c core.sshCommand='git push --force origin main' fetch",
      "git -c core.hooksPath=/tmp/h commit -m x",
      "git -c push.default=matching push origin",
      "git --config-env core.pager=P log",
      "git --config-env=user.name log",
      "git -c $K=1 log",
      "GIT_PAGER='git push --force origin main' git log",
      "GIT_SSH_COMMAND='git push --force origin main' git fetch",
      "GIT_EXEC_PATH=/tmp/x git push origin",
      "GIT_EDITOR='git push --force origin main' git commit",
      "git --exec-path=/tmp/x push origin",
      "HOME=/tmp/h git push origin",
      "XDG_CONFIG_HOME=/tmp/x git push origin",
      "export HOME=/tmp/h; git push origin",
      "set -a; GIT_CONFIG_COUNT=1; GIT_CONFIG_KEY_0=remote.origin.push; GIT_CONFIG_VALUE_0=+HEAD:refs/heads/main; git push origin",
      "set -o allexport; GIT_PAGER=x; git log",
      "set -ea; HOME=/tmp/h; git push origin",
      "git config remote.origin.push +HEAD:refs/heads/main && git push origin",
      "git config alias.fp 'push --force origin main' && git fp",
      "git config --global alias.p '!git push -f origin main'",
      "git config set remote.origin.mirror true",
      "git config --add include.path /tmp/x",
      "git config core.pager 'git push --force origin main'",
      "git config --rename-section x remote.origin",
      "git config --edit",
      "git config $K $V",
      "git remote add --mirror=push backup /tmp/x",
    ],
    FEATURE,
  );
  at(
    "pass",
    [
      "git -c color.ui=never log",
      "git -c core.quotepath=off status",
      "git -c user.name=x -c user.email=y commit -m z",
      "git -c core.pager=cat log",
      "git -c core.editor=true rebase --continue",
      "git -c commit.gpgsign=false commit -m x",
      "git --config-env=user.name=NAME log",
      "GIT_EDITOR=true git rebase --continue",
      "GIT_PAGER=cat git log",
      "GIT_TERMINAL_PROMPT=0 git fetch",
      "GIT_AUTHOR_DATE=2020-01-01 git commit -m x",
      "HOME=$HOME git push origin feature",
      "git config user.name x",
      "git config --get remote.origin.url",
      "git config --list",
      "git config get alias.p",
      "git config --get-regexp '^alias'",
      "git config --unset remote.origin.push",
      "set -a; set +a; GIT_PAGER=x; git log",
      "git --exec-path",
    ],
    FEATURE,
  );

  // Everyday config that can't run a program or send a push elsewhere passes too: agents set
  // pull.rebase after git pull's divergent-branches hint, and trace git when it misbehaves.
  at(
    "pass",
    [
      "git config pull.rebase false",
      "git -c pull.rebase=false pull",
      "git config pull.ff only",
      "git config core.autocrlf false",
      "git config core.fileMode false",
      "git config core.ignorecase true",
      "git config --global --add safe.directory /x",
      "git -c safe.directory='*' status",
      "git -c protocol.file.allow=always submodule update --init",
      "git config push.autoSetupRemote true",
      "git config rebase.autoStash true",
      "git config rebase.autosquash true",
      "git config merge.conflictStyle zdiff3",
      "git config diff.noprefix true",
      "git config diff.algorithm histogram",
      "git config fetch.prune true",
      "git config init.defaultBranch main",
      "git config gc.auto 0",
      "git config log.date iso",
      "git -c core.hooksPath=/dev/null commit -m x",
      "GIT_TRACE=1 git status",
      "GIT_TRACE2_EVENT=/tmp/t.json git status",
      "GIT_CURL_VERBOSE=1 git fetch",
    ],
    FEATURE,
  );
  // Keys that name a program, a file of config, or where git fetches and pushes stay refused.
  at(
    "deny",
    [
      "git config diff.external 'git push --force origin main'",
      "git config diff.x.command x",
      "git config diff.x.textconv x",
      "git config filter.x.clean x",
      "git config credential.helper x",
      "git config gpg.program x",
      "git config core.sshCommand x",
      "git config core.fsmonitor x",
      "git config merge.x.driver x",
      "git config init.templateDir /tmp/t",
      "git config url.x.insteadOf origin",
      "git config remote.origin.url /tmp/x",
      "git -c protocol.ext.allow=always fetch 'ext::sh -c x'",
      "git -c protocol.allow=always fetch",
      "git -c core.hooksPath=/tmp/hooks commit -m x",
      "git -c sequence.editor=x rebase -i HEAD~2",
      "GIT_EXTERNAL_DIFF=x git diff",
    ],
    FEATURE,
  );

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

  // A word with several known values is judged as each of them.
  at("pass", ['for b in a b; do git push origin "$b"; done', "for b in a b; do git push origin $b; done", 'for b in a b; do git push -f origin "$b"; done'], FEATURE);
  at("ask", ['for b in a main; do git push -f origin "$b"; done', 'for b in a +main; do git push origin "$b"; done', 'for f in -u -f; do git push $f origin main; done'], FEATURE);
  at("deny", ['for b in a "x y"; do git push -f origin $b; done'], FEATURE);

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

  // Config set earlier, in the repo or for the user, can send a push with no refspec
  // somewhere else, force it, or make a command an alias for a push, so the guard asks git.
  const repo = (name, ...config) => {
    const dir = join(root, name);
    git("init", "-q", "-b", "feature", dir);
    for (const [key, value] of config) git("-C", dir, "config", key, value);
    return dir;
  };
  const REDIRECTED = repo("redirected", ["remote.origin.push", "+HEAD:refs/heads/main"]);
  const MIRRORED = repo("mirrored", ["remote.backup.mirror", "true"]);
  const MATCHING = repo("matching", ["push.default", "matching"]);
  const UPSTREAM = repo("upstream", ["push.default", "upstream"]);
  const ALIASED = repo(
    "aliased",
    ["alias.fp", "push --force origin main"],
    ["alias.sh", "!git push --force origin main"],
    ["alias.pf", "push --force"],
    ["alias.st", "status"],
    ["alias.rmall", "!rm -rf ~/Documents"],
  );
  at("ask", ["git push origin", "git push", "git push -u origin"], REDIRECTED);
  at("pass", ["git push origin feature", "git status"], REDIRECTED);
  at("ask", ["git push backup", "git push"], MIRRORED);
  at("pass", ["git push origin feature"], MIRRORED);
  at("ask", ["git push --force", "git push --force origin"], MATCHING);
  at("pass", ["git push", "git push --force origin feature"], MATCHING);
  at("ask", ["git push --force origin"], UPSTREAM);
  at("pass", ["git push"], UPSTREAM);
  at("ask", ["git fp", "git sh", "git -C . fp", "git pf origin main", "git --no-pager fp"], ALIASED);
  at("deny", ["git rmall"], ALIASED);
  at("pass", ["git st", "git zzguardnone", "git pf origin feature", "git pf"], ALIASED);
  at("ask", ["cd $R && git fp", "cd $R && git push"]);
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

  // git answers which branch a repo is on before the line runs, so after an earlier command
  // that could change it (checkout, switch, a script) the branch isn't known. A loop runs
  // its body again after its last command.
  at(
    "deny",
    [
      "git checkout main && git push --force",
      'git switch main; git push -f origin "$(git branch --show-current)"',
      "git checkout main; git push -f origin HEAD",
      'git switch main && git push --force origin "$(git branch --show-current)"',
      "./switch.sh && git push --force",
      "$X; git push --force",
      "git branch -m main && git push --force",
      "git symbolic-ref HEAD refs/heads/main && git push -f origin HEAD",
      "git -C /tmp checkout main; git push --force",
      "(git checkout main); git push --force",
      'echo "$(git checkout main)"; git push --force',
      "sudo git switch main && git push --force",
      "while true; do git push --force; git checkout main; done",
      'for i in 1 2; do git push -f origin "$(git branch --show-current)"; git switch main; done',
      "git rebase origin/main main && git push --force",
      "git rebase --onto x origin/main main && git push --force",
      "git rebase --continue && git push --force",
      "git rebase --abort && git push --force",
      "git stash branch main && git push --force",
    ],
    FEATURE,
  );
  // Commands that change files or history but never switch the branch.
  at(
    "pass",
    [
      "git rebase origin/main && git push --force-with-lease",
      "git rebase --onto origin/main HEAD~2 && git push --force",
      "git pull --rebase && git push --force",
      "git stash && git stash pop && git push --force",
      "git checkout -- file.txt && git push --force",
      "git reset --hard HEAD~1 && git push --force",
      "git merge origin/main && git tag v1 && git push --force",
    ],
    FEATURE,
  );
  at("ask", ['git checkout main && git push -u origin "$(git branch --show-current)"'], FEATURE);
  at(
    "pass",
    [
      'git status && git add -A && git commit -m "x" && git push --force',
      'git fetch && git push --force origin "$(git branch --show-current)"',
      "git push --force; git checkout main",
      'git push -u origin "$(git branch --show-current)" && gh pr create --fill',
      "git checkout main && git push --force origin feature",
      "cd . && git push --force",
      "git branch --list && git log --oneline -3 && git push --force",
      "echo hi; ls; git push --force",
    ],
    FEATURE,
  );

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
    assert.match(reason("git -c remote.origin.push=+HEAD:main push", FEATURE), /git -c remote\.origin\.push=\+HEAD:main isn't on the guard's list of config .* Leave it out/);
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

// Monitor runs a shell command the way Bash does, so it gets every one of Bash's checks.
test("a Monitor command is checked like a Bash one", () => {
  const monitor = (command) => decision(null, { tool: "Monitor", input: { command, description: "x", timeout_ms: 1000 } });
  assert.equal(monitor("git push --force origin main"), "ask");
  assert.equal(monitor("rm -rf ~"), "deny");
  assert.equal(monitor("cat ~/.config/claude-pool/age-identity"), "deny");
  assert.equal(monitor("diskutil eraseDisk APFS X disk9"), "ask");
  assert.equal(monitor("tail -f build.log | grep --line-buffered ERROR"), "pass");
  assert.equal(decision(null, { tool: "Monitor", input: { ws: { url: "wss://example.invalid" }, description: "x", timeout_ms: 1000 } }), "pass");
});

// Failing closed, for Bash and Monitor only. Claude Code lets a call through when a hook
// passes its 10 s timeout or exits with a status other than 0 or 2, unless the hook's entry
// says onFailure "block". A call that runs a shell command has to be refused when the guard
// breaks; every other tool keeps going through a broken guard, so a session can always
// repair it with Edit.
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
      [payload("Monitor", { command: "tail -f x.log", description: "x", timeout_ms: 1000 }), BASH_ENTRY],
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
      [payload("Monitor", null), BASH_ENTRY],
      [payload("Monitor", null), []],
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
      [payload("Monitor", { command: 5 }), BASH_ENTRY],
      [payload("Monitor", { description: "x" }), []],
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
    for (const tool of SHELL_TOOLS) {
      const run = await hook(payload(tool, { command: "git push --force" }), { args: BASH_ENTRY, env: { ...process.env, PATH: bin } });
      assert.deepEqual([run.status, run.decision], [0, "deny"], tool);
      assert.match(run.reason, /can't tell which branch .* is on \(git didn't say within 3 s\)/);
    }
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

test("settings.json blocks a failed guard on Bash and Monitor only", () => {
  const settings = JSON.parse(readFileSync(join(import.meta.dirname, "..", "settings.json"), "utf8"));
  const entries = settings.hooks.PreToolUse.flatMap(({ matcher, hooks }) =>
    hooks.filter((h) => h.command.includes("guard.mjs")).map((h) => ({ matcher, ...h })),
  );
  const matches = (tool) => entries.filter((e) => new RegExp(`^(?:${e.matcher})$`).test(tool));
  for (const tool of SHELL_TOOLS) {
    const [entry, ...more] = matches(tool);
    assert.deepEqual([more.length, entry.onFailure], [0, "block"], tool);
    assert.ok(entry.command.endsWith(` ${BASH_ENTRY.join(" ")}`), entry.command);
  }
  for (const tool of ["Read", "Edit", "Write", "mcp__claude_ai_Gmail__send_message"]) {
    const [entry, ...more] = matches(tool);
    assert.deepEqual([more.length, entry.onFailure, entry.command.includes("--fail-closed")], [0, undefined, false], tool);
  }
});
