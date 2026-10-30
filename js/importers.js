import { isValidDate } from './budget.js';

// No DOM, clock, randomness or storage: the same bill always produces the same records.
export function decodeBillBuffer(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gbk', { fatal: true }).decode(buffer);
  }
}

function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const pushField = () => { row.push(field.trim()); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || !field.trim()) quoted = !quoted;
      else field += char;
    } else if (char === ',' && !quoted) {
      pushField();
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushField(); rows.push(row); row = [];
    } else field += char;
  }
  if (quoted) throw new Error('账单 CSV 引号未闭合，请使用原始导出文件。');
  if (field.length || row.length) { pushField(); rows.push(row); }
  return rows;
}

export function guessCategory(text) {
  for (const [category, pattern] of [
    ['餐饮', /餐|饭|外卖|美团|饿了么|肯德基|麦当劳|瑞幸|星巴克|奶茶|咖啡|食堂/],
    ['交通', /滴滴|地铁|公交|铁路|12306|打车/],
    ['购物', /淘宝|京东|拼多多/],
    ['学习', /书|教育|课程|打印/],
    ['日用', /超市|便利店/],
    ['娱乐', /电影|游戏|视频会员/],
  ]) if (pattern.test(text)) return category;
  return '其他';
}

export function dedupKey(transaction) {
  return transaction.date + (transaction.time || '') + Number(transaction.amount).toFixed(2) + (transaction.counterparty || '');
}

// added is an array of new records; skipped counts duplicates, including within incoming.
export function mergeTransactions(existing, incoming) {
  const seen = new Set(existing.map(dedupKey));
  const usedIds = new Set(existing.map(item => item.id));
  const added = [];
  let skipped = 0;
  for (const transaction of incoming) {
    const key = dedupKey(transaction);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    let id = transaction.id;
    let suffix = 1;
    // An edited imported record retains its id; reimporting its old values must still work.
    while (usedIds.has(id)) id = `${transaction.id}:import-${suffix++}`;
    usedIds.add(id);
    added.push(id === transaction.id ? transaction : { ...transaction, id });
  }
  return { added, skipped };
}

function parseBill(text, source) {
  if (typeof text !== 'string') throw new TypeError('账单内容必须是文本。');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headerIndex = lines.findIndex(line => {
    if (!/交易时间|交易创建时间/.test(line) || !line.includes('收/支')) return false;
    const fields = csvRows(line)[0] || [];
    return fields.some(field => ['交易时间', '交易创建时间'].includes(field)) &&
      fields.some(field => ['金额', '金额(元)', '金额（元）'].includes(field));
  });
  if (headerIndex < 0) throw new Error('未找到账单表头，请选择微信或支付宝导出的 CSV 文件。');
  const [headers, ...rows] = csvRows(lines.slice(headerIndex).join('\n'));
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  const get = (row, ...names) => {
    for (const name of names) if (index[name] !== undefined) return (row[index[name]] || '').trim();
    return '';
  };
  const transactions = [];
  for (const row of rows) {
    const timestamp = get(row, '交易时间', '交易创建时间');
    const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(timestamp);
    if (!match) {
      // Export footers and blank lines are not transactions; date-like bad rows are errors.
      if (/^\d{4}[-/]/.test(timestamp)) throw new Error(`账单日期或时间无效：${timestamp}`);
      continue;
    }
    const [, date, time] = match;
    const kind = get(row, '交易类型', '交易分类');
    const status = get(row, '当前状态', '交易状态');
    if (/交易关闭|已关闭|失败/.test(`${kind} ${status}`)) continue;
    if (!isValidDate(date) || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) {
      throw new Error(`账单日期或时间无效：${timestamp}`);
    }
    const amountText = get(row, '金额(元)', '金额（元）', '金额').replace(/[¥￥,\s]/g, '');
    const amount = Number(amountText);
    if (!/^\d+(\.\d{1,2})?$/.test(amountText) || !Number.isFinite(amount) || amount <= 0 || amount > 9_999_999_999.99) {
      throw new Error(`账单金额无效：${timestamp}`);
    }
    const direction = get(row, '收/支');
    const type = /退款/.test(`${kind} ${status}`) ? 'refund'
      : direction === '支出' ? 'expense' : direction === '收入' ? 'income' : 'transfer';
    const counterparty = get(row, '交易对方');
    const product = get(row, '商品', '商品说明');
    const remark = get(row, '备注');
    const transaction = {
      date, time, type, amount: Math.round(amount * 100) / 100, counterparty, source,
      category: guessCategory(`${kind} ${counterparty} ${product} ${remark}`),
      note: [product, remark === '/' ? '' : remark].filter(value => value && value !== '/').join(' · '),
      createdAt: `${date}T${time}`,
    };
    const order = get(row, '交易单号', '交易订单号');
    transaction.id = `${source}:${order}:${dedupKey(transaction)}`;
    transactions.push(transaction);
  }
  return transactions;
}

export function parseWechatCsv(text) { return parseBill(text, 'wechat'); }
export function parseAlipayCsv(text) { return parseBill(text, 'alipay'); }
