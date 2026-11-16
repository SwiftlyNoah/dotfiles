// Has a session check with me before the few things that can't be undone, whatever its
// permission mode. Everything else runs as before.
//
// Sessions run with permissions skipped, often unattended, next to mail and a browser
// signed in to real accounts, so one instruction hidden in a page or an email could steer
// one. When I asked for the action, approving it is one click; when I didn't, it waits:
//
//   - sending, replying to or forwarding mail, and trashing mail, events or Drive files
//   - sharing a Google Drive file
//   - a force push to main or master, or deleting either (including a push with no branch
//     named, from main; git's arguments are read the way git reads them, and the branch a
//     repo is on, as in "$(git branch --show-current)", is asked of git; a force push whose
//     repo or branch the guard can't work out is refused, like an rm -r target below, and
//     so is git config on the command line or in git's environment that could redirect a
//     push or define an alias; a push that doesn't force but holds a word the guard can't
//     read is asked about, since that word could force it)
//   - deleting a GitHub repo
//   - rm -r on /, my home folder, or a folder directly in either (~/Documents, /Users)
//   - erasing a disk (diskutil erase*, dd to a device)
//
// Reading the claude-pool key is refused outright (see ~/.claude/CLAUDE.md).
//
// rm -r is judged on the path it would really remove. Variables assigned earlier in the
// same command line (D=..., export D=..., D=$(mktemp -d), for D in ...) are filled in, and
// so are $HOME, $PWD, $TMPDIR and $CLAUDE_*; cd is followed. Anything under a temp folder
// (/tmp, /private/tmp, /var/folders, $TMPDIR) is fine. A target that still can't be worked
// out (an unknown variable, a command substitution) is refused with a reason, never asked
// about: a refusal comes back at once and the session rewrites the command, while a
// question to me stalls a subagent until I happen to look.
//
// Wired up as a PreToolUse hook in home/.claude/settings.json, which runs it from this
// repo (no rebuild needed). Emitting nothing leaves the decision alone. A session with
// no one to ask (claude -p) is refused instead. When the guard itself breaks, a Bash call
// is refused and every other tool goes on (see Running, at the end). Tests: node --test
// (guard.test.mjs).
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import vm from "node:vm";

const HOME = homedir();
const OUTWARD = {
  mcp__claude_ai_Gmail__send_message: "sending mail",
  mcp__claude_ai_Gmail__reply: "replying to mail",
  mcp__claude_ai_Gmail__forward: "forwarding mail",
  mcp__claude_ai_Gmail__trash_message: "trashing mail",
  mcp__claude_ai_Gmail__trash_thread: "trashing mail",
  mcp__claude_ai_Google_Calendar__delete_event: "deleting a calendar event",
  mcp__claude_ai_Google_Drive__trash_file: "trashing a Drive file",
  mcp__claude_ai_Google_Drive__share_file: "sharing a Drive file",
};
const POOL_KEY = /claude-pool\/age-identity/;
const TMP = process.env.TMPDIR ? resolve(process.env.TMPDIR) : "/tmp";
const TEMP_ROOTS = [...new Set(["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", TMP])];
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "done", "fi", "esac", "time"]);
const WRAPPERS = new Set(["command", "builtin", "exec", "nohup", "time", "sudo", "env", "nice"]);
const DECLARE = new Set(["export", "declare", "local", "readonly", "typeset"]);
const MAX_VALUES = 64;
const MAX_DEPTH = 8;
const now = () => performance.now(); // ms since the process started
const DEADLINE = 7_000; // on that clock; the hook's timeout in settings.json is 10 s
const GIT_TIMEOUT_MS = 3_000; // at most, per git call
const GIT_MARGIN_MS = 500; // every git call ends this long before the deadline

// The first decision ends the checks: decide() throws it up to judge().
class Verdict {
  constructor(decision, reason) {
    this.decision = decision;
    this.reason = reason;
  }
}

function decide(decision, reason) {
  throw new Verdict(decision, reason);
}

// ---------------------------------------------------------------------------------------
// Parsing. A command line becomes a flat list of items: { words, heredocs } for a simple
// command, and "(" or ")" around a subshell. A word is a list of parts:
//   { text, quoted }       literal text (quoted: no tilde expansion or word splitting)
//   { name, op, quoted }   a parameter: $NAME or ${NAME<op>}
//   { sub, quoted }        a command substitution, $(...) or `...` (null for $((...)))
// It follows the shell where it matters here: quotes, escapes, ; && || | & and newlines,
// subshells, comments, redirections and here-documents.

const upTo = (k, s) => (k === -1 ? s.length : k);

function closeDouble(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === '"') return j;
  }
  return s.length;
}

