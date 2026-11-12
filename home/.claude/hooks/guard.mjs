// Has a session check with me before the few things that can't be undone, whatever its
// permission mode. Everything else runs as before.
//
// Sessions run with permissions skipped, often unattended, next to mail and a browser
// signed in to real accounts, so one instruction hidden in a page or an email could steer
// one. When I asked for the action, approving it is one click; when I didn't, it waits:
//
//   - sending, replying to or forwarding mail, and trashing mail, events or Drive files
//   - sharing a Google Drive file
//   - a force push to main or master (including a push with no branch named, from main)
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
// no one to ask (claude -p) is refused instead. Tests: node --test (guard.test.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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

// What $(inner) prints, where the guard can tell: mktemp and pwd.
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
      if (top(path) || top(dirname(path))) decide("ask", `rm -r ${raw(word)}${raw(word) === value ? "" : ` (${value})`}`);
    }
  }
}

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const flags = (words) => words.filter((w) => w.startsWith("-"));
const operands = (words) => words.filter((w) => !w.startsWith("-"));

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

function checkSimple(cmd, state) {
  let words = cmd.words;
  // Substitutions run first, each in a subshell.
  for (const word of words) for (const part of word) if (part.sub) checkLine(part.sub, copy(state));

  while (words.length && RESERVED.has(literal(words[0]))) words = words.slice(1);
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
  words = words.slice(lead);
  while (WRAPPERS.has(literal(words[0]))) {
    const wrapper = literal(words[0]);
    words = words.slice(1);
    while (words.length && (literal(words[0])?.startsWith("-") || (wrapper === "env" && assignment(words[0])))) {
      if (assignment(words[0])) assign(child, words[0], true);
      words = words.slice(1);
    }
  }
  if (!words.length) return;

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
  checkGitPush(strings, state.cwd ?? state.base);
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
  if (state.depth >= MAX_DEPTH) return;
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

function checkBash(command, cwd) {
  if (POOL_KEY.test(command)) decide("deny", "the claude-pool key is never read or copied");
  checkLine(command, { vars: new Map(), exported: new Set(), cwd, base: cwd, depth: 0 });
}

const input = JSON.parse(readFileSync(0, "utf8"));
const { tool_name: tool, tool_input: args = {}, cwd = process.cwd() } = input;
if (tool === "Bash") checkBash(args.command ?? "", cwd);
else if (["Read", "Edit", "Write"].includes(tool) && POOL_KEY.test(args.file_path ?? ""))
  decide("deny", "the claude-pool key is never read or copied");
else if (OUTWARD[tool]) decide("ask", OUTWARD[tool]);
