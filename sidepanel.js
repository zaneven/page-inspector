/* 侧边栏逻辑：注入 scanner.js → 调用 __piScan → 合并多 frame → 渲染/导出 */
const $ = (id) => document.getElementById(id);
const out = $('out'), overview = $('overview'), summary = $('summary');
let last = null, lastMd = '', lastSchema = '', view = 'overview', timer = null, scanning = false;

const opts = () => ({
  expandDropdowns: $('optExpand').checked,
  traverseTabs: $('optTabs').checked,
  collectTableRows: $('optRows').checked,
  tableRowLimit: Math.min(100, Math.max(1, +$('optLimit').value || 20)),
});

async function run() {
  if (scanning) return;
  scanning = true;
  $('scan').disabled = true;
  out.textContent = '扫描中…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无活动标签页');
    const o = opts();
    // 两阶段注入（allFrames）：先装 scanner，再逐 frame 调用
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['scanner.js'] });
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (args) => window.__piScan(args),
      args: [o],
    });
    const parts = (res || []).map((r) => ({ frameId: r.frameId, ...(r.result || {}) }))
      .filter((p) => p.fields?.length || p.buttons?.length || p.tables?.length);
    if (!parts.length) throw new Error('该页面不允许注入（chrome://、应用商店等）或无内容');
    last = parts.length === 1 ? parts[0] : mergeFrames(parts);
    lastMd = toMarkdown(last);
    lastSchema = JSON.stringify(toJsonSchema(last), null, 2);
    render();
  } catch (e) {
    summary.textContent = '扫描失败';
    out.hidden = false; overview.innerHTML = '';
    out.textContent = '扫描失败：' + e.message;
  } finally {
    scanning = false;
    $('scan').disabled = false;
  }
}

function mergeFrames(parts) {
  const sum = (k) => parts.reduce((a, p) => a + (p.counts?.[k] ?? p[k]?.length ?? 0), 0);
  return {
    url: parts[0].url, title: parts[0].title, timestamp: new Date().toISOString(),
    counts: { fields: sum('fields'), buttons: sum('buttons'), tables: sum('tables'), dropdowns: sum('dropdowns'), tabGroups: sum('tabs') },
    fields: parts.flatMap((p) => (p.fields || []).map((f) => ({ ...f, _frame: p.frameId }))),
    buttons: parts.flatMap((p) => (p.buttons || []).map((b) => ({ ...b, _frame: p.frameId }))),
    tables: parts.flatMap((p) => (p.tables || []).map((t) => ({ ...t, _frame: p.frameId }))),
    dropdowns: parts.flatMap((p) => p.dropdowns || []),
    tabs: parts.flatMap((p) => p.tabs || []),
    frames: parts,
  };
}

// ---------- 导出：Markdown ----------
function toMarkdown(d) {
  const L = [];
  L.push(`# ${d.title || '页面信息'}\n`);
  L.push(`- URL：${d.url || ''}`);
  L.push(`- 采集时间：${d.timestamp || ''}`);
  L.push(`- 字段 ${d.counts?.fields ?? d.fields?.length ?? 0} · 按钮 ${d.counts?.buttons ?? d.buttons?.length ?? 0} · 表格 ${d.counts?.tables ?? d.tables?.length ?? 0} · 下拉展开 ${d.dropdowns?.length ?? 0} · Tab组 ${d.tabs?.length ?? 0}\n`);
  L.push('## 表单字段');
  L.push('| # | Label | 类型 | name | 必填 | 可选值 | 选择器 |');
  L.push('|---|---|---|---|---|---|---|');
  (d.fields || []).forEach((f, i) => {
    const opt = (f.options || []).map((o) => o.text || o.value).filter(Boolean).slice(0, 12).join(' / ');
    const total = f.optionCount ?? f.options?.length ?? 0;
    L.push(`| ${i + 1} | ${md(f.label || f.placeholder)} | ${md(f.component || f.type)} | ${md(f.name)} | ${f.required ? '是' : ''} | ${md(opt)}${total > 12 ? ` …(共${total})` : ''} | \`${md(f.selector)}\` |`);
  });
  if (d.dropdowns?.length) {
    L.push('\n## 下拉 / 级联展开明细');
    d.dropdowns.forEach((x, i) => {
      L.push(`### ${i + 1}. ${x.triggerLabel || x.triggerSelector}（${x.optionCount} 项）`);
      L.push((x.options || []).map((o) => `- ${o.text}${o.selected ? ' ✅' : ''}`).join('\n'));
      (x.cascaderColumns || []).forEach((c) => L.push(`\n- L${c.level}：${c.options.join(' / ')}`));
    });
  }
  if (d.tabs?.length) {
    L.push('\n## Tab 遍历');
    d.tabs.forEach((g, i) => {
      L.push(`### Tab组${i + 1} \`${g.tablistSelector}\``);
      g.tabs.forEach((t) => L.push(`- **${t.label}**：${t.fieldCount} 个字段（${t.fields.slice(0, 15).join(' / ')}）`));
    });
  }
  L.push('\n## 按钮');
  L.push('| # | 文本 | 类型 | 选择器 |');
  L.push('|---|---|---|---|');
  (d.buttons || []).forEach((b, i) => L.push(`| ${i + 1} | ${md(b.text)} | ${md(b.type)} | \`${md(b.selector)}\` |`));
  L.push('\n## 表格 / 列表');
  (d.tables || []).forEach((t, i) => {
    L.push(`### 表格${i + 1} \`${t.selector}\`（${t.rowCount} 行${t.truncated ? '，仅采前 ' + t.rows.length + ' 行' : ''}）`);
    L.push('|' + t.columns.map(md).join('|') + '|');
    L.push('|' + t.columns.map(() => '---').join('|') + '|');
    (t.rows || []).forEach((r) => L.push('|' + t.columns.map((c) => md(r[c] ?? '')).join('|') + '|'));
    if (t.pagination) L.push(`\n分页：${t.pagination}`);
  });
  return L.join('\n');
}
const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300);

