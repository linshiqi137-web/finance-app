import { computeDashboard, computeCategoryBreakdown, isValidDate } from './budget.js';
import { DEFAULT_SETTINGS, loadState, saveSettings, saveTransaction, updateTransaction,
  deleteTransaction, saveImportedTransactions, saveNotificationTransactions, exportBackup, validateBackup, restoreBackup } from './store.js';
import { parseWechatCsv, parseAlipayCsv, decodeBillBuffer, mergeTransactions } from './importers.js';

const $ = selector => document.querySelector(selector);
const androidBridge = window.AndroidBridge;
const appName = androidBridge ? '小凪记账' : '小小记账';
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 });
const formatMoney = value => money.format(Math.abs(value) < 0.005 ? 0 : value);
const expenseCategories = [['餐饮', '♨'], ['交通', '⇄'], ['购物', '♧'], ['娱乐', '♫'], ['学习', '▤'], ['日用', '⌂'], ['其他', '···']];
const categoryOptions = {
  expense: expenseCategories,
  income: [['生活费', '☀'], ['兼职', '▣'], ['红包', '♡'], ['其他收入', '···']],
  refund: expenseCategories,
  transfer: [['转账', '⇄']],
};
const sourceNames = { manual: '手动', wechat: '微信', alipay: '支付宝' };
const typeNames = { expense: '支出', income: '收入', transfer: '转账', refund: '退款' };
const amountInput = $('#amount');
const dateInput = $('#entry-date');
const editDialog = $('#edit-dialog');
let state = { transactions: [], settings: { ...DEFAULT_SETTINGS } };
let activeType = 'expense';
let previousAmount = '';
let available = true;
let toastTimer;
let editingId = null;
let pendingImport = null;
let importReadId = 0;
let selectedMonth = localDate().slice(0, 7);

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
}

function setAvailable(value) {
  available = value;
  document.querySelectorAll('[data-requires-storage], .entry-card input, .entry-card button').forEach(element => { element.disabled = !value; });
}

