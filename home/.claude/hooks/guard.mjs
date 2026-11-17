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
//     named, from main, --prune, git send-pack and gh api; git's arguments are read the way
//     git reads them, and the branch a repo is on, as in "$(git branch --show-current)", is
//     asked of git, until an earlier command in the line could have switched it; so are
//     the config that decides where a push with no refspec goes, and aliases. A force push
//     whose repo or branch the guard can't work out is refused, like an rm -r target below,
//     and so is any config given to git, in its environment or written with git config,
//     that could run a program or move a push; a push that doesn't force but holds a word
//     the guard can't read is asked about, since that word could force it)
//   - deleting a GitHub repo
//   - rm -r on /, my home folder, or a folder directly in either (~/Documents, /Users)
//   - erasing a disk (diskutil erase*, dd to a device)
//   - running code the guard can't read: eval or sh -c of a string it can't work out, or a
//     command word that could be any command
//
// A command a wrapper, a shell, find -exec or git runs for you (sudo, watch, sh -c, rebase
// -x...) gets the same checks. A question never ends the checks: a refusal anywhere in the
// line wins over it. Reading the claude-pool key is refused outright, in any spelling (see
// ~/.claude/CLAUDE.md).
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
// no one to ask (claude -p) is refused instead. Monitor's command is checked like Bash's.
// When the guard itself breaks, a Bash or Monitor call is refused and every other tool goes
// on (see Running, at the end). Tests: node --test (guard.test.mjs).
import { execFileSync } from "node:child_process";
import { realpathSync, writeSync } from "node:fs";
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
const POOL_KEY = /claude-pool\/+age-identity/i; // APFS ignores case
const POOL_KEY_PATH = join(HOME, ".config", "claude-pool", "age-identity");
const TMP = process.env.TMPDIR ? resolve(process.env.TMPDIR) : "/tmp";
const TEMP_ROOTS = [...new Set(["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", TMP])];
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_TOOLS = new Set(["Bash", "Monitor"]); // the tools that run a shell command
const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "done", "fi", "esac", "time"]);
// Commands that run the command after them, with how many words each takes before it
// (timeout's duration, script's file, flock's lock, taskset's mask). noglob, nocorrect and
// - are zsh's precommand words.
const WRAPPERS = new Map(
  Object.entries({
    ...{ command: 0, builtin: 0, exec: 0, nohup: 0, time: 0, sudo: 0, doas: 0, env: 0, nice: 0, timeout: 1, gtimeout: 1, caffeinate: 0, stdbuf: 0 },
    ...{ xargs: 0, arch: 0, xcrun: 0, script: 1, noglob: 0, nocorrect: 0, "-": 0, coproc: 0, watch: 0, flock: 1, ionice: 0, taskset: 1 },
    ...{ chronic: 0, unbuffer: 0, parallel: 0 },
  }),
);
// The wrappers that are part of the shell itself, so the command they run runs in it.
const SHELL_WRAPPERS = new Set(["command", "builtin", "exec", "noglob", "nocorrect", "-", "time"]);
const DECLARE = new Set(["export", "declare", "local", "readonly", "typeset"]);
// The name a program is run by. APFS ignores case, so RM and Git run rm and git; the shell's
// own builtins and keywords do mind case, and are matched as written.
const commandName = (path) => basename(path).toLowerCase();
const MAX_VALUES = 64;
const MAX_DEPTH = 8;
const now = () => performance.now(); // ms since the process started
const DEADLINE = 7_000; // on that clock; the hook's timeout in settings.json is 10 s
const GIT_TIMEOUT_MS = 3_000; // at most, per git call
const GIT_MARGIN_MS = 500; // every git call ends this long before the deadline

// A refusal ends the checks: deny() throws it up to judge(). A question doesn't: ask() keeps
// the first one and the checks go on, since a refusal later in the line outranks it.
class Verdict {
  constructor(decision, reason) {
    this.decision = decision;
    this.reason = reason;
  }
}

function deny(reason) {
  throw new Verdict("deny", reason);
}

let asked = null;
function ask(reason) {
  asked ??= new Verdict("ask", reason);
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

// The commands substituted anywhere in text, however deep: what an arithmetic expansion or
// a ${X:-...} operator runs.
function commandsIn(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") {
      const close = upTo(text.indexOf("`", i + 1), text);
      found.push(text.slice(i + 1, close));
      i = close;
    } else if (text[i] === "$") {
      const [part, last] = dollar(text, i, true);
      if (part.sub) found.push(part.sub);
      found.push(...(part.nested ?? []));
      i = last;
    }
  }
  return found;
}

// zsh's (e) parameter flag, as in ${(e)X}, anywhere in text: it runs the substitutions in
// the value. Returns what to name in a question, or undefined.
const evalFlag = (text) => /\$\{\([^)]*e[^)]*\)[^}]*\}?/.exec(text)?.[0];

// Reads the expansion at the "$" at i: returns [part, index of its last character]. A part
// can carry nested: the commands its operator or arithmetic runs; and runs: code it runs
// that the guard can't read.
function dollar(s, i, quoted) {
  const next = s[i + 1];
  if (next === "(") {
    const close = closeBracket(s, i + 1, "(", ")");
    if (s[i + 2] === "(") return [{ sub: null, nested: commandsIn(s.slice(i + 3, close)), quoted, runs: evalFlag(s.slice(i + 3, close)) }, close];
    return [{ sub: s.slice(i + 2, close), quoted }, close];
  }
  if (next === "{") {
    const close = closeBracket(s, i + 1, "{", "}");
    const body = s.slice(i + 2, close);
    const m = /^([A-Za-z_]\w*|\d+|[@*#?$!-])([\s\S]*)$/.exec(body);
    const nested = commandsIn(m ? m[2] : body);
    const runs = evalFlag(`\${${body}}`);
    return [m ? { name: m[1], op: m[2], quoted, nested, runs } : { sub: null, nested, quoted, runs }, close];
  }
  if (!quoted && next === "'") {
    let j = i + 2;
    for (; j < s.length && s[j] !== "'"; j++) if (s[j] === "\\") j++;
    return [{ text: ansiC(s.slice(i + 2, j)), quoted: true }, j];
  }
  if (!quoted && next === '"') return [{ text: "", quoted: true }, i];
  // zsh's $=NAME splits the value into words, $~NAME globs it, $^NAME and $+NAME change it too.
  const flagged = /^[=~^+]+(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(i + 1));
  if (flagged) return [{ name: flagged[0], op: "", quoted }, i + flagged[0].length];
  const name = /^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(i + 1));
  if (name) return [{ name: name[0], op: "", quoted }, i + name[0].length];
  return [{ text: "$", quoted }, i];
}

// The text of $'body' as bash and zsh decode it: \n, \t and the like, octal \NNN, \xHH,
// \uHHHH, \UHHHHHHHH and \cX. An unknown escape keeps its backslash, and a NUL ends the text.
const ESCAPES = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
function ansiC(body) {
  const text = body.replace(/\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|c([\s\S])|([\s\S])?)/g, (all, oct, hex, u, U, ctrl, other) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8) & 0xff);
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    const point = parseInt(u ?? U, 16);
    if (u || U) return point <= 0x10ffff ? String.fromCodePoint(point) : all;
    if (ctrl) return ctrl === "?" ? "\x7f" : String.fromCharCode(ctrl.toUpperCase().charCodeAt(0) & 0x1f);
    return ESCAPES[other] ?? all;
  });
  return text.split("\0")[0];
}

// A simple command also keeps its redirection targets (redirects), those it writes to
// (writes) and its here-strings, and notes whether a pipe or a process substitution feeds
// it (streamed).
const command = () => ({ words: [], heredocs: [], redirects: [], writes: [], herestrings: [], streamed: false });

