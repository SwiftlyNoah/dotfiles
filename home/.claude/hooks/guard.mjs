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
//     beyond a short safe list; a push that doesn't force but holds a word the guard can't
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
// no one to ask (claude -p) is refused instead. Monitor's command is checked like Bash's.
// When the guard itself breaks, a Bash or Monitor call is refused and every other tool goes
// on (see Running, at the end). Tests: node --test (guard.test.mjs).
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
const SHELL_TOOLS = new Set(["Bash", "Monitor"]); // the tools that run a shell command
const RESERVED = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "done", "fi", "esac", "time"]);
// Commands that run the command after them, with how many words each takes before it
// (timeout's duration, script's file). noglob, nocorrect and - are zsh's precommand words.
const WRAPPERS = new Map(
  Object.entries({ command: 0, builtin: 0, exec: 0, nohup: 0, time: 0, sudo: 0, doas: 0, env: 0, nice: 0, timeout: 1, gtimeout: 1, caffeinate: 0, stdbuf: 0, xargs: 0, arch: 0, xcrun: 0, script: 1, noglob: 0, nocorrect: 0, "-": 0, coproc: 0 }),
);
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

// Reads the expansion at the "$" at i: returns [part, index of its last character]. A part
// can carry nested: the commands its operator or arithmetic runs.
function dollar(s, i, quoted) {
  const next = s[i + 1];
  if (next === "(") {
    const close = closeBracket(s, i + 1, "(", ")");
    if (s[i + 2] === "(") return [{ sub: null, nested: commandsIn(s.slice(i + 3, close)), quoted }, close];
    return [{ sub: s.slice(i + 2, close), quoted }, close];
  }
  if (next === "{") {
    const close = closeBracket(s, i + 1, "{", "}");
    const body = s.slice(i + 2, close);
    const m = /^([A-Za-z_]\w*|\d+|[@*#?$!-])([\s\S]*)$/.exec(body);
    const nested = commandsIn(m ? m[2] : body);
    return [m ? { name: m[1], op: m[2], quoted, nested } : { sub: null, nested, quoted }, close];
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
  let cmd = { words: [], heredocs: [], redirects: [] };
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
    } else if (redirect) {
      cmd.redirects.push(word);
      redirect = false;
    } else cmd.words.push(word);
    word = null;
  };
  const endCmd = () => {
    endWord();
    if (cmd.words.length || cmd.redirects.length) items.push(cmd);
    cmd = { words: [], heredocs: [], redirects: [] };
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
const branches = new Map(); // what each query printed, by folder and query

// git answers for the repo as it is before the line runs. After a command that could have
// switched a branch (anything but a few read-only ones), that answer is out of date, and
// the line's branch is unknown. A loop runs its body again after its last command, so a
// line with one is checked a second time from the start when that happened after an answer.
function staleAfter(state) {
  state.repo.staleAfterRead ||= state.repo.read;
  state.repo.stale = true;
}

// What git [-C dir]... <a branch query> prints, or null when the guard can't tell.
function branchQuery(args, state) {
  if (state.repo.stale || state.exported.has("GIT_DIR") || state.exported.has("GIT_WORK_TREE")) return null;
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
  if (exported || state.allexport) state.exported.add(name);
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
  if (braced(word)) return false;
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
// --shallow-file isn't in git's manual, but git reads it like the rest.
const GIT_VALUES = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source", "--shallow-file"];

const redirects = (what) =>
  decide("deny", `${what} can change what git runs or where it pushes, so the guard can't tell whether this is a force push to main or master. Leave it out and run it again.`);

// Config that can't run a program or change where a push goes, and so is safe to give git
// on the command line or to write with git config: everything else is refused (a pager, an
// ssh command, fsmonitor, hooks, an alias, an include, a remote's push refspec). push.default
// may be current or simple, which push the branch the repo is on, and a pager or editor one
// of a few programs that do nothing else. value is undefined when the guard can't see it.
const SAFE_PROGRAMS = new Set(["true", "false", ":", "cat", "less"]);
function safeConfig(key, value) {
  if (/^(user\.[^.]+|color\..+|advice\.[^.]+|core\.quotepath|commit\.gpgsign|tag\.gpgsign|init\.defaultbranch)$/i.test(key)) return true;
  if (/^push\.default$/i.test(key)) return ["current", "simple"].includes(value);
  if (/^(core\.(pager|editor)|sequence\.editor|pager\..+)$/i.test(key)) return SAFE_PROGRAMS.has(value);
  return false;
}

// git -c key[=value] (a bare key is true) and git --config-env key=VARIABLE.
function checkConfig(option, value) {
  const [key, setting] = value === null ? [null] : value.split(/=(.*)/s);
  const ok = key !== null && (option === "-c" ? safeConfig(key, setting ?? "true") : setting !== undefined && safeConfig(key, undefined));
  if (!ok) redirects(`git ${option} ${value ?? "with a value the guard can't work out"}`);
}

// What git's environment may hold from this line: GIT_ variables that can't run a program
// or choose a config file (GIT_DIR and GIT_WORK_TREE make the repo unknown instead), a
// pager or editor from the safe few, and HOME and XDG_CONFIG_HOME only as they already are.
const SAFE_GIT_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|TERMINAL_PROMPT|OPTIONAL_LOCKS|FLUSH|PROGRESS_DELAY|ADVICE)$/;
function checkGitEnv(env) {
  for (const name of env.exported) {
    if (!env.vars.has(name)) continue; // exported as it already was
    const values = env.vars.get(name);
    const program = /^GIT_(PAGER|EDITOR|SEQUENCE_EDITOR)$/.test(name) && values?.every((v) => SAFE_PROGRAMS.has(v));
    const kept = !["HOME", "XDG_CONFIG_HOME"].includes(name) || values?.every((v) => v === (name === "HOME" ? HOME : process.env.XDG_CONFIG_HOME));
    if ((name.startsWith("GIT_") && !SAFE_GIT_ENV.test(name) && !program) || !kept) redirects(`${name} in git's environment`);
  }
}

// git [options] <command> [args], read the way git reads it: its own options as
// { name, value } (value null when the guard can't work it out), and the command and its
// index (command null when there's none, or when git.unread stopped the reading before
// it). env is what git runs with.
function gitCommand(words, state, env) {
  checkGitEnv(env);
  const git = { words, state, options: [], command: null, at: words.length, unread: null };
  const stop = (at, command = null) => Object.assign(git, { at, command });
  for (let k = 1; k < words.length; k++) {
    const arg = gitArg(git, k);
    if (git.unread) return stop(k);
    if (!arg.startsWith("-")) return stop(k, arg);
    if (arg.startsWith("--exec-path=")) redirects(`git ${arg}`);
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!GIT_VALUES.includes(name)) continue;
    if (eq === -1 && ++k === words.length) break;
    const value = eq === -1 ? gitArg(git, k, false) : arg.slice(eq + 1);
    if (name === "-c" || name === "--config-env") checkConfig(name, value);
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

// git push's long options that take a value (the next word, or after "="), that force or
// delete, and that push every branch. git takes any prefix of one that names only it.
// --prune deletes every remote branch with no local one; with no refspec that's any branch.
const PUSH_VALUES = ["repo", "receive-pack", "exec", "recurse-submodules", "push-option"];
const PUSH_FORCE = ["force", "force-with-lease", "force-if-includes", "mirror", "delete", "prune"];
const PUSH_EVERY = ["all", "branches", "mirror"];
const prefixOf = (name) => (option) => option.startsWith(name);

// git push [options] [remote [refspec...]], with options anywhere until "--". Deleting a
// branch counts as forcing it, and so does --mirror. A push with a word the guard can't
// read is refused when it forces and asked about when it doesn't, since the word itself
// could force it. git send-pack is read the same way: with no ref named it pushes every
// branch both sides have, and --stdin reads the refs from a place the guard can't see.
function checkGitPush(git, env) {
  const { words, state } = git;
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
  every ||= !refspecs.length && (pruned || git.command === "send-pack");
  if (git.unread) {
    const { word, split } = git.unread;
    if (!forced)
      decide("ask", `${git.command ? "git push" : "git"} with ${word}, which the guard can't read, so it could be a force push to main or master`);
    if (split) unknownGit(`what git gets from ${word}, which could split into several words, vanish or match files`, `Quote it ("${word}")`);
    unknownGit(`what git does with ${word}`, "Write it out literally");
  }
  const config = !refspecs.length && !every;
  if (!forced) {
    if (config) checkPushConfig(git, env, false);
    return;
  }
  if (every || refspecs.includes(":")) decide("ask", "force push of every branch, main included");

  // Where each refspec lands. Without one, or with HEAD, that's the branch the repo is on.
  const targets = refspecs.map((r) => r.split(":").at(-1));
  if (!targets.length || targets.some((t) => t === "HEAD" || t === "@")) {
    const dir = gitFolder(git.options, state, env);
    if (dir === null) unknownPush("which repo this force push runs in");
    targets.push(currentBranch(dir, state));
  }
  // git finds a short name like heads/main under refs/ on the remote.
  const protectedBranch = targets.find((t) => /(^|\/)(main|master)$/.test(t) || t.includes("*"));
  if (protectedBranch) decide("ask", `force push to ${protectedBranch}`);
  if (config) checkPushConfig(git, env, true);
}

// With no refspec, git's config says where a push goes and whether it forces: a remote's
// push refspec or mirror setting, and push.default (only current and simple push just the
// branch the repo is on). A push that doesn't force and can't be looked up is asked about.
function checkPushConfig(git, env, forced) {
  const unknown = (what) => (forced ? unknownPush(what) : decide("ask", `git push with no branch named, and the guard can't tell ${what}`));
  const dir = gitFolder(git.options, git.state, env);
  if (dir === null) unknown("which repo this push runs in");
  let config;
  try {
    config = gitConfig(dir, ["--get-regexp", String.raw`^(remote\..*\.(push|mirror)|push\.default)$`]);
  } catch (e) {
    unknown(`where git's config sends this push (${e.message})`);
  }
  for (const line of config.split("\n").filter(Boolean)) {
    const [key, value = ""] = line.split(/ (.*)/s);
    if (/\.mirror$/i.test(key) && /^(true|yes|on|1)$/i.test(value)) decide("ask", `git push with ${key} set, which force pushes every branch, main included`);
    if (/\.push$/i.test(key) && (forced || /^[+:]/.test(value))) decide("ask", `git push with ${key} ${value} set, which can force push to main or master`);
    if (/^push\.default$/i.test(key) && forced && !["current", "simple"].includes(value)) decide("ask", `force push with push.default ${value}, which can push to main or master`);
  }
}

// git config that writes a key, other than one safeConfig allows, is refused, so that no
// later command (in this line or another) is redirected by it. Reading and removing are fine.
function checkGitConfig(git) {
  const args = git.words.slice(git.at + 1).map((w) => one(w, git.state));
  if (args.includes(null)) redirects("git config with a word the guard can't read");
  let write = false;
  let read = false;
  const operands = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (/^(-e|--edit|--rename-section)$/.test(a)) redirects(`git config ${a}`);
    else if (/^--(unset|unset-all|remove-section)$/.test(a)) return;
    else if (/^--(add|replace-all)$/.test(a)) write = true;
    else if (/^(-l|--list|--get(-all|-regexp|-urlmatch|-color|-colorbool)?)$/.test(a)) read = true;
    else if (/^(-f|--file|--blob|--type|--default|--comment|--value)$/.test(a)) k++;
    else if (!a.startsWith("-")) operands.push(a);
  }
  const sub = ["get", "list", "set", "unset", "remove-section", "rename-section", "edit"].includes(operands[0]) ? operands.shift() : null;
  if (sub === "rename-section" || sub === "edit") redirects(`git config ${sub}`);
  if (sub === null ? read || (!write && operands.length <= 1) : sub !== "set") return;
  const [key = "", value] = operands;
  if (!safeConfig(key, value)) redirects(`git config ${key}${value === undefined ? "" : ` ${value}`}`);
}

// git's own commands. Any other is an alias, or a git-<name> program on PATH.
const GIT_BUILTINS = new Set(
  "add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout cherry cherry-pick clean clone commit config count-objects describe diff difftool fetch for-each-ref format-patch fsck gc grep help init log ls-files ls-remote ls-tree merge merge-base mv notes pull push range-diff rebase reflog remote repack replace reset restore rev-list rev-parse revert rm send-pack shortlog show show-ref sparse-checkout stash status submodule switch symbolic-ref tag update-ref version worktree".split(" "),
);
const quote = (s) => `'${s.replaceAll("'", String.raw`'\''`)}'`;

// An alias is judged as what it stands for, with the words after it: a shell command when
// it starts with !, else a git command. One the guard can't look up is asked about.
function checkAlias(git, env) {
  const what = `git ${git.command}, which could be an alias the guard`;
  const dir = gitFolder(git.options, git.state, env);
  if (dir === null) decide("ask", `${what} can't look up, since it can't tell which repo this runs in`);
  let alias;
  try {
    alias = gitConfig(dir, ["--get", `alias.${git.command}`]).replace(/\n$/, "");
  } catch (e) {
    decide("ask", `${what} couldn't look up (${e.message})`);
  }
  if (!alias) return;
  const args = git.words.slice(git.at + 1).map((w) => (one(w, git.state) === null ? raw(w) : quote(one(w, git.state))));
  const options = git.words.slice(1, git.at).map((w) => quote(single(w, git.state)));
  checkLine(alias.startsWith("!") ? [alias.slice(1), ...args].join(" ") : ["git", ...options, alias, ...args].join(" "), copy(env));
}

// gh api can move or delete a branch without git: a call that writes to main or master, or
// to a branch the guard can't read, asks. gh sends GET unless told otherwise or given fields.
function checkGhApi(strings) {
  let method = null;
  let fields = false;
  for (let k = 2; k < strings.length; k++) {
    const m = /^(?:-X|--method)(?:=?(.+))?$/.exec(strings[k]);
    if (m) method = m[1] ?? strings[++k] ?? "";
    fields ||= /^(-[fF]|--field|--raw-field|--input)/.test(strings[k] ?? "");
  }
  if ((method ?? (fields ? "POST" : "GET")).toUpperCase() === "GET") return;
  const ref = strings.map((s) => /^\/?repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.*)$/.exec(s)?.[1]).find((r) => r !== undefined);
  if (ref !== undefined && /^(main|master)\/?$|[$`*]/.test(ref)) decide("ask", `changing or deleting the ${ref} branch through the GitHub API`);
  if (strings.includes("graphql") && strings.some((s) => /\b(deleteRef|updateRefs?)\b/.test(s))) decide("ask", "changing or deleting a branch through the GitHub API");
}

// git commands that never switch the branch a repo is on. git branch only lists, and git
// symbolic-ref only reads, when given no branch to work on.
const READ_ONLY_GIT = new Set(
  "status log diff show add commit fetch push send-pack config rev-parse ls-files ls-remote grep blame describe shortlog cat-file ls-tree for-each-ref show-ref merge-base rev-list".split(" "),
);
const READ_ONLY = new Set(["echo", "printf", "true", "false", ":", "test", "[", "[[", "ls", "cat", "pwd", "sleep", "date", "which", "type", "grep", "head", "tail", "wc", "sort", "uniq", "jq"]);

function readOnlyGit(git) {
  if (git.unread || git.command === null) return false;
  const args = git.words.slice(git.at + 1).map((w) => single(w, git.state));
  if (git.command === "branch") return args.every((a) => a.startsWith("-") && !/^(-[a-zA-Z]*[mMcC]|--(move|copy))/.test(a));
  if (git.command === "symbolic-ref") return args.filter((a) => !a.startsWith("-")).length <= 1;
  return READ_ONLY_GIT.has(git.command);
}

// Returns whether the command was a git command that leaves the branch alone.
function checkGit(words, strings, state, env) {
  if (basename(strings[0]) !== "git") return false;
  const git = gitCommand(words, state, env);
  // A word the guard can't read before the command could be the push itself.
  if (git.command === "push" || git.command === "send-pack" || git.unread) checkGitPush(git, env);
  if (git.unread || git.command === null) return false;
  if (git.command === "config") checkGitConfig(git);
  if (git.command === "remote" && strings.slice(git.at + 1).some((s) => s.startsWith("--mirror")))
    decide("deny", "git remote --mirror makes every later push to that remote a force push of every branch, main included. Leave it out and run it again.");
  if (!GIT_BUILTINS.has(git.command)) checkAlias(git, env);
  return readOnlyGit(git);
}

function checkSimple(cmd, state) {
  let words = cmd.words;
  // Substitutions run first, each in a subshell, also in redirection targets.
  for (const word of [...words, ...cmd.redirects])
    for (const part of word)
      for (const inner of [part.sub, ...(part.nested ?? [])]) if (typeof inner === "string") checkLine(inner, copy(state));

  while (words.length && RESERVED.has(literal(words[0]))) {
    const reserved = literal(words[0]);
    words = words.slice(1);
    if (reserved === "while" || reserved === "until") state.repo.loop = true;
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
// the command and as a value, with the command after it. When an option could change the
// working folder (env -C, sudo -D) it isn't known. env -S splits its value into the
// command, and sudo -s or -i hands the command to a shell. xargs adds words from its
// input, which the guard can't see.
function checkRun(cmd, words, state, child) {
  const value = one(words[0], state);
  if (value === null || !oneArg(words[0], state)) return checkUnread(cmd, words, state, child);
  // zsh runs =git as the git on PATH.
  if (/^=./.test(value)) words = [[{ text: value.slice(1), quoted: true }], ...words.slice(1)];
  const wrapper = basename(value.replace(/^=/, ""));
  if (!WRAPPERS.has(wrapper)) return checkCommand(cmd, words, state, child);
  let k = 1;
  let chdir = false;
  let shell = false;
  let replace = false;
  for (; k < words.length; k++) {
    if (wrapper === "env" && assignment(words[k])) {
      assign(child, words[k], true);
      continue;
    }
    const option = one(words[k], state);
    if (!option?.startsWith("-")) break;
    chdir ||= /^(-[^-]*[CD]|--chdir)/.test(option);
    shell ||= wrapper === "sudo" && /^(-[a-zA-Z]*[si]|--shell$|--login$)/.test(option);
    replace ||= wrapper === "xargs" && /^(-[IJi]|--replace)/.test(option);
    const split = wrapper === "env" && /^(-[^-]*S|--split-string(=|$))(.*)/s.exec(option);
    if (!split) continue;
    if ((split[3] || single(words[k + 1] ?? [], state)).includes("\\"))
      decide("deny", "env -S reads backslashes its own way (\\_ splits words), so the guard can't check the command it runs. Write the command out without env -S and run it again.");
    checkLine([split[3], ...words.slice(k + 1).map((w) => single(w, state))].join(" "), copy(child));
  }
  if (k === words.length) return;
  const moved = (s) => ({ ...copy(s), cwd: chdir ? null : s.cwd });
  const next = one(words[k], state);
  if (k > 1 && one(words[k - 1], state)?.startsWith("-") && !WRAPPERS.has(basename(next ?? "")))
    checkRun(cmd, [words[0], ...words.slice(k + 1)], moved(state), moved(child));
  const run = words.slice(k + WRAPPERS.get(wrapper));
  if (!run.length) return;
  if (shell) checkLine(run.map((w) => single(w, state)).join(" "), moved(child));
  const input = wrapper === "xargs" ? [...(replace ? run.slice(1).map(() => XARGS_INPUT) : run.slice(1)), XARGS_INPUT] : run.slice(1);
  checkRun(cmd, [run[0], ...input], chdir ? moved(state) : state, chdir ? moved(child) : child);
}

// What xargs reads from its input: a word the guard can't work out.
const XARGS_INPUT = [{ name: "(xargs input)", op: "", quoted: true }];

// The names the guard has checks for, so that a command word it can only partly read
// (${X}git, g?t) is judged as each of them it could be.
const CHECKED = () => ["git", "gh", "rm", "diskutil", "dd", "eval", ...SHELLS, ...WRAPPERS.keys()];
function globMatches(pattern, name) {
  const source = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("[!", "[^").replaceAll("*", ".*").replaceAll("?", ".");
  try {
    return new RegExp(`^${source}$`).test(name);
  } catch {
    return false; // an unclosed [ matches only itself
  }
}

// A command word the guard can't read, or one that could split, vanish or match files,
// could be any command. What it could turn into is judged, and so are the words after it as
// a command of their own (it could be empty, or a wrapper). A push after it is judged as a
// git push, in a repo the guard can't name.
function checkUnread(cmd, words, state, child) {
  const [first, ...rest] = words;
  const as = (name) => checkRun(cmd, [[{ text: name, quoted: true }], ...rest], state, child);
  if (rest.length) checkRun(cmd, rest, state, child);
  const tail = first.slice(first.findLastIndex((p) => !("text" in p)) + 1).map((p) => p.text).join("");
  if (tail && tail !== raw(first)) as(tail);
  let values = [];
  try {
    values = expand(first, state);
  } catch (e) {
    if (!(e instanceof Unresolved)) throw e;
  }
  for (const v of values) {
    const pieces = v.split(/\s+/).filter(Boolean);
    if (pieces.length) checkRun(cmd, [...pieces.map((t) => [{ text: t, quoted: true }]), ...rest], state, child);
  }
  for (const pattern of [raw(first), ...values].filter((v) => /[*?[]/.test(v)))
    for (const name of CHECKED()) if (globMatches(basename(pattern), name)) as(name);
  const push = words.findIndex((w, k) => k > 0 && one(w, state) === "push");
  if (push !== -1 && one(first, state) === null)
    checkGitPush({ words, state, options: [{ name: "-C", value: null }], command: "push", at: push, unread: null }, child);
  staleAfter(state);
}

// The command string a shell's -c runs: its first operand after every option (-o and -O
// take a value, -- and - end the options). undefined without -c, null when it's missing.
function shellString(strings) {
  let c = false;
  let k = 1;
  for (; k < strings.length; k++) {
    const s = strings[k];
    if (s === "--" || s === "-") {
      k++;
      break;
    }
    if (/^[-+][a-zA-Z]+$/.test(s)) {
      c ||= s[0] === "-" && s.includes("c");
      if (/[oO]$/.test(s)) k++;
    } else if (s === "--rcfile" || s === "--init-file") k++;
    else if (!s.startsWith("--")) break;
  }
  if (!c) return undefined;
  return k < strings.length ? strings[k] : null;
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
  // set -a (or -o allexport) exports every variable assigned after it, until set +a.
  if (name === "set") {
    for (let k = 1; k < strings.length && strings[k] !== "--"; k++) {
      const s = strings[k];
      if (/^[-+]o$/.test(s) && strings[k + 1] === "allexport") state.allexport = s[0] === "-";
      else if (/^[-+][a-zA-Z]*a/.test(s)) state.allexport = s[0] === "-";
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
  // Whether the branch is still the one git reports, once this has run.
  let readOnly = checkGit(words, strings, state, child) || READ_ONLY.has(name);
  const [, sub, sub2] = strings;
  if (name === "gh" && sub === "repo" && sub2 === "delete") decide("ask", "deleting a GitHub repo");
  if (name === "gh" && sub === "api") checkGhApi(strings);
  if (name === "gh" && sub === "api" && strings.some((w) => /^(-X|--method)=?DELETE$/i.test(w) || w === "DELETE") && strings.some((w) => /^\/?repos\/[^/]+\/[^/]+\/?$/.test(w)))
    decide("ask", "deleting a GitHub repo");
  if (name === "diskutil" && /^(erase|zero|randomDisk|secureErase|partitionDisk)/i.test(sub ?? "")) decide("ask", `diskutil ${sub}`);
  if (name === "dd" && strings.some((w) => /^of=\/dev\//.test(w))) decide("ask", "dd to a device");

  // A command handed to another shell runs there: check it too, with what that shell inherits.
  if (SHELLS.has(name)) {
    const inherited = { ...child, vars: new Map([...child.vars].filter(([k]) => child.exported.has(k))) };
    const c = shellString(strings);
    if (c === null) decide("deny", `can't find the command ${name} -c runs, so the guard can't check it. Write it as ${name} -c '<command>' and run it again.`);
    if (c !== undefined) checkLine(c, inherited);
    else for (const doc of cmd.heredocs) checkLine(doc.body, inherited);
    // What runs there was checked, and marked the branch unknown if it could change it.
    readOnly = c !== undefined || cmd.heredocs.length > 0;
  }
  if (name === "eval") {
    checkLine(strings.slice(1).join(" "), copy(state));
    readOnly = true;
  }
  if (!readOnly) staleAfter(state);
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
const TOP = String.raw`(?:/|${ROOTISH}${CHILD})`;
// The path on its own, or as one choice of a brace expansion that starts the word ({~,/tmp/x}).
const RM_HARD = new RegExp(String.raw`${RM_FLAGS}[^\n;|&]*?(?:^|\s)["']?(?:${TOP}${END}|\{(?:[^\s{}]*,)*${TOP}/*\*?(?=[,}]))`);
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
  const start = (stale) => ({ vars: new Map(), exported: new Set(), cwd, depth: 0, repo: { stale, read: false, staleAfterRead: false, loop: false } });
  const first = start(false);
  checkLine(command, first);
  if (first.repo.loop && first.repo.staleAfterRead) checkLine(command, start(true));
}

// The hook's payload in, a Verdict (or null to stay out of it) back. Throws on a payload
// it can't read.
function judge(payload) {
  const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = payload;
  if (typeof tool !== "string") throw new TypeError("the payload names no tool");
  try {
    if (SHELL_TOOLS.has(tool)) {
      // Monitor can open a WebSocket instead of running a command.
      const socket = tool === "Monitor" && args?.command === undefined && args?.ws;
      if (!socket && typeof args?.command !== "string") throw new TypeError(`the ${tool} call has no command`);
      if (!socket) checkBash(args.command, cwd);
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