function navigate(page) {
  if (!['home', 'entry', 'details', 'settings'].includes(page)) page = 'home';
  document.querySelectorAll('[data-page]').forEach(element => { element.hidden = element.dataset.page !== page; });
  document.querySelectorAll('[data-tab]').forEach(button => {
    if (button.dataset.tab === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.title = `${{ home: '首页', entry: '记一笔', details: '明细', settings: '设置' }[page]} · ${appName}`;
}

function renderDashboard() {
  const today = localDate();
  const dashboard = computeDashboard(state.transactions, state.settings, today);
  $('#today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
  $('#today-label').dateTime = today;
  const fields = {
    'today-remaining': dashboard.todayRemaining,
    'today-suggested': dashboard.todaySuggested,
    'today-spend': dashboard.todayNetSpend,
    'month-spend': dashboard.monthNetSpend,
    'month-income': dashboard.monthIncome,
    'projected-savings': dashboard.projectedSavings,
  };
  for (const [id, value] of Object.entries(fields)) $(`#${id}`).textContent = formatMoney(value);
  $('#remaining-days').textContent = dashboard.remainingDays;
  $('#remaining-card').classList.toggle('over-budget', dashboard.isOverBudget);
  $('#budget-message').textContent = dashboard.isOverBudget
    ? '今天超出建议啦，之后的日子慢慢调整。'
    : state.settings.monthlyIncome === 0
      ? '先在设置中填写预算，开启你的小计划。'
      : '慢慢记，把生活照顾好。';
}

const sortedTransactions = items => [...items].sort((a, b) =>
  b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '') || b.createdAt.localeCompare(a.createdAt)
);

function transactionRow(item, actions = false) {
  const li = document.createElement('li');
  li.className = 'transaction';
  const icon = document.createElement('span');
  icon.className = 'transaction-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = [...expenseCategories, ...categoryOptions.income].find(([name]) => name === item.category)?.[1] || '⇄';
  const details = document.createElement('div');
  details.className = 'transaction-details';
  const title = document.createElement('strong');
  title.textContent = item.category;
  const source = document.createElement('span');
  source.className = 'source-tag';
  source.textContent = sourceNames[item.source];
  const description = document.createElement('p');
  description.textContent = [actions ? item.time : item.date === localDate() ? '今天' : item.date,
    typeNames[item.type], item.counterparty, item.note].filter(Boolean).join(' · ');
  description.title = description.textContent;
  details.append(title, source, description);
  if (item.automatic) {
    const badge = document.createElement('span');
    badge.className = 'source-tag auto-tag';
    badge.textContent = '自动';
    badge.title = item.confidence === 'low' ? '通知信息有限，请核对金额和分类' : '来自支付通知，分类可编辑';
    source.after(badge);
  }
  const amount = document.createElement('span');
  const incoming = item.type === 'income' || item.type === 'refund';
  amount.className = `transaction-amount${incoming ? ' positive' : ''}`;
  amount.textContent = `${incoming ? '+' : item.type === 'expense' ? '−' : ''}${formatMoney(item.amount)}`;
  li.append(icon, details, amount);
  if (actions) {
    const controls = document.createElement('div');
    controls.className = 'transaction-actions';
    for (const [label, handler] of [['编辑', () => openEdit(item.id)], ['删除', () => removeTransaction(item.id)]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = !available;
      button.setAttribute('aria-label', `${label} ${item.date} ${item.category} ${formatMoney(item.amount)}`);
      button.addEventListener('click', handler);
      controls.append(button);
    }
    li.append(controls);
  }
  return li;
}

function renderRecent() {
  const list = $('#recent-list');
  list.replaceChildren();
  $('#record-count').textContent = `${state.transactions.length} 笔记录`;
  $('#empty-state').hidden = state.transactions.length > 0;
  for (const item of sortedTransactions(state.transactions).slice(0, 5)) list.append(transactionRow(item));
}

function renderDetails() {
  $('#list-month').value = selectedMonth;
  const items = sortedTransactions(state.transactions.filter(item => item.date.startsWith(`${selectedMonth}-`)));
  $('#month-record-count').textContent = `${items.length} 笔记录`;
  $('#transactions-empty').hidden = items.length > 0;
  const groups = $('#transaction-groups');
  groups.replaceChildren();
  let date = '', list;
  for (const item of items) {
    if (item.date !== date) {
      date = item.date;
      const group = document.createElement('section');
      group.className = 'date-group';
      const heading = document.createElement('h2');
      heading.textContent = date;
      list = document.createElement('ul');
      list.className = 'recent-list';
      group.append(heading, list);
      groups.append(group);
    }
    list.append(transactionRow(item, true));
  }
  const breakdown = computeCategoryBreakdown(state.transactions, selectedMonth);
  $('#category-total').textContent = formatMoney(breakdown.total);
  $('#category-empty').hidden = breakdown.categories.length > 0;
  $('#percentage-help').hidden = !breakdown.categories.length || breakdown.total > 0;
  const bars = $('#category-bars');
  bars.replaceChildren();
  const scale = Math.max(1, ...breakdown.categories.map(item => Math.abs(item.amount)));
  for (const item of breakdown.categories) {
    const row = document.createElement('div');
    row.className = `category-row${item.amount < 0 ? ' refund-offset' : ''}`;
    const label = document.createElement('div');
    label.className = 'category-label';
    const name = document.createElement('span');
    name.textContent = item.category;
    const value = document.createElement('span');
    value.textContent = `${formatMoney(item.amount)} · ${item.percentage === null ? '—' : `${item.percentage.toFixed(1)}%`}`;
    label.append(name, value);
    const track = document.createElement('div');
    track.className = 'bar-track';
    track.setAttribute('aria-hidden', 'true');
    const bar = document.createElement('div');
    bar.className = 'category-bar';
    bar.style.width = `${Math.min(100, Math.abs(item.amount) / scale * 100)}%`;
    track.append(bar);
    row.append(label, track);
    bars.append(row);
  }
}

function render() {
  renderDashboard();
  renderRecent();
  renderDetails();
  if (pendingImport) renderImportPreview();
}

function renderCategories() {
  $('#categories').replaceChildren();
  $('#entry-hint').textContent = activeType === 'refund' ? '选择原消费分类，退款会抵扣该分类消费' : '输入金额后，点分类保存';
  for (const [category, symbol] of categoryOptions[activeType]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-chip';
    button.disabled = !available;
    button.setAttribute('aria-label', `${category}，保存一笔${typeNames[activeType]}`);
    const icon = document.createElement('span');
    icon.textContent = symbol;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(category));
    button.addEventListener('click', () => addTransaction(category));
    $('#categories').append(button);
  }
}

// Keep two decimal places and cap the integer part, including typed/pasted input.
function updateAmount(value) {
  if (value === '.') value = '0.';
  if (!/^\d{0,10}(\.\d{0,2})?$/.test(value)) return false;
  value = value.replace(/^0+(?=\d)/, '');
  amountInput.value = value;
  previousAmount = value;
  showError($('#entry-error'));
  return true;
}

function addTransaction(category) {
  if (!available) return;
  const amount = Number(amountInput.value);
  if (!Number.isFinite(amount) || amount <= 0) {
    showError($('#entry-error'), '先输入大于 0 的金额，再点分类就能保存。');
    return;
  }
  if (!isValidDate(dateInput.value)) {
    showError($('#entry-error'), '请选择有效的记账日期。');
    dateInput.focus();
    return;
  }
  const now = new Date();
  const transaction = {
    id: globalThis.crypto?.randomUUID?.() || `${now.getTime()}-${Math.random().toString(36).slice(2)}`,
    type: activeType,
    amount: Math.round(amount * 100) / 100,
    category,
    note: $('#note').value.trim(),
    date: dateInput.value,
    time: now.toTimeString().slice(0, 8),
    counterparty: '',
    source: 'manual',
    createdAt: now.toISOString(),
  };
  try {
    state = saveTransaction(transaction);
  } catch (error) {
    showError($('#entry-error'), error.message);
    return;
  }
  updateAmount('');
  $('#note').value = '';
  dateInput.value = localDate();
  render();
  toast(`已记下 ${category} ${formatMoney(amount)} ♡`);
}

function openEdit(id) {
  try {
    state = loadState();
    const item = state.transactions.find(transaction => transaction.id === id);
    if (!item) { render(); toast('这笔记录已不存在'); return; }
    editingId = id;
    for (const key of ['type', 'amount', 'date', 'time', 'category', 'counterparty', 'note']) {
      $('#edit-form').elements.namedItem(key).value = item[key] ?? '';
    }
    $('#edit-source').textContent = `来源：${sourceNames[item.source]}`;
    showError($('#edit-error'));
    editDialog.showModal();
  } catch (error) { showError($('#storage-error'), error.message); }
}

function removeTransaction(id) {
  if (!available) return;
  const item = state.transactions.find(transaction => transaction.id === id);
  if (!item || !window.confirm(`确定删除 ${item.date} 的${typeNames[item.type]} ${formatMoney(item.amount)}？删除后无法撤销。`)) return;
  try {
    state = deleteTransaction(id);
    render();
    toast('记录已删除');
  } catch (error) { showError($('#storage-error'), error.message); }
}

$('#edit-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!available || !event.currentTarget.reportValidity()) return;
  try {
    const latest = loadState().transactions.find(item => item.id === editingId);
    if (!latest) throw new Error('这笔记录已不存在，请关闭编辑后刷新明细。');
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (!fields.category.trim()) throw new Error('请填写分类。');
    state = updateTransaction({ ...latest, ...fields, category: fields.category.trim(),
      time: fields.time ? fields.time.length === 5 ? `${fields.time}:00` : fields.time : undefined,
      amount: Math.round(Number(fields.amount) * 100) / 100 });
    editDialog.close();
    render();
    toast('记录已更新');
  } catch (error) { showError($('#edit-error'), error.message); }
});
$('#close-edit').addEventListener('click', () => editDialog.close());
editDialog.addEventListener('close', () => { editingId = null; });

function renderImportPreview() {
  if (!pendingImport) return;
  const result = mergeTransactions(state.transactions, pendingImport);
  $('#import-preview').hidden = false;
  $('#import-summary').textContent = `有效记录 ${pendingImport.length} 笔：新增 ${result.added.length} 笔，重复 ${result.skipped} 笔。`;
  $('#confirm-import').disabled = !available || result.added.length === 0;
  $('#import-sample').replaceChildren();
  for (const item of result.added.slice(0, 5)) {
    const row = document.createElement('li');
    row.textContent = `${item.date} ${typeNames[item.type]} ${formatMoney(item.amount)} · ${item.counterparty || item.category}`;
    $('#import-sample').append(row);
  }
}

function clearImport() {
  importReadId++;
  pendingImport = null;
  $('#import-file').value = '';
  $('#import-preview').hidden = true;
  showError($('#import-error'));
}

$('#import-source').addEventListener('change', clearImport);
$('#cancel-import').addEventListener('click', clearImport);
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  const readId = ++importReadId;
  pendingImport = null;
  $('#import-preview').hidden = true;
  showError($('#import-error'));
  if (!file || !available) return;
  const source = $('#import-source').value;
  try {
    const buffer = await file.arrayBuffer();
    if (readId !== importReadId) return;
    const text = decodeBillBuffer(buffer);
    pendingImport = source === 'wechat' ? parseWechatCsv(text) : parseAlipayCsv(text);
    state = loadState();
    renderImportPreview();
  } catch (error) {
    if (readId !== importReadId) return;
    pendingImport = null;
    showError($('#import-error'), `无法导入：${error.message}`);
    event.target.value = '';
  }
});
$('#confirm-import').addEventListener('click', () => {
  if (!available || !pendingImport) return;
  try {
    // Recheck persisted records, as another tab may have imported since preview.
    const result = mergeTransactions(loadState().transactions, pendingImport);
    state = saveImportedTransactions(result.added);
    clearImport();
    render();
    toast(`已导入 ${result.added.length} 笔，跳过重复 ${result.skipped} 笔`);
  } catch (error) { showError($('#import-error'), error.message); }
});