// Index of the bracket closing the one at i.
function closeBracket(s, i, open, close) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'") j = upTo(s.indexOf("'", j + 1), s);
    else if (c === '"') j = closeDouble(s, j);
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return j;
  }
  return s.length;
}

// Reads the expansion at the "$" at i: returns [part, index of its last character].
function dollar(s, i, quoted) {
  const next = s[i + 1];
  if (next === "(") {
    const close = closeBracket(s, i + 1, "(", ")");
    return [{ sub: s[i + 2] === "(" ? null : s.slice(i + 2, close), quoted }, close];
  }
  if (next === "{") {
    const close = closeBracket(s, i + 1, "{", "}");
    const m = /^([A-Za-z_]\w*|\d+|[@*#?$!-])([\s\S]*)$/.exec(s.slice(i + 2, close));
    return [m ? { name: m[1], op: m[2], quoted } : { sub: null, quoted }, close];
  }
  if (!quoted && next === "'") {
    let j = i + 2;
    let text = "";
    for (; j < s.length && s[j] !== "'"; j++) text += s[j] === "\\" ? s[++j] : s[j];
    return [{ text, quoted: true }, j];
  }
  if (!quoted && next === '"') return [{ text: "", quoted: true }, i];
  const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(i + 1));
  if (name) return [{ name: name[0], op: "", quoted }, i + name[0].length];
  return [{ text: "$", quoted }, i];
}

function parse(line) {
  const items = [];
  let cmd = { words: [], heredocs: [] };
  let word = null;
  let redirect = false; // the next word is a redirection target, not an argument
  let heredocNext = null; // the next word is a here-document delimiter
  let pending = []; // here-documents whose bodies start after the next newline

  const add = (part) => {
    word ??= [];
    const last = word.at(-1);
    if ("text" in part && last && "text" in last && last.quoted === part.quoted) last.text += part.text;
    else word.push(part);
  };
  const endWord = () => {
    if (word === null) return;
    if (heredocNext) {
      const doc = { ...heredocNext, delim: word.map((p) => p.text ?? "").join(""), body: "" };
      cmd.heredocs.push(doc);
      pending.push(doc);
      heredocNext = null;
    } else if (redirect) redirect = false;
    else cmd.words.push(word);
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (cmd.words.length) items.push(cmd);
    cmd = { words: [], heredocs: [] };
    redirect = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      const close = upTo(line.indexOf("'", i + 1), line);
      add({ text: line.slice(i + 1, close), quoted: true });
      i = close;
    } else if (c === '"') {
      const close = closeDouble(line, i);
      add({ text: "", quoted: true });
      for (let j = i + 1; j < close; j++) {
        if (line[j] === "\\" && /[$`"\\\n]/.test(line[j + 1] ?? "")) add({ text: line[++j], quoted: true });
        else if (line[j] === "$") {
          const [part, last] = dollar(line, j, true);
          add(part);
          j = last;
        } else if (line[j] === "`") {
          const k = Math.min(upTo(line.indexOf("`", j + 1), line), close);
          add({ sub: line.slice(j + 1, k), quoted: true });
          j = k;
        } else add({ text: line[j], quoted: true });
      }
      i = close;
    } else if (c === "\\") {
      if (line[i + 1] === "\n") i++;
      else if (i + 1 < line.length) add({ text: line[++i], quoted: true });
    } else if (c === "$") {
      const [part, last] = dollar(line, i, false);
      add(part);
      i = last;
    } else if (c === "`") {
      const close = upTo(line.indexOf("`", i + 1), line);
      add({ sub: line.slice(i + 1, close), quoted: false });
      i = close;
    } else if (c === "#" && word === null) {
      i = upTo(line.indexOf("\n", i), line) - 1;
    } else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      endWord();
      i++;
      const strip = line[i + 1] === "-";
      if (strip) i++;
      heredocNext = { strip };
    } else if (c === ">" || c === "<" || (c === "&" && line[i + 1] === ">")) {
      // 2>&1, >>file, &>file, <<<word: drop the operator and its target.
      if (word?.length === 1 && !word[0].quoted && /^\d+$/.test(word[0].text ?? "")) word = null;
      else endWord();
      while (/[<>&|]/.test(line[i + 1] ?? "")) i++;
      redirect = true;
    } else if (c === "\n") {
      endCmd();
      let j = i + 1;
      for (const doc of pending) {
        while (j < line.length) {
          const stop = upTo(line.indexOf("\n", j), line);
          const text = line.slice(j, stop);
          j = stop + 1;
          if ((doc.strip ? text.replace(/^\t+/, "") : text) === doc.delim) break;
          doc.body += `${text}\n`;
        }
      }
      i = j - 1;
      pending = [];
    } else if (c === ";" || c === "&" || c === "|") {
      endCmd();
    } else if (c === "(" || c === ")") {
      endCmd();
      items.push(c);
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      add({ text: c, quoted: false });
    }
  }
  endCmd();
  return items;
}

