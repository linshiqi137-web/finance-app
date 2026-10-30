import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveNotificationTransactions, updateTransaction, exportBackup, restoreBackup } from '../js/store.js';

// 示例数据 / example data: fictional notifications, never inserted at app startup.
const example = (changes = {}) => ({
  id: 'example-notification', source: 'wechat', type: 'expense', amount: 12.5,
  counterparty: '示例瑞幸咖啡', text: '微信支付 已支付￥12.50',
  confidence: 'high', timestamp: new Date('2026-10-15T12:30:00+08:00').getTime(), ...changes,
});
let entries;
test.beforeEach(() => {
  entries = new Map();
  globalThis.localStorage = {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
});

test('native replay after save-before-ack retains edits and never inserts twice', () => {
  const first = saveNotificationTransactions([example(), example()]);
  assert.equal(first.added, 1);
  const item = first.state.transactions[0];
  assert.equal(item.source, 'wechat');
  assert.equal(item.automatic, true);
  assert.equal(item.category, '餐饮');
  updateTransaction({ ...item, category: '日用' });
  const replay = saveNotificationTransactions([example()]);
  assert.equal(replay.added, 0);
  assert.deepEqual(replay.ids, ['example-notification']);
  assert.equal(replay.state.transactions[0].category, '日用');
  restoreBackup(JSON.parse(exportBackup(replay.state)));
  assert.equal(loadState().transactions[0].automatic, true);
});

test('native batches are atomic on invalid data or storage failure', () => {
  assert.throws(() => saveNotificationTransactions([example(), example({ id: 'invalid', amount: -1 })]));
  assert.equal(entries.size, 0);
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => saveNotificationTransactions([example()]), /保存失败/);
  assert.equal(entries.size, 0);
});

test('notifications use keyword categories and preserve transfer semantics', () => {
  for (const [counterparty, category] of [['肯德基', '餐饮'], ['麦当劳', '餐饮'], ['星巴克', '餐饮'], ['滴滴', '交通'], ['12306', '交通'], ['京东', '购物'], ['未知商户', '其他']]) {
    const result = saveNotificationTransactions([example({ id: counterparty, counterparty })]);
    assert.equal(result.state.transactions.at(-1).category, category);
  }
  const result = saveNotificationTransactions([example({ id: 'transfer', type: 'transfer', source: 'alipay', counterparty: '滴滴' })]);
  assert.equal(result.state.transactions.at(-1).category, '转账');
  assert.equal(result.state.transactions.at(-1).type, 'transfer');
});