function parse(line) {
  const items = [];
  let cmd = command();
  let word = null;
  let redirect = null; // the operator whose target the next word is, not an argument
  let heredocNext = null; // the next word is a here-document delimiter
  let pending = []; // here-documents whose bodies start after the next newline
  let streamNext = false; // the next command reads a process substitution's stream

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
    } else if (redirect) {
      cmd.redirects.push(word);
      if (redirect === "<<<") cmd.herestrings.push(word);
      else if (redirect.includes(">")) cmd.writes.push(word);
      redirect = null;
    } else cmd.words.push(word);
    word = null;
  };
  // A pipe feeds the command after it, through a subshell or a { group.
  const endCmd = (piped = false) => {
    endWord();
    const empty = !cmd.words.length && !cmd.redirects.length;
    if (!empty) items.push(cmd);
    piped ||= empty && cmd.streamed;
    cmd = command();
    cmd.streamed = piped;
    redirect = null;
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
      // 2>&1, >>file, &>file, <<<word: the operator and its target are no argument.
      if (word?.length === 1 && !word[0].quoted && /^\d+$/.test(word[0].text ?? "")) word = null;
      else endWord();
      let op = c;
      while (/[<>&|]/.test(line[i + 1] ?? "")) op += line[++i];
      // <(...) and >(...) run a command whose output or input is a stream: what's inside is a subshell.
      if (line[i + 1] === "(" && /^[<>]$/.test(op)) {
        cmd.streamed = true;
        streamNext = true;
      } else redirect = op;
    } else if (c === "(" && word !== null && !/^=?$|=$/.test(literal(word) ?? "x") && line[i + 1] !== ")") {
      // A group glued to a word is part of it: a zsh glob alternation, or qualifiers when it
      // ends the word and holds no unquoted | or ( (or starts with #q). Their e:...: and
      // +name run code.
      const close = closeBracket(line, i, "(", ")");
      const inner = line.slice(i + 1, close);
      const bare = inner.replace(/\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"/g, "");
      const qualifiers = (/^$|[\s;&|<>)]/.test(line[close + 1] ?? "") && !/[|(]/.test(bare)) || inner.startsWith("#q");
      const runs = qualifiers && /e[^\w\s]|\+/.test(inner) ? `the glob qualifier (${inner})` : undefined;
      word.push({ text: `(${inner})`, quoted: false, nested: commandsIn(inner), runs });
      i = close;
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
    } else if (c === "|" && line[i + 1] === "|") {
      i++;
      endCmd();
    } else if (c === "|") {
      if (line[i + 1] === "&") i++;
      endCmd(true);
    } else if (c === ";" || c === "&") {
      endCmd();
    } else if (c === "(" || c === ")") {
      // zsh's =(...) is a process substitution too.
      const stream = c === "(" && (streamNext || literal(word ?? []) === "=");
      if (literal(word ?? []) === "=") word = null;
      if (stream) cmd.streamed = true;
      endCmd(stream);
      streamNext = false;
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
const branches = new Map(); // what each query printed, by folder and query

// git answers for the repo as it is before the line runs. After a command that could have
// switched a branch (anything but a few read-only ones), that answer is out of date, and
// the line's branch is unknown (stale). Unless it was one of git's own commands that only
// switch, git's config and refs are unknown too (changed). A loop runs its body again after
// its last command, so a line with one is checked a second time from the start when that
// happened after an answer.
function staleAfter(state, branchOnly = false) {
  state.repo.staleAfterRead ||= state.repo.read;
  state.repo.stale = true;
  state.repo.changed ||= !branchOnly;
}

// What git [-C dir]... <a branch query> prints, or null when the guard can't tell.
function branchQuery(args, state) {
  if (state.repo.stale || otherRepo(state)) return null;
  state.repo.read = true;
  let dir = state.cwd;
  let k = 0;
  for (; args[k] === "-C" && k + 1 < args.length; k += 2)
    dir = dir !== null || isAbsolute(args[k + 1]) ? resolve(dir ?? "/", args[k + 1]) : null;
  const query = args.slice(k);
  if (dir === null || !BRANCH_QUERIES.has(query.join(" "))) return null;
  const key = `${dir}\0${query.join(" ")}`;
  if (!branches.has(key)) {
    try {
      branches.set(key, runGit(dir, query).replace(/\n+$/, ""));
    } catch {
      branches.set(key, null);
    }
  }
  return branches.get(key);
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
  const branch = commandName(name) === "git" ? branchQuery(args, state) : null;
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

// Brace expansion comes before every other expansion, so only unquoted text written in the
// command can make it. That text's {, "," and } (and a ~ that starts a word or follows
// either) are marked with these, so that a value with a comma in it never splits.
const MARKS = "{,}~";
const [OPEN, COMMA, CLOSE, TILDE] = [...MARKS].map((_, n) => String.fromCharCode(0xe000 + n));
const MARK = new RegExp(`[${OPEN}-${TILDE}]`, "g");
const marked = (text, start) =>
  text.replace(start ? /(^|[{,])~/g : /([{,])~/g, `$1${TILDE}`).replaceAll("{", OPEN).replaceAll(",", COMMA).replaceAll("}", CLOSE);
const unmarked = (s) => s.replace(new RegExp(`^${TILDE}(?=/|$)`), HOME).replace(MARK, (c) => MARKS[c.charCodeAt(0) - 0xe000]);

// {a,b} and {1..3} at their marks, as bash and zsh expand them.
function braceExpand(s) {
  for (let i = s.indexOf(OPEN); i !== -1; i = s.indexOf(OPEN, i + 1)) {
    let depth = 0;
    const cuts = [i];
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === OPEN) depth++;
      else if (s[j] === CLOSE && --depth === 0) break;
      else if (s[j] === COMMA && depth === 1) cuts.push(j);
    }
    if (j === s.length) continue;
    cuts.push(j);
    const alternatives = cuts.length > 2 ? cuts.slice(0, -1).map((c, n) => s.slice(c + 1, cuts[n + 1])) : sequence(s.slice(i + 1, j));
    if (!alternatives) continue;
    const out = [];
    for (const a of alternatives) {
      out.push(...braceExpand(s.slice(0, i) + a + s.slice(j + 1)));
      if (out.length > MAX_VALUES) throw new Unresolved("a brace expansion");
    }
    return out;
  }
  return [s];
}

function sequence(body) {
  const m = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(body);
  const letters = m && /[a-zA-Z]/.test(m[1]);
  if (!m || letters !== /[a-zA-Z]/.test(m[2])) return null;
  const [a, b] = letters ? [m[1].charCodeAt(0), m[2].charCodeAt(0)] : [Number(m[1]), Number(m[2])];
  const step = Math.abs(Number(m[3] ?? 1)) || 1;
  if (Math.abs(b - a) / step >= MAX_VALUES) throw new Unresolved("a brace expansion");
  const out = [];
  for (let n = a; a <= b ? n <= b : n >= b; n += a <= b ? step : -step) out.push(letters ? String.fromCharCode(n) : String(n));
  return out;
}

// Whether brace expansion makes several words of this one.
function braced(word) {
  const template = word.map((p) => ("text" in p && !p.quoted ? marked(p.text, false) : "x")).join("");
  try {
    return braceExpand(template).length > 1;
  } catch (e) {
    if (e instanceof Unresolved) return true;
    throw e;
  }
}

// Every value a word could take, or throws Unresolved naming what isn't known.
function expand(word, state) {
  let values = [""];
  let split = false;
  word.forEach((part, k) => {
    let options;
    if ("text" in part) options = [part.quoted ? part.text : marked(part.text, k === 0)];
    else {
      options = "name" in part ? lookup(part.name, part.op, state) : substitute(part.sub, state);
      if (!part.quoted && options.some((v) => /\s/.test(v))) split = true;
    }
    values = values.flatMap((v) => options.map((o) => v + o));
    if (values.length > MAX_VALUES) throw new Unresolved(raw(word));
  });
  try {
    values = values.flatMap(braceExpand).map(unmarked);
  } catch (e) {
    if (e instanceof Unresolved) throw new Unresolved(raw(word));
    throw e;
  }
  if (values.length > MAX_VALUES) throw new Unresolved(raw(word));
  // An unquoted expansion with spaces in it splits into several words: judge those too.
  if (split) values = [...values, ...values.flatMap((v) => v.split(/\s+/).filter(Boolean))];
  return [...new Set(values)];
}

// The word as written, for messages and for words the guard can't expand.
const raw = (word) =>
  word
    .map((p) => ("text" in p ? p.text : p.name === FOUND ? "{}" : "name" in p ? (p.op ? `\${${p.name}${p.op}}` : `$${p.name}`) : `$(${p.sub ?? "(...)"})`))
    .join("");

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
  if (exported || state.allexport) state.exported.add(name);
}

// ---------------------------------------------------------------------------------------
// Checks.

// Paths compared the way APFS compares them, ignoring case.
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const under = (p, root) => p.toLowerCase().startsWith(`${root.toLowerCase()}/`);
const top = (p) => p === "/" || same(p, HOME);
const underTemp = (p) => TEMP_ROOTS.some((root) => under(p, root));
const atOrUnderTemp = (p) => TEMP_ROOTS.some((root) => same(p, root) || under(p, root));

// The path with every link on the way followed, as far as it exists.
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    const up = dirname(p);
    return up === p ? p : join(real(up), basename(p));
  }
}

