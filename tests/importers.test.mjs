import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseWechatCsv, parseAlipayCsv, decodeBillBuffer, dedupKey, mergeTransactions, guessCategory } from '../js/importers.js';
import { computeDashboard, computeCategoryBreakdown } from '../js/budget.js';
import { DEFAULT_SETTINGS } from '../js/store.js';

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const wechat = (await fixture('wechat-example.csv')).toString('utf8');
const alipay = (await fixture('alipay-example.csv')).toString('utf8');

for (const [name, parser, text, source, amount, category] of [
  ['WeChat', parseWechatCsv, wechat, 'wechat', 12.5, '餐饮'],
  ['Alipay', parseAlipayCsv, alipay, 'alipay', 32, '购物'],
]) {
  test(`${name}: skips info rows, closed and failed rows; keeps refunds, transfers and duplicates`, () => {
    const rows = parser(text);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(item => item.type), ['expense', 'income', 'transfer', 'refund', 'expense']);
    assert.ok(rows.every(item => item.source === source));
    assert.equal(rows[0].amount, amount);
    assert.equal(rows[0].category, category);
    assert.equal(rows[3].category, category);
    assert.equal(rows[0].date, source === 'wechat' ? '2026-10-01' : '2026-10-10');
    assert.equal(rows[0].time, source === 'wechat' ? '12:30:00' : '10:20:30');
    assert.deepEqual(parser(text), rows, 'parser is deterministic');
    assert.equal(dedupKey(rows[0]), dedupKey(rows[4]));
    assert.equal(rows[0].id, rows[4].id);
  });
}

test('Alipay trims tabs and spaces and preserves quoted commas and escaped quotes', () => {
  const rows = parseAlipayCsv(alipay);
  assert.equal(rows[0].counterparty, '示例京东商城');
  assert.equal(rows[0].note, '示例商品, "小物件" · 示例数据');
  assert.equal(rows[1].amount, 500);
  const variant = alipay.replace('交易创建时间', '交易时间');
  assert.deepEqual(parseAlipayCsv(variant), rows);
});

test('CSV supports multiline quoted fields, CRLF, BOM, and quoted headers', () => {
  const text = '\uFEFF示例数据 / example data\r\n"交易时间","交易类型","交易对方","商品","收/支","金额(元)","当前状态"\r\n' +
    '"2026-10-31 23:59:59",消费,"示例,商户","第一行\r\n第二行 ""引号""",支出,￥1.20,支付成功\r\n';
  const [row] = parseWechatCsv(text);
  assert.equal(row.note, '第一行\n第二行 "引号"');
  assert.equal(row.counterparty, '示例,商户');
  assert.equal(row.amount, 1.2);
  assert.equal(row.time, '23:59:59');
});

test('direction maps blank, slash and 不计收支 to transfer; refund overrides direction', () => {
  const header = '交易时间,交易类型,交易对方,收/支,金额(元),当前状态\n';
  const parse = (direction, kind = '零钱提现', status = '成功') => parseWechatCsv(header +
    `2026-10-31 12:00:00,${kind},本人示例账户,${direction},10.00,${status}`)[0];
  for (const direction of ['', '/', '不计收支']) assert.equal(parse(direction).type, 'transfer');
  assert.equal(parse('收入', '转账').type, 'income');
  assert.equal(parse('支出', '消费').type, 'expense');
  assert.equal(parse('/', '商户退款').type, 'refund');
  assert.equal(parse('不计收支', '消费', '退款成功').type, 'refund');
  assert.equal(parse('收入', '退款', '退款失败'), undefined);
});

test('malformed headers, dates, amounts and truncated CSV are rejected', () => {
  assert.throws(() => parseWechatCsv('示例数据\n没有账单'), /表头/);
  assert.throws(() => parseAlipayCsv(null), TypeError);
  for (const date of ['2026-02-30 12:00:00', '2026-10-01 25:00:00', '2026-10-01 12:00']) {
    assert.throws(() => parseWechatCsv(wechat.replaceAll('2026-10-01 12:30:00', date)), /日期或时间/);
  }
  for (const amount of ['¥abc', '¥0', '¥-1', '¥1.234', '¥10000000000.00']) {
    assert.throws(() => parseWechatCsv(wechat.replaceAll('¥12.50', amount)), /金额/);
  }
  assert.throws(() => parseWechatCsv(wechat + '\n"unterminated'), /引号/);
});

test('all keyword families map to the requested categories', () => {
  const families = {
    餐饮: ['餐', '饭', '外卖', '美团', '饿了么', '奶茶', '咖啡', '食堂'],
    交通: ['滴滴', '地铁', '公交', '铁路', '12306', '打车'],
    购物: ['淘宝', '京东', '拼多多'], 学习: ['书', '教育', '课程', '打印'],
    日用: ['超市', '便利店'], 娱乐: ['电影', '游戏', '视频会员'],
  };
  for (const [category, keywords] of Object.entries(families)) {
    for (const keyword of keywords) assert.equal(guessCategory(keyword), category, keyword);
  }
  assert.equal(guessCategory('未知示例商户'), '其他');
});

