// Closes the pages a session opened once that session ends, so the shared browser doesn't
// fill up with tabs nobody owns (a signed-in console left on its API keys, say).
//
// A session's pages are the ones its new_page calls created, plus the popups those opened.
// Sessions share the browser, so each new_page runs under a lock that every session's
// server takes: the pages that appear while it's held are this call's. Each session's list
// is a file named after the session, so a session that a pool switch restarts keeps its
// pages. When a server exits, its pages close a few minutes later unless the session is
// back by then, and any server that starts also closes what dead sessions left (one that
// was killed, or the Mac restarted). Pages a session didn't open, mine included, are
// never touched.
//
// The page lists are the only record of who owns what, and every change to one is made
// under the lock: a Chrome restart (home/bin/agent-browser-mode) rewrites them all, since
// Chrome gives the tabs it restores new IDs.
//
// Also a command line for home/lib/agent-browser.zsh:
//   node own-pages.mjs snapshot <browserUrl>          its pages, to stdout, before a restart
//   node own-pages.mjs remap <browserUrl> <snapshot>  give each session its pages back
//   node own-pages.mjs front <browserUrl>             bring the latest agent's tab forward
import { open, readdir, readFile, rename, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(homedir(), ".local/share/agent-browser/pages");
const LOCK = join(DIR, "new-page.lock");
// Longer than any new_page waits for its page to load.
const STALE_LOCK_MS = 120_000;
// How long a session's pages outlive its server: enough for a pool switch to bring it back.
const GRACE_MS = Number(process.env.AGENT_BROWSER_PAGE_GRACE_MS) || 180_000;
// How often a busy session marks itself active.
const ACTIVE_EVERY_MS = 10_000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lock() {
  await mkdir(DIR, { recursive: true });
  for (;;) {
    try {
      const file = await open(LOCK, "wx");
      await file.writeFile(String(process.pid));
      await file.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    // A holder that died, or hung, gives the lock up.
    const holder = Number(await readFile(LOCK, "utf8").catch(() => "")) || 0;
    const age = Date.now() - ((await stat(LOCK).catch(() => null))?.mtimeMs ?? Date.now());
    if ((holder && !alive(holder)) || age > STALE_LOCK_MS) await rm(LOCK, { force: true });
    else await sleep(100);
  }
}

async function unlock() {
  const holder = Number(await readFile(LOCK, "utf8").catch(() => "")) || 0;
  if (holder === process.pid) await rm(LOCK, { force: true });
}

async function locked(fn) {
  await lock();
  try {
    return await fn();
  } finally {
    await unlock();
  }
}

const readSession = (path) => readFile(path, "utf8").then(JSON.parse, () => null);

// Whole or not at all: a reader never sees half a file.
async function writeSession(path, session) {
  await mkdir(DIR, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(session));
  await rename(temp, path);
}

// Every session file, with its path.
async function sessions() {
  const names = (await readdir(DIR).catch(() => [])).filter((name) => name.endsWith(".json"));
  const all = await Promise.all(
    names.map(async (name) => ({ path: join(DIR, name), session: await readSession(join(DIR, name)) })),
  );
  return all.filter(({ session }) => session);
}

async function pageIds(browserUrl) {
  const targets = await (await fetch(`${browserUrl}/json/list`, { signal: AbortSignal.timeout(10_000) })).json();
  return new Set(targets.filter((t) => t.type === "page").map((t) => t.id));
}

// A DevTools connection to the browser itself, for a few calls.
async function connect(browserUrl) {
  const version = await (await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(10_000) })).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const waiting = new Map();
  ws.onmessage = ({ data }) => {
    const { id, result, error } = JSON.parse(data);
    const call = waiting.get(id);
    waiting.delete(id);
    if (error) call?.reject(new Error(error.message));
    else call?.resolve(result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      waiting.set(++next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params }));
    });
  const pages = async () => (await send("Target.getTargets")).targetInfos.filter((t) => t.type === "page");
  return { send, pages, close: () => ws.close() };
}