function unresolvedRm(target, what) {
  deny(
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
  if (targets.length && state.disk.linked)
    deny(`can't tell what rm -r ${raw(targets[0])} would remove, because a link made earlier in this command could lead it anywhere. Run the rm as a command of its own.`);
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
      if (!isAbsolute(prefix) && !state.cwd) unresolvedRm(raw(word), "the folder it runs in (after a cd, env -C or the like)");
      const path = resolve(state.cwd ?? "/", prefix || ".");
      // rm follows a link in the folders on the way, and the last one too when the path ends
      // in "/" or a glob starts inside it: judge the path both as written and as followed.
      const inside = glob ? prefix === "" || prefix.endsWith("/") : value.endsWith("/");
      for (const p of new Set([path, inside ? real(path) : join(real(dirname(path)), basename(path))])) {
        if (glob ? atOrUnderTemp(inside ? p : dirname(p)) : underTemp(p)) continue;
        if (top(p) || top(dirname(p))) deny(`rm -r ${raw(word)}${raw(word) === value ? "" : ` (${value})`}${p === path ? "" : `, which leads to ${p}`}`);
      }
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

// Every value a word could take, when whichever it takes is sure to be exactly one argument;
// else null.
function choices(word, state) {
  if (braced(word) || globbed(word)) return null;
  let values;
  try {
    values = expand(word, state);
  } catch (e) {
    if (e instanceof Unresolved) return null;
    throw e;
  }
  const loose = word.some((p) => !p.quoted && !("text" in p));
  return loose && values.some((v) => !/\S/.test(v) || /\s/.test(v) || GLOB.test(v)) ? null : values;
}

// A glob: *, ?, or a [ with a ] after it ([ and [[ alone are no glob).
const GLOB = /[*?]|\[[\s\S]*\]/;
const globbed = (word) => GLOB.test(word.map((p) => (!p.quoted && "text" in p ? p.text : " ")).join(""));

// Whether a word is sure to reach the command as exactly one argument: nothing unquoted in
// it can split into several, vanish or match files.
function oneArg(word, state) {
  if (braced(word)) return false;
  const loose = word.filter((p) => !p.quoted);
  if (globbed(word)) return false;
  if (loose.every((p) => "text" in p)) return true;
  const value = one(word, state);
  return value !== null && /\S/.test(value) && !GLOB.test(value);
}

const unknownGit = (what, fix) =>
  deny(`can't tell ${what}, so it could be a force push to main or master. ${fix} and run it again.`);
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
// --shallow-file isn't in git's manual, but git reads it like the rest.
const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source", "--shallow-file"];

const redirects = (what) =>
  deny(`${what} can run a program the guard can't read or change what a push sends and where, so the guard can't tell whether this is a force push to main or master. Leave it out and run it again.`);

// Config and environment whose value is a pager or an editor, PAGER, EDITOR and VISUAL
// included, which git falls back to. git runs an editor with a file it wrote as its argument
// and feeds a pager on stdin, so a shell, source, eval, xargs or an interpreter runs that
// text as code: only programs that do nothing else pass.
const SAFE_PROGRAMS = new Set(["true", "false", ":", "cat", "less", "vi", "vim", "nano"]);
const COMMAND_KEYS = /^(core\.(pager|editor)|sequence\.editor|pager\..+)$/i;
const COMMAND_ENV = /^(GIT_(PAGER|EDITOR|SEQUENCE_EDITOR)|PAGER|EDITOR|VISUAL)$/;

// Config that makes git run a program the guard can't read (hooks, an ssh command, a
// credential helper or askpass, an fsmonitor hook, a diff or merge driver or tool, a filter,
// gpg, a template folder's hooks, the ext:: transport, a browser for help), or that brings in
// config it can't see (an include, or an alias, which checkAlias looks up in git's config and
// can't find here), or help.autocorrect, which runs the git command nearest a mistyped one.
// It's refused for every git command, push or not: the program could itself force push main
// or delete files, and the guard checks every command something runs. Matched by section and
// by the names git gives such keys, so one git adds later in that shape is refused too. The
// one outside that shape is diff.tool and merge.tool (and their gui forms): difftool and
// mergetool source the file of that name in git's mergetools folder, "../" included.
const RUNS_PROGRAM = new RegExp(
  `^(${[
    String.raw`(alias|help|include|includeif|credential|filter|gpg|hook|sendemail|difftool|mergetool|guitool|man|browser|web|instaweb)\..+`,
    String.raw`(diff|merge)\.(gui)?tool`,
    String.raw`protocol\.(?!(version|(file|git|http|https|ssh)\.allow)$).+`,
    String.raw`core\.(hookspath|askpass|gitproxy)|init\.templatedir|interactive\.difffilter|diff\.external|imap\.tunnel`,
    String.raw`submodule\..+\.update|remote\..+\.(uploadpack|receivepack|vcs)|lfs\.(customtransfer|extension)\..+`,
    String.raw`(?!advice\.|color\.).+\.[^.]*(cmd|command|program|helper|driver|textconv|clean|smudge|process|hooks?)`,
  ].join("|")})$`,
  "i",
);
// Config a push reads to choose what it sends and where: the remote and its url, refspecs
// and mirror setting, url rewrites, push settings, and the branch's upstream. push.default
// may be current or simple, which push the branch the repo is on. They're refused with every
// git command, not only a push: git passes config given on its command line to each hook and
// program it runs, and one of those (a post-commit hook that pushes) can push with it.
const PUSH_CONFIG = /^(remote\..+|url\..+|push\.(?!(autosetupremote|followtags)$).+|branch\..+\.(merge|remote|pushremote))$/i;
// http config, http.<url>.<key> included, also chooses which host git talks to over http (a
// proxy, curl's resolve list) and whether that host's certificate is checked. It's refused
// with every git command, not only a push, except for the keys that tune speed and size: a
// fetch or ls-remote sends that host the credential helper's token, which can then push
// anywhere, and a hook that pushes gets the config too. These lists aren't every way to steer
// a push: proxy variables such as https_proxy and the ssh client's own config aren't checked.
const HTTP_TRANSPORT = /^http\.(?!(.+\.)?(postbuffer|lowspeedlimit|lowspeedtime|maxrequests|version)$)/i;

// Whether git run with key=value could run a program the guard can't read or change what a
// push sends or where. value is undefined when the guard can't see it. Hooks may go to
// /dev/null, which turns them off, and fsmonitor may be on or off (true starts git's own
// daemon); a path is a hook it runs.
function risky(key, value) {
  if (/^core\.hookspath$/i.test(key)) return value !== "/dev/null";
  if (/^core\.fsmonitor$/i.test(key)) return !/^(true|false|yes|no|on|off|1|0|)$/i.test(value ?? "?");
  if (/^push\.default$/i.test(key)) return !["current", "simple"].includes(value);
  return RUNS_PROGRAM.test(key) || PUSH_CONFIG.test(key) || HTTP_TRANSPORT.test(key);
}

// Whether git's system config holds a key that steers a push, or an include, which could
// bring one in: only then does leaving that file out (GIT_CONFIG_NOSYSTEM) change where a
// push goes, made by git or by a hook or program it runs. One the guard can't read counts.
let steers;
function systemConfigSteersPush() {
  try {
    steers ??= runGit("/", ["config", "--system", "--name-only", "--list"])
      .split("\n")
      .some((key) => PUSH_CONFIG.test(key) || /^include(if)?\./i.test(key));
  } catch {
    steers = true;
  }
  return steers;
}

// git's environment from this line. Only GIT_ variables known not to run a program or choose
// a config file pass, for every command: unlike config keys, the ones that run a shell
// string have names with no telling shape (GIT_TEST_FSMONITOR is the fsmonitor hook when
// core.fsmonitor is unset, git-difftool--helper evals GIT_DIFFTOOL_EXTCMD), and the harmless
// ones an agent sets are few. They name who wrote a commit, tune output, prompts, locks and
// tracing, skip Git LFS downloads, or leave the system config file out. HOME and
// XDG_CONFIG_HOME are refused other than as they already are, since they choose git's own
// config file, which can hold an alias, a pager or hooks. Leaving the system config out is
// refused for a push, and for any command when that file steers a push. GIT_DIR,
// GIT_WORK_TREE and GIT_COMMON_DIR make the repo unknown instead, which refuses what depends
// on it.
const SAFE_GIT_ENV =
  /^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|TERMINAL_PROMPT|OPTIONAL_LOCKS|FLUSH|PROGRESS_DELAY|ADVICE|TRACE\w*|CURL_VERBOSE|REDACT_COOKIES|MERGE_VERBOSITY|(LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS|LFS_SKIP_SMUDGE|CONFIG_NOSYSTEM)$/;
const otherRepo = (env) => ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].some((name) => env.exported.has(name));

// What a command git runs (rebase -x, an alias) inherits: git's environment, and the config
// given to git, which git passes on to every git it starts.
const gitChild = (git, env) => ({ ...copy(env), gitConfig: git.config.map((c) => ({ ...c, own: false })) });

// The config and environment git runs with (push set when the command could be a push):
// config given on its command line (own), and config passed on by a git that started this
// one, whose pager or editor was checked there. A pager or editor (an unknown one counts)
// must be one of the safe few, except on a push that doesn't page, which never runs either.
// A command that may be an alias isn't a push here, whatever its name: git runs alias.push
// for PUSH where it finds no git-PUSH program, and checkAlias doesn't see the editor.
function checkGitSettings(git, env, push) {
  const programs = [];
  for (const { key, value, what, own } of git.config) {
    if (own && COMMAND_KEYS.test(key)) programs.push({ what, value });
    else if (risky(key, value)) redirects(what);
  }
  for (const name of env.exported) {
    if (!env.vars.has(name)) continue; // exported as it already was
    const values = env.vars.get(name);
    const what = `${name} in git's environment`;
    const kept = !["HOME", "XDG_CONFIG_HOME"].includes(name) || values?.every((v) => v === (name === "HOME" ? HOME : process.env.XDG_CONFIG_HOME));
    if (COMMAND_ENV.test(name)) programs.push(...(values ?? [undefined]).map((value) => ({ what, value })));
    else if ((name === "GIT_CONFIG_NOSYSTEM" && (push || systemConfigSteersPush())) || !kept) redirects(what);
    else if (name.startsWith("GIT_") && !SAFE_GIT_ENV.test(name))
      deny(`${what} isn't on the guard's list of GIT_ variables that can't run a program or change what a push sends and where, so the guard can't tell whether this is a force push to main or master. Leave it out and run it again.`);
  }
  const unsafe = programs.find(({ value }) => !SAFE_PROGRAMS.has(value));
  if (unsafe && !(PUSHES.has(git.command) && !git.alias && !pagesPush(git, env)))
    deny(`${unsafe.what} sets a pager or editor, which git runs on text it writes, and only ${[...SAFE_PROGRAMS].join(", ")} can't run that text as code. Leave it out, or use one of those, and run it again.`);
}

// Whether git pages this push, and so starts its pager before the push reads anything: when
// the last of -p, --paginate, -P and --no-pager among git's options is -p or --paginate
// (git.paginate, read the way git reads its options, so the value of --shallow-file isn't
// taken for one), or else with pager.<command> on, given to git or in its config. One the
// guard can't look up pages.
function pagesPush(git, env) {
  if (git.paginate !== null) return git.paginate;
  const key = `pager.${git.command}`;
  const given = git.config.findLast((c) => c.key.toLowerCase() === key);
  if (given) return given.value === undefined || !/^(false|no|off|0)$/i.test(given.value);
  const dir = pushRepo(git, env);
  if (dir === null) return true;
  try {
    const value = gitConfig(dir, ["--get", key]).trim();
    return value !== "" && !/^(false|no|off|0)$/i.test(value);
  } catch {
    return true;
  }
}

// git [options] <command> [args], read the way git reads it: its own options as
// { name, value } (value null when the guard can't work it out), the config it runs with
// as { key, value, what, own }, whether it was told to page (paginate: true for -p or
// --paginate, false for -P or --no-pager, the last one winning, null for neither), and the
// command and its index (command null when there's none, or when git.unread stopped the
// reading before it). env is what git runs with. git finds its own commands by their exact
// name, and an alias (alias set when the command could be one) or a git-<name> program in
// any case.
function gitCommand(words, state, env) {
  const git = { words, state, options: [], config: [...(env.gitConfig ?? [])], paginate: null, command: null, at: words.length, unread: null, alias: false };
  const stop = (at, command = null) => Object.assign(git, { at, command: command?.toLowerCase() ?? null, alias: command !== null && !GIT_BUILTINS.has(command) });
  for (let k = 1; k < words.length; k++) {
    const arg = gitArg(git, k);
    if (git.unread) return stop(k);
    if (!arg.startsWith("-")) return stop(k, arg);
    if (arg.startsWith("--exec-path=")) redirects(`git ${arg}`);
    if (arg === "-p" || arg === "--paginate") git.paginate = true;
    if (arg === "-P" || arg === "--no-pager") git.paginate = false;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!GIT_VALUES.includes(name)) continue;
    if (eq === -1 && ++k === words.length) break;
    const value = eq === -1 ? gitArg(git, k, false) : arg.slice(eq + 1);
    if (name === "-c" || name === "--config-env") {
      // git -c key[=value] (a bare key is true), and git --config-env key=VARIABLE.
      const what = `git ${name} ${value ?? "with a value the guard can't work out"}`;
      const [key, setting] = value === null ? [null] : value.split(/=(.*)/s);
      if (key === null || (name === "--config-env" && setting === undefined)) redirects(what);
      git.config.push({ key, value: name === "-c" ? (setting ?? "true") : undefined, what, own: true });
    }
    if (git.unread) return stop(k);
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
    throw Object.assign(new Error(e.code === "ETIMEDOUT" ? `git didn't say within ${within}` : `git couldn't say: ${why}`), { status: e.status });
  }
}