// ---------------------------------------------------------------------------------------
// Expansion. A state is what the shell would know at a point in the line: the variables
// assigned so far (name to its possible values, or null when assigned something the guard
// can't work out), which of them are exported, and the working folder (null after a cd
// to somewhere unknown).

const copy = (state) => ({ ...state, vars: new Map(state.vars), exported: new Set(state.exported) });

class Unresolved extends Error {}

function lookup(name, op, state) {
  // ${D:?message}, ${D:-default} and ${D=value} are $D when D is known; other forms aren't.
  if (op && !/^:?[-=?]/.test(op)) throw new Unresolved(`\${${name}${op}}`);
  if (state.vars.has(name)) {
    const values = state.vars.get(name);
    if (values === null) throw new Unresolved(`$${name}`);
    return values;
  }
  if (name === "HOME") return [HOME];
  if (name === "PWD" && state.cwd) return [state.cwd];
  if ((name === "TMPDIR" || name.startsWith("CLAUDE_")) && process.env[name] !== undefined) return [process.env[name]];
  throw new Unresolved(`$${name}`);
}

// git commands that print which branch a repo is on and change nothing. Agents push the
// branch they're on with one of these, so the guard asks git the same thing.
const BRANCH_QUERIES = new Set(["branch --show-current", "rev-parse --abbrev-ref HEAD", "symbolic-ref --short HEAD"]);

// What git [-C dir]... <a branch query> prints, or null when the guard can't tell.
function branchQuery(args, state) {
  if (state.exported.has("GIT_DIR") || state.exported.has("GIT_WORK_TREE")) return null;
  let dir = state.cwd;
  let k = 0;
  for (; args[k] === "-C" && k + 1 < args.length; k += 2)
    dir = dir !== null || isAbsolute(args[k + 1]) ? resolve(dir ?? "/", args[k + 1]) : null;
  if (dir === null || !BRANCH_QUERIES.has(args.slice(k).join(" "))) return null;
  try {
    return runGit(dir, args.slice(k)).replace(/\n+$/, "");
  } catch {
    return null;
  }
}

// What $(inner) prints, where the guard can tell: mktemp, pwd and the branch a repo is on.
function substitute(inner, state) {
  const what = inner === null ? "$((...))" : `$(${inner.trim()})`;
  const items = inner === null ? [] : parse(inner);
  if (items.length !== 1 || typeof items[0] === "string") throw new Unresolved(what);
  const [name, ...args] = items[0].words.map((w) => {
    const values = expand(w, state);
    if (values.length !== 1) throw new Unresolved(what);
    return values[0];
  });
  if (name === "pwd" && state.cwd) return [state.cwd];
  const path = name === "mktemp" ? mktemp(args, state.cwd) : null;
  if (path) return [path];
  const branch = basename(name) === "git" ? branchQuery(args, state) : null;
  if (branch !== null) return [branch];
  throw new Unresolved(what);
}

// Where mktemp makes its file or folder: in $TMPDIR, unless given a template or a folder.
function mktemp(args, cwd) {
  let dir = null;
  let temp = false;
  const templates = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === "--tmpdir") temp = true;
    else if (a.startsWith("--tmpdir=")) dir = a.slice("--tmpdir=".length);
    else if (a.startsWith("--")) continue;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes("t")) temp = true;
      if (a.endsWith("p")) dir = args[++k] ?? null;
    } else templates.push(a);
  }
  const name = basename(templates[0] ?? "tmp.XXXXXXXXXX");
  if (dir) return isAbsolute(dir) || cwd ? resolve(cwd ?? "/", dir, name) : null;
  if (temp || !templates.length) return join(TMP, name);
  return isAbsolute(templates[0]) || cwd ? resolve(cwd ?? "/", templates[0]) : null;
}

// Every value a word could take, or throws Unresolved naming what isn't known.
function expand(word, state) {
  let values = [""];
  let split = false;
  word.forEach((part, k) => {
    let options;
    if ("text" in part) {
      const tilde = k === 0 && !part.quoted && /^~(?=\/|$)/.test(part.text);
      options = [tilde ? HOME + part.text.slice(1) : part.text];
    } else {
      options = "name" in part ? lookup(part.name, part.op, state) : substitute(part.sub, state);
      if (!part.quoted && options.some((v) => /\s/.test(v))) split = true;
    }
    values = values.flatMap((v) => options.map((o) => v + o));
    if (values.length > MAX_VALUES) throw new Unresolved(raw(word));
  });
  // An unquoted expansion with spaces in it splits into several words: judge those too.
  if (split) values = [...values, ...values.flatMap((v) => v.split(/\s+/).filter(Boolean))];
  return [...new Set(values)];
}