// These pages and every popup they (or their popups) opened.
function withPopups(ids, pages) {
  const all = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of pages)
      if (t.openerId && all.has(t.openerId) && !all.has(t.targetId)) {
        all.add(t.targetId);
        grew = true;
      }
  }
  return all;
}

// Closes these pages and every popup they (or their popups) opened.
async function closePages(browserUrl, ids) {
  if (ids.size === 0) return;
  const browser = await connect(browserUrl);
  try {
    const pages = await browser.pages();
    const doomed = withPopups(
      [...ids].filter((id) => pages.some((t) => t.targetId === id)),
      pages,
    );
    if (doomed.size === 0) return;
    // Every other session needs a page to land on: never close the last one.
    if (pages.every((t) => doomed.has(t.targetId)))
      await browser.send("Target.createTarget", { url: "about:blank", background: true });
    for (const targetId of doomed) await browser.send("Target.closeTarget", { targetId }).catch(() => {});
  } finally {
    browser.close();
  }
}

export function ownPages(browserUrl) {
  // By session, which outlives this process: a pool switch restarts the session's servers.
  const name = process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`;
  const file = join(DIR, `${name}.json`);
  const activeFile = join(DIR, `${name}.active`);
  // The same session back after a restart takes its pages back.
  const adopted = locked(async () => {
    const pages = (await readSession(file))?.pages ?? [];
    await writeSession(file, { browserUrl, pid: process.pid, pages });
  }).catch(() => {});
  // The pages open before the new_page under way, if one is (the lock allows one at a time).
  let pending = null;
  // Adds the pages that weren't open before. Only while holding the lock.
  const take = async (before) => {
    const added = [...(await pageIds(browserUrl))].filter((id) => !before.has(id));
    if (added.length === 0) return;
    const session = (await readSession(file)) ?? { browserUrl, pid: process.pid, pages: [] };
    session.pages = [...new Set([...session.pages, ...added])];
    await writeSession(file, session);
  };
  let lastActive = 0;
  return {
    // Call before a new_page goes to the server, and pass what it returns to opened().
    async opening() {
      await adopted;
      await lock();
      try {
        return (pending = await pageIds(browserUrl));
      } catch (error) {
        await unlock();
        throw error;
      }
    },
    // Call once that new_page has answered.
    async opened(before) {
      try {
        await take(before);
      } finally {
        pending = null;
        await unlock();
      }
    },
    // Call on every tool call: opening the browser shows the tab of the agent that used
    // it last.
    async active() {
      if (Date.now() - lastActive < ACTIVE_EVERY_MS) return;
      lastActive = Date.now();
      await mkdir(DIR, { recursive: true });
      await writeFile(activeFile, browserUrl);
    },
    // Call as the server exits. Its pages close a few minutes later, unless the session has
    // come back by then (a pool switch, /mcp reconnecting it).
    async release() {
      // A session can end while its new_page is still loading: that page is its too.
      if (pending) await take(pending).catch(() => {});
      await unlock().catch(() => {});
      const session = await readSession(file);
      if (!session?.pages.length) return;
      // The grace period counts from now.
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      spawn(process.execPath, [fileURLToPath(import.meta.url), "sweep-later"], { detached: true, stdio: "ignore" }).unref();
    },
  };
}

// Closes the pages of sessions that ended (their server gone) more than GRACE_MS ago.
export async function sweep() {
  for (const { path, session } of await sessions()) {
    try {
      const { browserUrl, pid, pages } = session;
      const { mtimeMs } = await stat(path);
      if (alive(pid) || Date.now() - mtimeMs < GRACE_MS) continue;
      await closePages(browserUrl, new Set(pages)).catch(() => {
        // Its browser isn't running: those pages are gone already.
      });
      await rm(path, { force: true });
      await rm(path.replace(/\.json$/, ".active"), { force: true });
    } catch {
      // Already swept by another server.
    }
  }
}

// Each page before a restart, matched to the one Chrome restored from it: the same URL
// first, in order (several tabs can share one). A tab whose URL changed on the way (a
// redirect, a sign-in that timed out) is matched by its position, but only when every
// tab came back, so a guess can never hand a session a tab that isn't its own.
export function match(before, after) {
  const matched = new Map();
  const used = new Set();
  for (const b of before) {
    const a = after.find((a) => !used.has(a.targetId) && a.url === b.url);
    if (a) {
      matched.set(b.targetId, a.targetId);
      used.add(a.targetId);
    }
  }
  if (before.length === after.length)
    before.forEach((b, i) => {
      const a = after[i];
      if (!matched.has(b.targetId) && !used.has(a.targetId)) {
        matched.set(b.targetId, a.targetId);
        used.add(a.targetId);
      }
    });
  return matched;
}

async function snapshot(browserUrl) {
  const browser = await connect(browserUrl);
  try {
    return (await browser.pages()).map(({ targetId, url, openerId }) => ({ targetId, url, openerId }));
  } finally {
    browser.close();
  }
}

// After a restart: waits for Chrome to bring its tabs back, then gives each session the
// ones that were its own (with their popups, whose openers are gone now).
async function remap(browserUrl, before) {
  if (before.length === 0) return;
  const browser = await connect(browserUrl);
  let after = [];
  try {
    for (let waited = 0, steady = 0; waited < 20_000 && steady < 1_000; waited += 250) {
      const now = await browser.pages();
      steady = now.length === after.length && now.length >= before.length ? steady + 250 : 0;
      after = now;
      await sleep(250);
    }
  } finally {
    browser.close();
  }
  const matched = match(before, after);
  await locked(async () => {
    for (const { path, session } of await sessions()) {
      if (session.browserUrl !== browserUrl) continue;
      const pages = [...withPopups(session.pages, before)].map((id) => matched.get(id)).filter(Boolean);
      // Not utimes-preserving on purpose: a rewritten list is a fresh start for the grace period.
      await writeSession(path, { ...session, pages });
    }
  });
}

// Selects, in this Chrome, the tab of the agent that used it last: its newest page that is
// still open. Any tab when no agent has one, a new tab when there is none. Bringing the
// app in front is Hammerspoon's (home/lib/agent-browser.zsh, agent_browser_front).
async function front(browserUrl) {
  const browser = await connect(browserUrl);
  try {
    const pages = await browser.pages();
    const recent = [];
    for (const { path, session } of await sessions()) {
      if (session.browserUrl !== browserUrl) continue;
      const active = await stat(path.replace(/\.json$/, ".active")).catch(() => stat(path));
      recent.push({ when: active.mtimeMs, pages: session.pages });
    }
    recent.sort((a, b) => b.when - a.when);
    const page =
      recent
        .flatMap(({ pages: ids }) => [...ids].reverse().map((id) => pages.find((p) => p.targetId === id)))
        .find(Boolean) ?? pages[0];
    if (page) await browser.send("Target.activateTarget", { targetId: page.targetId });
    else await browser.send("Target.createTarget", { url: "chrome://newtab/" });
  } finally {
    browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, browserUrl, arg] = process.argv.slice(2);
  if (command === "sweep-later") {
    await sleep(GRACE_MS + 5_000);
    await sweep();
  } else if (command === "snapshot") {
    process.stdout.write(JSON.stringify(await snapshot(browserUrl)));
  } else if (command === "remap") {
    await remap(browserUrl, JSON.parse((await readFile(arg, "utf8")) || "[]"));
  } else if (command === "front") {
    await front(browserUrl);
  } else {
    console.error(`own-pages: unknown command ${command}`);
    process.exit(2);
  }
}