// What git config args prints in the repo at dir, "" when nothing is set (exit status 1).
const configs = new Map();
function gitConfig(dir, args) {
  const key = `${dir}\0${args.join("\0")}`;
  if (!configs.has(key)) {
    try {
      configs.set(key, runGit(dir, ["config", ...args]));
    } catch (e) {
      if (e.status !== 1) throw e;
      configs.set(key, "");
    }
  }
  return configs.get(key);
}

// Which branch the repo at dir is on. Any failure refuses the call: an answer read as
// "not main" would let a force push to main through.
function currentBranch(dir, state) {
  if (state.repo.stale)
    unknownGit(`which branch ${dir} is on after the commands before this push`, "Name the branch literally (git push --force origin <branch>), or run the push as a command of its own,");
  state.repo.read = true;
  try {
    return runGit(dir, ["branch", "--show-current"]).trim();
  } catch (e) {
    unknownPush(`which branch ${dir} is on (${e.message})`);
  }
}

// The folder git works in, or null when the guard can't pin it down: after a cd it
// couldn't follow, with a -C it can't work out, or with the repo named some other way.
function gitFolder(options, state, env) {
  if (otherRepo(env)) return null;
  let dir = state.cwd;
  for (const { name, value } of options) {
    if (name === "--git-dir" || name === "--work-tree") return null;
    if (name !== "-C") continue;
    if (value === null || (dir === null && !isAbsolute(value))) return null;
    dir = resolve(dir ?? "/", value);
  }
  return dir;
}

// git push's long options that take a value (the next word, or after "="), that force or
// delete, and that push every branch. git takes any prefix of one that names only it.
// --prune deletes every remote branch with no local one; with no refspec that's any branch.
const PUSHES = new Set(["push", "send-pack", "http-push"]);
const PUSH_VALUES = ["repo", "receive-pack", "exec", "recurse-submodules", "push-option"];
const PUSH_FORCE = ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune"];
const PUSH_EVERY = ["all", "branches", "mirror"];
const prefixOf = (name) => (option) => option.startsWith(name);

// git push [options] [remote [refspec...]], with options anywhere until "--". Deleting a
// branch counts as forcing it, and so does --mirror. A push with a word the guard can't
// read is refused when it forces and asked about when it doesn't, since the word itself
// could force it. git send-pack and git http-push are read the same way: with no ref named
// they push every branch both sides have, and send-pack's --stdin reads the refs from a
// place the guard can't see.
function checkGitPush(git, env) {
  const { words, state } = git;
  // A word with several known values, each sure to be one argument (for b in a b; do git
  // push origin "$b"), is judged as each of them, unless that makes too many pushes.
  const several = words.map((w, k) => (k > git.at && one(w, state) === null ? choices(w, state) : null));
  const k = several.findIndex((values) => values?.length > 1);
  if (k !== -1 && several.reduce((n, values) => n * (values?.length || 1), 1) <= MAX_VALUES) {
    for (const value of several[k]) checkGitPush({ ...git, words: words.with(k, [{ text: value, quoted: true }]) }, env);
    return;
  }
  let forced = false;
  let every = false;
  let pruned = false;
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
      if (git.command === "send-pack" && name === "stdin") git.unread ??= { word: "the refs send-pack reads from stdin", split: false };
      pruned ||= name.length > 1 && "prune".startsWith(name);
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
  every ||= !refspecs.length && (pruned || git.command !== "push");
  if (git.unread) {
    const { word, split } = git.unread;
    if (!forced)
      return ask(`${git.command ? "git push" : "git"} with ${word}, which the guard can't read, so it could be a force push to main or master`);
    if (split) unknownGit(`what git gets from ${word}, which could split into several words, vanish or match files`, `Quote it ("${word}")`);
    unknownGit(`what git does with ${word}`, "Write it out literally");
  }
  // A branch named alone (no colon) goes where git's config maps it, and so does a push with none.
  const plain = refspecs.filter((r) => !r.includes(":"));
  const config = !every && (!refspecs.length || plain.length > 0);
  if (!forced) return config ? checkPushConfig(git, env, false, plain) : undefined;
  if (every || refspecs.includes(":")) return ask("force push of every branch, main included");

  // Where each refspec lands. Without one, or with HEAD, that's the branch the repo is on;
  // a branch named alone that's a link to another (a symref) lands on that one.
  const targets = refspecs.map((r) => r.split(":").at(-1));
  const named = targets.find(protectedRef);
  if (named) return ask(`force push to ${named}`);
  if (!targets.length || targets.some((t) => t === "HEAD" || t === "@")) {
    const dir = gitFolder(git.options, state, env);
    if (dir === null) unknownPush("which repo this force push runs in");
    targets.push(currentBranch(dir, state));
  }
  for (const r of plain) if (r !== "HEAD" && r !== "@") targets.push(linkTarget(git, env, r));
  const protectedBranch = targets.find(protectedRef);
  if (protectedBranch) return ask(`force push to ${protectedBranch}`);
  if (config) checkPushConfig(git, env, true, plain);
}

// git finds a short name like heads/main under refs/ on the remote.
const protectedRef = (ref) => /(^|\/)(main|master)$/.test(ref) || ref.includes("*");

// The folder of the repo whose config and refs git reads for this push, as the guard can
// still see them: null after an earlier command in the line could have changed them, or
// when it can't tell which repo it is.
function pushRepo(git, env) {
  if (git.state.repo.changed) return null;
  const dir = gitFolder(git.options, git.state, env);
  if (dir !== null) git.state.repo.read = true;
  return dir;
}
const unseen = (git) => (git.state.repo.changed ? "after the commands before it in this line" : "since it can't tell which repo this runs in");

// The ref a branch named in a force push stands for: the branch it links to, for a symref.
// A name git can't find is pushed as written, or not at all.
function linkTarget(git, env, ref) {
  const dir = pushRepo(git, env);
  if (dir === null) unknownGit(`where ${ref} points ${unseen(git)}`, "Run the push as a command of its own, from the repo's folder or with git -C <folder>,");
  try {
    return runGit(dir, ["rev-parse", "--symbolic-full-name", "--end-of-options", ref]).trim() || ref;
  } catch (e) {
    if (e.status) return ref;
    unknownPush(`where ${ref} points (${e.message})`);
  }
}

// Where a remote's push refspec sends ref, or undefined when it doesn't name it. git looks
// it up by its full name; a short one is taken too, to be safe.
function mapped(refspec, ref) {
  const [src, dst = src] = refspec.replace(/^\+/, "").split(":");
  const [head, tail] = src.split("*");
  for (const name of [ref, `refs/${ref}`, `refs/heads/${ref}`]) {
    if (tail === undefined && name === src) return dst;
    if (tail !== undefined && name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail))
      return dst.replace("*", name.slice(head.length, name.length - tail.length));
  }
}