// The word as written, for messages and for words the guard can't expand.
const raw = (word) =>
  word.map((p) => ("text" in p ? p.text : "name" in p ? (p.op ? `\${${p.name}${p.op}}` : `$${p.name}`) : `$(${p.sub ?? "(...)"})`)).join("");

// The one value a word has, or else how it was written.
function single(word, state) {
  try {
    const values = expand(word, state);
    return values.length === 1 ? values[0] : raw(word);
  } catch (e) {
    if (e instanceof Unresolved) return raw(word);
    throw e;
  }
}

const literal = (word) => (word?.every((p) => "text" in p) ? word.map((p) => p.text).join("") : null);

// For a NAME=value word: the name, and the value as a word.
function assignment(word) {
  const first = word[0];
  if (!first || !("text" in first) || first.quoted) return null;
  const m = /^([A-Za-z_]\w*)\+?=/.exec(first.text);
  if (!m) return null;
  const rest = first.text.slice(m[0].length);
  return { name: m[1], value: [...(rest ? [{ text: rest, quoted: false }] : []), ...word.slice(1)] };
}

function assign(state, word, exported) {
  const { name, value } = assignment(word);
  let values = [""];
  try {
    if (value.length) values = expand(value, state);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    values = null;
  }
  state.vars.set(name, values);
  if (exported) state.exported.add(name);
}

// ---------------------------------------------------------------------------------------
// Checks.

const top = (p) => p === "/" || p === HOME;
const underTemp = (p) => TEMP_ROOTS.some((root) => p.startsWith(`${root}/`));
const atOrUnderTemp = (p) => TEMP_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));

function unresolvedRm(target, what) {
  decide(
    "deny",
    `can't tell what rm -r ${target} would remove, because ${what} isn't known to the guard. Write the path out literally, or assign the variable earlier in this same command (D=/full/path; rm -r "$D"), and run it again.`,
  );
}

