// Closes the pages a session opened once that session ends, so the shared browser doesn't
// fill up with tabs nobody owns (a signed-in console left on its API keys, say).
//
// A session's pages are the ones its new_page calls created, plus the popups those opened.
// Sessions share the browser, so each new_page runs under a lock that every session's
// server takes: the pages that appear while it's held are this call's. Each server keeps
// its list in a file named after its process ID, and any server that starts closes the
// pages listed for a process that has died without cleaning up (killed, or the Mac
// restarted). Pages a session didn't open, mine included, are never touched.
import { open, readdir, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".local/share/agent-browser/pages");
const LOCK = join(DIR, "new-page.lock");
// Longer than any new_page waits for its page to load.
const STALE_LOCK_MS = 120_000;

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
  const file = join(DIR, `${process.pid}.json`);
  const owned = new Set();
  // The pages open before the new_page under way, if one is (the lock allows one at a time).
  let pending = null;
  const take = async (before) => {
    for (const id of await pageIds(browserUrl)) if (!before.has(id)) owned.add(id);
  };
  return {
    // Call before a new_page goes to the server, and pass what it returns to opened().
    async opening() {
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
      await writeFile(file, JSON.stringify({ browserUrl, pages: [...owned] }));
    },
    async closeAll() {
      // A session can end while its new_page is still loading: that page is its too.
      if (pending) await take(pending).catch(() => {});
      await unlock().catch(() => {});
      await closePages(browserUrl, owned);
      await rm(file, { force: true });
    },
  };
}

// Closes what dead sessions left behind.
export async function sweep() {
  for (const name of await readdir(DIR).catch(() => [])) {
    const pid = Number(name.replace(/\.json$/, ""));
    if (!name.endsWith(".json") || !pid || alive(pid)) continue;
    const path = join(DIR, name);
    try {
      const { browserUrl, pages } = JSON.parse(await readFile(path, "utf8"));
      await closePages(browserUrl, new Set(pages));
    } catch {
      // Its browser isn't running: those pages are gone already.
    }
    await rm(path, { force: true });
  }
}