test('UTF-8 (including BOM) and real GBK bytes decode to the same Alipay records', async () => {
  const gbk = await fixture('alipay-example-gbk.csv');
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(gbk));
  assert.equal(decodeBillBuffer(gbk), alipay);
  const utf8 = await fixture('alipay-example.csv');
  const buffer = utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength);
  assert.equal(decodeBillBuffer(buffer), alipay);
  assert.equal(decodeBillBuffer(new TextEncoder().encode('\uFEFF' + alipay)), alipay);
  assert.deepEqual(parseAlipayCsv(decodeBillBuffer(gbk)), parseAlipayCsv(alipay));
  assert.ok(decodeBillBuffer(await fixture('wechat-example.csv')).startsWith('示例数据 / example data'));
});

test('dedup key uses date, time, amount to two decimals and counterparty, across sources', () => {
  const [item] = parseWechatCsv(wechat);
  assert.equal(dedupKey(item), `${item.date}${item.time}12.50${item.counterparty}`);
  assert.equal(dedupKey(item), dedupKey({ ...item, source: 'manual', id: 'different', amount: 12.5001 }));
  for (const change of [{ date: '2026-10-02' }, { time: '00:00:00' }, { amount: 12.51 }, { counterparty: '另一示例商户' }]) {
    assert.notEqual(dedupKey(item), dedupKey({ ...item, ...change }));
  }
});

test('merge skips duplicates within a file and against existing records without mutation', () => {
  const incoming = parseWechatCsv(wechat);
  const before = JSON.stringify(incoming);
  const first = mergeTransactions([], incoming);
  assert.equal(first.added.length, 4);
  assert.equal(first.skipped, 1);
  const existing = first.added.map(item => Object.freeze({ ...item }));
  const again = mergeTransactions(Object.freeze(existing), Object.freeze(incoming));
  assert.deepEqual(again, { added: [], skipped: 5 });
  assert.equal(JSON.stringify(incoming), before);
  assert.deepEqual(mergeTransactions([], []), { added: [], skipped: 0 });
});

test('reimporting an edited record preserves unique IDs without changing existing records', () => {
  const [original] = parseWechatCsv(wechat);
  const edited = { ...original, amount: 50 };
  const { added, skipped } = mergeTransactions([edited], [original, original]);
  assert.equal(added.length, 1);
  assert.equal(skipped, 1);
  assert.notEqual(added[0].id, edited.id);
  assert.equal(added[0].amount, original.amount);
  assert.equal(original.id, edited.id);
});

test('imported expenses/refunds offset and transfers stay out of the last-day budget', () => {
  const data = mergeTransactions([], [...parseWechatCsv(wechat), ...parseAlipayCsv(alipay)]).added;
  const result = computeDashboard(data, { ...DEFAULT_SETTINGS, monthlyIncome: 25 }, '2026-10-31');
  assert.equal(result.monthNetSpend, 30); // 12.50 - 2.50 + 32 - 12
  assert.equal(result.monthIncome, 1500);
  assert.equal(result.remainingDays, 1);
  assert.equal(result.todaySuggested, -5);
  assert.equal(result.todayRemaining, -5);
  assert.equal(result.isOverBudget, true);
  const summary = computeCategoryBreakdown(data, '2026-10');
  assert.equal(summary.total, 30);
  assert.deepEqual(summary.categories.map(item => [item.category, item.amount]), [['购物', 20], ['餐饮', 10]]);
  assert.ok(Math.abs(summary.categories.reduce((sum, item) => sum + item.percentage, 0) - 100) < 1e-10);
});

test('category breakdown handles cents, zero/negative net totals and signed refunds', () => {
  const item = (type, amount, category, date = '2024-02-29') => ({ type, amount, category, date });
  const data = [item('expense', 0.1, '餐饮'), item('expense', 0.2, '餐饮'), item('refund', 0.3, '餐饮'),
    item('transfer', 100, '转账'), item('income', 50, '兼职'), item('expense', 200, '购物', '2024-03-01')];
  assert.deepEqual(computeCategoryBreakdown(data, '2024-02'), { total: 0, categories: [{ category: '餐饮', amount: 0, percentage: null }] });
  assert.deepEqual(computeCategoryBreakdown([item('refund', 10, '购物')], '2024-02'), {
    total: -10, categories: [{ category: '购物', amount: -10, percentage: null }],
  });
  assert.deepEqual(computeCategoryBreakdown([], '2024-02'), { total: 0, categories: [] });
  const signed = computeCategoryBreakdown([item('expense', 20, '餐饮'), item('refund', 10, '购物')], '2024-02');
  assert.deepEqual(signed.categories.map(row => row.percentage), [200, -100]);
  assert.throws(() => computeCategoryBreakdown([], '2024-13'), TypeError);
});