// git's config can send a push somewhere else and force it. With no refspec: a remote's push
// refspec or mirror setting, and push.default (only current and simple push just the branch
// the repo is on). For a branch named alone (plain): a remote's push refspec that maps it,
// or for a force push with push.default upstream, the branch it tracks. A force push whose
// config can't be read is refused, and any other asked about.
function checkPushConfig(git, env, forced, plain) {
  const unknown = (what) => (forced ? unknownPush(what) : ask(`git push, and the guard can't tell ${what}, so it could be a force push to main or master`));
  const dir = pushRepo(git, env);
  if (dir === null) return unknown(`where git's config sends it ${unseen(git)}`);
  let config;
  try {
    config = gitConfig(dir, ["--get-regexp", String.raw`^(remote\..*\.(push|mirror)|push\.default|branch\..*\.merge)$`]);
  } catch (e) {
    return unknown(`where git's config sends it (${e.message})`);
  }
  const settings = config.split("\n").filter(Boolean).map((line) => line.split(/ (.*)/s));
  const upstream = settings.some(([key, value]) => /^push\.default$/i.test(key) && value === "upstream");
  for (const [key, value = ""] of settings) {
    const forces = forced || /^[+:]/.test(value);
    if (plain.length) {
      const tracks = forced && upstream && plain.some((b) => key === `branch.${b.replace(/^(refs\/)?heads\//, "")}.merge`);
      const lands = /\.push$/i.test(key) ? plain.map((b) => mapped(value, b)).find((d) => d !== undefined) : tracks ? value : undefined;
      if (lands !== undefined && forces && protectedRef(lands)) return ask(`git push with ${key} ${value} set, which sends it to ${lands}`);
    } else if (/\.mirror$/i.test(key) && /^(true|yes|on|1)$/i.test(value)) return ask(`git push with ${key} set, which force pushes every branch, main included`);
    else if (/\.push$/i.test(key) && forces) return ask(`git push with ${key} ${value} set, which can force push to main or master`);
    else if (/^push\.default$/i.test(key) && forced && !["current", "simple"].includes(value)) return ask(`force push with push.default ${value}, which can push to main or master`);
  }
}

// git config that writes a key is judged as if every later git command were a push given it
// on the command line, so that no later command (in this line or another) is redirected by
// it or runs a program the guard can't read. A pager or editor written for later runs in
// commands the guard won't connect to it, a push that pages included, so only the few safe
// programs pass. Reading and removing are fine. git takes -t like --type, the value of -f or
// -t as the rest of a short cluster or the next word, and any unique abbreviation of a long
// option (--typ, --rename-sec, --ed), so the guard knows git config's options only by their
// full names and refuses any other: one it misread would move the words, and the value would
// be judged as the key. Every word a write is given is still judged as a key, with the word
// after it as its value, so no other misreading can hide one.
const CONFIG_VALUES = new Set(["file", "blob", "type", "default", "comment", "value", "url"]);
const CONFIG_FLAGS = new Set(
  "global system local worktree null name-only show-origin show-scope show-names bool int bool-or-int bool-or-str path expiry-date fixed-value includes all regexp append".split(" "),
);
const CONFIG_READS = new Set(["get", "get-all", "get-regexp", "get-urlmatch", "get-color", "get-colorbool", "list"]);
function checkGitConfig(git) {
  const args = git.words.slice(git.at + 1).map((w) => one(w, git.state));
  if (args.includes(null)) redirects("git config with a word the guard can't read");
  let write = false;
  let read = false;
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    // git reads "-" and a word such as -1 as an operand (a value can be negative).
    if (!/^-[^\d]/.test(a)) operands.push(a);
    else if (a === "--") operands.push(...args.splice(k + 1));
    else if (a.startsWith("--")) {
      const [name, given] = a.slice(2).split(/=(.*)/s);
      const negated = name.replace(/^no-/, ""); // --no-file and the like take no value
      if (CONFIG_VALUES.has(name)) k += given === undefined ? 1 : 0;
      else if (given !== undefined || ["edit", "rename-section"].includes(name)) redirects(`git config ${a}`);
      else if (["unset", "unset-all", "remove-section"].includes(name)) return;
      else if (["add", "replace-all"].includes(name)) write = true;
      else if (CONFIG_READS.has(name)) read = true;
      else if (!CONFIG_FLAGS.has(negated) && !CONFIG_VALUES.has(negated)) redirects(`git config ${a}, which the guard doesn't know by that name,`);
    } else
      for (let c = 1; c < a.length; c++) {
        if (a[c] === "l") read = true;
        else if (a[c] === "f" || a[c] === "t") {
          if (c === a.length - 1) k++;
          break;
        } else if (a[c] !== "z") redirects(`git config ${a}`);
      }
  }
  const sub = ["get", "list", "set", "unset", "remove-section", "rename-section", "edit"].includes(operands[0]) ? operands.shift() : null;
  if (sub === "rename-section" || sub === "edit") redirects(`git config ${sub}`);
  if (sub === null ? read || (!write && operands.length <= 1) : sub !== "set") return;
  operands.forEach((key, i) => {
    const value = operands[i + 1];
    if (COMMAND_KEYS.test(key) ? !SAFE_PROGRAMS.has(value) : risky(key, value)) redirects(`git config ${key}${value === undefined ? "" : ` ${value}`}`);
  });
}

// git's own commands. Any other is an alias, or a git-<name> program on PATH.
const GIT_BUILTINS = new Set(
  "add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout cherry cherry-pick clean clone commit config count-objects describe diff difftool fetch for-each-ref format-patch fsck gc grep help http-push init log ls-files ls-remote ls-tree merge merge-base mv notes pull push range-diff rebase reflog remote repack replace reset restore rev-list rev-parse revert rm send-pack shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-ref version worktree".split(" "),
);
const quote = (s) => `'${s.replaceAll("'", String.raw`'\''`)}'`;

// An alias is judged as what it stands for, with the words after it: a shell command when
// it starts with !, else a git command. One the guard can't look up is asked about, and so
// is a command that's no alias when help.autocorrect is on in git's config: with no
// git-<name> program, git then runs the git command nearest it, which could be a push.
function checkAlias(git, env) {
  const what = `git ${git.command}, which could be an alias the guard`;
  const dir = pushRepo(git, env);
  if (dir === null) return ask(`${what} can't look up ${unseen(git)}`);
  // help.autocorrect set with no value is on, and git config prints it as an empty line.
  let alias;
  let autocorrect = "";
  try {
    alias = gitConfig(dir, ["--get", `alias.${git.command}`]).replace(/\n$/, "");
    if (!alias) autocorrect = gitConfig(dir, ["--get", "help.autocorrect"]);
  } catch (e) {
    return ask(`${what} couldn't look up (${e.message})`);
  }
  if (!alias)
    return /^((0|false|no|off|never|show)\n)?$/i.test(autocorrect)
      ? undefined
      : ask(`git ${git.command}, which isn't an alias, with help.autocorrect on in git's config, which runs the git command nearest it, so it could be a force push to main or master`);
  const args = argvLine(git.words.slice(git.at + 1), git.state);
  const options = git.words.slice(1, git.at).map((w) => quote(single(w, git.state)));
  // A git alias is given git's options again; a shell one gets git's config from git.
  if (alias.startsWith("!")) checkLine(`${alias.slice(1)} ${args}`, gitChild(git, env));
  else checkLine(["git", ...options, alias, args].join(" "), copy(env));
}

// What git runs for you: rebase's -x or --exec, submodule foreach and bisect run. Where it
// runs (the top of the repo, each submodule) isn't known.
function checkGitRuns(git, env) {
  const args = git.words.slice(git.at + 1);
  const strings = args.map((w) => single(w, git.state));
  const inner = { ...gitChild(git, env), cwd: null };
  const what = `git ${git.command}`;
  if (git.command === "rebase")
    for (let k = 0; k < args.length && strings[k] !== "--"; k++) {
      const m = /^(?:--ex(?:ec?)?(?:=([\s\S]*))?|-[a-zA-Z]*?x([\s\S]*))$/.exec(strings[k]);
      if (!m) continue;
      const inline = m[1] ?? (m[2] || undefined);
      checkString(inline === undefined ? args[++k] : [{ text: inline, quoted: true }], `${what} --exec`, git.state, inner);
    }
  if (git.command === "submodule") {
    let k = strings.indexOf("foreach");
    if (k === -1) return;
    while (/^(--recursive|-q|--quiet)$/.test(strings[k + 1] ?? "")) k++;
    checkRuns(args.slice(k + 1), `${what} foreach`, git.state, inner);
  }
  if (git.command === "bisect" && strings[0] === "run") checkRuns(args.slice(1), `${what} run`, git.state, inner);
}

