import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { computeDashboard, isValidDate } from '../js/budget.js';
import { DEFAULT_SETTINGS, loadState, saveSettings, saveTransaction } from '../js/store.js';

const settings = { monthlyIncome: 6000, fixedExpenses: 1500, savingsGoal: 1000, reserve: 500 };
const transaction = (type, amount, date, id = `${type}-${date}-${amount}`) => ({
  id, type, amount, category: '其他', note: '', date, counterparty: '', source: 'manual', createdAt: '2026-10-15T12:00:00.000Z',
});

test('carry-over includes today, offsets refunds, and excludes transfers and other months', () => {
  const data = [
    transaction('expense', 900, '2026-10-01'),
    transaction('refund', 100, '2026-10-10'),
    transaction('expense', 100, '2026-10-15'),
    transaction('refund', 20, '2026-10-15'),
    transaction('transfer', 2000, '2026-10-15'),
    transaction('income', 7000, '2026-10-15'),
    transaction('expense', 1000, '2026-09-30'),
    transaction('expense', 1000, '2026-11-01'),
  ];
  const before = JSON.stringify({ data, settings });
  const result = computeDashboard(data, settings, '2026-10-15');
  assert.equal(result.remainingDays, 17);
  assert.equal(result.spendable, 3000);
  assert.equal(result.monthNetSpend, 880);
  assert.equal(result.todayNetSpend, 80);
  assert.equal(result.monthIncome, 7000);
  assert.equal(result.todaySuggested, 2200 / 17);
  assert.equal(result.todayRemaining, 2200 / 17 - 80);
  assert.equal(result.projectedSavings, 3120); // Uses settings income even when actual income is larger.
  assert.equal(result.isOverBudget, false);
  assert.equal(JSON.stringify({ data, settings }), before);
});

test('month starts, month ends, leap years, and year boundaries', () => {
  for (const [date, expected] of [['2026-10-01', 31], ['2026-10-31', 1], ['2024-02-01', 29], ['2024-02-29', 1], ['2026-02-01', 28], ['2026-12-31', 1], ['2027-01-01', 31]]) {
    assert.equal(computeDashboard([], settings, date).remainingDays, expected, date);
  }
});

test('zero budgets and negative budgets remain unclamped', () => {
  assert.equal(computeDashboard([], DEFAULT_SETTINGS, '2026-10-31').todayRemaining, 0);
  const result = computeDashboard([transaction('expense', 4000, '2026-10-31')], settings, '2026-10-31');
  assert.equal(result.todaySuggested, 3000);
  assert.equal(result.todayRemaining, -1000);
  assert.equal(result.isOverBudget, true);
  const overspent = computeDashboard([transaction('expense', 5000, '2026-10-30')], settings, '2026-10-31');
  assert.equal(overspent.todaySuggested, -2000);
  assert.equal(overspent.projectedSavings, -1000);
});

test('a refund-only day can have negative net spending', () => {
  const result = computeDashboard([transaction('refund', 30, '2026-10-31')], settings, '2026-10-31');
  assert.equal(result.todayNetSpend, -30);
  assert.equal(result.todayRemaining, 3030);
  assert.equal(result.monthIncome, 0);
});

test('sums currency in cents and retains fractional daily suggestions', () => {
  const result = computeDashboard([transaction('expense', 0.1, '2026-10-15'), transaction('expense', 0.2, '2026-10-15')], settings, '2026-10-15');
  assert.equal(result.todayNetSpend, 0.3);
  assert.equal(result.todaySuggested, 3000 / 17);
});

test('future records affect monthly totals but not the before-today allocation', () => {
  const result = computeDashboard([transaction('expense', 200, '2026-10-31')], settings, '2026-10-15');
  assert.equal(result.monthNetSpend, 200);
  assert.equal(result.todaySuggested, 3000 / 17);
  assert.equal(result.todayNetSpend, 0);
});

test('validates calendar dates without timezone conversion', () => {
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '', undefined]) {
    assert.equal(isValidDate(value), false);
    assert.throws(() => computeDashboard([], settings, value), TypeError);
  }
  assert.equal(isValidDate('2024-02-29'), true);
});

let entries;
test.beforeEach(() => {
  entries = new Map();
  globalThis.localStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
});

