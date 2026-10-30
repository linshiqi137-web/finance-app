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

const DIRECTIONS = ['expense', 'income', 'transfer_in', 'transfer_out', 'refund', 'withdraw'];
const STATUSES = ['candidate', 'confirmed', 'unresolved', 'reconciled', 'duplicate'];
function validEvent(item) {
  if (item.event_id === undefined) return item.status === undefined;
  return typeof item.event_id === 'string' && item.event_id.length > 0 &&
    Number.isSafeInteger(item.event_time) && Number.isFinite(new Date(item.event_time).getTime()) &&
    DIRECTIONS.includes(item.direction) && STATUSES.includes(item.status) &&
    typeof item.merchant === 'string' && (item.matched_event_id === null || typeof item.matched_event_id === 'string') &&
    (item.own_account === undefined || typeof item.own_account === 'boolean');
}

function validTransaction(item) {
  return item && typeof item.id === 'string' && item.id.length > 0 &&
    ['expense', 'income', 'transfer', 'refund'].includes(item.type) &&
    validEvent(item) && ((validMoney(item.amount) && item.amount > 0) ||
      (item.amount === null && ['candidate', 'unresolved', 'reconciled', 'duplicate'].includes(item.status))) && isValidDate(item.date) &&
    (item.time === undefined || (typeof item.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(item.time))) &&
    ['manual', 'wechat', 'alipay'].includes(item.source) &&
    (item.automatic === undefined || typeof item.automatic === 'boolean') &&
    (item.manually_filled === undefined || typeof item.manually_filled === 'boolean') &&
    (item.confidence === undefined || ['high', 'low'].includes(item.confidence)) &&
    ['category', 'note', 'counterparty', 'createdAt'].every(key => typeof item[key] === 'string');
}

export function validateBackup(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.transactions) ||
      !value.transactions.every(validTransaction) || !validSettings(value.settings) ||
      new Set(value.transactions.map(item => item.id)).size !== value.transactions.length ||
      new Set(value.transactions.filter(item => item.event_id).map(item => item.event_id)).size !== value.transactions.filter(item => item.event_id).length) {
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
  if (!Array.isArray(pending)) throw new Error('自动记账队列格式异常，尚未确认任何记录。');
  const state = loadState();
  if (pending.some(item => item?.event_id !== undefined)) return savePaymentEvents(pending, state);
  const seen = new Set(state.transactions.map(item => item.id));
  const incoming = [];
  const ids = [];
  for (const item of pending) {
    if (!item || typeof item.id !== 'string' || !item.id ||
        !['wechat', 'alipay'].includes(item.source) || !['expense', 'income', 'transfer'].includes(item.type) ||
        !validMoney(item.amount) || item.amount === 0 || !Number.isSafeInteger(item.timestamp) ||
        !['high', 'low'].includes(item.confidence) || typeof item.text !== 'string' ||
        typeof item.counterparty !== 'string') throw new Error('自动记账记录格式异常，请保留数据后重试。');
    const date = new Date(item.timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error('自动记账日期无效。');
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

// Delivery IDs belong to native queue revisions; event_id identifies the durable event.
// A terminal event never regresses when an old unacked delivery is replayed.
function savePaymentEvents(pending, state) {
  const transactions = state.transactions.map(item => ({ ...item }));
  const ids = [];
  let added = 0, changed = false;
  for (const raw of pending) {
    const event = raw?.event_id === undefined && raw && typeof raw.text === 'string' && typeof raw.counterparty === 'string' ? {
      ...raw, event_id: raw.id, event_time: raw.timestamp, merchant: raw.counterparty,
      direction: raw.type === 'transfer' ? 'transfer_out' : raw.type,
      status: 'confirmed', matched_event_id: null,
    } : raw;
    if (!event || typeof event.id !== 'string' || !event.id || !validEvent(event) ||
        !['wechat', 'alipay'].includes(event.source) || !['high', 'low'].includes(event.confidence) ||
        !['expense', 'income', 'transfer', 'refund'].includes(event.type) ||
        !((validMoney(event.amount) && event.amount > 0) || (event.amount === null && event.status !== 'confirmed'))) {
      throw new Error('自动记账事件格式异常，尚未确认任何记录。');
    }
    ids.push(event.id);
    const index = transactions.findIndex(item => item.event_id === event.event_id || item.id === `notification:${event.source}:${event.event_id}`);
    const previous = transactions[index];
    if (previous && (previous.status !== 'unresolved' && previous.status !== 'candidate' || previous.status === event.status)) continue;
    const date = new Date(event.event_time);
    const type = event.direction === 'withdraw' || event.own_account ? 'transfer' : event.type;
    const item = {
      id: previous?.id || `notification:${event.source}:${event.event_id}`,
      event_id: event.event_id, event_time: event.event_time, source: event.source,
      amount: event.amount, merchant: event.merchant, direction: event.direction,
      confidence: event.confidence,
      status: event.status === 'confirmed' && transactions.some(other => other.event_id === event.matched_event_id && other.manually_filled) ? 'duplicate' : event.status,
      matched_event_id: event.matched_event_id,
      own_account: event.own_account || false, direction_known: event.direction_known !== false, ambiguous: event.ambiguous || false,
      type, counterparty: event.merchant, note: event.text || previous?.note || '',
      category: type === 'transfer' ? '转账' : guessCategory(`${event.merchant} ${event.text || ''}`),
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      time: date.toTimeString().slice(0, 8), createdAt: date.toISOString(), automatic: true,
    };
    if (previous) transactions[index] = item;
    else { transactions.push(item); added++; }
    changed = true;
  }
  const next = { ...state, transactions };
  validateBackup({ ...next, version: 1 });
  return { state: changed ? persist(next) : state, ids, added, changed };
}

export function fillUnresolvedEvent(id, amount) {
  if (!validMoney(amount) || amount <= 0 || Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6)
    throw new Error('请填写大于零、最多两位小数的金额。');
  const state = loadState();
  const event = state.transactions.find(item => item.id === id && item.status === 'unresolved');
  if (!event) throw new Error('这笔待补全事件已处理，请刷新后重试。');
  if (event.direction_known === false) throw new Error('收支方向尚不明确，请显示微信支付凭证后再补全，或手动记账。');
  const resolved = { ...event, amount, status: 'confirmed', manually_filled: true };
  return updateTransaction(resolved);
}
