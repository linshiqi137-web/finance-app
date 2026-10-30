// Pure budget calculations. Dates are calendar strings, independent of time zones.
const TYPES = new Set(['expense', 'income', 'transfer', 'refund']);

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : 0;
}

export function isConfirmedTransaction(item) {
  return item.status === undefined || item.status === 'confirmed';
}

function accountingType(item) {
  return item.own_account || item.direction === 'withdraw' ? 'transfer' : item.type;
}

export function computeCategoryBreakdown(transactions, month) {
  if (!isValidDate(`${month}-01`)) throw new TypeError('请输入有效月份 YYYY-MM');
  const totals = new Map();
  for (const item of transactions) {
    if (!isConfirmedTransaction(item) || !isValidDate(item.date) || !item.date.startsWith(`${month}-`) || !['expense', 'refund'].includes(accountingType(item))) continue;
    const category = item.category || '其他';
    totals.set(category, (totals.get(category) || 0) + cents(item.amount) * (accountingType(item) === 'refund' ? -1 : 1));
  }
  const totalCents = [...totals.values()].reduce((sum, amount) => sum + amount, 0);
  const categories = [...totals].map(([category, amount]) => ({
    category, amount: amount / 100,
    // With zero/negative total, a spending share is undefined; the UI displays a dash.
    percentage: totalCents > 0 ? amount / totalCents * 100 : null,
  })).sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category, 'zh-CN'));
  return { total: totalCents / 100, categories };
}

export function computeDashboard(transactions, settings, todayDateString) {
  if (!isValidDate(todayDateString)) throw new TypeError('请输入有效日期 YYYY-MM-DD');
  const month = todayDateString.slice(0, 7);
  const [, monthNumber, day] = todayDateString.split('-').map(Number);
  const monthEnd = new Date(`${month}-01T12:00:00Z`);
  monthEnd.setUTCMonth(monthNumber);
  monthEnd.setUTCDate(0);
  const remainingDays = monthEnd.getUTCDate() - day + 1;
  let monthNet = 0;
  let todayNet = 0;
  let beforeTodayNet = 0;
  let income = 0;

  for (const transaction of transactions) {
    if (!isConfirmedTransaction(transaction) || !isValidDate(transaction.date) || !transaction.date.startsWith(month) || !TYPES.has(transaction.type)) continue;
    const amount = cents(transaction.amount);
    const type = accountingType(transaction);
    if (type === 'income') income += amount;
    const net = type === 'expense' ? amount : type === 'refund' ? -amount : 0;
    monthNet += net;
    if (transaction.date === todayDateString) todayNet += net;
    if (transaction.date < todayDateString) beforeTodayNet += net;
  }

  const monthlyIncome = cents(settings.monthlyIncome);
  const fixed = cents(settings.fixedExpenses);
  const reserve = cents(settings.reserve);
  const spendable = monthlyIncome - fixed - cents(settings.savingsGoal) - reserve;
  const todaySuggested = (spendable - beforeTodayNet) / remainingDays / 100;
  const todayNetSpend = todayNet / 100;
  const todayRemaining = todaySuggested - todayNetSpend;

  return {
    spendable: spendable / 100,
    remainingDays,
    todayNetSpend,
    monthNetSpend: monthNet / 100,
    monthIncome: income / 100,
    todaySuggested,
    todayRemaining,
    projectedSavings: (monthlyIncome - fixed - reserve - monthNet) / 100,
    isOverBudget: todayRemaining < 0 || todayNetSpend > todaySuggested,
  };
}
