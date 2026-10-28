// Stops the few things a session must not do on its own, whatever its permission mode.
//
// Sessions run with permissions skipped, unattended, next to a browser and mail signed in
// to real accounts, so one instruction hidden in a page or an email could steer one. Most
// mistakes there are cheap to undo; these aren't, so they wait for me ("ask") or never
// happen ("deny"):
//
//   - a force push to main or master (including a push with no branch named, from main)
//   - deleting a GitHub repo
//   - rm -r on /, my home folder, or a folder directly in either (~/Documents, /Users)
//   - erasing a disk (diskutil erase*, dd to a device)
//   - reading the keychain (security find-*-password, dump-keychain, export)
//   - sharing a Google Drive file
//   - reading the claude-pool key (denied: see ~/.claude/CLAUDE.md)
//
// Sending or forwarding mail and deleting events or files are denied outright in
// settings.json instead (permissions.deny), which no mode can skip.
//
// Wired up as a PreToolUse hook in home/.claude/settings.json; home.nix links it to
// ~/.claude/hooks/guard.mjs. Emitting nothing leaves the decision alone.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const HOME = homedir();
const POOL_KEY = /claude-pool\/age-identity/;

function decide(permissionDecision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: `guard: ${reason}`,
      },
    }),
  );
  process.exit(0);
}

// Splits a command line into simple commands, each a list of words, the way the shell
// would for the cases that matter here: quotes, and ; && || | & and newlines between
// commands. Expansions stay as written, except a leading ~ or $HOME.
function commands(line) {
  const all = [[]];
  let word = null;
  const end = () => {
    if (word !== null) all.at(-1).push(word);
    word = null;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      word = (word ?? "") + line.slice(i + 1, close === -1 ? undefined : close);
      i = close === -1 ? line.length : close;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (/[;&|\n()]/.test(c)) {
      end();
      if (all.at(-1).length) all.push([]);
    } else if (/\s/.test(c)) {
      end();
    } else {
      word = (word ?? "") + c;
    }
  }
  end();
  return all
    .filter((words) => words.length)
    .map((words) =>
      words
        // Leading assignments and wrappers don't change what runs.
        .slice(words.findIndex((w) => !/^\w+=/.test(w) && !["command", "exec", "nohup", "time", "sudo"].includes(w)))
        .map((w) => w.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME)),
    );
}

const flags = (words) => words.filter((w) => w.startsWith("-"));
const operands = (words) => words.filter((w) => !w.startsWith("-"));

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function checkGitPush(words, cwd) {
  // git [-C dir] push ...
  const at = words.indexOf("push");
  if (words[0] !== "git" || at === -1) return;
  const args = words.slice(at + 1);
  const forced =
    args.some((w) => w === "--force" || w.startsWith("--force-with-lease") || w === "--force-if-includes") ||
    flags(args).some((w) => /^-[a-zA-Z]*f/.test(w) && !w.startsWith("--")) ||
    operands(args).some((w) => w.startsWith("+"));
  if (!forced) return;
  const dir = words[1] === "-C" ? resolve(cwd, words[2]) : cwd;
  const refspecs = operands(args).slice(1);
  const targets = refspecs.length ? refspecs.map((r) => r.replace(/^\+/, "").split(":").at(-1)) : [currentBranch(dir)];
  const protectedBranch = targets.find((t) => /^(refs\/heads\/)?(main|master)$/.test(t));
  if (protectedBranch) decide("ask", `force push to ${protectedBranch}`);
}

function checkRm(words, cwd) {
  if (words[0] !== "rm") return;
  const recursive = flags(words).some((w) => w === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(w) && !w.startsWith("--")));
  if (!recursive) return;
  for (const target of operands(words.slice(1))) {
    // A glob or variable could be anything: judge the folder it starts in.
    const literal = target.split(/[*?[$]/)[0];
    const path = resolve(cwd, literal || ".");
    const top = (p) => p === "/" || p === HOME;
    if (top(path) || top(dirname(path))) decide("ask", `rm -r ${target}`);
  }
}

function checkBash(command, cwd) {
  if (POOL_KEY.test(command)) decide("deny", "the claude-pool key is never read or copied");
  for (const words of commands(command)) {
    checkGitPush(words, cwd);
    checkRm(words, cwd);
    const [cmd, sub, sub2] = words;
    if (cmd === "gh" && sub === "repo" && sub2 === "delete") decide("ask", "deleting a GitHub repo");
    if (cmd === "gh" && sub === "api" && words.some((w) => /^(-X|--method)=?DELETE$/i.test(w) || w === "DELETE") && words.some((w) => /^\/?repos\/[^/]+\/[^/]+\/?$/.test(w)))
      decide("ask", "deleting a GitHub repo");
    if (cmd === "diskutil" && /^(erase|zero|randomDisk|secureErase|partitionDisk)/i.test(sub ?? "")) decide("ask", `diskutil ${sub}`);
    if (cmd === "dd" && words.some((w) => /^of=\/dev\//.test(w))) decide("ask", "dd to a device");
    if (cmd === "security" && /^(find-(generic|internet)-password|dump-keychain|export)$/.test(sub ?? ""))
      decide("ask", `security ${sub} reads the keychain`);
  }
}

const input = JSON.parse(readFileSync(0, "utf8"));
const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = input;
if (tool === "Bash") checkBash(args.command ?? "", cwd);
else if (["Read", "Edit", "Write"].includes(tool) && POOL_KEY.test(args.file_path ?? ""))
  decide("deny", "the claude-pool key is never read or copied");
else if (tool === "mcp__claude_ai_Google_Drive__share_file") decide("ask", "sharing a Drive file");