function checkRm(words, state) {
  let recursive = false;
  let options = true;
  const targets = [];
  for (const word of words.slice(1)) {
    const text = literal(word);
    if (options && text === "--") options = false;
    else if (options && text?.startsWith("-") && text !== "-") {
      if (text === "--recursive" || (/^-[a-zA-Z]*[rR]/.test(text) && !text.startsWith("--"))) recursive = true;
    } else targets.push(word);
  }
  if (!recursive) return;
  for (const word of targets) {
    let values;
    try {
      values = expand(word, state);
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
      unresolvedRm(raw(word), e.message);
    }
    for (const value of values) {
      if (value === "") continue;
      // A glob could match anything in the folder it starts in: judge that folder.
      const prefix = value.split(/[*?[]/)[0];
      const glob = prefix !== value;
      if (!isAbsolute(prefix) && !state.cwd) unresolvedRm(raw(word), "the folder an earlier cd moved to");
      const path = resolve(state.cwd ?? "/", prefix || ".");
      if (glob ? atOrUnderTemp(prefix === "" || prefix.endsWith("/") ? path : dirname(path)) : underTemp(path)) continue;
      if (top(path) || top(dirname(path))) decide("deny", `rm -r ${raw(word)}${raw(word) === value ? "" : ` (${value})`}`);
    }
  }
}

// The one value a word has, or null when it has several or one the guard can't work out.
function one(word, state) {
  try {
    const values = expand(word, state);
    return values.length === 1 ? values[0] : null;
  } catch (e) {
    if (e instanceof Unresolved) return null;
    throw e;
  }
}

// Whether a word is sure to reach the command as exactly one argument: nothing unquoted in
// it can split into several, vanish or match files.
function oneArg(word, state) {
  const loose = word.filter((p) => !p.quoted);
  if (loose.some((p) => "text" in p && /[*?[]/.test(p.text))) return false;
  if (loose.every((p) => "text" in p)) return true;
  const value = one(word, state);
  return value !== null && /\S/.test(value) && !/[*?[]/.test(value);
}

const unknownGit = (what, fix) =>
  decide("deny", `can't tell ${what}, so it could be a force push to main or master. ${fix} and run it again.`);
const unknownPush = (what) => unknownGit(what, "Name the branch literally (git push --force origin <branch>)");

// The argument git gets from git.words[k], or null when the guard can't work it out. The
// first word that isn't sure to be one known argument is kept in git.unread: one that
// splits or vanishes moves every word after it, and an unknown one could be push, --force
// or +main. known = false accepts an unknown value whose place is all that matters.
function gitArg(git, k, known = true) {
  const word = git.words[k];
  const value = one(word, git.state);
  if (value === null && known) git.unread ??= { word: raw(word), split: false };
  else if (!oneArg(word, git.state)) git.unread ??= { word: raw(word), split: true };
  return value;
}

// git's own options that take a value: the next word, or for the long ones also after "=".
const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"];

// Config that changes what a git command runs (an alias, an included file) or where a push
// goes and whether it forces. push.default may be current or simple: both push the branch
// the repo is on, which the guard checks.
function checkConfig(option, value) {
  const [key, setting] = value === null ? [null] : value.split(/=(.*)/s);
  const runs = key === null || /^(alias\..|include\.path$|includeif\..*\.path$|remote\..*\.(push|mirror)$)/i.test(key);
  const pushDefault = /^push\.default$/i.test(key ?? "") && (option === "--config-env" || !["current", "simple"].includes(setting));
  if (runs || pushDefault)
    decide(
      "deny",
      `git ${option} ${value ?? "with a value the guard can't work out"} can change what git runs or where it pushes, so the guard can't tell whether this is a force push to main or master. Leave it out and run it again.`,
    );
}

// git [options] <command> [args], read the way git reads it: its own options as
// { name, value } (value null when the guard can't work it out), and the command and its
// index (command null when there's none, or when git.unread stopped the reading before
// it). env is what git runs with.
function gitCommand(words, state, env) {
  const config = [...env.exported].find((name) => name.startsWith("GIT_CONFIG"));
  if (config)
    decide("deny", `${config} in git's environment can change what git runs or where it pushes, so the guard can't tell whether this is a force push to main or master. Leave it out and run it again.`);
  const git = { words, state, options: [], command: null, at: words.length, unread: null };
  const stop = (at, command = null) => Object.assign(git, { at, command });
  for (let k = 1; k < words.length; k++) {
    const arg = gitArg(git, k);
    if (git.unread) return stop(k);
    if (!arg.startsWith("-")) return stop(k, arg);
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!GIT_VALUES.includes(name)) continue;
    if (eq === -1 && ++k === words.length) break;
    const value = eq === -1 ? gitArg(git, k, false) : arg.slice(eq + 1);
    if (git.unread) return stop(k);
    if (name === "-c" || name === "--config-env") checkConfig(name, value);
    git.options.push({ name, value });
  }
  return git;
}

// What git prints for args in the repo at dir, asked within the time the guard has left
// before its deadline. Throws, saying why, when git fails or doesn't answer in time.
function runGit(dir, args) {
  const left = DEADLINE - GIT_MARGIN_MS - now();
  if (left <= 0) throw new Error("the guard ran out of time before asking git");
  const timeout = Math.ceil(Math.min(GIT_TIMEOUT_MS, left));
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    const within = `${+(timeout / 1000).toFixed(1)} s${timeout < GIT_TIMEOUT_MS ? ", the time the guard had left" : ""}`;
    const why = e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`);
    throw new Error(e.code === "ETIMEDOUT" ? `git didn't say within ${within}` : `git couldn't say: ${why}`);
  }
}

// Which branch the repo at dir is on. Any failure refuses the call: an answer read as
// "not main" would let a force push to main through.
function currentBranch(dir) {
  try {
    return runGit(dir, ["branch", "--show-current"]).trim();
  } catch (e) {
    unknownPush(`which branch ${dir} is on (${e.message})`);
  }
}

// The folder git works in, or null when the guard can't pin it down: after a cd it
// couldn't follow, with a -C it can't work out, or with the repo named some other way.
function gitFolder(options, state, env) {
  if (env.exported.has("GIT_DIR") || env.exported.has("GIT_WORK_TREE")) return null;
  let dir = state.cwd;
  for (const { name, value } of options) {
    if (name === "--git-dir" || name === "--work-tree") return null;
    if (name !== "-C") continue;
    if (value === null || (dir === null && !isAbsolute(value))) return null;
    dir = resolve(dir ?? "/", value);
  }
  return dir;
}

// git push's long options that take a value (the next word, or after "="), that force, and
// that push every branch. git takes any prefix of one that names only it.
const PUSH_VALUES = ["repo", "receive-pack", "exec", "recurse-submodules", "push-option"];
const PUSH_FORCE = ["force", "force-with-lease", "force-if-includes", "mirror", "delete"];
const PUSH_EVERY = ["all", "branches", "mirror"];
const prefixOf = (name) => (option) => option.startsWith(name);

// git push [options] [remote [refspec...]], with options anywhere until "--". Deleting a
// branch counts as forcing it, and so does --mirror. A push with a word the guard can't
// read is refused when it forces and asked about when it doesn't, since the word itself
// could force it.
function checkGitPush(git, env) {
  const { words, state } = git;
  let forced = false;
  let every = false;
  let ended = false;
  const operands = [];
  for (let k = git.at + 1; k < words.length; k++) {
    // A word the guard can't read is judged as written, so "+$B" still forces.
    const arg = gitArg(git, k) ?? raw(words[k]);
    if (ended || arg === "-" || !arg.startsWith("-")) operands.push(arg);
    else if (arg === "--") ended = true;
    else if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      if (name.startsWith("no-")) continue;
      forced ||= name.startsWith("force") || PUSH_FORCE.some(prefixOf(name));
      every ||= PUSH_EVERY.some(prefixOf(name));
      if (!arg.includes("=") && PUSH_VALUES.some(prefixOf(name)) && ++k < words.length) gitArg(git, k, false);
    } else {
      // -fu, -d, -o value or -ovalue: what follows o in a cluster is its value.
      const o = arg.indexOf("o");
      forced ||= /[fd]/.test(o === -1 ? arg : arg.slice(0, o));
      if (o === arg.length - 1 && ++k < words.length) gitArg(git, k, false);
    }
  }
  const refspecs = operands.slice(1).map((r) => r.replace(/^\+/, ""));
  forced ||= operands.some((r) => r.startsWith("+")) || refspecs.some((r) => r.startsWith(":"));
  if (git.unread) {
    const { word, split } = git.unread;
    if (!forced)
      decide("ask", `${git.command ? "git push" : "git"} with ${word}, which the guard can't read, so it could be a force push to main or master`);
    if (split) unknownGit(`what git gets from ${word}, which could split into several words, vanish or match files`, `Quote it ("${word}")`);
    unknownGit(`what git does with ${word}`, "Write it out literally");
  }
  if (!forced) return;
  if (every || refspecs.includes(":")) decide("ask", "force push of every branch, main included");

  // Where each refspec lands. Without one, or with HEAD, that's the branch the repo is on.
  const targets = refspecs.map((r) => r.split(":").at(-1));
  if (!targets.length || targets.some((t) => t === "HEAD" || t === "@")) {
    const dir = gitFolder(git.options, state, env);
    if (dir === null) unknownPush("which repo this force push runs in");
    targets.push(currentBranch(dir));
  }
  // git finds a short name like heads/main under refs/ on the remote.
  const protectedBranch = targets.find((t) => /(^|\/)(main|master)$/.test(t) || t.includes("*"));
  if (protectedBranch) decide("ask", `force push to ${protectedBranch}`);
}

function checkGit(words, strings, state, env) {
  if (basename(strings[0]) !== "git") return;
  const git = gitCommand(words, state, env);
  // A word the guard can't read before the command could be the push itself.
  if (git.command === "push" || git.unread) checkGitPush(git, env);
}

function checkSimple(cmd, state) {
  let words = cmd.words;
  // Substitutions run first, each in a subshell.
  for (const word of words) for (const part of word) if (part.sub) checkLine(part.sub, copy(state));

  while (words.length && RESERVED.has(literal(words[0]))) {
    const reserved = literal(words[0]);
    words = words.slice(1);
    // The time keyword takes its own -p, and a -- after it, before the command it times.
    if (reserved === "time") while (words.length && ["-p", "--"].includes(literal(words[0]))) words = words.slice(1);
  }
  if (!words.length) return;
  const keyword = literal(words[0]);
  if (keyword === "for" || keyword === "select") {
    const name = literal(words[1]);
    if (!name) return;
    try {
      if (literal(words[2]) !== "in") throw new Unresolved(name);
      state.vars.set(name, [...new Set(words.slice(3).flatMap((w) => expand(w, state)))]);
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
      state.vars.set(name, null);
    }
    return;
  }
  if (keyword === "case") return;

  // NAME=value on its own sets a variable for the rest of the line. Before a command it
  // only reaches that command's environment, after its arguments are expanded.
  let lead = 0;
  while (lead < words.length && assignment(words[lead])) lead++;
  if (lead === words.length) {
    for (const word of words) assign(state, word, false);
    return;
  }
  const child = copy(state);
  for (const word of words.slice(0, lead)) assign(child, word, true);
  if (lead < words.length) checkRun(cmd, words.slice(lead), state, child);
}

// A wrapper (sudo, env, nice...) runs the command after its options. An option can take
// the next word as its value (nice -n 5 rm, env -u NAME rm), so the first word after the
// options is judged both as the command and as a value, with the command after it. When an
// option could change the working folder (env -C, sudo -D) it isn't known. env -S splits
// its value into the command.
function checkRun(cmd, words, state, child) {
  const wrapper = literal(words[0]);
  if (!WRAPPERS.has(wrapper)) return checkCommand(cmd, words, state, child);
  let k = 1;
  let chdir = false;
  for (; k < words.length && (literal(words[k])?.startsWith("-") || (wrapper === "env" && assignment(words[k]))); k++) {
    if (assignment(words[k])) assign(child, words[k], true);
    const option = literal(words[k]) ?? "";
    chdir ||= /^(-[^-]*[CD]|--chdir)/.test(option);
    const split = wrapper === "env" && /^(-[^-]*S|--split-string(=|$))(.*)/s.exec(option);
    if (split) checkLine([split[3], ...words.slice(k + 1).map((w) => single(w, state))].join(" "), copy(child));
  }
  if (k === words.length) return;
  const moved = (s) => ({ ...copy(s), cwd: chdir ? null : s.cwd });
  if (literal(words[k - 1])?.startsWith("-") && !WRAPPERS.has(literal(words[k])))
    checkRun(cmd, [words[0], ...words.slice(k + 1)], moved(state), moved(child));
  checkRun(cmd, words.slice(k), chdir ? moved(state) : state, chdir ? moved(child) : child);
}

// A command's own checks, from its name on. child is what it runs with.
function checkCommand(cmd, words, state, child) {
  const strings = words.map((w) => single(w, state));
  const name = basename(strings[0]);
  const args = words.slice(1);

  if (DECLARE.has(name)) {
    const exported = name === "export" || strings.slice(1).some((s) => /^-\w*x/.test(s));
    for (const word of args) {
      if (assignment(word)) assign(state, word, exported);
      else if (exported && /^[A-Za-z_]\w*$/.test(literal(word) ?? "")) state.exported.add(literal(word));
    }
    return;
  }
  if (name === "unset") {
    for (const s of strings.slice(1)) if (!s.startsWith("-")) state.vars.set(s, [""]);
    return;
  }
  if (name === "read") {
    for (const s of strings.slice(1)) if (/^[A-Za-z_]\w*$/.test(s)) state.vars.set(s, null);
    return;
  }
  if (name === "cd" || name === "pushd") {
    const dirs = args.filter((w) => !/^-[LPe@]+$/.test(literal(w) ?? ""));
    let to = null;
    if (!dirs.length) to = HOME;
    else if (literal(dirs[0]) !== "-") {
      try {
        const values = expand(dirs[0], state);
        if (values.length === 1) to = values[0];
      } catch (e) {
        if (!(e instanceof Unresolved)) throw e;
      }
    }
    state.cwd = to !== null && (isAbsolute(to) || state.cwd) ? resolve(state.cwd ?? "/", to) : null;
    return;
  }
  if (name === "popd") {
    state.cwd = null;
    return;
  }

  if (name === "rm") checkRm(words, state);
  checkGit(words, strings, state, child);
  const [, sub, sub2] = strings;
  if (name === "gh" && sub === "repo" && sub2 === "delete") decide("ask", "deleting a GitHub repo");
  if (name === "gh" && sub === "api" && strings.some((w) => /^(-X|--method)=?DELETE$/i.test(w) || w === "DELETE") && strings.some((w) => /^\/?repos\/[^/]+\/[^/]+\/?$/.test(w)))
    decide("ask", "deleting a GitHub repo");
  if (name === "diskutil" && /^(erase|zero|randomDisk|secureErase|partitionDisk)/i.test(sub ?? "")) decide("ask", `diskutil ${sub}`);
  if (name === "dd" && strings.some((w) => /^of=\/dev\//.test(w))) decide("ask", "dd to a device");

  // A command handed to another shell runs there: check it too, with what that shell inherits.
  if (SHELLS.has(name)) {
    const inherited = { ...child, vars: new Map([...child.vars].filter(([k]) => child.exported.has(k))) };
    const c = strings.findIndex((s, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(s));
    if (c !== -1 && words[c + 1]) checkLine(strings[c + 1], inherited);
    else for (const doc of cmd.heredocs) checkLine(doc.body, inherited);
  }
  if (name === "eval") checkLine(strings.slice(1).join(" "), copy(state));
}

function checkLine(line, state) {
  // Past this depth the guard can no longer see what runs, so it refuses rather than let it through.
  if (state.depth >= MAX_DEPTH) decide("deny", "the command nests eval, sh -c or $( ) too deeply for the guard to check. Write it out flat.");
  state = { ...state, depth: state.depth + 1 };
  const outer = [];
  for (const item of parse(line)) {
    if (item === "(") {
      outer.push(state);
      state = copy(state);
    } else if (item === ")") {
      if (outer.length) state = outer.pop();
    } else checkSimple(item, state);
  }
}

// Hard refusals, read off the raw command text before any parsing, so they also catch text
// inside here-documents, quotes and command substitutions (2026-11-16: an unquoted
// here-document's backticks ran `rm -rf ~` and wiped most of the home folder). These are
// "deny", never "ask": a skipped-permissions or auto-accepting session can't approve them.
const HOME_RE = HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROOTISH = String.raw`(?:~|\$\{?HOME\}?|${HOME_RE}|/Users|/System|/Library|/Applications|/Volumes(?:/[^\s/'"\`;|&)]+)?|/private|/opt|/nix|/usr|/etc|/var)`;
const CHILD = String.raw`(?:/+[^\s/'"\`;|&)]*)?`; // the root itself, or one level under it (~/me, ~/Library)
const END = String.raw`/*\*?["']?(?=$|[\s;|&)\`"'])`;
const RM_FLAGS = String.raw`\brm\b(?:\s+-[a-zA-Z-]*)*\s+-[a-zA-Z]*[rRf][a-zA-Z]*(?:\s+-[a-zA-Z-]*)*`;
const RM_HARD = new RegExp(String.raw`${RM_FLAGS}[^\n;|&]*?(?:^|\s)["']?(?:/|${ROOTISH}${CHILD})${END}`);
const FIND_DELETE = new RegExp(String.raw`\bfind\s+["']?(?:/|${ROOTISH}${CHILD})${END}[^\n;|&]*-delete\b`);
function hardRefusals(command) {
  if (RM_HARD.test(command))
    decide("deny", "rm -r or rm -f on /, a system folder, my home folder or a folder directly in it is never run by an agent, in any form (also inside quotes, here-documents or backticks). Name the exact path inside a project or temp folder instead.");
  if (FIND_DELETE.test(command)) decide("deny", "find -delete from /, my home folder or a folder directly in it is never run by an agent");
  // An unquoted here-document expands `...` and $(...) in its body: refuse any body that holds them.
  const re = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/g;
  for (const m of command.matchAll(re))
    if (!m[1] && /`|\$\(/.test(m[3]))
      decide("deny", `this here-document (<<${m[2]}) is unquoted and its body holds backticks or $( ), which the shell would run. Quote the delimiter (<<'${m[2]}') or write the text to a file with the Write tool and pass the file.`);
}

function checkBash(command, cwd) {
  if (POOL_KEY.test(command)) decide("deny", "the claude-pool key is never read or copied");
  hardRefusals(command);
  checkLine(command, { vars: new Map(), exported: new Set(), cwd, depth: 0 });
}

// The hook's payload in, a Verdict (or null to stay out of it) back. Throws on a payload
// it can't read.
function judge(payload) {
  const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = payload;
  if (typeof tool !== "string") throw new TypeError("the payload names no tool");
  try {
    if (tool === "Bash") {
      if (typeof args?.command !== "string") throw new TypeError("the Bash call has no command");
      checkBash(args.command, cwd);
    } else if (["Read", "Edit", "Write"].includes(tool) && POOL_KEY.test(args.file_path ?? ""))
      decide("deny", "the claude-pool key is never read or copied");
    else if (OUTWARD[tool]) decide("ask", OUTWARD[tool]);
  } catch (e) {
    if (e instanceof Verdict) return e;
    throw e;
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Running. A Bash call fails closed: when the guard can't finish its checks (a payload it
// can't read, a throw, git not answering, its deadline passing) it refuses the call. Every
// other tool fails open, as Claude Code does for a hook that fails, so a broken guard never
// blocks the Edit that would fix it. settings.json's Bash entry passes --fail-closed, so a
// payload too broken to name its tool is refused there, and says onFailure "block", for a
// guard that can't even start. The guard keeps its own deadline, under the hook's timeout,
// since a Claude Code that predates onFailure ignores it.

let closed = process.argv.includes("--fail-closed");

function answer(verdict) {
  if (verdict) {
    const reason = `guard: ${verdict.reason}`;
    const output = { hookEventName: "PreToolUse", permissionDecision: verdict.decision, permissionDecisionReason: reason };
    try {
      writeSync(1, JSON.stringify({ hookSpecificOutput: output }));
    } catch {
      // Exit status 2 blocks the call whatever the hook's settings say.
      try {
        writeSync(2, reason);
      } finally {
        process.exit(2);
      }
    }
  }
  process.exit(0);
}

const refuse = (why) =>
  answer({
    decision: "deny",
    reason: `${why}, so this call is refused rather than let through unchecked. Run it again; if this keeps happening, ~/.dotfiles/home/.claude/hooks/guard.mjs needs fixing.`,
  });
const late = () => refuse(`didn't finish within ${DEADLINE / 1000} s`);

// Failing open is failing the way main did: a stack on stderr and exit status 1.
function fail(e) {
  if (!closed) {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exit(1);
  }
  if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") late();
  refuse(`failed (${e?.message ?? e})`);
}

async function main() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  const payload = JSON.parse(text);
  if (typeof payload?.tool_name === "string") closed = payload.tool_name === "Bash";
  if (!closed) return answer(judge(payload));
  // The checks run synchronously, where no timer can stop them; a vm timeout can.
  globalThis.guardJudge = () => judge(payload);
  answer(vm.runInThisContext("guardJudge()", { timeout: Math.max(1, Math.floor(DEADLINE - now())) }));
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
// A Bash payload still not read by the deadline is refused; any other waits for the hook timeout.
setTimeout(() => closed && late(), DEADLINE - now());
main().catch(fail);