$('#export-backup').addEventListener('click', () => {
  if (!available) return;
  showError($('#backup-error'));
  try {
    const backup = exportBackup(loadState());
    if (androidBridge?.saveBackup) { androidBridge.saveBackup(backup); return; }
    const url = URL.createObjectURL(new Blob([backup], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `小小记账备份-${localDate()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast('备份已准备，请保存下载的 JSON 文件');
  } catch (error) { showError($('#backup-error'), error.message); }
});
$('#restore-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  showError($('#backup-error'));
  try {
    const value = JSON.parse(await file.text());
    const restored = validateBackup(value);
    if (!window.confirm(`备份包含 ${restored.transactions.length} 笔记录。确定覆盖当前全部记录和预算设置？请先保存当前备份。`)) return;
    state = restoreBackup(value);
    setAvailable(true);
    showError($('#storage-error'));
    clearImport();
    editDialog.close();
    fillSettings();
    render();
    toast(`已恢复 ${state.transactions.length} 笔记录和预算设置`);
  } catch (error) { showError($('#backup-error'), `恢复失败：${error.message}`); }
  finally { event.target.value = ''; }
});

function fillSettings() {
  for (const key of Object.keys(DEFAULT_SETTINGS)) $('#settings-form').elements.namedItem(key).value = state.settings[key];
}
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!available || !event.currentTarget.reportValidity()) return;
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, Number(event.currentTarget.elements.namedItem(key).value)]));
  try {
    state = saveSettings(settings);
  } catch (error) {
    showError($('#settings-error'), error.message);
    return;
  }
  showError($('#settings-error'));
  render();
  toast('预算已保存，慢慢实现小目标 ♡');
});

amountInput.addEventListener('input', () => {
  if (!updateAmount(amountInput.value)) {
    amountInput.value = previousAmount;
    showError($('#entry-error'), '金额最多支持 10 位整数和 2 位小数。');
  }
});
$('.keypad').addEventListener('click', event => {
  const key = event.target.closest('button[data-key]')?.dataset.key;
  if (!key || !available) return;
  updateAmount(key === 'backspace' ? amountInput.value.slice(0, -1) : amountInput.value + key);
});
document.querySelectorAll('.type-button').forEach(button => {
  button.addEventListener('click', () => {
    activeType = button.dataset.type;
    document.querySelectorAll('.type-button').forEach(item => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    showError($('#entry-error'));
    renderCategories();
  });
});

document.querySelectorAll('[data-tab]').forEach(button => {
  button.addEventListener('click', () => {
    if (button.dataset.tab === 'settings') fillSettings();
    navigate(button.dataset.tab);
  });
});
$('#open-settings').addEventListener('click', () => { fillSettings(); navigate('settings'); });
$('.brand').addEventListener('click', event => { event.preventDefault(); navigate('home'); });
$('#list-month').addEventListener('change', event => {
  if (!isValidDate(`${event.target.value}-01`)) { event.target.value = selectedMonth; return; }
  selectedMonth = event.target.value;
  renderDetails();
});
function shiftMonth(offset) {
  const date = new Date(`${selectedMonth}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const next = date.toISOString().slice(0, 7);
  if (!isValidDate(`${next}-01`)) return;
  selectedMonth = next;
  renderDetails();
}
$('#previous-month').addEventListener('click', () => shiftMonth(-1));
$('#next-month').addEventListener('click', () => shiftMonth(1));
$('#current-month').addEventListener('click', () => { selectedMonth = localDate().slice(0, 7); renderDetails(); });

try { state = loadState(); }
catch (error) { setAvailable(false); showError($('#storage-error'), error.message); }
dateInput.value = localDate();
let lastToday = localDate();
fillSettings();
renderCategories();
render();
navigate('home');

function refreshDay() {
  const today = localDate();
  if (today !== lastToday) {
    if (dateInput.value === lastToday) dateInput.value = today;
    if (selectedMonth === lastToday.slice(0, 7)) selectedMonth = today.slice(0, 7);
    lastToday = today;
    render();
  }
}
setInterval(refreshDay, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDay(); });
window.addEventListener('storage', event => {
  if (event.key !== 'little-ledger:v1' && event.key !== null) return;
  try {
    state = loadState();
    setAvailable(true);
    showError($('#storage-error'));
    render();
  } catch (error) {
    setAvailable(false);
    showError($('#storage-error'), error.message);
  }
});

function syncAndroid() {
  if (!androidBridge) return;
  try {
    $('#android-setup').hidden = androidBridge.isNotificationAccessGranted();
    if (!available) return;
    const result = saveNotificationTransactions(JSON.parse(androidBridge.getPendingTransactions()));
    state = result.state;
    // A failed ack leaves IDs in the queue; the next pull will acknowledge without inserting twice.
    androidBridge.ackTransactions(JSON.stringify(result.ids));
    if (result.added) { render(); toast(`已自动记下 ${result.added} 笔，分类可在明细中修改`); }
  } catch (error) {
    render();
    showError($('#android-error'), `自动记账暂未完成：${error.message || error}。通知会保留以便重试。`);
    return;
  }
  showError($('#android-error'));
}

if (androidBridge) {
  $('.brand > span:last-child').firstChild.textContent = appName;
  $('.brand').setAttribute('aria-label', `${appName}首页`);
  $('#android-settings').hidden = false;
  document.querySelectorAll('[data-android-notifications]').forEach(button =>
    button.addEventListener('click', () => androidBridge.openNotificationSettings()));
  document.querySelectorAll('[data-android-battery]').forEach(button =>
    button.addEventListener('click', () => androidBridge.openBatterySettings()));
  window.onAndroidResume = () => { refreshDay(); syncAndroid(); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAndroid(); });
  syncAndroid();
}

if (!androidBridge && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    showError($('#storage-error'), '离线缓存未启用；记账仍可使用，请联网重新打开以重试。');
  });
}
