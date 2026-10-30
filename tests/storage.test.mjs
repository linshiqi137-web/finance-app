import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, loadState, saveSettings, saveTransaction, updateTransaction, deleteTransaction,
  saveImportedTransactions, validateBackup, exportBackup, restoreBackup } from '../js/store.js';
import { parseWechatCsv, mergeTransactions } from '../js/importers.js';
import { readFile } from 'node:fs/promises';

const incoming = parseWechatCsv(await readFile(new URL('./fixtures/wechat-example.csv', import.meta.url), 'utf8'));
describe('transaction storage and backup', () => {
  let storage;
  test.beforeEach(() => {
    storage = new Map();
    globalThis.localStorage = {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    };
  });

  function backup() {
    return { version: 1, transactions: mergeTransactions([], incoming).added.map(item => ({ ...item })),
      settings: { ...DEFAULT_SETTINGS, monthlyIncome: 1000, reserve: 100 } };
  }

  test('update and delete persist across reload while preserving source metadata and settings', () => {
    const original = incoming[0];
    saveSettings({ ...DEFAULT_SETTINGS, monthlyIncome: 1000 });
    saveTransaction(original);
    const other = incoming[1];
    saveTransaction(other);
    const edited = { ...original, amount: 20, category: '日用', date: '2026-09-30', note: '修改备注' };
    updateTransaction(edited);
    assert.deepEqual(loadState().transactions, [edited, other]);
    assert.equal(loadState().transactions[0].source, 'wechat');
    deleteTransaction(edited.id);
    assert.deepEqual(loadState().transactions, [other]);
    assert.equal(loadState().settings.monthlyIncome, 1000);
  });

  test('invalid updates and missing records leave the stored data intact', () => {
    saveTransaction(incoming[0]);
    const before = [...storage];
    for (const change of [{ amount: 0 }, { amount: -1 }, { date: '2026-02-30' },
      { time: '24:00:00' }, { source: 'unknown' }, { id: 'missing' }]) {
      assert.throws(() => updateTransaction({ ...incoming[0], ...change }));
    }
    assert.deepEqual([...storage], before);
  });

  test('batch import is atomic, persists unique records and rejects invalid rows or IDs', () => {
    const { added } = mergeTransactions([], incoming);
    saveImportedTransactions(added);
    assert.deepEqual(loadState().transactions, added);
    const before = [...storage];
    assert.throws(() => saveImportedTransactions([{ ...incoming[1], id: 'new' }, { ...incoming[0], amount: -1 }]));
    assert.throws(() => saveImportedTransactions([incoming[0]]));
    assert.deepEqual([...storage], before);
  });

  test('JSON export and restore round-trip all records, settings and version', () => {
    const expected = backup();
    restoreBackup(expected);
    const json = exportBackup(loadState());
    assert.deepEqual(JSON.parse(json), expected);
    deleteTransaction(expected.transactions[0].id);
    saveSettings(DEFAULT_SETTINGS);
    restoreBackup(JSON.parse(json));
    assert.deepEqual(loadState(), { transactions: expected.transactions, settings: expected.settings });
    assert.deepEqual(validateBackup(expected), loadState());
  });

  test('backup validation rejects malformed data, incompatible versions and duplicate IDs without writes', () => {
    const good = backup();
    restoreBackup(good);
    const before = [...storage];
    const invalid = [null, [], {}, { ...good, version: 2 }, { ...good, version: '1' },
      { ...good, transactions: {} }, { ...good, settings: [] },
      { ...good, settings: { ...good.settings, monthlyIncome: '1000' } },
      { ...good, settings: { ...good.settings, reserve: -1 } },
      { ...good, settings: { ...good.settings, reserve: Infinity } },
      { ...good, transactions: [good.transactions[0], good.transactions[0]] }];
    for (const change of [{ amount: 0 }, { amount: '12.5' }, { date: '2026-02-30' }, { time: null },
      { time: '12:99:00' }, { type: 'bad' }, { source: 'bad' }, { counterparty: null }, { id: '' }]) {
      invalid.push({ ...good, transactions: [{ ...good.transactions[0], ...change }] });
    }
    for (const value of invalid) {
      assert.throws(() => validateBackup(value), /备份格式/);
      assert.throws(() => restoreBackup(value), /备份格式/);
    }
    assert.deepEqual([...storage], before);
  });

  test('validated backups are copied, and legacy records without time can be restored', () => {
    const value = backup();
    delete value.transactions[0].time;
    const validated = validateBackup(value);
    validated.transactions[0].amount = 99;
    validated.settings.reserve = 5;
    assert.equal(value.transactions[0].amount, 12.5);
    assert.equal(value.settings.reserve, 100);
    restoreBackup(value);
    assert.equal(loadState().transactions[0].time, undefined);
  });

  test('explicit restore can recover corrupt storage, including an empty backup', () => {
    storage.set('little-ledger:v1', 'corrupt');
    assert.throws(loadState);
    restoreBackup(backup());
    assert.equal(loadState().transactions.length, 4);
    restoreBackup({ version: 1, transactions: [], settings: DEFAULT_SETTINGS });
    assert.deepEqual(loadState(), { transactions: [], settings: DEFAULT_SETTINGS });
  });

  test('quota failures during import, edit and restore retain previous data', () => {
    saveTransaction(incoming[0]);
    const before = [...storage];
    globalThis.localStorage.setItem = () => { throw new Error('quota'); };
    assert.throws(() => updateTransaction({ ...incoming[0], amount: 20 }), /保存失败/);
    assert.throws(() => deleteTransaction(incoming[0].id), /保存失败/);
    assert.throws(() => saveImportedTransactions([incoming[1]]), /保存失败/);
    assert.throws(() => restoreBackup(backup()), /保存失败/);
    assert.deepEqual([...storage], before);
  });

});