// ---------- 导出：JSON Schema ----------
function toJsonSchema(d) {
  const props = {}, required = [];
  (d.fields || []).forEach((f, i) => {
    const key = sanitizeKey(f.name || f.label || f.placeholder || f.component) || ('field_' + (i + 1));
    const p = { title: f.label || f.placeholder || key, description: `selector: ${f.selector}` };
    const t = (f.type || '').toLowerCase();
    if (['number', 'range'].includes(t)) p.type = 'number';
    else if (t === 'checkbox') p.type = 'array';
    else if (['switch', 'slider'].includes(t)) p.type = ['boolean', 'number', 'string'];
    else p.type = 'string';
    if (t === 'number' || t === 'range') {
      if (f.min != null && f.min !== '') p.minimum = +f.min;
      if (f.max != null && f.max !== '') p.maximum = +f.max;
    }
    if (f.maxLength) p.maxLength = f.maxLength;
    if (f.pattern) p.pattern = f.pattern;
    const vals = (f.options || []).map((o) => o.value ?? o.text).filter((v) => v !== '' && v != null);
    const total = f.optionCount ?? vals.length;
    // 大枚举不直接写 enum（否则 Schema 巨大），截断 + x-total
    if (vals.length && t !== 'checkbox') {
      p.enum = [...new Set(vals)].slice(0, 50);
      if (total > 50) p['x-totalOptions'] = total;
    }
    if (t === 'checkbox') p.items = vals.length ? { enum: [...new Set(vals)] } : { type: 'string' };
    props[disambiguate(props, key)] = p;
    if (f.required) required.push(key);
  });
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: (d.title || '页面表单') + ' — 自动生成',
    type: 'object',
    properties: props,
    ...(required.length ? { required: [...new Set(required)] } : {}),
    'x-meta': { url: d.url, exportedAt: d.timestamp, counts: d.counts },
  };
}
const sanitizeKey = (s) => String(s || '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^[^_\p{L}]+/u, '').slice(0, 60).replace(/_+$/, '');
function disambiguate(props, key) {
  if (!props[key]) return key;
  let i = 2; while (props[`${key}_${i}`]) i++; return `${key}_${i}`;
}

// ---------- 渲染 ----------
function filtered(d) {
  const q = $('filter').value.trim().toLowerCase();
  const onlyVis = $('optVisible').checked;
  const hideNav = $('optHideNav').checked;
  let fields = d.fields, buttons = d.buttons;
  if (onlyVis) {
    fields = fields.filter((f) => f.visible && f.source !== 'popup');
    buttons = buttons.filter((b) => b.visible);
  }
  if (hideNav) buttons = buttons.filter((b) => !b.nav && !b.empty);
  if (q) {
    const hit = (o) => JSON.stringify(o).toLowerCase().includes(q);
    fields = fields.filter(hit); buttons = buttons.filter(hit);
  }
  return { ...d, fields, buttons };
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render() {
  const d = filtered(last);
  const c = last.counts || {};
  const fv = c.fieldsVisible ?? last.fields.filter((f) => f.visible).length;
  const bv = c.buttonsVisible ?? last.buttons.filter((b) => b.visible).length;
  summary.textContent = `字段 ${d.fields.length}（可见 ${fv} / 共 ${c.fields ?? last.fields.length}）· 按钮 ${d.buttons.length}（可见 ${bv} / 共 ${c.buttons ?? 0}）· 表格 ${c.tables ?? 0} · 下拉 ${last.dropdowns?.length ?? 0} · Tab组 ${last.tabs?.length ?? 0}` +
    (last.frames ? ` · frame ${last.frames.length}` : '');
  $('views').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
  const showPre = view !== 'overview';
  out.hidden = !showPre; overview.style.display = showPre ? 'none' : '';
  if (view === 'json') out.textContent = JSON.stringify(last, null, 2);
  else if (view === 'md') out.textContent = lastMd;
  else if (view === 'schema') out.textContent = lastSchema;
  else overview.innerHTML = overviewHtml(d);
}

function overviewHtml(d) {
  const optPreview = (f) => {
    const n = (f.options || []).map((o) => o.text || o.value).filter(Boolean).slice(0, 8).join(' / ');
    const total = f.optionCount ?? f.options?.length ?? 0;
    return esc(n) + (total > 8 ? ` …(前8/共${total})` : '') + (f.expanded ? ' 🔽已展开' : '');
  };
  const labelCell = (f) => esc(f.label || f.placeholder || '') + (f.required ? ' *' : '') + (f.source === 'popup' ? ' (浮层)' : '');
  const fRows = d.fields.map((f, i) => `<tr><td>${i + 1}</td><td>${labelCell(f)}</td><td>${esc(f.component || f.type)}</td><td>${optPreview(f)}</td></tr>`).join('');
  const bRows = d.buttons.map((b, i) => `<tr><td>${i + 1}</td><td>${esc(b.text)}</td><td>${esc(b.type)}</td></tr>`).join('');
  const tSecs = (d.tables || []).map((t, i) =>
    `<div class="sec">表格${i + 1}（${t.rowCount}行${t.truncated ? '，截断' : ''}）</div><div class="muted">${esc(t.selector)}</div>` +
    `<table class="mini"><tr>${t.columns.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>` +
    (t.rows || []).map((r) => `<tr>${t.columns.map((col) => `<td>${esc(r[col])}</td>`).join('')}</tr>`).join('') + '</table>').join('');
  const tabSecs = (last.tabs || []).map((g, i) =>
    `<div class="sec">Tab组${i + 1}</div><div class="muted">${esc(g.tablistSelector)}</div>` +
    g.tabs.map((t) => `<div>▪ <b>${esc(t.label)}</b>：${t.fieldCount} 字段</div>`).join('')).join('');
  return `<div class="sec">表单字段（${d.fields.length}）</div><table class="mini"><tr><th>#</th><th>Label</th><th>类型</th><th>可选值</th></tr>${fRows || '<tr><td colspan=4 class=muted>无</td></tr>'}</table>` +
    (tabSecs || '') +
    `<div class="sec">按钮（${d.buttons.length}）</div><table class="mini"><tr><th>#</th><th>文本</th><th>类型</th></tr>${bRows || '<tr><td colspan=3 class=muted>无</td></tr>'}</table>` +
    `<div class="sec">表格（${(d.tables || []).length}）</div>${tSecs || '<div class=muted>无</div>'}`;
}

// ---------- 事件 ----------
$('scan').onclick = run;
$('filter').oninput = () => last && render();
$('optVisible').onchange = () => last && render();
$('optHideNav').onchange = () => last && render();
$('views').onclick = (e) => { if (e.target.dataset.v) { view = e.target.dataset.v; if (last) render(); } };
$('optAuto').onchange = () => {
  clearInterval(timer); timer = null;
  if ($('optAuto').checked) { timer = setInterval(run, +$('optInterval').value); summary.textContent += '（自动刷新开）'; }
};
$('optInterval').onchange = () => { if ($('optAuto').checked) { clearInterval(timer); timer = setInterval(run, +$('optInterval').value); } };
const copy = (t) => navigator.clipboard.writeText(t);
$('cpJson').onclick = () => copy(JSON.stringify(last, null, 2));
$('cpMd').onclick = () => copy(lastMd);
$('cpSchema').onclick = () => copy(lastSchema);
const dl = (name, text) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('dlJson').onclick = () => dl('page-inspector.json', JSON.stringify(last, null, 2));
$('dlMd').onclick = () => dl('page-inspector.md', lastMd);
$('dlSchema').onclick = () => dl('page-inspector.schema.json', lastSchema);

run();
