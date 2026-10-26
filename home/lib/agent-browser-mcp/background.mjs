// Runs chrome-devtools-mcp with its pages kept behind whatever I'm using.
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

const [server, ...args] = process.argv.slice(2);
const child = spawn(server, args, { stdio: ["pipe", "inherit", "inherit"] });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
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

// The MCP stdio transport is one JSON-RPC message per line.
createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    let out = line;
    try {
      const message = JSON.parse(line);
      out = JSON.stringify(Array.isArray(message) ? message.map(quiet) : quiet(message));
    } catch {
      // Not JSON: pass it through untouched and let the server answer it.
    }
    child.stdin.write(out + "\n");
  })
  .on("close", () => child.stdin.end());
