// Runs chrome-devtools-mcp with its pages kept behind whatever I'm using, and closed once
// the session that opened them ends (own-pages.mjs).
//
//   node background.mjs <chrome-devtools-mcp> [its arguments...]
//
// Two of its tools bring the agents' Chrome in front of my apps, where my typing could
// land in a browser signed in to real accounts: new_page opens in the foreground unless
// told otherwise, and select_page can call Page.bringToFront. This sits between Claude
// Code and the server and rewrites just those calls: new pages open in the background,
// and bringToFront is dropped. Agents lose nothing: background tabs load, take input and
// screenshot normally (select_page emulates focus, and agent-browser.zsh keeps their
// renderers at foreground priority).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ownPages, sweep } from "./own-pages.mjs";

const [server, ...args] = process.argv.slice(2);
const browserUrl = args[args.indexOf("--browserUrl") + 1];
const pages = ownPages(browserUrl);
sweep().catch(() => {});

const child = spawn(server, args, { stdio: ["pipe", "pipe", "inherit"] });
child.on("exit", async (code, signal) => {
  await pages.release().catch(() => {});
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));

function quiet(message) {
  if (message?.method !== "tools/call") return message;
  const { name, arguments: input = {} } = message.params ?? {};
  if (name === "new_page") input.background = true;
  else if (name === "select_page") delete input.bringToFront;
  else return message;
  message.params.arguments = input;
  return message;
}

const opensPage = (message) => message?.method === "tools/call" && message.params?.name === "new_page";

// new_page calls waiting for their answer, by request ID: the pages open before each.
const opening = new Map();

// The MCP stdio transport is one JSON-RPC message per line. Lines go on in order, each
// after the one before it, since a new_page first waits its turn for the page lock.
let queue = Promise.resolve();
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    queue = queue.then(async () => {
      let out = line;
      let message;
      try {
        message = JSON.parse(line);
        out = JSON.stringify(Array.isArray(message) ? message.map(quiet) : quiet(message));
      } catch {
        // Not JSON: pass it through untouched and let the server answer it.
      }
      for (const m of [message].flat())
        if (opensPage(m)) opening.set(m.id, await pages.opening().catch(() => null));
      child.stdin.write(out + "\n");
    });
  })
  .on("close", () => queue.then(() => child.stdin.end()));

createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  process.stdout.write(line + "\n");
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  for (const m of [message].flat()) {
    if (!m || !opening.has(m.id)) continue;
    const before = opening.get(m.id);
    opening.delete(m.id);
    if (before) pages.opened(before).catch(() => {});
  }
});
