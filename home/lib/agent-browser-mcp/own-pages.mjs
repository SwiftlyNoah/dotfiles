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
import { open, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
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

async function pageIds(browserUrl) {
  const targets = await (await fetch(`${browserUrl}/json/list`)).json();
  return new Set(targets.filter((t) => t.type === "page").map((t) => t.id));
}

// Closes these pages and every popup they (or their popups) opened.
async function closePages(browserUrl, ids) {
  if (ids.size === 0) return;
  const { webSocketDebuggerUrl } = await (await fetch(`${browserUrl}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
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
  try {
    const pages = (await send("Target.getTargets")).targetInfos.filter((t) => t.type === "page");
    const doomed = new Set([...ids].filter((id) => pages.some((t) => t.targetId === id)));
    for (let grew = true; grew; ) {
      grew = false;
      for (const t of pages)
        if (t.openerId && doomed.has(t.openerId) && !doomed.has(t.targetId)) {
          doomed.add(t.targetId);
          grew = true;
        }
    }
    if (doomed.size === 0) return;
    // Every other session needs a page to land on: never close the last one.
    if (pages.every((t) => doomed.has(t.targetId)))
      await send("Target.createTarget", { url: "about:blank", background: true });
    for (const targetId of doomed) await send("Target.closeTarget", { targetId }).catch(() => {});
  } finally {
    ws.close();
  }
}

export function ownPages(browserUrl) {
  // By session, which outlives this process: a pool switch restarts the session's servers.
  const file = join(DIR, `${process.env.CLAUDE_CODE_SESSION_ID || `pid-${process.pid}`}.json`);
  const owned = new Set();
  const save = async () => {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ browserUrl, pid: process.pid, pages: [...owned] }));
  };
  // The same session back after a restart takes its pages back.
  const adopted = readFile(file, "utf8")
    .then(async (text) => {
      for (const id of JSON.parse(text).pages ?? []) owned.add(id);
      await save();
    })
    .catch(() => {});
  // The pages open before the new_page under way, if one is (the lock allows one at a time).
  let pending = null;
  const take = async (before) => {
    for (const id of await pageIds(browserUrl)) if (!before.has(id)) owned.add(id);
  };
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
      await save();
    },
    // Call as the server exits. Its pages close a few minutes later, unless the session has
    // come back by then (a pool switch, /mcp reconnecting it).
    async release() {
      // A session can end while its new_page is still loading: that page is its too.
      if (pending) await take(pending).catch(() => {});
      await unlock().catch(() => {});
      if (owned.size === 0) return;
      await save();
      spawn(process.execPath, [fileURLToPath(import.meta.url), "sweep-later"], { detached: true, stdio: "ignore" }).unref();
    },
  };
}

// Closes the pages of sessions that ended (their server gone) more than GRACE_MS ago.
export async function sweep() {
  for (const name of await readdir(DIR).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const path = join(DIR, name);
    try {
      const { browserUrl, pid, pages } = JSON.parse(await readFile(path, "utf8"));
      const { mtimeMs } = await stat(path);
      if (alive(pid) || Date.now() - mtimeMs < GRACE_MS) continue;
      await closePages(browserUrl, new Set(pages)).catch(() => {
        // Its browser isn't running: those pages are gone already.
      });
      await rm(path, { force: true });
    } catch {
      // Written as we read it, or already swept by another server.
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "sweep-later") {
  await sleep(GRACE_MS + 5_000);
  await sweep();
}
