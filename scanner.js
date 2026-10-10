/* Page Inspector scanner v0.3 — 注入到页面执行，需保持自包含、无外部依赖。
 * 挂载为 window.__piScan(opts)，返回可 JSON 序列化的结果。
 * opts: { expandDropdowns, traverseTabs, collectTableRows, tableRowLimit,
 *         maxOptions(total, 默认100), previewOptions(回填fields前N, 默认30),
 *         drillCascader(默认true，只下钻首节点拿L2示例) }
 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const GENERIC_LABEL = new Set(['请选择', '选择日期', '请选择日期', '请选择时间', '选择时间', '请输入']);

  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    try {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  };

  // 穿透 Shadow DOM
  const deepAll = (selector, root = document) => {
    let out = [];
    try { out = [...root.querySelectorAll(selector)]; } catch { /* 非法选择器 */ }
    const all = (() => { try { return root.querySelectorAll('*'); } catch { return []; } })();
    all.forEach((n) => { if (n.shadowRoot) out.push(...deepAll(selector, n.shadowRoot)); });
    return [...new Set(out)];
  };

  // 带语义 class 的选择器：解决 "div > div > div > input" _collision_问题
  const cssPath = (el) => {
    try {
      if (!el || el.nodeType !== 1) return '';
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'html' && parts.length < 7) {
        let p = cur.tagName.toLowerCase();
        try {
          const cls = (cur.className?.toString?.() || '').split(/\s+/)
            .filter((c) => /^(el-|ant-|is-|has-|form|query|search|filter|field|btn|button|nav|menu|table|select|picker|cascader|input|date|dialog|drawer)/i.test(c))
            .slice(0, 2);
          if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.');
        } catch {}
        const sib = cur.parentElement && [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName);
        if (sib && sib.length > 1) p += `:nth-of-type(${sib.indexOf(cur) + 1})`;
        parts.unshift(p);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    } catch { return el?.tagName || ''; }
  };

  // Element / Ant 的 form-item label（去掉 * 和冒号）
  const formItemLabel = (el) => {
    try {
      const item = el.closest?.('.el-form-item, .ant-form-item, .ant-form-item-row');
      if (!item) return '';
      let l = null;
      try { l = item.querySelector(':scope > .el-form-item__label, :scope > .ant-form-item-label, :scope > .ant-col > .ant-form-item-label'); } catch { /* 老浏览器不支持 :scope */ }
      if (!l) l = item.querySelector('.el-form-item__label, .ant-form-item-label');
      if (!l || l.contains(el)) return '';
      return txt(l.textContent).replace(/[*：:]/g, '').trim();
    } catch { return ''; }
  };

  const labelOf = (el) => {
    try {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return txt(l.textContent);
      }
      const wrap = el.closest?.('label');
      if (wrap) {
        const t = txt(wrap.textContent);
        if (t && !GENERIC_LABEL.has(t)) return t;
      }
      const aria = el.getAttribute?.('aria-label');
      if (aria && !GENERIC_LABEL.has(txt(aria))) return txt(aria);
      const by = el.getAttribute?.('aria-labelledby');
      if (by) {
        const t = txt(by.split(' ').map((i) => document.getElementById(i)?.textContent || '').join(' '));
        if (t && !GENERIC_LABEL.has(t)) return t;
      }
      const item = el.closest?.('.el-form-item, .ant-form-item, .ant-form-item-row, .form-group, .form-item, [class*=form-item], tr');
      if (item) {
        const l = item.querySelector('label, .el-form-item__label, .ant-form-item-label, th, [class*=label]');
        if (l && !l.contains(el)) {
          const t = txt(l.textContent).replace(/[*：:]/g, '').trim();
          if (t && !GENERIC_LABEL.has(t)) return t;
        }
      }
      const fl = formItemLabel(el);
      if (fl) return fl;
      // placeholder 太泛（请选择/选择日期）不配当 label，返回空，placeholder 另存
      return '';
    } catch { return ''; }
  };

  const fireClick = (el) => {
    try {
      el.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
      ['pointerdown', 'mousedown', 'focus', 'mouseup', 'click'].forEach((t) => {
        el.dispatchEvent(new MouseEvent(t, init));
      });
      el.focus?.();
    } catch { /* 忽略 */ }
  };
  const pressEsc = () => {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch {}
  };

  // ---------- 表单字段 ----------
  function collectFields() {
    const raw = [];
    const seenGroups = new Set();
    const list = deepAll('input, select, textarea, [contenteditable="true"], [role=combobox], [role=listbox], [role=radiogroup], [role=switch], [role=slider], .el-select, .ant-select, .el-cascader, .ant-cascader-picker, .ant-picker, .el-date-editor');
    list.forEach((el) => {
      try {
        const tag = (el.tagName || '').toLowerCase();
        const type = (el.getAttribute?.('type') || '').toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(type)) return;
        const role = el.getAttribute?.('role') || '';
        const cls = el.className?.toString?.() || '';
        const ph = el.getAttribute?.('placeholder') || '';
        const container = el.closest?.('.el-select, .el-cascader, .el-date-editor, .ant-select, .ant-picker, .ant-cascader-picker') || null;
        const f = {
          selector: cssPath(el),
          tag, type: type || role || tag,
          label: labelOf(el) || formItemLabel(el),
          name: el.getAttribute?.('name') || '',
          required: !!(el.required || el.getAttribute?.('aria-required') === 'true' || el.closest?.('.el-form-item.is-required, .ant-form-item-required')),
          disabled: !!(el.disabled || el.getAttribute?.('aria-disabled') === 'true'),
          readonly: !!el.readOnly,
          visible: visible(el),
          form: el.form ? cssPath(el.form) : null,
          ...(ph ? { placeholder: ph } : {}),
          _el: el,
          _container: container ? cssPath(container) : '',
        };
        if (cls.includes('el-select') || cls.includes('ant-select') || cls.includes('cascader') || cls.includes('picker') || cls.includes('date-editor')) {
          f.component = cls.split(' ').filter(Boolean).slice(0, 3).join(' ');
        }
        // 浮层里的 radio（省市区选择）标记来源，侧边栏默认隐藏
        try {
          if ((type === 'radio' || type === 'checkbox') && el.closest?.('.el-cascader-panel, .ant-cascader-menus, .el-select-dropdown, .ant-select-dropdown, [role=listbox], [role=menu]')) {
            f.source = 'popup';
          }
        } catch {}
        if (tag === 'select') {
          f.multiple = el.multiple;
          f.options = [...el.options].map((o) => ({ text: txt(o.text), value: o.value, selected: o.selected, disabled: o.disabled }));
        } else if (type === 'radio' || type === 'checkbox') {
          // 无 name 时按父容器分组，避免 34 个省 radio 各成一条
          let key;
          if (el.name) key = type + ':named:' + el.name;
          else {
            let scope = '';
            try { scope = cssPath(el.closest('ul, [role=listbox], [role=menu], .el-cascader-panel, form') || el.parentElement || el); } catch { scope = cssPath(el); }
            key = type + ':scope:' + scope;
          }
          if (seenGroups.has(key)) return;
          seenGroups.add(key);
          let group;
          if (el.name) group = deepAll(`input[type=${type}]`).filter((i) => i.name === el.name);
          else {
            const scopeEl = el.closest('ul, [role=listbox], [role=menu], .el-cascader-panel, form') || el.parentElement;
            group = scopeEl ? [...scopeEl.querySelectorAll(`input[type=${type}]`)].filter((i) => !i.name) : [el];
          }
          f.options = group.map((i) => ({ text: labelOf(i) || i.value, value: i.value, checked: i.checked, disabled: i.disabled }));
          try { f.label = f.label || txt(el.closest('fieldset')?.querySelector('legend')?.textContent || '') || formItemLabel(el); } catch {}
          f.optionCount = f.options.length;
        } else if (tag === 'input') {
          if (el.maxLength > 0) f.maxLength = el.maxLength;
          ['min', 'max', 'step', 'pattern'].forEach((a) => el.getAttribute(a) && (f[a] = el.getAttribute(a)));
          if (el.list) f.options = [...el.list.options].map((o) => ({ text: o.label || o.value, value: o.value }));
          f.value = type === 'password' ? '***' : (el.value ?? '');
        } else if (tag === 'textarea') {
          f.value = el.value ?? '';
        }
        if (role === 'combobox' || role === 'listbox') {
          const ownsId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
          const box = ownsId && document.getElementById(ownsId);
          const opts = box ? [...box.querySelectorAll('[role=option]')] : [...el.querySelectorAll('[role=option]')];
          if (opts.length) f.options = opts.map((o) => ({ text: txt(o.textContent), selected: o.getAttribute('aria-selected') === 'true' }));
          else if (!f.options) f.note = '自定义下拉：选项可能需展开后才渲染';
        }
        raw.push(f);
      } catch {}
    });

    // 合并同一 Element 容器：div.el-select + input.el-select__input 只留一条
    const byContainer = new Map();
    const singles = [];
    raw.forEach((f) => {
      if (f._container) {
        if (!byContainer.has(f._container)) byContainer.set(f._container, []);
        byContainer.get(f._container).push(f);
      } else singles.push(f);
    });
    const merged = [...singles];
    byContainer.forEach((group) => {
      if (group.length === 1) { merged.push(group[0]); return; }
      const main = group.find((g) => g.tag === 'div') || group[0];
      const inputs = group.filter((g) => g !== main);
      main.mergedFrom = group.map((g) => g.selector);
      // 从内部 input 补 placeholder / value / label
      for (const inp of inputs) {
        if (!main.placeholder && inp.placeholder) main.placeholder = inp.placeholder;
        if ((!main.label || !main.label) && inp.label) main.label = inp.label;
        if ((main.value === undefined || main.value === '') && inp.value) main.value = inp.value;
        if (inp.visible) main.visible = true;
      }
      if (!main.label) main.label = main.label || formItemLabel(main._el);
      merged.push(main);
    });
    return merged;
  }

  // ---------- 按钮 ----------
  function collectButtons() {
    const out = [];
    deepAll('button, input[type=button], input[type=submit], input[type=reset], [role=button], a.btn, a[class*=button], .el-button, .ant-btn').forEach((el) => {
      try {
        const text = txt(el.textContent) || el.value || el.getAttribute?.('aria-label') || el.title || '';
        const cls = el.className?.toString?.() || '';
        let nav = false;
        try { nav = !!el.closest?.('nav, aside, header, .el-menu, .ant-menu, [role=navigation], [role=menubar]'); } catch {}
        out.push({
          selector: cssPath(el),
          text,
          type: el.getAttribute?.('type') || el.getAttribute?.('role') || (el.tagName || '').toLowerCase(),
          variant: /primary/.test(cls) ? 'primary' : /danger/.test(cls) ? 'danger' : /text/.test(cls) && cls.includes('el-button') ? 'text' : '',
          nav, empty: !text,
          disabled: !!(el.disabled || el.getAttribute?.('aria-disabled') === 'true'),
          visible: visible(el),
          form: el.form ? cssPath(el.form) : null,
        });
      } catch {}
    });
    return [...new Map(out.map((b) => [b.selector + '|' + b.text + '|' + b.visible, b])).values()];
  }

  // ---------- 列表 / 表格 ----------
  function collectTables(rowLimit) {
    const seen = new Map(); // columns签名去重：wrapper div 与 table 重复只留一个
    const tables = deepAll('table, [role=grid], [role=table], [role=treegrid], .el-table, .ant-table, .ant-table-wrapper');
    tables.forEach((t) => {
      try {
        let heads = [...t.querySelectorAll('thead th, thead [role=columnheader], [role=columnheader]')]
          .map((h) => txt(h.textContent)).filter(Boolean);
        if (!heads.length) {
          heads = [...t.querySelectorAll('.el-table__header th, .ant-table-thead th, tr:first-child th, tr:first-child td')]
            .map((h) => txt(h.textContent)).filter(Boolean);
        }
        heads = [...new Set(heads)];
        if (!heads.length) return;
        const rowEls = [...t.querySelectorAll('tbody tr, .el-table__body tr, .ant-table-tbody tr, [role=row]')]
          .filter((r) => !r.querySelector('th') || r.querySelector('td'));
        const total = rowEls.length;
        const rows = rowLimit > 0 ? rowEls.slice(0, rowLimit).map((r) => {
          const cells = [...r.querySelectorAll('td, [role=cell], [role=gridcell]')].map((c) => txt(c.textContent));
          const obj = {};
          cells.forEach((c, i) => { obj[heads[i] || ('列' + (i + 1))] = c; });
          return obj;
        }) : [];
        let pagination = '';
        try {
          const pg = t.parentElement?.querySelector?.('.el-pagination, .ant-pagination, [class*=pagination]')
            || document.querySelector('.el-pagination, .ant-pagination');
          if (pg) pagination = txt(pg.textContent).slice(0, 200);
        } catch {}
        let emptyText = '';
        try {
          emptyText = txt(t.querySelector('.el-table__empty-text, .ant-table-placeholder, .ant-empty')?.textContent || '');
        } catch {}
        const rec = { selector: cssPath(t), columns: heads, rowCount: total, rows, truncated: total > rows.length, pagination, visible: visible(t) };
        if (!total && emptyText) { rec.empty = true; rec.emptyText = emptyText; }
        const sig = heads.join('');
        const prev = seen.get(sig);
        // 留更优的：可见 > 行数多 > selector 短
        if (!prev || score(rec) > score(prev)) seen.set(sig, rec);
      } catch {}
    });
    return [...seen.values()];
  }
  const score = (t) => (t.visible ? 1000 : 0) + Math.min(t.rowCount, 100) - t.selector.length / 100;

  // ---------- 下拉 / 级联展开探测 ----------
  const PANEL_SEL = '.el-select-dropdown, .el-cascader-panel, .el-picker-panel, .ant-select-dropdown, .ant-cascader-menus, .ant-picker-dropdown, [role=listbox], [role=menu], [class*=dropdown-menu]';
  const OPT_SEL = '[role=option], .el-select-dropdown__item, .el-cascader-node, .ant-select-item, .ant-cascader-menu-item, .ant-picker-cell-inner, li[class*=option], li[class*=menu-item]';
  const PAGESIZE_RE = /条\/页|page-size/i;

  function snapshotPanels() {
    return new Set(deepAll(PANEL_SEL).filter(visible));
  }
  function extractPanelOptions(panel) {
    const items = [...panel.querySelectorAll(OPT_SEL)].filter((o) => visible(o) || txt(o.textContent));
    const seen = new Set();
    const opts = [];
    const isCascader = !!panel.querySelector('.el-cascader-menu, .ant-cascader-menu');
    items.forEach((o) => {
      const text = txt(o.textContent);
      if (!text || seen.has(text)) return;
      seen.add(text);
      const rec = {
        text,
        selected: o.getAttribute?.('aria-selected') === 'true' || o.classList?.contains('selected') || o.classList?.contains('is-selected') || o.classList?.contains('ant-select-item-option-selected'),
        disabled: o.getAttribute?.('aria-disabled') === 'true' || o.classList?.contains('is-disabled') || o.classList?.contains('ant-select-item-option-disabled'),
      };
      if (isCascader) {
        try {
          rec.hasChildren = !!(o.querySelector('.el-cascader-node__postfix, .ant-cascader-menu-item-expand-icon') || (o.getAttribute('aria-expanded') !== null && o.getAttribute('aria-expanded') !== undefined));
        } catch {}
      }
      opts.push(rec);
    });
    return opts;
  }
  // 只有真正的级联面板才算列；普通 select 不记 cascaderColumns
  function extractCascaderColumns(panel) {
    const menus = [...panel.querySelectorAll('.el-cascader-menu, .ant-cascader-menu')];
    if (!menus.length) return null;
    return menus.slice(0, 5).map((m, i) => ({
      level: i + 1,
      options: [...m.querySelectorAll(OPT_SEL)].map((o) => txt(o.textContent)).filter(Boolean).slice(0, 100),
    }));
  }

  async function probeDropdowns(fields, o) {
    const byTrigger = new Map();
    const triggers = deepAll('[role=combobox], .el-select, .ant-select, .el-cascader, .ant-cascader-picker, .el-date-editor, .ant-picker, input[readonly][placeholder]').filter(visible).slice(0, 20);
    for (const trig of triggers) {
      try {
        // 跳过“每页条数”这种分页噪音下拉
        const trigText = txt(trig.textContent) + ' ' + (trig.querySelector('input')?.value || '');
        if (PAGESIZE_RE.test(trigText)) continue;
        const before = snapshotPanels();
        fireClick(trig.querySelector('input, [role=combobox], .el-input__inner, .ant-select-selector') || trig);
        await sleep(380);
        const after = deepAll(PANEL_SEL).filter(visible).filter((p) => !before.has(p));
        const panels = after.length ? after : deepAll(PANEL_SEL).filter(visible).slice(0, 2);
        if (!panels.length) { pressEsc(); await sleep(120); continue; }
        for (const p of panels.slice(0, 2)) {
          const options = extractPanelOptions(p);
          if (!options.length) continue;
          if (options.length <= 5 && options.every((x) => PAGESIZE_RE.test(x.text))) continue; // 分页噪音
          const columns = extractCascaderColumns(p);
          const key = cssPath(trig);
          let rec = byTrigger.get(key);
          if (!rec) {
            rec = { triggerSelector: key, triggerLabel: labelOf(trig) || formItemLabel(trig), panelSelector: cssPath(p), options: [], _seen: new Set() };
            byTrigger.set(key, rec);
          }
          options.forEach((x) => { if (!rec._seen.has(x.text)) { rec._seen.add(x.text); rec.options.push(x); } });
          if (columns) rec.cascaderColumns = columns;

          // 级联下钻：点首节点拿 L2（只做一次，避免状态爆炸）
          if (o.drillCascader && columns && columns.length === 1) {
            try {
              const firstNode = p.querySelector('.el-cascader-node, .ant-cascader-menu-item');
              if (firstNode) {
                fireClick(firstNode);
                await sleep(350);
                const cols2 = extractCascaderColumns(p);
                if (cols2 && cols2.length > 1) { rec.cascaderColumns = cols2; rec.drilled = true; }
              }
            } catch {}
          }
        }
        pressEsc();
        await sleep(150);
      } catch {}
    }
    pressEsc();
    // 定稿：总数 + 截断，fields 只回填预览
    const details = [...byTrigger.values()].map((rec) => {
      const { _seen, ...rest } = rec;
      const total = rec.options.length;
      return { ...rest, optionCount: total, options: rec.options.slice(0, o.maxOptions), truncated: total > o.maxOptions };
    });
    details.forEach((rec) => {
      const f = fields.find((x) => x._container === rec.triggerSelector || x.selector === rec.triggerSelector);
      if (f) {
        f.options = rec.options.slice(0, o.previewOptions);
        f.optionCount = rec.optionCount;
        f.optionsTruncated = rec.optionCount > o.previewOptions;
        f.dropdownRef = rec.triggerSelector;
        f.expanded = true;
        if (rec.cascaderColumns) f.cascaderColumns = rec.cascaderColumns;
        delete f.note;
      }
    });
    return details;
  }

  // ---------- Tab 遍历 ----------
  async function traverseTabs(fields) {
    const tabLists = deepAll('[role=tablist], .el-tabs__nav, .ant-tabs-nav, .nav-tabs, [class*=tabs-nav]').slice(0, 5);
    const result = [];
    for (const list of tabLists) {
      try {
        const tabs = [...list.querySelectorAll('[role=tab], .el-tabs__item, .ant-tabs-tab, li, [class*=tab]')]
          .filter((t) => visible(t) && txt(t.textContent)).slice(0, 10);
        if (tabs.length < 2) continue;
        const perTab = [];
        for (let i = 0; i < tabs.length; i++) {
          try {
            fireClick(tabs[i]);
            await sleep(350);
            const visFields = fields.filter((f) => { try { return visible(f._el); } catch { return false; } });
            perTab.push({ index: i, label: txt(tabs[i].textContent), fieldCount: visFields.length, fields: visFields.map((f) => f.label || f.name || f.selector).slice(0, 60) });
          } catch {}
        }
        try { fireClick(tabs[0]); await sleep(250); } catch {}
        result.push({ tablistSelector: cssPath(list), tabCount: tabs.length, tabs: perTab });
      } catch {}
    }
    return result;
  }

  // ---------- 主入口 ----------
  window.__piScan = async (opts = {}) => {
    const o = Object.assign({ expandDropdowns: true, traverseTabs: true, collectTableRows: true, tableRowLimit: 20, maxOptions: 100, previewOptions: 30, drillCascader: true }, opts);
    const fields = collectFields();
    const buttons = collectButtons();
    const tables = o.collectTableRows ? collectTables(o.tableRowLimit) : collectTables(0);
    let dropdowns = [], tabs = [];
    if (o.expandDropdowns) { try { dropdowns = await probeDropdowns(fields, o); } catch {} }
    if (o.traverseTabs) { try { tabs = await traverseTabs(fields); } catch {} }
    const cleanFields = fields.map(({ _el, _container, ...rest }) => rest);
    const vis = (a) => a.filter((x) => x.visible).length;
    return {
      url: location.href, title: document.title, timestamp: new Date().toISOString(),
      counts: { fields: cleanFields.length, fieldsVisible: vis(cleanFields), buttons: buttons.length, buttonsVisible: vis(buttons), tables: tables.length, dropdowns: dropdowns.length, tabGroups: tabs.length },
      fields: cleanFields, buttons, tables, dropdowns, tabs,
    };
  };
})();
