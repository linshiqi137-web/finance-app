import { isValidDate } from './budget.js';
import { guessCategory } from './importers.js';

const STORAGE_KEY = 'little-ledger:v1';
const MAX_AMOUNT = 9_999_999_999.99;
export const DEFAULT_SETTINGS = Object.freeze({
  monthlyIncome: 0,
  fixedExpenses: 0,
  savingsGoal: 0,
  reserve: 0,
});

function validMoney(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
}

function validSettings(settings) {
  return settings && typeof settings === 'object' && !Array.isArray(settings) &&
    Object.keys(DEFAULT_SETTINGS).every(key => validMoney(settings[key]));
}

function validTransaction(item) {
  return item && typeof item.id === 'string' && item.id.length > 0 &&
    ['expense', 'income', 'transfer', 'refund'].includes(item.type) &&
    validMoney(item.amount) && item.amount > 0 && isValidDate(item.date) &&
    (item.time === undefined || (typeof item.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(item.time))) &&
    ['manual', 'wechat', 'alipay'].includes(item.source) &&
    (item.automatic === undefined || typeof item.automatic === 'boolean') &&
    (item.confidence === undefined || ['high', 'low'].includes(item.confidence)) &&
    ['category', 'note', 'counterparty', 'createdAt'].every(key => typeof item[key] === 'string');
}

export function validateBackup(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.transactions) ||
      !value.transactions.every(validTransaction) || !validSettings(value.settings) ||
      new Set(value.transactions.map(item => item.id)).size !== value.transactions.length) {
    throw new Error('备份格式无效或版本不受支持，请选择本应用导出的 JSON 备份。');
  }
  return { transactions: value.transactions.map(item => ({ ...item })),
    settings: Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, value.settings[key]])) };
}

export function exportBackup(state) {
  return JSON.stringify({ version: 1, ...validateBackup({ ...state, version: 1 }) }, null, 2);
}

export function restoreBackup(value) {
  return persist(validateBackup(value));
}

export function loadState() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    throw new Error('无法访问本地存储，请允许此网站存储数据后重试。');
  }
  if (raw === null) return { transactions: [], settings: { ...DEFAULT_SETTINGS } };
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error('本地数据无法读取，原始数据已保留，请勿清除浏览器数据。');
  }
  if (state?.version !== 1 || !Array.isArray(state.transactions) ||
      !state.transactions.every(validTransaction) || !validSettings(state.settings)) {
    throw new Error('本地数据格式异常，原始数据已保留，请勿清除浏览器数据。');
  }
  return { transactions: state.transactions, settings: state.settings };
}

function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...state }));
  } catch {
    throw new Error('保存失败，本地存储可能已满或不可用。请保留当前输入后重试。');
  }
  return state;
}

export function saveTransaction(transaction) {
  if (!validTransaction(transaction)) throw new Error('记账信息不完整，请检查金额和日期。');
  const state = loadState();
  if (state.transactions.some(item => item.id === transaction.id)) throw new Error('这笔记录已保存。');
  return persist({ ...state, transactions: [...state.transactions, transaction] });
}

export function saveSettings(settings) {
  if (!validSettings(settings)) throw new Error('请填写有效的非负金额。');
  return persist({ ...loadState(), settings: { ...settings } });
}

export function updateTransaction(transaction) {
  if (!validTransaction(transaction)) throw new Error('记账信息不完整，请检查金额和日期。');
  const state = loadState();
  if (!state.transactions.some(item => item.id === transaction.id)) throw new Error('这笔记录已不存在，请刷新明细。');
  return persist({ ...state, transactions: state.transactions.map(item => item.id === transaction.id ? transaction : item) });
}

export function deleteTransaction(id) {
  const state = loadState();
  return persist({ ...state, transactions: state.transactions.filter(item => item.id !== id) });
}

export function saveImportedTransactions(incoming) {
  const state = loadState();
  const transactions = [...state.transactions, ...incoming];
  validateBackup({ ...state, transactions, version: 1 });
  return persist({ ...state, transactions });
}

// One durable write before native ack. Stable IDs also cover a crash between save and ack.
export function saveNotificationTransactions(pending) {
  if (!Array.isArray(pending)) throw new Error('通知队列格式异常，尚未确认任何通知。');
  const state = loadState();
  const seen = new Set(state.transactions.map(item => item.id));
  const incoming = [];
  const ids = [];
  for (const item of pending) {
    if (!item || typeof item.id !== 'string' || !item.id ||
        !['wechat', 'alipay'].includes(item.source) || !['expense', 'income', 'transfer'].includes(item.type) ||
        !validMoney(item.amount) || item.amount === 0 || !Number.isSafeInteger(item.timestamp) ||
        !['high', 'low'].includes(item.confidence) || typeof item.text !== 'string' ||
        typeof item.counterparty !== 'string') throw new Error('通知记录格式异常，请保留数据后重试。');
    const date = new Date(item.timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error('通知日期无效。');
    const id = `notification:${item.source}:${item.id}`;
    ids.push(item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    incoming.push({
      id, source: item.source, type: item.type, amount: item.amount,
      counterparty: item.counterparty, note: item.text,
      category: item.type === 'transfer' ? '转账' : guessCategory(`${item.counterparty} ${item.text}`),
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      time: date.toTimeString().slice(0, 8), createdAt: date.toISOString(),
      automatic: true, confidence: item.confidence,
    });
  }
  const next = { ...state, transactions: [...state.transactions, ...incoming] };
  validateBackup({ ...next, version: 1 });
  return { state: incoming.length ? persist(next) : state, ids, added: incoming.length };
}
