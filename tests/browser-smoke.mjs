import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createServer } from 'node:http';

const chromePath = process.env.CHROME_BIN || ['/opt/ungoogled-chromium/chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
// 示例数据 / example data. Native APIs are mocked; no personal notifications or accounts.
test('browser PWA and native bridge: pending, recovery, diagnostics, manual fill and replay', { skip: !chromePath, timeout: 30000 }, async () => {
  const root = new URL('../', import.meta.url);
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const file = new URL(`.${path === '/' ? '/index.html' : path}`, root);
      if (!file.href.startsWith(root.href)) throw Error('invalid path');
      const content = await readFile(file);
      response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[extname(file.pathname)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = await mkdtemp(join(tmpdir(), 'jizhang-v04-browser-'));
  const chrome = spawn(chromePath, ['--headless=new', '--no-sandbox', '--no-zygote', '--single-process', '--disable-dev-shm-usage',
    '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run',
    '--disable-extensions', '--disable-breakpad', '--disable-crashpad-for-testing', '--allow-file-access-from-files',
    '--no-proxy-server', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let sequence = 0, buffered = '';
  const pending = new Map(), errors = [];
  chrome.stdio[4].on('data', chunk => {
    buffered += chunk.toString();
    let end;
    while ((end = buffered.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
        message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  try {
    for (const native of [false, true]) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const call = (method, params) => send(method, params, sessionId);
      await call('Page.enable'); await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 1, mobile: true });
      const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      await call('Page.addScriptToEvaluateOnNewDocument', { source: `
        localStorage.clear();
        ${native ? `
          window.example = {id:'delivery-1',event_id:'example-event',source:'wechat',event_time:Date.now(),amount:null,
            merchant:'示例食堂',direction:'expense',type:'expense',confidence:'low',status:'unresolved',matched_event_id:null};
          window.pendingEvents=[example];window.copies=0;window.log='[{"示例数据":"通知"}]';window.resolves=[];
          window.AndroidBridge={getPendingTransactions:()=>JSON.stringify(pendingEvents),
            ackTransactions:json=>{if(window.failAck)throw Error('示例确认失败');pendingEvents=pendingEvents.filter(e=>!JSON.parse(json).includes(e.id))},
            isNotificationAccessGranted:()=>true,isAccessibilityServiceEnabled:()=>true,
            getNotificationDiagnostics:()=>window.log,copyNotificationDiagnostics:()=>window.copies++,clearNotificationDiagnostics:()=>window.log='[]',
            resolvePaymentEvent:(id,amount)=>resolves.push([id,amount])};` : ''}
      ` });
      const navigation = await call('Page.navigate', { url });
      assert.equal(navigation.errorText, undefined, JSON.stringify(navigation));
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (await evaluate('document.querySelectorAll(".category-chip").length===7')) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(ready, true, JSON.stringify(errors));
      assert.equal(await evaluate('document.querySelector("#storage-error").hidden'), true);
      assert.equal(await evaluate('document.querySelector("#pending-events").hidden'), !native);
      assert.equal(await evaluate('document.querySelector("#record-count").textContent'), '0 笔记录');
      if (!native) {
        await evaluate(`document.querySelector('[data-tab=entry]').click();document.querySelector('#amount').value='12.50';document.querySelector('.category-chip').click()`);
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("little-ledger:v1")).transactions.length'), 1);
        assert.equal(await evaluate('document.querySelector("#android-settings").hidden'), true);
      } else {
        assert.equal(await evaluate('document.querySelectorAll("#pending-list form").length'), 1);
        await evaluate(`document.querySelector('[data-tab=settings]').click();for(let i=0;i<5;i++)document.querySelector('#app-version').click()`);
        assert.equal(await evaluate('document.querySelector("#diagnostics-dialog").open'), true);
        assert.match(await evaluate('document.querySelector("#diagnostics-content").textContent'), /示例数据/);
        await evaluate(`document.querySelector('#copy-diagnostics').click();document.querySelector('#clear-diagnostics').click()`);
        assert.equal(await evaluate('copies'), 1);
        assert.match(await evaluate('document.querySelector("#diagnostics-content").textContent'), /^\[\]/);
        await evaluate(`document.querySelector('#close-diagnostics').click();document.querySelector('[data-tab=home]').click();
          pendingEvents=[{...example,id:'delivery-2',status:'reconciled',matched_event_id:'example-receipt'},
          {...example,id:'delivery-3',event_id:'example-receipt',status:'confirmed',amount:12.5,matched_event_id:'example-event'}];
          window.failAck=true;window.onAndroidResume()`);
        assert.equal(await evaluate('document.querySelector("#pending-events").hidden'), true);
        assert.equal(await evaluate('document.querySelector("#record-count").textContent'), '1 笔记录');
        assert.match(await evaluate('document.querySelector("#month-spend").textContent'), /12\.50/);
        await evaluate('window.failAck=false;window.onAndroidResume();window.onAndroidResume()');
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("little-ledger:v1")).transactions.length'), 2);
        // Manually filling a withdrawal still must not create spending or income.
        await evaluate(`pendingEvents=[{...example,id:'withdraw-delivery',event_id:'example-withdraw',direction:'withdraw',type:'transfer'}];window.onAndroidResume();
          document.querySelector('#pending-list input').value='100';document.querySelector('#pending-list form').requestSubmit()`);
        assert.equal(await evaluate('document.querySelector("#pending-events").hidden'), true);
        assert.match(await evaluate('document.querySelector("#month-spend").textContent'), /12\.50/);
        assert.match(await evaluate('document.querySelector("#month-income").textContent'), /0\.00/);
        assert.equal(await evaluate('resolves.some(([id,amount])=>id==="example-withdraw"&&amount==="100")'), true);
      }
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      await send('Target.closeTarget', { targetId });
    }
    assert.deepEqual(errors, []);
  } finally {
    chrome.kill('SIGTERM');
    await new Promise(resolve => chrome.once('exit', resolve));
    await rm(profile, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  }
});
