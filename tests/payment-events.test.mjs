import test from 'node:test';
import assert from 'node:assert/strict';
import { saveNotificationTransactions, fillUnresolvedEvent, loadState, exportBackup, restoreBackup, updateTransaction, DEFAULT_SETTINGS } from '../js/store.js';
import { computeDashboard, computeCategoryBreakdown } from '../js/budget.js';
import { parseWechatCsv } from '../js/importers.js';

// 示例数据 / example data. Fabricated events only; never seeded into app storage.
const example = (changes = {}) => ({
  id: 'delivery-1', event_id: 'example-event-1', source: 'wechat',
  event_time: new Date('2026-10-31T12:30:00+08:00').getTime(), amount: null,
  merchant: '示例食堂', direction: 'expense', type: 'expense',
  confidence: 'low', status: 'unresolved', matched_event_id: null, ...changes,
});
let entries;
test.beforeEach(() => {
  entries = new Map();
  globalThis.localStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
});
const dashboard = state => computeDashboard(state.transactions, DEFAULT_SETTINGS, '2026-10-31');

test('opaque notifications remain durable, backed up and excluded from all statistics', () => {
  const first = saveNotificationTransactions([example()]);
  assert.equal(first.state.transactions[0].status, 'unresolved');
  assert.equal(first.state.transactions[0].amount, null);
  assert.equal(dashboard(first.state).monthNetSpend, 0);
  assert.deepEqual(computeCategoryBreakdown(first.state.transactions, '2026-10'), { total: 0, categories: [] });
  const backup = JSON.parse(exportBackup(first.state));
  restoreBackup(backup);
  assert.equal(loadState().transactions[0].event_id, 'example-event-1');
  assert.deepEqual(saveNotificationTransactions([example()]).ids, ['delivery-1']);
  assert.equal(loadState().transactions.length, 1);
});

test('recovery reconciles original and counts only confirmed receipt, including replay after ack failure', () => {
  saveNotificationTransactions([example()]);
  const reconciled = example({ id: 'delivery-2', status: 'reconciled', matched_event_id: 'example-receipt' });
  const confirmed = example({ id: 'delivery-3', event_id: 'example-receipt', amount: 12.5, confidence: 'high', status: 'confirmed', matched_event_id: 'example-event-1' });
  const result = saveNotificationTransactions([example(), reconciled, confirmed]);
  assert.equal(result.state.transactions.length, 2);
  assert.equal(result.state.transactions.filter(item => item.status === 'unresolved').length, 0);
  assert.equal(dashboard(result.state).monthNetSpend, 12.5);
  const item = result.state.transactions.find(item => item.status === 'confirmed');
  updateTransaction({ ...item, amount: 15, category: '其他' });
  const replay = saveNotificationTransactions([example(), reconciled, confirmed]);
  assert.equal(dashboard(replay.state).monthNetSpend, 15);
  assert.equal(replay.state.transactions[0].status, 'reconciled');
});

test('candidate, duplicate, reconciled and unresolved statuses cannot enter totals even if amount is present', () => {
  const statuses = ['candidate', 'duplicate', 'reconciled', 'unresolved'];
  const result = saveNotificationTransactions(statuses.map((status, i) => example({ id: `delivery-${i}`, event_id: `example-${i}`, status, amount: 100 })));
  assert.equal(dashboard(result.state).monthNetSpend, 0);
  assert.equal(computeCategoryBreakdown(result.state.transactions, '2026-10').total, 0);
});

test('withdrawal and own-account events stay excluded even when old heuristics or edits label them income/expense', () => {
  const result = saveNotificationTransactions([
    example({ amount: 100, status: 'confirmed', direction: 'withdraw', type: 'income' }),
    example({ id: 'delivery-2', event_id: 'example-own', amount: 200, status: 'confirmed', direction: 'transfer_out', own_account: true }),
  ]);
  assert.ok(result.state.transactions.every(item => item.type === 'transfer'));
  const changed = result.state.transactions.map(item => ({ ...item, type: 'expense' }));
  assert.equal(dashboard({ transactions: changed }).monthNetSpend, 0);
  assert.equal(dashboard(result.state).monthIncome, 0);
  assert.equal(computeCategoryBreakdown(changed, '2026-10').total, 0);
});

test('optional manual fill validates cents, survives backup and closes late native recovery without double counting', () => {
  const { state } = saveNotificationTransactions([example()]);
  const id = state.transactions[0].id;
  for (const amount of [0, -1, 1.001, NaN, Infinity]) assert.throws(() => fillUnresolvedEvent(id, amount));
  fillUnresolvedEvent(id, 12.5);
  const late = saveNotificationTransactions([
    example({ id: 'reconciled', status: 'reconciled', matched_event_id: 'late-receipt' }),
    example({ id: 'receipt', event_id: 'late-receipt', amount: 12.5, status: 'confirmed', matched_event_id: 'example-event-1' }),
  ]);
  assert.equal(dashboard(late.state).monthNetSpend, 12.5);
  assert.equal(late.state.transactions.find(item => item.event_id === 'late-receipt').status, 'duplicate');
  restoreBackup(JSON.parse(exportBackup(late.state)));
  assert.equal(loadState().transactions[0].manually_filled, true);
});

test('invalid events and storage failure leave the whole native batch unacknowledged and unchanged', () => {
  for (const changes of [{ status: 'bad' }, { event_time: 'now' }, { direction: 'transfer' }, { matched_event_id: 4 }, { status: 'confirmed', amount: null }]) {
    assert.throws(() => saveNotificationTransactions([example(), example({ ...changes, id: 'bad', event_id: 'bad' })]));
    assert.equal(entries.size, 0);
  }
  globalThis.localStorage.setItem = () => { throw Error('quota'); };
  assert.throws(() => saveNotificationTransactions([example()]), /保存失败/);
  assert.equal(entries.size, 0);
});

test('v0.3 pending notifications and v0.4 events migrate together in one atomic batch', () => {
  const old = { id: 'v03', source: 'wechat', type: 'expense', amount: 10, confidence: 'high', timestamp: example().event_time, counterparty: '示例书店', text: '示例数据 已支付￥10.00' };
  const result = saveNotificationTransactions([old, example()]);
  assert.equal(result.state.transactions.length, 2);
  assert.deepEqual(result.ids, ['v03', 'delivery-1']);
  assert.equal(dashboard(result.state).monthNetSpend, 10);
  saveNotificationTransactions([old, example()]);
  assert.equal(loadState().transactions.length, 2);
});

test('CSV withdrawal/own-account classification overrides the exported income or expense column', () => {
  const header = '交易时间,交易类型,交易对方,收/支,金额(元),当前状态\n';
  for (const [kind, name, direction] of [['零钱提现', '示例银行', '收入'], ['转账', '本人账户', '支出']]) {
    const [row] = parseWechatCsv(`${header}2026-10-31 12:00:00,${kind},${name},${direction},100.00,成功`);
    assert.equal(row.type, 'transfer');
  }
});

test('unknown direction is displayed as unresolved and cannot become spending through amount-only fill', () => {
  const { state } = saveNotificationTransactions([example({ direction_known: false })]);
  assert.throws(() => fillUnresolvedEvent(state.transactions[0].id, 12.5), /方向/);
  assert.equal(dashboard(loadState()).monthNetSpend, 0);
});
