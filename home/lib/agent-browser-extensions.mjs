// Reports the extensions in one shared browser's Chrome, from its own chrome://extensions
// page (chrome.developerPrivate, the API that page uses), over the DevTools port. The
// browser MCP refuses chrome:// pages, so home/bin/agent-browser-doctor asks here instead.
//
//   node agent-browser-extensions.mjs <port>
//
// Prints one JSON line per extension: {id, name, state, corrupt}. The page opens in the
// background and closes again; nothing on it is changed.
const port = process.argv[2];
const limit = AbortSignal.timeout(20000);
limit.addEventListener('abort', () => { console.error('agent-browser-extensions: timed out'); process.exit(1); });

const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: limit })).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
let next = 0;
const waiting = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++next;
  waiting.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const call = waiting.get(message.id);
  if (!call) return;
  waiting.delete(message.id);
  message.error ? call.reject(new Error(message.error.message)) : call.resolve(message.result);
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

const { targetId } = await send('Target.createTarget', { url: 'chrome://extensions', background: true });
try {
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  let list;
  for (let tries = 0; !list && tries < 40; tries++) {
    const { result } = await send('Runtime.evaluate', {
      expression: `typeof chrome?.developerPrivate?.getExtensionsInfo === 'function'
        ? new Promise(r => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, r)) : null`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    list = result.value;
    if (!list) await new Promise((r) => setTimeout(r, 250));
  }
  if (!list) throw new Error('chrome://extensions did not load');
  for (const e of list) {
    console.log(JSON.stringify({ id: e.id, name: e.name, state: e.state, corrupt: !!e.disableReasons?.corruptInstall }));
  }
} finally {
  await send('Target.closeTarget', { targetId }).catch(() => {});
  ws.close();
}
process.exit(0);