test('new storage is empty; settings and all transaction fields survive reload', () => {
  assert.deepEqual(loadState(), { transactions: [], settings: DEFAULT_SETTINGS });
  saveSettings(settings);
  const item = { ...transaction('refund', 12.34, '2026-10-15'), time: '23:59:59', note: '餐费退回', counterparty: '小店', source: 'wechat' };
  saveTransaction(item);
  assert.deepEqual(loadState(), { transactions: [item], settings });
  saveSettings({ ...settings, reserve: 100 });
  assert.deepEqual(loadState().transactions, [item]);
});

test('duplicate ids and invalid amounts, dates, settings are rejected without changing storage', () => {
  const item = transaction('expense', 10, '2026-10-15');
  saveTransaction(item);
  const before = [...entries];
  assert.throws(() => saveTransaction(item));
  for (const amount of [-1, 0, NaN, Infinity]) assert.throws(() => saveTransaction({ ...item, id: 'bad', amount }));
  assert.throws(() => saveTransaction({ ...item, id: 'bad', date: '2026-02-30' }));
  assert.throws(() => saveSettings({ ...settings, reserve: -1 }));
  assert.deepEqual([...entries], before);
});

test('corrupt and incompatible stored data is preserved', () => {
  for (const raw of ['broken json', JSON.stringify({ version: 9 }), JSON.stringify({ version: 1, transactions: [{}], settings })]) {
    entries.set('little-ledger:v1', raw);
    assert.throws(loadState);
    assert.throws(() => saveSettings(settings));
    assert.equal(entries.get('little-ledger:v1'), raw);
  }
});

test('storage access and quota failures are reported', () => {
  globalThis.localStorage.getItem = () => { throw new Error('denied'); };
  assert.throws(loadState, /无法访问本地存储/);
  globalThis.localStorage.getItem = () => null;
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => saveTransaction(transaction('expense', 1, '2026-10-15')), /保存失败/);
});

test('offline shell references exist and service worker serves them without a connection', async () => {
  const handlers = {};
  const cached = new Map();
  let claimed = false;
  let skipped = false;
  const deleted = [];
  const cache = {
    async addAll(paths) {
      for (const path of paths) {
        const file = path === './' ? './index.html' : path;
        const content = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
        cached.set(new URL(path, 'https://ledger.test/').href, content);
      }
    },
    async match(request) { return cached.get(new URL(typeof request === 'string' ? request : request.url, 'https://ledger.test/').href); },
  };
  const context = {
    URL,
    self: {
      location: { origin: 'https://ledger.test' },
      registration: { scope: 'https://ledger.test/' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      skipWaiting: () => { skipped = true; },
      clients: { claim: () => { claimed = true; } },
    },
    caches: {
      open: async () => cache,
      keys: async () => ['little-ledger-shell-old', 'another-app-cache', 'little-ledger-shell-v1', 'little-ledger-shell-v3'],
      delete: async key => { deleted.push(key); },
    },
    fetch: async () => { throw new Error('offline'); },
  };
  vm.runInNewContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), context);
  let pending;
  handlers.install({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(skipped, true);
  handlers.activate({ waitUntil: promise => { pending = promise; } });
  await pending;
  assert.equal(claimed, true);
  assert.deepEqual(deleted, ['little-ledger-shell-old', 'little-ledger-shell-v1']);
  for (const [url, expected] of [
    ['https://ledger.test/', '<!doctype html>'],
    ['https://ledger.test/js/app.js', 'computeDashboard'],
    ['https://ledger.test/js/importers.js', 'parseWechatCsv'],
    ['https://ledger.test/?installed=1', '<!doctype html>'],
  ]) {
    let response;
    handlers.fetch({ request: { method: 'GET', url, mode: url.includes('/js/') ? 'cors' : 'navigate' }, respondWith: promise => { response = promise; } });
    assert.ok((await response).includes(expected));
  }
  for (const request of [
    { method: 'GET', url: 'https://external.test/', mode: 'cors' },
    { method: 'POST', url: 'https://ledger.test/', mode: 'cors' },
    { method: 'GET', url: 'https://ledger.test/unrelated', mode: 'cors' },
  ]) {
    handlers.fetch({ request, respondWith: () => assert.fail('unrelated request intercepted') });
  }
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) await readFile(new URL(`../${icon.src}`, import.meta.url));
});