// gh api can move or delete a branch without git: a call that writes to main or master, or
// to a branch the guard can't read, asks, and so does one that deletes a repo. gh sends GET
// unless told otherwise or given fields. A path is read the way gh and GitHub read it: as
// a URL, maybe a full one, without its query or fragment, with escapes decoded.
function checkGhApi(strings) {
  let method = null;
  let fields = false;
  for (let k = 2; k < strings.length; k++) {
    const m = /^(?:-X|--method)(?:=?(.+))?$/.exec(strings[k]);
    if (m) method = m[1] ?? strings[++k] ?? "";
    fields ||= /^(-[fF]|--field|--raw-field|--input)/.test(strings[k] ?? "");
  }
  method = (method ?? (fields ? "POST" : "GET")).toUpperCase();
  if (method === "GET") return;
  const paths = strings.slice(2).map((s) => {
    try {
      return decodeURIComponent(new URL(s.replace(/^\/+/, ""), "https://api.github.com/").pathname).replace(/\/+/g, "/");
    } catch {
      return s;
    }
  });
  const ref = paths.map((p) => /\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.*)$/.exec(p)?.[1]).find((r) => r !== undefined);
  if (ref !== undefined && /^(main|master)\/?$|[$`*]/.test(ref)) ask(`changing or deleting the ${ref} branch through the GitHub API`);
  if (method === "DELETE" && paths.some((p) => /\/repos\/[^/]+\/[^/]+\/?$/.test(p))) ask("deleting a GitHub repo");
  if (strings.includes("graphql") && strings.some((s) => /\b(deleteRef|updateRefs?)\b/.test(s))) ask("changing or deleting a branch through the GitHub API");
}

// git commands that never switch the branch a repo is on, and other commands that change
// nothing git can see. git branch only lists, and git symbolic-ref only reads, when given no
// branch to work on; checkout with -- only restores files; git stash branch and a rebase
// given a branch, or finishing one, switch.
const KEEPS_BRANCH = new Set(
  "status log diff show add commit fetch push send-pack http-push config rev-parse ls-files ls-remote grep blame describe shortlog cat-file ls-tree for-each-ref show-ref merge-base rev-list pull merge reset cherry-pick revert tag rm mv restore apply am clean stash".split(" "),
);
const READ_ONLY = new Set(["echo", "printf", "true", "false", ":", "test", "[", "[[", "ls", "cat", "pwd", "sleep", "date", "which", "type", "grep", "head", "tail", "wc", "jq"]);

function keepsBranch(git) {
  const args = git.words.slice(git.at + 1).map((w) => single(w, git.state));
  // The words that aren't options, nor the value of an option that takes one.
  const operands = (valued = /(?!)/) => args.filter((a, k) => !a.startsWith("-") && !(k > 0 && valued.test(args[k - 1]))).length;
  switch (git.command) {
    case "branch":
      return args.every((a) => a.startsWith("-") && !/^(-[a-zA-Z]*[mMcC]|--(move|copy))/.test(a));
    case "symbolic-ref":
      return operands() <= 1;
    case "checkout": // git checkout main -- with no path after it still switches
      return args.indexOf("--") !== -1 && args.indexOf("--") < args.length - 1;
    case "stash":
      return args[0] !== "branch";
    case "rebase":
      return !args.some((a) => /^--(continue|skip|abort|quit|edit-todo)$/.test(a)) && operands(/^(--onto|-s|--strategy|-X|--strategy-option|-x|--exec)$/) <= 1;
    default:
      return KEEPS_BRANCH.has(git.command);
  }
}

// git commands that can switch the branch but leave git's config and refs alone.
const ONLY_SWITCH = new Set(["checkout", "switch", "rebase", "stash"]);

// Returns true for a git command that leaves the branch alone, "branch" for one that can
// only switch it, and false for anything else.
function checkGit(words, strings, state, env) {
  // git-core's git-push and the rest are git with that command.
  const own = /^git-(.+)$/.exec(commandName(strings[0]))?.[1];
  if (GIT_BUILTINS.has(own)) {
    words = [[{ text: "git", quoted: true }], [{ text: own, quoted: true }], ...words.slice(1)];
    strings = ["git", own, ...strings.slice(1)];
  } else if (commandName(strings[0]) !== "git") return false;
  const git = gitCommand(words, state, env);
  // A word the guard can't read before the command could be the push itself, and so could
  // an alias or a git-<name> program, which gets git's config.
  const push = PUSHES.has(git.command);
  checkGitSettings(git, env, push || git.unread !== null || git.alias);
  if (push || git.unread) checkGitPush(git, env);
  if (git.unread || git.command === null) return false;
  if (git.command === "config") checkGitConfig(git);
  if (git.command === "remote" && strings.slice(git.at + 1).some((s) => s.startsWith("--mirror")))
    deny("git remote --mirror makes every later push to that remote a force push of every branch, main included. Leave it out and run it again.");
  if (git.alias) checkAlias(git, env);
  checkGitRuns(git, env);
  return keepsBranch(git) || (!git.alias && ONLY_SWITCH.has(git.command) && "branch");
}

// Whether a path, or a glob, could name the claude-pool key: in any case, and through a link
// when follow is set or its name starts with "age".
function namesPoolKey(path, follow) {
  if (POOL_KEY.test(path) || (/[*?[]/.test(path) && globRegex(path, "i").test(POOL_KEY_PATH))) return true;
  if (!follow && !/^age/i.test(basename(path))) return false;
  try {
    return POOL_KEY.test(realpathSync(path));
  } catch {
    return false; // nothing there
  }
}

// Where a redirection can write without touching a file git reads.
const HARMLESS = /^(\d+|-|\/dev\/(null|stdout|stderr|tty|fd\/\d+))$/;

function checkSimple(cmd, state) {
  checkWords(cmd, state);
  // A file written through a redirect could be .git/HEAD or .git/config.
  if (cmd.writes.some((w) => !HARMLESS.test(one(w, state) ?? ""))) staleAfter(state);
}

function checkWords(cmd, state) {
  let words = cmd.words;
  // Every word, after expansion and from the folder the command runs in, is kept off the key.
  for (const word of [...words, ...cmd.redirects]) {
    let values = [];
    try {
      values = expand(word, state);
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
    }
    for (const value of values)
      if (namesPoolKey(value) || (state.cwd && namesPoolKey(resolve(state.cwd, value)))) deny("the claude-pool key is never read or copied");
  }
  // Substitutions run first, each in a subshell, also in redirection targets.
  for (const word of [...words, ...cmd.redirects])
    for (const part of word) {
      if (part.runs) ask(`${part.runs} runs code the guard can't read`);
      for (const inner of [part.sub, ...(part.nested ?? [])]) if (typeof inner === "string") checkLine(inner, copy(state));
    }

  // function NAME { ...; } runs its body later: check it here, like any other command. zsh
  // runs the command after repeat N, and after the ]] of a short if or while.
  for (let reserved = literal(words[0]); words.length; reserved = literal(words[0])) {
    const test = reserved === "[[" ? words.findIndex((w) => w.length === 1 && !w[0].quoted && w[0].text === "]]") : -1;
    if (RESERVED.has(reserved) || reserved === "function") words = words.slice(reserved === "function" ? 2 : 1);
    else if (reserved === "repeat" && words.length > 2) words = words.slice(2);
    else if (test !== -1 && test < words.length - 1) words = words.slice(test + 1);
    else break;
    if (["while", "until", "repeat"].includes(reserved)) state.repo.loop = true;
    // The time keyword takes its own -p, and a -- after it, before the command it times.
    if (reserved === "time") while (words.length && ["-p", "--"].includes(literal(words[0]))) words = words.slice(1);
  }
  if (!words.length) return;
  const keyword = literal(words[0]);
  if (keyword === "for" || keyword === "select") {
    state.repo.loop = true;
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

// A wrapper (sudo, env, nice...) runs the command after its options, and after the words
// it takes first (timeout's duration). An option can take the next word as its value
// (nice -n 5 rm, env -u NAME rm), so the first word after the options is judged both as
// the command and as a value, with the command after it (carried keeps what the options
// before it set, even when that word is a wrapper's name too). When an option could change the
// working folder (env -C, sudo -D) it isn't known. env -S splits its value into the
// command, and sudo -s or -i hands the command to a shell, as watch always does and flock
// does with -c. xargs and parallel add words from their input, which the guard can't see.
function checkRun(cmd, words, state, child, carried = {}) {
  const value = one(words[0], state);
  if (value === null || !oneArg(words[0], state)) return checkUnread(cmd, words, state, child);
  // zsh runs =git as the git on PATH.
  if (/^=./.test(value)) words = [[{ text: value.slice(1), quoted: true }], ...words.slice(1)];
  const wrapper = commandName(value.replace(/^=/, ""));
  if (!WRAPPERS.has(wrapper)) return checkCommand(cmd, words, state, child);
  // A wrapper that's a program of its own runs the command in another process, so a cd or
  // an assignment there changes nothing for the commands after it.
  if (!SHELL_WRAPPERS.has(value)) state = copy(state);
  let k = 1;
  let chdir = carried.chdir ?? false;
  let shell = carried.shell || wrapper === "watch";
  let replace = false; // the string xargs replaces with its input, null when unknown
  let taken = -1; // where the last xargs option that holds its own value was
  for (; k < words.length; k++) {
    if (["env", "sudo", "doas"].includes(wrapper) && assignment(words[k])) {
      assign(child, words[k], true);
      continue;
    }
    const option = one(words[k], state);
    if (!option?.startsWith("-")) break;
    chdir ||= /^(-[^-]*[CD]|--chdir)/.test(option);
    shell ||= wrapper === "sudo" && /^(-[a-zA-Z]*[si]|--shell$|--login$)/.test(option);
    const swap = wrapper === "xargs" && /^(?:-([IJ])([\s\S]*)|-i([\s\S]*)|--replace(?:=([\s\S]*))?)$/.exec(option);
    if (swap) [replace, taken] = [swap[2] || (swap[1] ? one(words[++k] ?? [], state) : swap[3] || swap[4] || "{}"), k];
    const split = wrapper === "env" && /^(-[^-]*S|--split-string(=|$))(.*)/s.exec(option);
    if (!split) continue;
    if ((split[3] || single(words[k + 1] ?? [], state)).includes("\\"))
      deny("env -S reads backslashes its own way (\\_ splits words), so the guard can't check the command it runs. Write the command out without env -S and run it again.");
    checkLine([split[3], ...words.slice(k + 1).map((w) => single(w, state))].join(" "), copy(child));
  }
  const moved = (s) => ({ ...copy(s), cwd: chdir ? null : s.cwd });
  // sudo -s or -i with no command runs a shell on what comes in on stdin.
  if (k + WRAPPERS.get(wrapper) >= words.length && shell && wrapper === "sudo") checkShellInput(cmd, "sudo -s", state, moved(child), true);
  if (k === words.length) return;
  if (k > 1 && taken !== k - 1 && one(words[k - 1], state)?.startsWith("-")) checkRun(cmd, [words[0], ...words.slice(k + 1)], moved(state), moved(child), { chdir, shell });
  let run = words.slice(k + WRAPPERS.get(wrapper));
  if (!run.length) return;
  if (wrapper === "flock" && /^(-c|--command)$/.test(one(run[0], state) ?? "")) return checkString(run[1], "flock -c", state, moved(child));
  if (wrapper === "parallel") return checkParallel(run, state, moved(child));
  if (shell) checkLine(run.map((w) => single(w, state)).join(" "), moved(child));
  // xargs adds its input at the end, or puts it in place of the replace string.
  if (replace === null) ask("xargs replaces a string the guard can't read with its input");
  if (wrapper === "xargs") run = replace ? placeIn(run, replace, XARGS_INPUT) : [...run, XARGS_INPUT];
  checkRun(cmd, run, chdir ? moved(state) : state, chdir ? moved(child) : child);
}

// words with each token in their text replaced by the placeholder word.
const placeIn = (words, token, placeholder) =>
  words.map((w) => w.flatMap((p) => ("text" in p && p.text.includes(token) ? p.text.split(token).flatMap((t, n) => [...(n ? placeholder : []), ...(t ? [{ text: t, quoted: p.quoted }] : [])]) : [p])));

// What xargs reads from its input: a word the guard can't work out.
const XARGS_INPUT = [{ name: "(xargs input)", op: "", quoted: true }];

// parallel joins the command before its ::: inputs into a line for the shell, with each
// {...} replaced by an input, or the input added at the end. The inputs are known when a
// single ::: lists them all in words the guard can read. With no command, they're the commands.
function checkParallel(run, state, inherited) {
  const strings = run.map((w) => single(w, state));
  const marker = (s) => /^:{3,4}\+?$/.test(s);
  const cut = upTo(strings.findIndex(marker), strings);
  const sources = run.slice(cut + 1);
  if (cut === 0) {
    for (const word of sources) if (!marker(single(word, state))) checkString(word, "parallel", state, inherited);
    return;
  }
  let inputs = ['"$(parallel-input)"'];
  if (strings[cut] === ":::" && !strings.slice(cut + 1).some(marker))
    try {
      inputs = sources.flatMap((w) => expand(w, state)).map(quote);
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
    }
  const line = strings.slice(0, cut).join(" ");
  for (const input of inputs) {
    const placed = line.replace(/\{[^{}\s]*\}/g, input);
    checkLine(placed === line ? `${line} ${input}` : placed, copy(inherited));
  }
}

// find runs the words between -exec, -execdir, -ok or -okdir and the ; (or {} +) that ends
// them, with {} standing for what it finds: a start folder, or a path under one (rm won't
// remove "." itself).
const FOUND = "(what find finds)";
function checkFind(cmd, words, state, child) {
  const strings = words.map((w) => single(w, state));
  let k = 1;
  while (/^-[HLP]+$/.test(strings[k] ?? "")) k++;
  const starts = [];
  for (; k < words.length && !/^[-(!]/.test(strings[k]); k++) starts.push(words[k]);
  let found = null;
  try {
    found = (starts.length ? starts.flatMap((w) => expand(w, state)) : ["."]).flatMap((s) => {
      const start = s.replace(/(.)\/+$/, "$1");
      return [...(/(^|\/)\.\.?$/.test(start) ? [] : [start]), `${start}/x`];
    });
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
  }
  const unread = starts.find((w) => one(w, state) === null && !choices(w, state));
  const placeholder = (!found && unread) || [{ name: FOUND, op: "", quoted: true }];
  const inner = copy(state);
  const innerChild = copy(child);
  inner.vars.set(FOUND, found);
  innerChild.vars.set(FOUND, found);
  for (let i = k; i < words.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(strings[i])) continue;
    let end = i + 1;
    while (end < words.length && strings[end] !== ";" && !(strings[end] === "+" && strings[end - 1] === "{}")) end++;
    const run = placeIn(words.slice(i + 1, end), "{}", placeholder);
    if (run.length) checkRun(cmd, run, inner, innerChild);
    i = end;
  }
}

// The names the guard has checks for, so that a command word it can only partly read
// (${X}git, g?t) is judged as each of them it could be. One it can't read at all is asked
// about, and judged only as those whose checks look at paths and pushes, not at how many
// arguments there are: as git config, any two words would be a write, and as xargs or
// parallel, input would follow.
const CHECKED = () => [...ANY_COMMAND(), "xargs", "parallel", ...[...GIT_BUILTINS].map((c) => `git-${c}`)];
const ANY_COMMAND = () => ["git", ...[...PUSHES].map((c) => `git-${c}`), "gh", "rm", "find", "su", "diskutil", "dd", "eval", ...SHELLS, ...[...WRAPPERS.keys()].filter((w) => w !== "xargs" && w !== "parallel")];

// A shell glob as a regular expression: * and ? never match a "/", ** matches anything.
function globRegex(pattern, flags = "") {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const close = c === "[" ? pattern.indexOf("]", i + 2) : -1;
    if (c === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (close !== -1) {
      source += `[${pattern.slice(i + 1, close).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`;
      i = close;
    } else source += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`, flags);
  } catch {
    return /(?!)/; // a class the shell reads some other way matches nothing here
  }
}

// A command word the guard can't read, or one that could split, vanish or match files,
// could be any command. The words after it are judged as a command of their own (it could
// be empty, or a wrapper), each value it could have is judged, and so is each command with a
// check whose name it could be, where a part the guard can't read matches anything. One that
// could split could hold a whole command, so it's asked about. That judging doesn't nest: a
// second such word inside it is asked about. A push after it is judged as a git push, in a
// repo the guard can't name.
// Each of those readings is judged on its own copy of the state, and the folder and the
// variables any of them could change are unknown after it.
let reading = false;
function checkUnread(cmd, words, state, child) {
  const [first, ...rest] = words;
  const maybe = (run) => {
    const s = copy(state);
    checkRun(cmd, run, s, child);
    if (s.cwd !== state.cwd) state.cwd = null;
    for (const [name, values] of s.vars) if (state.vars.get(name) !== values) state.vars.set(name, null);
    for (const name of s.exported) state.exported.add(name);
    state.allexport ||= s.allexport;
  };
  if (rest.length) maybe(rest);
  let values = null;
  try {
    values = expand(first, state);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
  }
  for (const v of values ?? []) {
    const pieces = v.split(/\s+/).filter(Boolean);
    if (pieces.length) maybe([...pieces.map((t) => [{ text: t, quoted: true }]), ...rest]);
  }
  // The name the command could have: after the last "/", where an unread part could hold one.
  const name = first.reduce((tail, p) => ("text" in p ? tail + p.text : "*").replace(/^.*\//s, ""), "");
  const any = !values && /^\**$/.test(name);
  if (!values && (any || first.some((p) => !p.quoted && !("text" in p)))) ask(`runs ${raw(first)}, which the guard can't read, so it could be any command`);
  const patterns = values ? values.map((v) => basename(v)).filter((p) => /[*?[]/.test(p)) : [name];
  const names = any ? ANY_COMMAND() : CHECKED().filter((n) => patterns.some((p) => globRegex(p, "i").test(n)));
  if (names.length && reading) ask(`runs ${raw(first)}, which the guard can't read, inside another command it can't read`);
  else if (names.length) {
    reading = true;
    try {
      for (const n of names) maybe([[{ text: n, quoted: true }], ...rest]);
    } finally {
      reading = false;
    }
  }
  const push = words.findIndex((w, k) => k > 0 && one(w, state) === "push");
  if (push !== -1 && one(first, state) === null)
    checkGitPush({ words, state, options: [{ name: "-C", value: null }], command: "push", at: push, unread: null }, child);
  staleAfter(state);
}

// c: the word holding the command string a shell's -c runs, its first operand after every
// option (-o and -O take a value, -- and - end the options); undefined without -c, null when
// it's missing. stdin: whether it reads its commands from stdin (no script named, or -s).
function shellString(words, strings) {
  let c = false;
  let s = false;
  let k = 1;
  for (; k < strings.length; k++) {
    const arg = strings[k];
    if (arg === "--" || arg === "-") {
      k++;
      break;
    }
    if (/^[-+][a-zA-Z]+$/.test(arg)) {
      c ||= arg[0] === "-" && arg.includes("c");
      s ||= arg[0] === "-" && arg.includes("s");
      if (/[oO]$/.test(arg)) k++;
    } else if (arg === "--rcfile" || arg === "--init-file") k++;
    else if (!arg.startsWith("--")) break;
  }
  return { c: c ? (words[k] ?? null) : undefined, stdin: !c && (s || k >= words.length) };
}

// The word su's -c or --command string is, wherever it comes (su root -c '...'), like
// shellString's.
function suString(words, strings) {
  for (let k = 1; k < strings.length; k++) {
    const m = /^(?:-[a-zA-Z]*c|--(?:session-)?command)(?:=([\s\S]*))?$/.exec(strings[k]);
    if (m) return m[1] !== undefined ? [{ text: m[1], quoted: true }] : (words[k + 1] ?? null);
    if (strings[k] === "-s" || strings[k] === "--shell") k++;
  }
  return undefined;
}

// A command string handed to a shell (sh -c, su -c, flock -c, git rebase -x...) is checked
// as each value it could have. One the guard can't read is asked about, and checked as
// written too, since a refusal there still holds.
function checkString(word, what, state, inherited) {
  if (!word) deny(`can't find the command ${what} runs, so the guard can't check it. Write it as ${what} '<command>' and run it again.`);
  let texts;
  try {
    texts = expand(word, state);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
    ask(`${what} runs ${raw(word)}, a command the guard can't read`);
    texts = [raw(word)];
  }
  for (const text of texts) checkLine(text, copy(inherited));
}

// The words a tool runs for you: one is a shell command, more are a program and its arguments.
function checkRuns(words, what, state, inherited) {
  if (words.length === 1) checkString(words[0], what, state, inherited);
  else if (words.length) checkLine(argvLine(words, state), copy(inherited));
}
const argvLine = (words, state) => words.map((w) => (one(w, state) === null ? raw(w) : quote(one(w, state)))).join(" ");

// Commands that print code to set up a shell, for eval to run.
const SETUP =
  /^\s*(?:[\w./-]*\/)?(?:brew shellenv|ssh-agent(?: -[sc])?|direnv (?:export|hook) \w+|(?:rbenv|pyenv|nodenv|zoxide|starship|mise) (?:init|activate|env)(?: -)?(?: \w+)?|fnm env(?: --[\w-]+)*|opam env)\s*$/;

// A shell given no command string checks its here-documents and here-strings as what it
// runs, and when it reads stdin (stdin) asks about a pipe or process substitution feeding
// it. Returns whether anything was checked.
function checkShellInput(cmd, name, state, inherited, stdin) {
  for (const doc of cmd.heredocs) checkLine(doc.body, inherited);
  for (const word of cmd.herestrings) checkString(word, `${name} <<<`, state, inherited);
  const fed = cmd.heredocs.length + cmd.herestrings.length > 0;
  if (stdin && cmd.streamed && !fed) ask(`${name} runs what it reads from a pipe or a process substitution, which the guard can't read`);
  return fed;
}

// A command's own checks, from its name on. child is what it runs with.
function checkCommand(cmd, words, state, child) {
  const strings = words.map((w) => single(w, state));
  const name = commandName(strings[0]);
  const builtin = strings[0];
  const args = words.slice(1);

  if (DECLARE.has(builtin)) {
    const exported = builtin === "export" || strings.slice(1).some((s) => /^-\w*x/.test(s));
    for (const word of args) {
      if (assignment(word)) assign(state, word, exported);
      else if (exported && /^[A-Za-z_]\w*$/.test(literal(word) ?? "")) state.exported.add(literal(word));
    }
    return;
  }
  // An alias can make any later word in the line run something else.
  if (builtin === "alias" && strings.slice(1).some((s) => s.includes("="))) ask("an alias defined here can make a later command run something the guard can't see");
  // set -a (or -o allexport) exports every variable assigned after it, until set +a.
  if (builtin === "set") {
    for (let k = 1; k < strings.length && strings[k] !== "--"; k++) {
      const s = strings[k];
      if (/^[-+]o$/.test(s) && strings[k + 1] === "allexport") state.allexport = s[0] === "-";
      else if (/^[-+][a-zA-Z]*a/.test(s)) state.allexport = s[0] === "-";
    }
    return;
  }
  if (builtin === "unset") {
    for (const s of strings.slice(1)) if (!s.startsWith("-")) state.vars.set(s, [""]);
    return;
  }
  if (builtin === "read") {
    for (const s of strings.slice(1)) if (/^[A-Za-z_]\w*$/.test(s)) state.vars.set(s, null);
    return;
  }
  if (builtin === "cd" || builtin === "pushd") {
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
  if (builtin === "popd") {
    state.cwd = null;
    return;
  }

  if (name === "rm") checkRm(words, state);
  if (name === "find") checkFind(cmd, words, state, child);
  // After a link is made, any path in the line could lead through it.
  if (name === "ln") state.disk.linked = true;
  // Whether the branch is still the one git reports, once this has run.
  const git = checkGit(words, strings, state, child);
  let readOnly = git === true || READ_ONLY.has(name);
  const [, sub, sub2] = strings;
  if (name === "gh" && sub === "repo" && sub2 === "delete") ask("deleting a GitHub repo");
  if (name === "gh" && sub === "api") checkGhApi(strings);
  if (name === "diskutil" && /^(erase|zero|randomDisk|secureErase|partitionDisk)/i.test(sub ?? "")) ask(`diskutil ${sub}`);
  if (name === "dd" && strings.some((w) => /^of=\/dev\//.test(w))) ask("dd to a device");

  // A command handed to another shell runs there: check it too, with what that shell
  // inherits. One that reads its commands from a pipe or a process substitution runs code
  // the guard can't see; a here-document or here-string it can.
  if (SHELLS.has(name) || name === "su") {
    const inherited = { ...child, vars: new Map([...child.vars].filter(([k]) => child.exported.has(k))) };
    const { c, stdin } = name === "su" ? { c: suString(words, strings), stdin: true } : shellString(words, strings);
    if (c !== undefined) checkString(c, `${name} -c`, state, inherited);
    // What runs there was checked, and marked the branch unknown if it could change it.
    readOnly = c !== undefined || checkShellInput(cmd, name, state, inherited, stdin);
  }
  if ((builtin === "source" || builtin === ".") && cmd.streamed) ask(`${builtin} runs what it reads from a process substitution, which the guard can't read`);
  if (name === "eval") {
    // Code eval gets from somewhere the guard can't see is asked about, unless it's what a
    // well-known tool prints to set up a shell (eval "$(brew shellenv)").
    const parts = args[0]?.filter((p) => p.text !== "") ?? [];
    const setup = args.length === 1 && parts.length === 1 && SETUP.test(parts[0].sub ?? "");
    const unread = args.find((w) => {
      try {
        return !expand(w, state);
      } catch (e) {
        if (e instanceof Unresolved) return true;
        throw e;
      }
    });
    if (unread && !setup) ask(`eval runs ${raw(unread)}, code the guard can't read`);
    if (!setup) checkLine(strings.slice(1).join(" "), copy(state));
    readOnly = true;
  }
  if (!readOnly) staleAfter(state, git === "branch");
}

function checkLine(line, state) {
  // Past this depth the guard can no longer see what runs, so it refuses rather than let it through.
  if (state.depth >= MAX_DEPTH) deny("the command nests eval, sh -c or $( ) too deeply for the guard to check. Write it out flat.");
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
const TOP = String.raw`(?:/|${ROOTISH}${CHILD})`;
// The path on its own, or as one choice of a brace expansion that starts the word ({~,/tmp/x}).
const RM_HARD = new RegExp(String.raw`${RM_FLAGS}[^\n;|&]*?(?:^|\s)["']?(?:${TOP}${END}|\{(?:[^\s{}]*,)*${TOP}/*\*?(?=[,}]))`, "i");
const FIND_DELETE = new RegExp(String.raw`\bfind\s+["']?(?:/|${ROOTISH}${CHILD})${END}[^\n;|&]*-delete\b`, "i");
function hardRefusals(command) {
  if (RM_HARD.test(command))
    deny("rm -r or rm -f on /, a system folder, my home folder or a folder directly in it is never run by an agent, in any form (also inside quotes, here-documents or backticks). Name the exact path inside a project or temp folder instead.");
  if (FIND_DELETE.test(command)) deny("find -delete from /, my home folder or a folder directly in it is never run by an agent");
  // An unquoted here-document expands `...` and $(...) in its body: refuse any body that holds them.
  const re = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/g;
  for (const m of command.matchAll(re))
    if (!m[1] && /`|\$\(/.test(m[3]))
      deny(`this here-document (<<${m[2]}) is unquoted and its body holds backticks or $( ), which the shell would run. Quote the delimiter (<<'${m[2]}') or write the text to a file with the Write tool and pass the file.`);
}

function checkBash(command, cwd) {
  if (POOL_KEY.test(command)) deny("the claude-pool key is never read or copied");
  hardRefusals(command);
  const start = (stale) => ({ vars: new Map(), exported: new Set(), cwd, depth: 0, repo: { stale, changed: stale, read: false, staleAfterRead: false, loop: false }, disk: { linked: false } });
  const first = start(false);
  checkLine(command, first);
  if (first.repo.loop && first.repo.staleAfterRead) checkLine(command, start(true));
}

// The hook's payload in, a Verdict (or null to stay out of it) back. Throws on a payload
// it can't read.
function judge(payload) {
  const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = payload;
  if (typeof tool !== "string") throw new TypeError("the payload names no tool");
  asked = null;
  try {
    if (SHELL_TOOLS.has(tool)) {
      // Monitor can open a WebSocket instead of running a command.
      const socket = tool === "Monitor" && args?.command === undefined && args?.ws;
      if (!socket && typeof args?.command !== "string") throw new TypeError(`the ${tool} call has no command`);
      if (!socket) checkBash(args.command, cwd);
    } else if (["Read", "Edit", "Write"].includes(tool) && namesPoolKey(resolve(cwd, args.file_path ?? ""), true))
      deny("the claude-pool key is never read or copied");
    else if (OUTWARD[tool]) ask(OUTWARD[tool]);
  } catch (e) {
    if (e instanceof Verdict) return e;
    throw e;
  }
  return asked;
}

// ---------------------------------------------------------------------------------------
// Running. A Bash or Monitor call (both run a shell command) fails closed: when the guard
// can't finish its checks (a payload it can't read, a throw, git not answering, its
// deadline passing) it refuses the call. Every other tool fails open, as Claude Code does
// for a hook that fails, so a broken guard never blocks the Edit that would fix it.
// settings.json's entry for those two passes --fail-closed, so a payload too broken to name
// its tool is refused there, and says onFailure "block", for a guard that can't even start.
// The guard keeps its own deadline, under the hook's timeout, since a Claude Code that
// predates onFailure ignores it.

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
    try {
      writeSync(2, `${e?.stack ?? e}\n`);
    } finally {
      process.exit(1);
    }
  }
  if (e?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") late();
  refuse(`failed (${e?.message ?? e})`);
}

async function main() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  const payload = JSON.parse(text);
  if (typeof payload?.tool_name === "string") closed = SHELL_TOOLS.has(payload.tool_name);
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
