/* ==========================================================================
   请拼豆 · 会员管理系统 · 前端
   原生 JS，无构建步骤：产物极小、加载快、零常驻内存。
   金额一律用整数分传输，只在展示时转成元。
   ========================================================================== */
'use strict';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const $ = (s) => document.querySelector(s);

function yuan(cents) {
  if (cents === null || cents === undefined) return '0.00';
  const neg = cents < 0, abs = Math.abs(cents);
  return (neg ? '-' : '') + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

/** 元 → 分，字符串解析避免浮点误差 */
function toCents(str) {
  const s = String(str ?? '').trim();
  if (s === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [i, d = ''] = s.split('.');
  return parseInt(i, 10) * 100 + parseInt(d.padEnd(2, '0') || '0', 10);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/** 把分钟数说成人话 */
function humanMinutes(min) {
  if (min === null || min === undefined) return '—';
  const neg = min < 0, abs = Math.abs(min);
  const h = Math.floor(abs / 60), m = abs % 60;
  const txt = h > 0 ? (m > 0 ? `${h}小时${m}分` : `${h}小时`) : `${m}分钟`;
  return (neg ? '超时 ' : '') + txt;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const api = {
  async request(method, path, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    // 只有确实要发 body 时才带 Content-Type。
    // Fastify 见到 application/json 就要求 body 非空，
    // DELETE 这类无 body 请求带上它会直接被拒（400 EMPTY_JSON_BODY）。
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch { /* 空响应 */ }
    if (!res.ok) {
      const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get: (p) => api.request('GET', p),
  post: (p, b) => api.request('POST', p, b),
  patch: (p, b) => api.request('PATCH', p, b),
  put: (p, b) => api.request('PUT', p, b),
  del: (p) => api.request('DELETE', p),
};

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const state = {
  user: null,
  route: { name: 'board', params: {} },
  toast: null,
  boardTimer: null,
  clockTimer: null,
};

function go(name, params = {}) {
  state.route = { name, params };
  window.scrollTo(0, 0);
  render();
}

function toast(msg, type = 'success') {
  state.toast = { msg, type };
  render();
  setTimeout(() => { state.toast = null; render(); }, 2600);
}

// ---------------------------------------------------------------------------
// 通用组件
// ---------------------------------------------------------------------------
function tabbar(active) {
  const tabs = [
    { id: 'board', icon: '🪑', label: '店铺' },
    { id: 'members', icon: '👥', label: '会员' },
    { id: 'revenue', icon: '💰', label: '收入' },
    { id: 'me', icon: '🙋', label: '我的' },
  ];
  return `<nav class="tabbar">${tabs.map((t) => `
    <button class="${active === t.id ? 'active' : ''}" onclick="go('${t.id}')">
      <span class="icon">${t.icon}</span><span>${t.label}</span>
    </button>`).join('')}</nav>`;
}

function topbar(title, backTo) {
  return `<header class="topbar">
    ${backTo ? `<button class="back" onclick="go('${backTo}')">‹ 返回</button>` : '<span class="logo">🧩</span>'}
    <h1>${esc(title)}</h1>
  </header>`;
}

function loadingView(msg = '加载中…') {
  return `<div class="page"><div class="loading"><div class="spinner"></div>${esc(msg)}</div></div>`;
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------
function LoginPage() {
  return `
  <div class="login-wrap">
    <div class="login-box">
      <div class="login-logo">
        <div class="mark">🧩</div>
        <h1>请拼豆</h1>
        <p>会员管理系统</p>
      </div>
      <div class="card">
        <div id="login-error"></div>
        <div class="field">
          <label>账号</label>
          <input id="username" autocomplete="username" autocapitalize="off" placeholder="请输入用户名">
        </div>
        <div class="field">
          <label>密码</label>
          <input id="password" type="password" autocomplete="current-password" placeholder="请输入密码">
        </div>
        <button class="btn" id="login-btn" onclick="doLogin()">登 录</button>
      </div>
    </div>
  </div>`;
}

async function doLogin() {
  const username = $('#username').value.trim();
  const password = $('#password').value;
  const errBox = $('#login-error'), btn = $('#login-btn');

  if (!username || !password) {
    errBox.innerHTML = `<div class="alert error">请输入账号和密码</div>`;
    return;
  }
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const r = await api.post('/api/v1/auth/login', { username, password });
    state.user = r.user;
    go('board');
    toast(`欢迎回来，${r.user.displayName || r.user.username}`);
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    btn.disabled = false; btn.textContent = '登 录';
  }
}

// ---------------------------------------------------------------------------
// 店铺看板（核心页面）
// ---------------------------------------------------------------------------
function seatCard(t) {
  if (t.status === 'maintenance') {
    return `<div class="seat maintenance">
      <div class="seat-head">
        <span class="seat-name">${esc(t.tableName)}</span>
        <span class="pill fix">维护中</span>
      </div>
      <div class="seat-empty"><span>暂不可用</span></div>
    </div>`;
  }

  if (t.status === 'idle') {
    return `<div class="seat idle" onclick="go('openTable',{tableId:${t.tableId}})">
      <div class="seat-head">
        <span class="seat-name">${esc(t.tableName)}</span>
        <span class="pill free">空闲</span>
      </div>
      <div class="seat-empty">
        <span class="plus">＋</span>
        <span>点击接待顾客</span>
      </div>
    </div>`;
  }

  const s = t.session;
  const isCard = s.usedCard;
  let cls = 'occupied', pillCls = 'busy', pillTxt = '使用中';

  // 暂停优先级最高：暂停中显示「已暂停」，不再进入超时/提醒状态
  if (s.paused) {
    pillCls = 'paused';
    pillTxt = '⏸ 已暂停';
  } else if (isCard) {
    // 用卡核销是全天不限时的通行权益，永远不进入"即将到时/已超时"状态
    pillCls = 'card';
    pillTxt = cardTypeName(s.cardType) + '中';
  } else {
    if (s.alertLevel === 'warning') { cls = 'warning'; pillCls = 'warn'; pillTxt = '即将到时'; }
    if (s.alertLevel === 'overtime') { cls = 'overtime'; pillCls = 'over'; pillTxt = '已超时'; }
  }

  // 时间信息：开始 + 结束（限时套餐）；用卡会话没有结束时间
  const timeRange = s.expectedEndAt
    ? `${fmtTime(s.startedAt)} — ${fmtTime(s.expectedEndAt)}`
    : `${fmtTime(s.startedAt)} 开始`;

  // 卡种会话：显示权益到期日与已玩时长，不显示倒计时
  let timerHtml = '';
  if (s.paused) {
    // 暂停中：倒计时冻结，显示暂停提示
    timerHtml = `<div class="seat-timer">
      <div class="label">${esc(s.productName || '计时')}</div>
      <div class="time small" style="color:#B08A00">⏸ 暂停中 · 恢复后继续计费</div>
    </div>`;
  } else if (isCard) {
    const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 60000);
    timerHtml = `<div class="seat-timer">
      <div class="label">🎫 ${cardTypeName(s.cardType)} · <span style="font-weight:700;color:#0B6B4F">全天不限时</span></div>
      <div class="time small">权益至 ${fmtDate(s.cardExpiresAt)}${s.cardType === 'day' ? '' : '（' + cardDaysLeft(s.cardExpiresAt) + '）'}</div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:4px" data-elapsed="${s.startedAt}">已玩 —</div>
    </div>`;
  } else if (s.expectedEndAt) {
    // 限时套餐：倒计时由 JS 每秒本地更新，不需要重新请求接口。
    // 首屏直接算出文本，避免出现一瞬间的占位符。
    const { text, over } = formatCountdown(new Date(s.expectedEndAt).getTime() - Date.now());
    timerHtml = `<div class="seat-timer">
      <div class="label">${esc(s.productName)} · <span class="cd-label">${over ? '已超时' : '剩余'}</span></div>
      <div class="time" data-countdown="${s.expectedEndAt}">${text}</div>
    </div>`;
  } else {
    const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 60000);
    timerHtml = `<div class="seat-timer">
      <div class="label">${esc(s.productName)}</div>
      <div class="time small" data-elapsed="${s.startedAt}">已玩 ${humanMinutes(elapsed)}</div>
    </div>`;
  }

  return `<div class="${cls === 'occupied' ? 'seat occupied' : 'seat ' + cls}"
               data-seat="${s.sessionId}"
               data-state="${cls}"
               data-end="${s.expectedEndAt || ''}"
               onclick="go('seatDetail',{sessionId:${s.sessionId}})">
    <div class="seat-head">
      <span class="seat-name">${esc(t.tableName)}</span>
      <span class="pill ${pillCls}">${pillTxt}</span>
    </div>
    <div class="seat-person">
      <span class="avatar">${s.memberId ? '👤' : '🙋'}</span>
      <span>${esc(s.displayName)}</span>
    </div>
    <div class="seat-meta">🕐 ${timeRange}</div>
    ${timerHtml}
  </div>`;
}

function cardDaysLeft(expiresAt) {
  if (!expiresAt) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(String(expiresAt).slice(0, 10) + 'T00:00:00');
  const days = Math.round((exp - today) / 86400000);
  if (days < 0) return '已过期';
  if (days === 0) return '今天到期';
  return `剩 ${days} 天`;
}

async function BoardPage() {
  const d = await api.get('/api/v1/board');
  const s = d.summary;

  // 缓存看板数据，并记录提醒阈值（由后端配置决定，默认 15 分钟）
  boardCache = d;
  warningThresholdMs = (d.pricing?.remind_before_minutes ?? 15) * 60 * 1000;

  const alerts = d.tables.filter((t) => t.session &&
    (t.session.alertLevel === 'warning' || t.session.alertLevel === 'overtime'));

  return `
  ${topbar('店铺')}
  <div class="page">
    <div class="stats">
      <div class="stat"><div class="value">${s.total}</div><div class="label">总桌数</div></div>
      <div class="stat"><div class="value pink">${s.occupied}</div><div class="label">使用中</div></div>
      <div class="stat"><div class="value mint">${s.idle}</div><div class="label">空闲</div></div>
    </div>

    ${alerts.length > 0 ? `<div class="alert warn">
      ⏰ ${alerts.length} 张桌需要关注：${alerts.map((t) =>
        `${esc(t.tableName)}${t.session.alertLevel === 'overtime' ? '（已超时）' : '（即将到时）'}`).join('、')}
    </div>` : ''}

    <div class="btn-group" style="margin-bottom:14px">
      <button class="btn" onclick="go('newMember')">＋ 新会员</button>
      <button class="btn secondary" onclick="go('members')">查会员</button>
    </div>

    <div class="board-grid">
      ${d.tables.map(seatCard).join('')}
    </div>
  </div>
  ${tabbar('board')}`;
}

// ---------------------------------------------------------------------------
// 开台：选会员 → 选套餐
// ---------------------------------------------------------------------------
async function OpenTablePage() {
  const tableId = state.route.params.tableId;
  const step = state.route.params.step || 'member';

  const tables = await api.get('/api/v1/tables');
  const table = tables.tables.find((t) => t.id === tableId);
  if (!table) return `<div class="page"><div class="alert error">桌位不存在</div></div>`;

  // 第一步：选会员或散客
  if (step === 'member') {
    const recent = await api.get('/api/v1/members?limit=12');
    // 记住桌名，供后续「开卡」流程回显与返回使用
    state.route.params.tableName = table.name;
    return `
    ${topbar(`${table.name} · 选择顾客`, 'board')}
    <div class="page">
      <div class="card">
        <div class="field" style="margin-bottom:10px">
          <label>搜索会员（昵称或手机尾号）</label>
          <input id="msearch" placeholder="输入昵称或尾号，如：小雨 或 5481"
                 oninput="debouncedSearchMembers(this.value)">
        </div>
        <div id="mresults"></div>
        <button class="btn" onclick="go('newMember',{from:'openTable',tableId:${tableId},tableName:'${esc(table.name)}'})">
          ＋ 新会员开卡
        </button>
      </div>

      ${recent.members.length > 0 ? `
      <div class="card">
        <div class="card-title">最近会员</div>
        <div class="list">
          ${recent.members.map((m) => `
            <div class="list-item" onclick="pickMember(${tableId},${m.id})">
              <div class="main">
                <div class="name">${esc(m.displayName)}</div>
                <div class="meta">${esc(m.memberNo)}${m.cardValid ? ' · ' + cardTypeName(m.cardType) + '有效' : ''}</div>
              </div>
              <div class="meta">›</div>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <div class="card">
        <div class="card-title">或者</div>
        <div class="field">
          <label>散客称呼</label>
          <input id="guestName" placeholder="如：小雨、穿蓝衣服的姐姐" maxlength="20">
          <div class="hint">散客不记会员，只记到店和消费</div>
        </div>
        <button class="btn secondary" onclick="pickGuest(${tableId})">以散客身份开台</button>
      </div>
    </div>`;
  }

  // 第二步：选套餐
  const memberId = state.route.params.memberId ? Number(state.route.params.memberId) : null;
  const guestName = state.route.params.guestName || null;
  const products = await api.get('/api/v1/products');

  let member = null;
  if (memberId) {
    const md = await api.get(`/api/v1/members/${memberId}`);
    member = md.member;
  }

  // 把本次开台的对象存进状态，避免把用户输入的称呼拼进 onclick（会破坏 JS 语法）
  state.openTarget = { tableId, memberId, guestName };

  const who = member ? member.displayName : guestName;

  const groups = [
    { key: 'timed', title: '⏱ 限时不限板', items: products.products.filter((p) => p.category === 'timed') },
    { key: 'board', title: '📌 限板不限时', items: products.products.filter((p) => p.category === 'board') },
    { key: 'day', title: '☀️ 日卡（当天有效）', items: products.products.filter((p) => p.category === 'day') },
    { key: 'card', title: '🎫 周卡', items: products.products.filter((p) => p.category === 'card') },
  ];

  return `
  ${topbar(`${table.name} · ${who}`, 'board')}
  <div class="page">
    <div id="ot-error"></div>

    ${member && member.cardValid && !member.cardFrozen ? `
    <div class="card" style="border:2px solid var(--mint)">
      <div class="card-title">该会员持有权益</div>
      <div style="font-size:16px;font-weight:700;color:#0B6B4F;margin-bottom:4px">
        🎫 ${cardTypeName(member.cardType)} · ${fmtDate(member.cardStartedAt)} — ${fmtDate(member.cardExpiresAt)}
      </div>
      <div style="font-size:12.5px;color:var(--text-mid);margin-bottom:12px">
        卡权益为全天不限时，用卡开台不选套餐、不计超时、不收费（加购另计）
      </div>
      <button class="btn mint" onclick="openWithCard(${tableId},${memberId})">用卡开台</button>
    </div>` : ''}

    <div class="card">
      <h2>${member ? '或者按套餐开台' : '选择套餐'}</h2>
      ${groups.filter((g) => g.items.length > 0).map((g) => `
        <div class="card-title" style="margin-top:12px">${g.title}</div>
        <div class="product-grid">
          ${g.items.map((p) => `
            <div class="product-card" onclick="openWithProduct(${p.id})">
              <div class="pname">${esc(p.name)}</div>
              <div class="pprice">¥${yuan(p.priceCents)}</div>
              <div class="ptag">${p.durationMinutes ? humanMinutes(p.durationMinutes) : (p.pins ? p.pins + ' 钉' : p.cardValidDays ? p.cardValidDays + ' 天' : '')}</div>
            </div>`).join('')}
        </div>`).join('')}
    </div>

    <div class="card">
      <div class="card-title">加购（开台后结账时也可加）</div>
      <div class="product-grid">
        ${products.products.filter((p) => p.category === 'addon').map((p) => `
          <div class="product-card" style="cursor:default">
            <div class="pname">${esc(p.name)}</div>
            <div class="pprice">¥${yuan(p.priceCents)}</div>
            <div class="ptag">结账时选择</div>
          </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function cardTypeName(t) {
  return { week: '周卡', month: '月卡', day: '日卡' }[t] || '卡';
}

let searchTimer = null;
function debouncedSearchMembers(q) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchMembers(q), 250);
}

/**
 * 会员列表页的实时搜索。
 * 与开台页不同，这里走路由刷新整页列表，因此：
 *   · 防抖时间略长，避免边打字边发请求
 *   · 已处于同一关键词时不重复跳转
 */
let memberSearchTimer = null;
function debouncedMemberSearch(q) {
  clearTimeout(memberSearchTimer);
  memberSearchTimer = setTimeout(() => {
    const cur = (state.route.params.q || '').trim();
    const next = q.trim();
    if (cur === next) return;
    go('members', { q: next });
  }, 350);
}

async function searchMembers(q) {
  const box = $('#mresults');
  const keyword = q.trim();
  if (!keyword) { box.innerHTML = ''; return; }

  const tableId = state.route.params.tableId;
  const d = await api.get(`/api/v1/members?limit=8&q=${encodeURIComponent(keyword)}`);

  if (d.members.length === 0) {
    // 搜不到就直接给开卡入口，不必跳去会员页再绕回来。
    // 把刚输入的关键字带过去，省得重打一遍。
    const isTail = /^\d{4}$/.test(keyword);
    box.innerHTML = `
      <div class="alert warn" style="margin-bottom:10px">
        没有找到「${esc(keyword)}」这个会员
      </div>
      <button class="btn" onclick="go('newMember',{from:'openTable',tableId:${tableId},tableName:'${esc(state.route.params.tableName || '')}',nickname:'${isTail ? '' : esc(keyword)}',phoneTail:'${isTail ? keyword : ''}'})">
        ＋ 给「${esc(keyword)}」开卡
      </button>`;
    return;
  }

  box.innerHTML = `<div class="list">${d.members.map((m) => `
    <div class="list-item" onclick="pickMember(${tableId},${m.id})">
      <div class="main">
        <div class="name">${esc(m.displayName)}</div>
        <div class="meta">${esc(m.memberNo)}${m.cardValid ? ' · ' + cardTypeName(m.cardType) + '有效' : ''}</div>
      </div>
      <div class="meta">›</div>
    </div>`).join('')}</div>`;
}

function pickMember(tableId, memberId) {
  go('openTable', { tableId, memberId, step: 'product' });
}

function pickGuest(tableId) {
  const name = $('#guestName').value.trim();
  if (!name) { toast('请填写散客称呼', 'error'); return; }
  if (name.length > 20) { toast('称呼不能超过 20 个字', 'error'); return; }
  go('openTable', { tableId, guestName: name, step: 'product' });
}

/**
 * 开台。
 * 只接收 productId，其余（桌位、会员、散客称呼）从 state.openTarget 读取。
 * 这样避免把用户输入的称呼拼进 onclick —— 那会破坏 JS 语法并造成注入风险。
 */
async function openWithProduct(productId) {
  const errBox = $('#ot-error');
  const target = state.openTarget;
  if (!target) {
    if (errBox) errBox.innerHTML = `<div class="alert error">页面状态已失效，请返回重新选择桌位</div>`;
    return;
  }

  // 二次确认：套餐一点就开台，选错只能整单作废，高峰期容易出错
  const products = await api.get('/api/v1/products');
  const prod = products.products.find((p) => p.id === productId);

  // 找不到套餐通常有两个原因，都要给店员一条明确的出路：
  //   1. 管理员刚刚下架了这个套餐，而页面上的列表还是旧的
  //   2. 页面状态过期
  // 只说"套餐不存在"等于把店员晾在原地，因此这里刷新列表并说明原因。
  if (!prod) {
    if (errBox) {
      errBox.innerHTML = `<div class="alert error">
        这个套餐刚刚被下架或已停用，请重新选择。<br>
        <span style="font-size:12.5px">下面列出的是当前在售的套餐。</span>
      </div>`;
    }
    // 重新渲染页面，让套餐列表刷新到最新
    render();
    window.scrollTo(0, 0);
    return;
  }

  const who = target.guestName ? `散客：${target.guestName}` : '会员（已选择）';

  // 说明文字必须按套餐类型区分：
  // 限时套餐按分钟计费并计超时；限板与日卡不限时，既不倒计时也不收超时费。
  let note;
  if (prod.category === 'timed') {
    note = '开台后立即开始计时。结账时按实际时长计费，' +
           '超出套餐时长每满 20 分钟加收 ¥5。';
  } else if (prod.category === 'board') {
    note = `这款按钉数计费，不限时。不计倒计时，也不会产生超时费。`;
  } else if (prod.category === 'day') {
    note = '日卡当天有效，不限时。不计倒计时，也不会产生超时费。';
  } else {
    note = '开台后立即生效。';
  }

  state.confirmDialog = {
    title: '确认开台',
    lines: [
      who,
      `套餐：${prod.name}　¥${yuan(prod.priceCents)}`,
      prod.durationMinutes ? `时长：${humanMinutes(prod.durationMinutes)}`
        : (prod.pins ? `钉数：${prod.pins} 钉（不限时）`
        : (prod.cardValidDays ? `有效期：${prod.cardValidDays} 天` : '')),
    ].filter(Boolean),
    note,
    confirmText: '确认开台',
    confirmFn: 'reallyOpenWithProduct',
    args: [productId],
  };
  render();
}

/** 已确认后真正执行开台 */
async function reallyOpenWithProduct(productId) {
  const errBox = $('#ot-error');
  const target = state.openTarget;
  if (!target) return;

  try {
    const r = await api.post('/api/v1/sessions', {
      tableId: target.tableId,
      memberId: target.memberId,
      guestName: target.guestName,
      productId,
    });
    state.openTarget = null;
    toast(`${r.tableName} 开台成功 · ${r.productName}`);
    go('seatDetail', { sessionId: r.sessionId });
  } catch (e) {
    if (errBox) errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    window.scrollTo(0, 0);
  }
}

/* =========================================================================
   通用确认弹窗
   用于开台、换套餐、桌位维护等"一点就生效"的操作，避免误触。
   ========================================================================= */
function closeConfirmDialog() {
  state.confirmDialog = null;
  render();
}

function confirmDialogHtml() {
  const dlg = state.confirmDialog;
  if (!dlg) return '';
  return `
  <div class="card-dialog-mask" onclick="closeConfirmDialog()"></div>
  <div class="card-dialog">
    <div class="cd-title">${esc(dlg.title)}</div>
    ${dlg.lines && dlg.lines.length ? `<div class="cd-info">
      ${dlg.lines.map((l) => esc(l)).join('<br>')}
    </div>` : ''}
    ${dlg.totalText ? `<div class="confirm-total">${esc(dlg.totalText)}</div>` : ''}
    ${dlg.note ? `<div class="confirm-note">${esc(dlg.note)}</div>` : ''}
    <div class="btn-group">
      <button class="btn" onclick="runConfirmAction()">${esc(dlg.confirmText || '确认')}</button>
      <button class="btn secondary" onclick="closeConfirmDialog()">取消</button>
    </div>
  </div>`;
}

/** 执行确认弹窗里挂载的动作 */
async function runConfirmAction() {
  const dlg = state.confirmDialog;
  if (!dlg) return;
  const fnName = dlg.confirmFn;
  const args = dlg.args ?? [];
  const fn = window[fnName];
  state.confirmDialog = null;
  render();
  if (typeof fn === 'function') await fn(...args);
}

/**
 * 用卡开台。
 *
 * 卡权益（周卡/月卡/日卡）是"全天不限时的通行权"，因此：
 *   · 不需要选择套餐
 *   · 不设结束时间，也就不会产生超时费
 * 这里只传 useCard，由后端记录权益到期日并释放套餐字段。
 */
async function openWithCard(tableId, memberId) {
  const errBox = $('#ot-error');
  try {
    const r = await api.post('/api/v1/sessions', {
      tableId, memberId, useCard: true, productId: null,
    });
    toast(`${r.tableName} 用卡开台成功 · 权益至 ${fmtDate(r.cardExpiresAt)}`);
    go('seatDetail', { sessionId: r.sessionId });
  } catch (e) {
    if (errBox) errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    window.scrollTo(0, 0);
  }
}

// ---------------------------------------------------------------------------
// 桌位详情 / 结账
// ---------------------------------------------------------------------------
async function SeatDetailPage() {
  const sessionId = state.route.params.sessionId;
  const d = await api.get(`/api/v1/sessions/${sessionId}`);
  const s = d.session;

  if (s.status !== 'active') {
    // 会话已结束，清掉可能残留的加购选择
    addonSelection = { sessionId: null, qty: new Map() };
    return `${topbar('桌位详情', 'board')}<div class="page">
      <div class="alert info">该桌已结账。</div>
      <button class="btn secondary" onclick="go('board')">返回看板</button></div>`;
  }

  // 每次进入详情页都把加购重置为"属于这个会话的空集合"。
  // 这是防止加购串到下一桌的关键：无论从看板、开台还是返回进入，
  // 加购状态都不会带着上一次的选择。
  resetAddonSelection(sessionId);

  const products = await api.get('/api/v1/products');
  const addons = products.products.filter((p) => p.category === 'addon');
  const timed = products.products.filter((p) => p.category === 'timed');

  // 可更换的套餐：限时、限板、日卡都能换。
  // 早先只列出限时套餐，导致店员把 78 钉选成 104 钉后无法修正。
  // 卡类（周卡）是购买后授予的权益，不作为"换套餐"的选项。
  const changeableGroups = [
    { key: 'timed', title: '⏱ 限时不限板', items: timed },
    { key: 'board', title: '📌 限板不限时', items: products.products.filter((p) => p.category === 'board') },
    { key: 'day', title: '☀️ 日卡（当天有效）', items: products.products.filter((p) => p.category === 'day') },
  ].filter((g) => g.items.length > 0);

  return `
  ${topbar(`${s.tableName} · 详情`, 'board')}
  <div class="page">
    <div id="sd-error"></div>

    <div class="member-head">
      <div class="name">${esc(s.memberName || '散客')}</div>
      <div class="no">${s.usedCard
        ? `🎫 ${cardTypeName(s.cardType)} · 全天不限时`
        : esc(s.productName)}</div>
      <div class="figures">
        <div class="fig"><div class="k">开始</div><div class="v">${fmtTime(s.startedAt)}</div></div>
        ${s.usedCard
          ? `<div class="fig"><div class="k">权益至</div>
               <div class="v">${fmtDate(s.cardExpiresAt)}</div></div>`
          : s.expectedEndAt
            ? `<div class="fig"><div class="k">预计结束</div><div class="v">${fmtTime(s.expectedEndAt)}</div></div>`
            : ''}
        <div class="fig"><div class="k">已玩</div>
          <div class="v" data-elapsed="${s.startedAt}" data-plain>${humanMinutes(s.elapsedMinutes)}</div></div>
        ${!s.usedCard && s.expectedEndAt ? `<div class="fig">
          <div class="k cd-label">${s.remainingMinutes <= 0 ? '已超时' : '剩余'}</div>
          <div class="v" data-countdown="${s.expectedEndAt}">—</div></div>` : ''}
      </div>
    </div>

    ${!s.usedCard && s.expectedEndAt ? `
    <div class="card pause-card">
      ${s.paused ? `
        <div class="pause-row">
          <div>
            <div class="pause-title">⏸ 计时已暂停</div>
            <div class="pause-desc">暂停时段不计费，恢复后继续</div>
          </div>
          <button class="btn" onclick="resumeTiming(${sessionId})">恢复计时</button>
        </div>
      ` : `
        <div class="pause-row">
          <div>
            <div class="pause-title">⏱ 计时进行中</div>
            <div class="pause-desc">顾客暂时离开可暂停，暂停时段不计费</div>
          </div>
          <button class="btn secondary" onclick="pauseTiming(${sessionId})">暂停计时</button>
        </div>
      `}
    </div>` : ''}

    ${!s.usedCard ? `
    <div class="card">
      <h2>换套餐</h2>
      ${changeableGroups.map((g) => `
        <div class="card-title" style="margin-top:12px">${g.title}</div>
        <div class="product-grid">
          ${g.items.map((p) => `
            <div class="product-card ${p.name === s.productName ? 'selected' : ''}"
                 onclick="changeProduct(${sessionId},${p.id})">
              <div class="pname">${esc(p.name)}</div>
              <div class="pprice">¥${yuan(p.priceCents)}</div>
              <div class="ptag">${p.durationMinutes ? humanMinutes(p.durationMinutes)
                : (p.pins ? p.pins + ' 钉' : (p.cardValidDays ? p.cardValidDays + ' 天' : ''))}</div>
            </div>`).join('')}
        </div>`).join('')}
      <div class="hint" style="font-size:12px;color:var(--text-dim);margin-top:8px">
        三类套餐都可以互换。换成限时套餐会按新时长重算剩余时间；
        换成限板或日卡则改为不限时，不再有倒计时与超时费。
      </div>
    </div>` : ''}

    <div class="card">
      <h2>加购</h2>
      ${addons.length > 0 ? `
      <div class="addon-list">
        ${addons.map((p) => `
          <div class="addon-row" id="addon-row-${p.id}">
            <div class="addon-info">
              <div class="addon-name">${esc(p.name)}</div>
              <div class="addon-price">¥${yuan(p.priceCents)}${p.discountable ? ' · 参与打折' : ''}</div>
            </div>
            <div class="qty-ctrl">
              <button class="qty-btn" onclick="changeAddonQty(${p.id},-1)" aria-label="减少">−</button>
              <span class="qty-num" id="addon-qty-${p.id}">0</span>
              <button class="qty-btn" onclick="changeAddonQty(${p.id},1)" aria-label="增加">+</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="hint">按数量计价，金额自动计入下方应收</div>` : '<div class="hint">暂无加购项</div>'}

      <div id="settle-preview"></div>


      <div class="field">
        <label>备注</label>
        <input id="settleNote" placeholder="选填">
      </div>
      <button class="btn" id="settleBtn" onclick="doSettle(${sessionId})">确认结账</button>
    </div>
  </div>`;
}

/**
 * 加购选择（带数量）。
 *
 * 两个必须遵守的约束：
 *   1. 按"当前结账的会话"隔离，并记录归属会话 ID。
 *      早先这是纯全局状态，只在结账成功时清空；店员选了加购后返回看板、
 *      再开别的桌时，下一个会话会莫名带上上一桌的加购金额 ——
 *      卡片上看不出勾选，但结账金额已经含了这笔钱，属于真实的多收钱事故。
 *   2. 数量存在 Map 里（id → qty），0 表示未选。
 *      渲染桌位详情页时强制重置，任何路径进入都从零开始。
 */
let addonSelection = { sessionId: null, qty: new Map() };

function resetAddonSelection(sessionId) {
  if (addonSelection.sessionId !== sessionId) {
    addonSelection = { sessionId, qty: new Map() };
  }
  return addonSelection;
}

/** 调整某加购项数量。delta 为 +1 / -1，范围 0–99 */
function changeAddonQty(id, delta) {
  const sel = addonSelection;
  const cur = sel.qty.get(id) ?? 0;
  const next = Math.max(0, Math.min(99, cur + delta));
  if (next === cur) return;

  if (next === 0) sel.qty.delete(id); else sel.qty.set(id, next);

  const numEl = $(`#addon-qty-${id}`);
  const rowEl = $(`#addon-row-${id}`);
  if (numEl) numEl.textContent = String(next);
  if (rowEl) {
    rowEl.classList.toggle('selected', next > 0);
    // 数量大于 1 时单独标出来，避免店员漏看
    rowEl.classList.toggle('multi', next > 1);
  }
  refreshPreview();
}

/** 当前已选加购，转成接口需要的数组 */
function currentAddonItems() {
  return [...addonSelection.qty.entries()].map(([id, qty]) => ({ id, qty }));
}

/** 当前已选加购的查询串，格式 id:qty,id:qty */
function currentAddonQuery() {
  return [...addonSelection.qty.entries()].map(([id, qty]) => `${id}:${qty}`).join(',');
}

async function refreshPreview() {
  const sessionId = state.route.params.sessionId;
  const box = $('#settle-preview');
  if (!box) return;
  const ids = currentAddonQuery();
  try {
    const d = await api.get(`/api/v1/sessions/${sessionId}/preview${ids ? '?addons=' + ids : ''}`);
    const p = d.preview;
    box.innerHTML = `
      <div style="margin:12px 0">
        <div class="summary-row"><span>套餐</span><span class="v">¥${yuan(p.productAmountCents)}</span></div>
        ${p.discountCents > 0 ? `<div class="summary-row"><span>🎉 打折日 8 折</span>
          <span class="v" style="color:var(--pink)">-¥${yuan(p.discountCents)}</span></div>` : ''}
        ${p.addonAmountCents > 0 ? `<div class="summary-row"><span>加购</span><span class="v">¥${yuan(p.addonAmountCents)}</span></div>` : ''}
        ${p.overtimeFeeCents > 0 ? `<div class="summary-row"><span>超时费（${p.overtimeUnits} 档）</span>
          <span class="v" style="color:var(--coral)">¥${yuan(p.overtimeFeeCents)}</span></div>` : ''}
        <div class="summary-row total"><span>应收</span><span class="v">¥${yuan(p.totalCents)}</span></div>
        <div class="hint" style="font-size:12px;color:var(--text-dim);margin-top:6px">
          已玩 ${humanMinutes(p.actualMinutes)}${p.usedCard ? ' · 卡核销免套餐费' : ''}
        </div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

async function changeProduct(sessionId, productId) {
  // 换套餐会立即改变计费时长与金额，加确认避免误触
  const products = await api.get('/api/v1/products');
  const p = products.products.find((x) => x.id === productId);
  if (!p) return;

  const d = await api.get(`/api/v1/sessions/${sessionId}`);
  const cur = d.session;

  // 说明按目标套餐类型给：
  // 换成限时套餐才会重新计算结束时间；换成限板/日卡则改为不限时。
  let note;
  if (p.durationMinutes) {
    note = `换套餐不会重置计时起点，剩余时间按新的 ${humanMinutes(p.durationMinutes)} 重新计算。` +
           `若已超时，超时费按新时长重算。此操作会记入日志。`;
  } else if (p.category === 'board') {
    note = `换成按钉数计费后不再限时：会取消倒计时与预计结束时间，也不会产生超时费。` +
           `此操作会记入日志。`;
  } else if (p.category === 'day') {
    note = `换成日卡后当天有效、不限时：会取消倒计时与预计结束时间，也不会产生超时费。` +
           `此操作会记入日志。`;
  } else {
    note = '此操作会记入日志。';
  }

  state.confirmDialog = {
    title: '确认换套餐',
    lines: [
      `当前：${cur.productName}`,
      `改为：${p.name}　¥${yuan(p.priceCents)}`,
      p.durationMinutes ? `新时长：${humanMinutes(p.durationMinutes)}（从原开始时间重算）`
        : (p.pins ? `钉数：${p.pins} 钉（不限时）` : '（不限时）'),
    ].filter(Boolean),
    note,
    confirmText: '确认更换',
    confirmFn: 'reallyChangeProduct',
    args: [sessionId, productId],
  };
  render();
}

async function reallyChangeProduct(sessionId, productId) {
  const errBox = $('#sd-error');
  try {
    const r = await api.patch(`/api/v1/sessions/${sessionId}/product`, { productId });
    toast(`已换成 ${r.productName}`);
    go('seatDetail', { sessionId });
  } catch (e) {
    if (errBox) errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

/** 暂停计时：顾客中途离开时暂停，暂停时段不计费 */
async function pauseTiming(sessionId) {
  try {
    await api.post(`/api/v1/sessions/${sessionId}/pause`);
    toast('⏸ 已暂停计时');
    go('seatDetail', { sessionId });
  } catch (e) { toast(e.message, 'error'); }
}

/** 恢复计时：暂停时长自动折算，从暂停处继续计费 */
async function resumeTiming(sessionId) {
  try {
    await api.post(`/api/v1/sessions/${sessionId}/resume`);
    toast('▶ 已恢复计时');
    go('seatDetail', { sessionId });
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * 结账第一步：弹出核对单。
 *
 * 收钱前必须让店员看清"这一单到底收了什么、收多少"，
 * 尤其是加购、超时费、折扣这些容易被忽略的部分。
 * 因此这里先取一次预览（不落库），把完整账单摊开，确认后才真正提交。
 */
/**
 * 结账第一步：打开结算面板。
 *
 * 面板里除了展示账单，还允许直接填实收金额 ——
 * 熟人少收、抹零、顾客给整钱不用找零都在这处理。
 * 差额记成一笔人工优惠，保证「应收 - 优惠 = 实收」恒等，账目永远能对上。
 */
async function doSettle(sessionId) {
  const errBox = $('#sd-error');
  const ids = currentAddonQuery();
  // 默认微信，但结算面板里可以改 —— 收款现场以实际收到的为准
  const method = state.lastPayMethod || 'wechat';
  const note = $('#settleNote').value.trim();

  try {
    const d = await api.get(`/api/v1/sessions/${sessionId}`);
    const s = d.session;

    const pv = (await api.get(
      `/api/v1/sessions/${sessionId}/preview${ids ? '?addons=' + ids : ''}`
    )).preview;

    state.settleDialog = {
      sessionId, session: s, preview: pv,
      method, note,
      // 默认实收等于应收，店员不改就是原价
      overrideCents: pv.totalCents,
      overrideInput: yuan(pv.totalCents),
      adjustNote: '',
    };
    render();
  } catch (e) {
    if (errBox) errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    window.scrollTo(0, 0);
  }
}

/** 关闭结算面板 */
/** 在结算面板里切换支付方式。收款现场选，避免默认值与实际不符。 */
function pickPayMethod(method) {
  const dlg = state.settleDialog;
  if (!dlg) return;
  dlg.method = method;
  // 只更新按钮高亮，不整页重渲染 —— 避免输入框内容被重置
  document.querySelectorAll('.pay-opt').forEach((b) => b.classList.remove('on'));
  const idx = ['wechat', 'alipay', 'cash', 'card', 'other'].indexOf(method);
  const btns = document.querySelectorAll('.pay-opt');
  if (btns[idx]) btns[idx].classList.add('on');
}

function closeSettleDialog() {
  state.settleDialog = null;
  render();
}

/** 输入实收金额时实时刷新差额提示 */
function onOverrideInput(value) {
  const dlg = state.settleDialog;
  if (!dlg) return;
  dlg.overrideInput = value;
  const cents = toCents(value);
  dlg.overrideCents = Number.isNaN(cents) ? null : cents;

  const box = $('#override-diff');
  // 按钮上的金额也要跟着变，否则店员看到的确认金额与差额提示不一致
  const btn = $('#settle-confirm-btn');
  if (btn) {
    btn.textContent = dlg.overrideCents === null ? '确认收款' : '确认收款 ¥' + yuan(dlg.overrideCents);
    btn.disabled = dlg.overrideCents === null;
  }
  if (!box) return;
  if (dlg.overrideCents === null) {
    box.innerHTML = '<div class="alert error">金额格式不正确</div>';
    return;
  }
  const diff = dlg.preview.totalCents - dlg.overrideCents;
  if (diff === 0) {
    box.innerHTML = '<div class="ov-row"><span>与应收一致</span><span>—</span></div>';
  } else if (diff > 0) {
    box.innerHTML = `<div class="ov-row discount"><span>少收</span><span>-¥${yuan(diff)}</span></div>`;
  } else {
    box.innerHTML = `<div class="ov-row extra"><span>多收</span><span>+¥${yuan(-diff)}</span></div>`;
  }
}

/** 结算面板 */
function settleDialogHtml() {
  const dlg = state.settleDialog;
  if (!dlg) return '';
  const { session: s, preview: pv } = dlg;

  const rows = [];
  rows.push(`<div class="ov-row"><span>桌位</span><span>${esc(s.tableName)}</span></div>`);
  rows.push(`<div class="ov-row"><span>顾客</span><span>${esc(s.memberName || '散客')}</span></div>`);

  if (s.usedCard) {
    rows.push(`<div class="ov-row"><span>权益</span><span>${cardTypeName(s.cardType)} · 全天不限时</span></div>`);
    rows.push(`<div class="ov-row"><span>套餐费</span><span>¥0.00（卡核销）</span></div>`);
  } else {
    rows.push(`<div class="ov-row"><span>套餐</span><span>${esc(s.productName)}　¥${yuan(pv.productOriginalCents)}</span></div>`);
  }
  if (pv.addonOriginalCents > 0) {
    rows.push(`<div class="ov-row"><span>加购</span><span>¥${yuan(pv.addonOriginalCents)}${pv.addonDiscountCents > 0 ? ' → ¥' + yuan(pv.addonAmountCents) : ''}</span></div>`);
  }
  if (pv.overtimeFeeCents > 0) {
    rows.push(`<div class="ov-row"><span>超时费</span><span>¥${yuan(pv.overtimeFeeCents)}${pv.overtimeUnits > 0 ? `（${pv.overtimeUnits} 段）` : ''}</span></div>`);
  }
  if (pv.discountCents > 0) {
    rows.push(`<div class="ov-row discount"><span>打折日优惠</span><span>-¥${yuan(pv.discountCents)}</span></div>`);
  }
  rows.push(`<div class="ov-row total"><span>应收</span><span>¥${yuan(pv.totalCents)}</span></div>`);

  const diff = dlg.overrideCents === null ? null : pv.totalCents - dlg.overrideCents;
  const diffHtml = dlg.overrideCents === null
    ? '<div class="alert error">金额格式不正确</div>'
    : diff === 0
      ? '<div class="ov-row"><span>与应收一致</span><span>—</span></div>'
      : diff > 0
        ? `<div class="ov-row discount"><span>少收</span><span>-¥${yuan(diff)}</span></div>`
        : `<div class="ov-row extra"><span>多收</span><span>+¥${yuan(-diff)}</span></div>`;

  const canSubmit = dlg.overrideCents !== null;

  return `
  <div class="card-dialog-mask" onclick="closeSettleDialog()"></div>
  <div class="card-dialog settle-dialog">
    <div class="cd-title">核对账单并收款</div>
    <div class="ov-box">${rows.join('')}</div>

    <div class="field" style="margin-top:12px">
      <label>实收金额（元）</label>
      <input id="ov-amount" inputmode="decimal" value="${esc(dlg.overrideInput)}"
             oninput="onOverrideInput(this.value)">
    </div>
    <div id="override-diff" class="ov-diff">${diffHtml}</div>

    <div class="field">
      <label>备注（选填）</label>
      <input id="ov-note" placeholder="如：熟客、抹零" value="${esc(dlg.adjustNote)}"
             oninput="state.settleDialog && (state.settleDialog.adjustNote = this.value)">
    </div>

    <div class="field">
      <label>支付方式</label>
      <div class="pay-picker">
        ${[['wechat', '微信'], ['alipay', '支付宝'], ['cash', '现金'], ['card', '卡核销'], ['other', '其他']]
          .map(([v, label]) => `<button type="button"
            class="pay-opt ${dlg.method === v ? 'on' : ''}"
            onclick="pickPayMethod('${v}')">${label}</button>`).join('')}
      </div>
    </div>
    ${dlg.note ? `<div class="ov-method">备注：${esc(dlg.note)}</div>` : ''}

    <div class="btn-group">
      <button class="btn" id="settle-confirm-btn" ${canSubmit ? '' : 'disabled'}
              onclick="reallyDoSettle()">确认收款 ¥${dlg.overrideCents === null ? '—' : yuan(dlg.overrideCents)}</button>
      <button class="btn secondary" onclick="closeSettleDialog()">取消</button>
    </div>
  </div>`;
}

/** 结账第二步：确认后真正提交 */
async function reallyDoSettle() {
  const dlg = state.settleDialog;
  if (!dlg) return;
  const errBox = $('#sd-error');

  const btn = $('#settle-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = '结账中…'; }

  try {
    const payload = {
      addonItems: currentAddonItems(),
      paymentMethod: dlg.method,
      note: dlg.note || undefined,
    };
    // 只有与应收不一致时才传 override，避免无谓地记一笔零差额
    if (dlg.overrideCents !== null && dlg.overrideCents !== dlg.preview.totalCents) {
      payload.overrideTotalCents = dlg.overrideCents;
      if (dlg.adjustNote.trim()) payload.overrideReason = dlg.adjustNote.trim();
    }

    const r = await api.post(`/api/v1/sessions/${dlg.sessionId}/settle`, payload);

    state.lastPayMethod = dlg.method;
    state.settleDialog = null;
    addonSelection = { sessionId: null, qty: new Map() };

    const msg = r.totalCents > 0
      ? `结账完成 · 实收 ¥${yuan(r.totalCents)}`
      : '结账完成 · 卡核销免费';
    toast(msg);
    go('board');
  } catch (e) {
    if (errBox) errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = '确认收款'; }
    window.scrollTo(0, 0);
  }
}

// ---------------------------------------------------------------------------
// 会员列表
//
// 每条会员直接展开显示权益与消费概况，不用点进去才看得到。
// 权益只展示"当前这一段"的起止；已过期则明确标记，不显示历史卡。
// ---------------------------------------------------------------------------
async function MembersPage() {
  const q = state.route.params.q || '';
  const d = await api.get(`/api/v1/members?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const reminders = await api.get('/api/v1/members/reminders?days=7');

  return `
  ${topbar('会员')}
  <div class="page">
    <div class="field" style="margin-bottom:12px">
      <div style="display:flex;gap:8px">
        <input id="search" placeholder="输入昵称或手机尾号" value="${esc(q)}"
               style="flex:1"
               oninput="debouncedMemberSearch(this.value)"
               onkeydown="if(event.key==='Enter'){clearTimeout(memberSearchTimer);go('members',{q:this.value.trim()})}">
        <button class="btn" style="flex:0 0 76px;padding:12px 0"
                onclick="go('members',{q:document.getElementById('search').value.trim()})">搜索</button>
      </div>
      <div class="hint">边输边搜，也可点右侧按钮</div>
    </div>

    <button class="btn" onclick="go('newMember')" style="margin-bottom:12px">＋ 新会员</button>

    ${reminders.reminders.length > 0 ? `<div class="alert warn">
      🎫 ${reminders.reminders.length} 位会员的卡即将到期：${reminders.reminders.slice(0, 3).map((m) =>
        `${esc(m.displayName)}（${m.daysLeft}天）`).join('、')}${reminders.reminders.length > 3 ? ' 等' : ''}
    </div>` : ''}

    ${d.members.length === 0
      ? `<div class="empty"><span class="emoji">🧩</span>${q ? '没有找到匹配的会员' : '还没有会员，点上面按钮开卡'}</div>`
      : d.members.map(memberCard).join('')}
  </div>
  ${tabbar('members')}`;
}

/** 会员卡片：信息技术上只保留身份 + 权益，突出"这张卡还能不能用、用到什么时候" */
function memberCard(m) {
  const hasCard = Boolean(m.cardType);

  // 权益行：有效 → 显示起止区间；过期 → 标记已过期；无卡 → 明示无权益
  let benefitHtml;
  if (!hasCard) {
    benefitHtml = `<div class="mc-benefit none">🎫 无权益</div>`;
  } else if (m.cardValid) {
    benefitHtml = `<div class="mc-benefit valid">
      🎫 ${cardTypeName(m.cardType)} · ${fmtDate(m.cardStartedAt)} — ${fmtDate(m.cardExpiresAt)}
      <span class="mc-left">${cardDaysLeft(m.cardExpiresAt)}</span>
    </div>`;
  } else {
    benefitHtml = `<div class="mc-benefit expired">
      🎫 ${cardTypeName(m.cardType)} · 已过期
      <span class="mc-left">${fmtDate(m.cardExpiresAt)} 到期</span>
    </div>`;
  }

  // 用卡次数只在有卡时展示，作为"这张卡用了几次"的参考
  return `
  <div class="member-card" onclick="go('memberDetail',{id:${m.id}})">
    <div class="mc-head">
      <div class="mc-name">${esc(m.displayName)}</div>
      <div class="mc-no">${esc(m.memberNo)}</div>
    </div>
    ${benefitHtml}
    <div class="mc-foot">
      <span>${fmtDate(m.joinedOn)} 加入 · 到店 ${m.visitCount} 次</span>
      ${hasCard ? `<span>用卡 ${m.cardUsedCount} 次</span>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 新会员
// ---------------------------------------------------------------------------
function NewMemberPage() {
  // 支持从开台流程跳进来：预填用户刚输入的关键字，开完卡直接继续开台
  const from = state.route.params.from;
  const tableId = state.route.params.tableId;
  const preNickname = state.route.params.nickname || '';
  const preTail = state.route.params.phoneTail || '';
  const cameFromOpenTable = from === 'openTable' && tableId;

  return `
  ${topbar('新会员', cameFromOpenTable ? '' : 'board')}
  <div class="page">
    ${cameFromOpenTable ? `<div class="alert info">
      开卡后会直接回到 ${esc(state.route.params.tableName || '刚才的桌')} 继续开台
    </div>` : ''}
    <div id="nm-error"></div>
    <div class="card">
      <div class="field">
        <label>昵称 <span style="color:var(--pink)">*</span></label>
        <input id="nm-nickname" placeholder="如：杨先生、小雨" maxlength="20"
               value="${esc(preNickname)}">
        <div class="hint">随便填，能认出是谁就行</div>
      </div>
      <div class="field">
        <label>手机尾号 4 位</label>
        <input id="nm-tail" inputmode="numeric" maxlength="4" placeholder="如：5481"
               value="${esc(preTail)}">
        <div class="hint">选填。填了以后可以快速查找</div>
      </div>
      <div class="field">
        <label>备注</label>
        <textarea id="nm-remark" rows="2" placeholder="选填"></textarea>
      </div>
      <button class="btn" id="nm-btn" onclick="doCreateMember()">开卡</button>
      ${cameFromOpenTable ? `<button class="btn secondary" style="margin-top:10px"
        onclick="go('openTable',{tableId:${tableId},step:'member'})">返回，不开卡</button>` : ''}
    </div>
  </div>`;
}

async function doCreateMember() {
  const nickname = $('#nm-nickname').value.trim();
  const tail = $('#nm-tail').value.trim();
  const errBox = $('#nm-error'), btn = $('#nm-btn');

  if (!nickname) { errBox.innerHTML = `<div class="alert error">请填写昵称</div>`; return; }
  if (tail && !/^\d{4}$/.test(tail)) { errBox.innerHTML = `<div class="alert error">手机尾号必须是 4 位数字</div>`; return; }

  btn.disabled = true; btn.textContent = '处理中…';
  try {
    const r = await api.post('/api/v1/members', {
      nickname,
      phoneTail: tail || null,
      remark: $('#nm-remark').value.trim() || undefined,
    });
    toast(`已开卡：${r.nickname}（${r.memberNo}）`);

    // 从开台流程进来的：开完卡直接带着这个会员进入选套餐
    const from = state.route.params.from;
    const tableId = state.route.params.tableId;
    if (from === 'openTable' && tableId) {
      go('openTable', { tableId, memberId: r.id, step: 'product' });
    } else {
      go('memberDetail', { id: r.id });
    }
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    btn.disabled = false; btn.textContent = '开卡';
  }
}

// ---------------------------------------------------------------------------
// 会员详情
// ---------------------------------------------------------------------------
async function MemberDetailPage() {
  const id = state.route.params.id;
  const d = await api.get(`/api/v1/members/${id}`);
  const m = d.member;
  // 缓存供标签局部切换使用，避免每次切 Tab 都重新请求
  state.memberCache = m;
  const products = await api.get('/api/v1/products');
  const cardProducts = products.products.filter((p) => p.category === 'card');

  return `
  ${topbar('会员详情', 'members')}
  <div class="page">
    <div class="member-head ${m.status === 'disabled' ? 'disabled' : ''}">
      <div class="name">${esc(m.displayName)}</div>
      <div class="no">${esc(m.memberNo)} · ${fmtDate(m.joinedOn)} 加入</div>
      ${m.status === 'disabled' ? `<div class="card-badge expired">⛔ 该会员已停用</div>` : ''}
      ${m.cardType
        ? (m.cardFrozen
            ? `<div class="card-badge frozen">❄️ ${cardTypeName(m.cardType)} 已冻结</div>`
            : `<div class="card-badge ${m.cardValid ? '' : 'expired'}">
                 🎫 ${cardTypeName(m.cardType)} ${m.cardValid
                   ? `${fmtDate(m.cardStartedAt)} — ${fmtDate(m.cardExpiresAt)}`
                   : '已过期 · ' + fmtDate(m.cardExpiresAt)}
               </div>`)
        : `<div class="card-badge expired">🎫 无权益</div>`}
      <div class="figures">
        <div class="fig"><div class="k">到店次数</div><div class="v">${m.visitCount}</div></div>
        <div class="fig"><div class="k">消费</div><div class="v">¥${yuan(m.stats.visitPaidCents)}</div></div>
        ${m.stats.cardPaidCents > 0
          ? `<div class="fig"><div class="k">办卡</div><div class="v">¥${yuan(m.stats.cardPaidCents)}</div></div>`
          : ''}
        ${m.cardType ? `<div class="fig"><div class="k">用卡次数</div><div class="v">${m.cardUsedCount}</div></div>` : ''}
      </div>
    </div>

    ${m.cardFrozen && m.cardFrozenReason ? `<div class="alert warn">
      ❄️ 卡已冻结：${esc(m.cardFrozenReason)}
    </div>` : ''}

    ${!m.cardValid && !m.cardFrozen && cardProducts.length > 0 ? `
    <div class="card">
      <h2>办卡</h2>
      <div class="product-grid">
        ${cardProducts.map((p) => `
          <div class="product-card" onclick="buyCard(${m.id},${p.id})">
            <div class="pname">${esc(p.name)}</div>
            <div class="pprice">¥${yuan(p.priceCents)}</div>
            <div class="ptag">${p.cardValidDays} 天</div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="btn-group" style="margin-bottom:12px">
      <button class="btn secondary" onclick="go('memberEdit',{id:${m.id}})">编辑资料</button>
      ${m.cardType && !m.cardFrozen
        ? `<button class="btn secondary" onclick="renewCard(${m.id})">续卡</button>` : ''}
    </div>

    ${m.cardType ? `
    <div class="card">
      <h2>权益管理</h2>
      <div class="btn-group">
        ${m.cardFrozen
          ? `<button class="btn mint" onclick="unfreezeCard(${m.id})">解冻权益</button>`
          : `<button class="btn secondary" onclick="freezeCard(${m.id})">冻结权益</button>`}
        <button class="btn danger" onclick="openRefundCard(${m.id})">退卡</button>
      </div>
      <div class="hint" style="margin-top:9px;font-size:12px;color:var(--text-dim)">
        冻结：暂时不能用，卡保留，不退款。退卡：作废权益并退款，需要填退款金额。
      </div>
    </div>` : ''}

    <div class="card">
      <h2>会员状态</h2>
      <div class="status-row">
        <div>
          <div class="status-label">${m.status === 'active' ? '正常使用中' : '已停用'}</div>
          <div class="status-hint">${m.status === 'active'
            ? '停用后不能开台、不能办卡、不能用卡核销'
            : '停用期间无法开台与办卡'}</div>
        </div>
        ${m.status === 'active'
          ? `<button class="btn danger small" onclick="toggleMemberStatus(${m.id},'disabled',event)">停用</button>`
          : `<button class="btn mint small" onclick="toggleMemberStatus(${m.id},'active',event)">恢复</button>`}
      </div>
    </div>

    <div class="segmented">
      <button class="${(state.route.params.tab || 'visits') === 'visits' ? 'active' : ''}"
              onclick="switchMemberTab(${m.id},'visits')">拼豆记录</button>
      <button class="${state.route.params.tab === 'orders' ? 'active' : ''}"
              onclick="switchMemberTab(${m.id},'orders')">消费记录</button>
      <button class="${state.route.params.tab === 'card' ? 'active' : ''}"
              onclick="switchMemberTab(${m.id},'card')">权益记录</button>
    </div>

    <div id="member-tab-body">${memberTabBody(m, state.route.params.tab || 'visits')}</div>

    ${m.remark ? `<div class="card"><div class="card-title">备注</div>${esc(m.remark)}</div>` : ''}
  </div>`;
}

/**
 * 切换会员详情的记录标签。
 *
 * 关键点：不调用 go() 重渲染整页 —— 那会让卡头、按钮区、分段控件
 * 全部重建，视觉上"闪一下"。这里只替换列表容器与按钮激活态。
 */
function switchMemberTab(memberId, tab) {
  if (state.route.params.tab === tab) return;
  state.route.params.tab = tab;

  // 只切分段控件的激活态
  const order = ['visits', 'orders', 'card'];
  const seg = document.querySelector('.segmented');
  if (seg) {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', order[i] === tab));
  }

  // 只替换列表区
  const body = document.getElementById('member-tab-body');
  if (body && state.memberCache?.id === memberId) {
    body.innerHTML = memberTabBody(state.memberCache, tab);
    if (tab === 'card') loadCardRecords(memberId);
  }
}

/** 会员详情里三个标签各自的内容 */
function memberTabBody(m, tab) {
  if (tab === 'card') {
    return `<div id="card-records-box"><div class="loading" style="padding:24px"><div class="spinner"></div></div></div>`;
  }

  if (tab === 'visits') {
    return m.visits.length === 0
      ? `<div class="empty"><span class="emoji">🪑</span>还没有到店记录</div>`
      : `<div class="list">${m.visits.map((v) => `
        <div class="list-item" style="cursor:default">
          <div class="main">
            <div class="name">${esc(v.productName)}${v.usedCard ? ' <span style="color:var(--mint);font-size:12px">卡核销</span>' : ''}</div>
            <div class="meta">${esc(v.tableName || '')} · ${fmtTime(v.startedAt)}${
              v.actualMinutes !== null ? ' · 玩了 ' + humanMinutes(v.actualMinutes) : ''}${
              v.overtimeUnits > 0 ? ' · 超时 ' + v.overtimeUnits + ' 档' : ''}</div>
          </div>
        </div>`).join('')}</div>`;
  }

  return m.orders.length === 0
    ? `<div class="empty"><span class="emoji">🧾</span>还没有消费记录</div>`
    : `<div class="list">${m.orders.map((o) => `
      <div class="list-item" onclick="go('orderDetail',{id:${o.id}})">
        <div class="main">
          <div class="name">${esc(o.orderNo)}${o.status !== 'completed' ? ' · ' + statusText(o.status) : ''}</div>
          <div class="meta">${fmtTime(o.completedAt)}${o.tableName ? ' · ' + esc(o.tableName) : ''}${
            o.usedCard ? ' · 卡核销' : ''}${o.isDiscountDay ? ' · 打折日' : ''}</div>
        </div>
        <div class="amount">¥${yuan(o.paidCents)}</div>
      </div>`).join('')}</div>`;
}

/** 卡权益流水列表（懒加载，切到该标签时才请求） */
async function loadCardRecords(memberId) {
  const box = document.getElementById('card-records-box');
  if (!box) return;
  try {
    const d = await api.get(`/api/v1/members/${memberId}/card-records`);
    if (d.records.length === 0) {
      box.innerHTML = `<div class="empty"><span class="emoji">🎫</span>还没有权益记录</div>`;
      return;
    }
    const actionText = { issue: '办卡', renew: '续卡', refund: '退卡', freeze: '冻结', unfreeze: '解冻' };
    box.innerHTML = `<div class="list">${d.records.map((r) => `
      <div class="list-item" style="cursor:default">
        <div class="main">
          <div class="name">${actionText[r.action] || r.action}${
            r.cardType ? ' · ' + cardTypeName(r.cardType) : ''}${
            r.refundMethod ? '（退' + payText(r.refundMethod) + '）' : ''}</div>
          <div class="meta">${fmtTime(r.createdAt)} · ${esc(r.operatorName || '')}${
            r.startedAt && r.expiresAt ? ` · ${fmtDate(r.startedAt)} 至 ${fmtDate(r.expiresAt)}` : ''}${
            r.reason ? ' · ' + esc(r.reason) : ''}</div>
        </div>
        ${r.amountCents > 0 ? `<div class="amount ${r.action === 'refund' ? 'neg' : ''}">${
          r.action === 'refund' ? '-' : '+'}¥${yuan(r.amountCents)}</div>` : ''}
      </div>`).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

function statusText(s) {
  return { completed: '已完成', refunded: '已退款', voided: '已作废' }[s] || s;
}

/**
 * 办卡：打开页面内的确认面板。
 *
 * 原先用 prompt() 让店员输 "1/2/3" 选支付方式，但 prompt/alert 在移动端
 * 与部分桌面浏览器会被拦截，被拦截时直接返回 null，表现为"点了没反应"。
 * 因此改为全页面内的交互，不依赖任何浏览器弹窗。
 */
async function buyCard(memberId, productId) {
  const products = await api.get('/api/v1/products?category=card');
  const product = products.products.find((p) => p.id === productId);
  if (!product) { toast('找不到该卡种', 'error'); return; }

  // 已过期的会员提示这是新卡；有效期内则提示会顺延
  const detail = await api.get(`/api/v1/members/${memberId}`);
  state.cardDialog = { memberId, product, member: detail.member };
  render();
}

/** 确认办卡 */
async function confirmBuyCard(paymentMethod) {
  const dlg = state.cardDialog;
  if (!dlg) return;

  const btn = document.querySelector('.card-dialog .btn');
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }

  try {
    const r = await api.post(`/api/v1/members/${dlg.memberId}/card`, {
      cardType: dlg.product.cardType,
      productId: dlg.product.id,
      paymentMethod,
    });
    state.cardDialog = null;
    toast(`办卡成功 · ${fmtDate(r.startedAt)} 至 ${fmtDate(r.expiresAt)}`);
    go('memberDetail', { id: dlg.memberId });
  } catch (e) {
    state.cardDialog = null;
    render();
    toast(e.message, 'error');
  }
}

function closeCardDialog() {
  state.cardDialog = null;
  render();
}

/** 渲染办卡确认面板（覆盖层） */
function cardDialogHtml() {
  const dlg = state.cardDialog;
  if (!dlg) return '';

  const m = dlg.member;
  const renewing = m.cardValid;
  const payOptions = [
    { key: 'wechat', label: '微信' },
    { key: 'alipay', label: '支付宝' },
    { key: 'cash', label: '现金' },
  ];

  return `
  <div class="card-dialog-mask" onclick="closeCardDialog()"></div>
  <div class="card-dialog">
    <div class="cd-title">${renewing ? '续卡' : '办卡'}</div>
    <div class="cd-product">${esc(dlg.product.name)}</div>
    <div class="cd-price">¥${yuan(dlg.product.priceCents)}</div>
    <div class="cd-info">
      会员：<b>${esc(m.displayName)}</b><br>
      ${renewing
        ? `现有${cardTypeName(m.cardType)}至 ${fmtDate(m.cardExpiresAt)}，续卡后从该日顺延 ${dlg.product.cardValidDays} 天`
        : `新卡有效期 ${dlg.product.cardValidDays} 天，从今天起算`}
    </div>
    <div class="cd-label">收款方式</div>
    <div class="cd-pay">
      ${payOptions.map((p) => `
        <button class="cd-pay-btn" onclick="confirmBuyCard('${p.key}')">${p.label}</button>`).join('')}
    </div>
    <button class="btn secondary" onclick="closeCardDialog()">取消</button>
  </div>`;
}

/** 续卡：沿用会员当前的卡种 */
async function renewCard(memberId) {
  const d = await api.get(`/api/v1/members/${memberId}`);
  const cardType = d.member.cardType;
  if (!cardType) { toast('该会员还没有卡，请先办卡', 'error'); return; }

  const products = await api.get('/api/v1/products?category=card');
  const product = products.products.find((p) => p.cardType === cardType);
  if (!product) { toast('找不到对应的卡种', 'error'); return; }

  await buyCard(memberId, product.id);
}

// ---------------------------------------------------------------------------
// 退卡 / 冻结权益
// ---------------------------------------------------------------------------

/** 打开退卡面板。退款金额手动填，不自动折算。 */
async function openRefundCard(memberId) {
  const d = await api.get(`/api/v1/members/${memberId}`);
  const m = d.member;
  if (!m.cardType) { toast('该会员当前没有卡', 'error'); return; }

  state.refundDialog = { memberId, member: m };
  render();
}

function closeRefundDialog() {
  state.refundDialog = null;
  render();
}

async function confirmRefundCard() {
  const dlg = state.refundDialog;
  if (!dlg) return;

  const errBox = $('#refund-error');
  const amountStr = $('#refund-amount').value.trim();
  const reason = $('#refund-reason').value.trim();
  const method = $('#refund-method').value;

  if (reason.length === 0) {
    errBox.innerHTML = `<div class="alert error">请填写退卡原因</div>`;
    return;
  }
  const cents = toCents(amountStr);
  if (Number.isNaN(cents) || cents < 0) {
    errBox.innerHTML = `<div class="alert error">请输入有效的退款金额（元）</div>`;
    return;
  }

  const btn = $('#refund-confirm-btn');
  btn.disabled = true; btn.textContent = '处理中…';

  try {
    const r = await api.post(`/api/v1/members/${dlg.memberId}/card/refund`, {
      refundCents: cents,
      refundMethod: method,
      reason,
    });
    state.refundDialog = null;
    toast(`已退卡，退款 ¥${yuan(r.refundCents)}`);
    go('memberDetail', { id: dlg.memberId });
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    btn.disabled = false; btn.textContent = '确认退卡';
  }
}

/** 渲染退卡面板 */
function refundDialogHtml() {
  const dlg = state.refundDialog;
  if (!dlg) return '';
  const m = dlg.member;

  return `
  <div class="card-dialog-mask" onclick="closeRefundDialog()"></div>
  <div class="card-dialog">
    <div class="cd-title">退卡</div>
    <div class="cd-product">${esc(m.displayName)}</div>
    <div class="cd-info">
      ${cardTypeName(m.cardType)} · ${fmtDate(m.cardStartedAt)} 至 ${fmtDate(m.cardExpiresAt)}<br>
      已用 <b>${m.cardUsedCount}</b> 次 · 累计办卡 <b>¥${yuan(m.stats.cardPaidCents)}</b><br>
      <span style="color:var(--coral)">退卡后权益立即作废，操作会记入日志</span>
    </div>
    <div id="refund-error"></div>
    <div class="field">
      <label>退款金额（元）</label>
      <input id="refund-amount" inputmode="decimal" placeholder="如 258 或 147.43" value="">
      <div class="hint">手动填写，不自动折算。不退钱就填 0</div>
    </div>
    <div class="field">
      <label>退款方式</label>
      <select id="refund-method">
        <option value="wechat">微信</option>
        <option value="alipay">支付宝</option>
        <option value="cash">现金</option>
        <option value="other">其他</option>
      </select>
    </div>
    <div class="field">
      <label>退卡原因 <span style="color:var(--pink)">*</span></label>
      <input id="refund-reason" placeholder="必填，会记入日志">
    </div>
    <div class="btn-group">
      <button class="btn danger" id="refund-confirm-btn" onclick="confirmRefundCard()">确认退卡</button>
      <button class="btn secondary" onclick="closeRefundDialog()">取消</button>
    </div>
  </div>`;
}

/** 冻结权益：暂停使用，不退款 */
async function freezeCard(memberId) {
  state.freezeDialog = { memberId, frozen: true };
  render();
}

/** 停用 / 恢复会员。停用后不能开台、办卡、用卡核销。 */
async function toggleMemberStatus(memberId, status, ev) {
  const isDisable = status === 'disabled';
  const btn = ev?.target ?? null;
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try {
    await api.patch(`/api/v1/members/${memberId}`, { status });
    toast(isDisable ? '会员已停用' : '会员已恢复');
    go('memberDetail', { id: memberId });
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = isDisable ? '停用' : '恢复'; }
  }
}

/** 解冻权益 */
async function unfreezeCard(memberId) {
  try {
    await api.post(`/api/v1/members/${memberId}/card/freeze`, { frozen: false });
    toast('权益已解冻');
    go('memberDetail', { id: memberId });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function closeFreezeDialog() {
  state.freezeDialog = null;
  render();
}

async function confirmFreezeCard() {
  const dlg = state.freezeDialog;
  if (!dlg) return;

  const errBox = $('#freeze-error');
  const reason = $('#freeze-reason').value.trim();
  if (!reason) {
    errBox.innerHTML = `<div class="alert error">请填写冻结原因</div>`;
    return;
  }

  const btn = $('#freeze-confirm-btn');
  btn.disabled = true; btn.textContent = '处理中…';

  try {
    await api.post(`/api/v1/members/${dlg.memberId}/card/freeze`, { frozen: true, reason });
    state.freezeDialog = null;
    toast('权益已冻结');
    go('memberDetail', { id: dlg.memberId });
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    btn.disabled = false; btn.textContent = '确认冻结';
  }
}

function freezeDialogHtml() {
  const dlg = state.freezeDialog;
  if (!dlg) return '';

  return `
  <div class="card-dialog-mask" onclick="closeFreezeDialog()"></div>
  <div class="card-dialog">
    <div class="cd-title">冻结权益</div>
    <div class="cd-product">暂停使用</div>
    <div class="cd-info">
      冻结后该卡<b>不能用于开台核销</b>，但不退款、到期日不变。
      随时可以解冻恢复。
    </div>
    <div id="freeze-error"></div>
    <div class="field">
      <label>冻结原因 <span style="color:var(--pink)">*</span></label>
      <input id="freeze-reason" placeholder="必填，会记入日志">
    </div>
    <div class="btn-group">
      <button class="btn" id="freeze-confirm-btn" onclick="confirmFreezeCard()">确认冻结</button>
      <button class="btn secondary" onclick="closeFreezeDialog()">取消</button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// 编辑会员
// ---------------------------------------------------------------------------
async function MemberEditPage() {
  const id = state.route.params.id;
  const d = await api.get(`/api/v1/members/${id}`);
  const m = d.member;

  return `
  ${topbar('编辑会员', 'memberDetail')}
  <div class="page">
    <div id="me-error"></div>
    <div class="card">
      <div class="field">
        <label>昵称</label>
        <input id="me-nickname" value="${esc(m.nickname)}" maxlength="20">
      </div>
      <div class="field">
        <label>手机尾号</label>
        <input id="me-tail" inputmode="numeric" maxlength="4" value="${esc(m.phoneTail || '')}">
      </div>
      <div class="field">
        <label>备注</label>
        <textarea id="me-remark" rows="2">${esc(m.remark)}</textarea>
      </div>
      <div class="field">
        <label>状态</label>
        <select id="me-status">
          <option value="active" ${m.status === 'active' ? 'selected' : ''}>正常</option>
          <option value="disabled" ${m.status === 'disabled' ? 'selected' : ''}>停用</option>
        </select>
      </div>
      <button class="btn" onclick="doUpdateMember(${id})">保存</button>
    </div>
  </div>`;
}

async function doUpdateMember(id) {
  const errBox = $('#me-error');
  try {
    await api.patch(`/api/v1/members/${id}`, {
      nickname: $('#me-nickname').value.trim(),
      phoneTail: $('#me-tail').value.trim() || null,
      remark: $('#me-remark').value.trim(),
      status: $('#me-status').value,
    });
    toast('已保存');
    go('memberDetail', { id });
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 收入
// ---------------------------------------------------------------------------
async function RevenuePage() {
  const tab = state.route.params.tab || 'summary';
  const body = await revenueTabBody(tab);

  return `
  ${topbar('收入')}
  <div class="page">
    <div class="segmented">
      <button class="${tab === 'summary' ? 'active' : ''}" onclick="switchRevenueTab('summary')">汇总</button>
      <button class="${tab === 'ledger' ? 'active' : ''}" onclick="switchRevenueTab('ledger')">流水</button>
      <button class="${tab === 'orders' ? 'active' : ''}" onclick="switchRevenueTab('orders')">订单</button>
    </div>
    <div id="revenue-tab-body">${body}</div>
  </div>
  ${tabbar('revenue')}`;
}

/**
 * 切换收入页标签。
 * 与会员详情同理：只替换内容区与按钮激活态，不重渲染整页，避免闪动。
 */
async function switchRevenueTab(tab) {
  if (state.route.params.tab === tab) return;
  state.route.params.tab = tab;

  const order = ['summary', 'ledger', 'orders'];
  const seg = document.querySelector('.segmented');
  if (seg) {
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('active', order[i] === tab));
  }

  const box = document.getElementById('revenue-tab-body');
  if (!box) return;
  box.innerHTML = `<div class="loading" style="padding:28px"><div class="spinner"></div></div>`;
  box.innerHTML = await revenueTabBody(tab);
}

/** 收入页三个标签各自的内容 */
async function revenueTabBody(tab) {
  if (tab === 'summary') {
    const sum = await api.get('/api/v1/revenue/summary');
    return `
      <div class="card">
        <h2>今日</h2>
        <div class="summary-row"><span>营业额</span><span class="v" style="font-size:20px;color:var(--pink)">¥${yuan(sum.today.amountCents)}</span></div>
        <div class="summary-row"><span>消费单数</span><span class="v">${sum.today.orderCount} 单</span></div>
        <div class="summary-row"><span>办卡</span><span class="v">${sum.today.cardCount} 张</span></div>
        <div class="summary-row"><span>新增会员</span><span class="v">${sum.members.todayNew} 人</span></div>
      </div>
      <div class="card">
        <h2>本月</h2>
        <div class="summary-row"><span>营业额</span><span class="v" style="font-size:20px;color:var(--pink)">¥${yuan(sum.month.amountCents)}</span></div>
        <div class="summary-row"><span>消费单数</span><span class="v">${sum.month.orderCount} 单</span></div>
        <div class="summary-row"><span>办卡</span><span class="v">${sum.month.cardCount} 张</span></div>
        <div class="summary-row"><span>新增会员</span><span class="v">${sum.members.monthNew} 人</span></div>
        <div class="summary-row"><span>会员总数</span><span class="v">${sum.members.total} 人</span></div>
      </div>
      ${sum.byPaymentMethod.length > 0 ? `
      <div class="card">
        <h2>本月收款方式</h2>
        ${sum.byPaymentMethod.map((x) => `
          <div class="summary-row"><span>${payText(x.method)}（${x.count} 笔）</span>
          <span class="v">¥${yuan(x.amountCents)}</span></div>`).join('')}
      </div>` : ''}`;
  }

  if (tab === 'ledger') {    const d = await api.get('/api/v1/revenue/ledger?limit=60');
    return `
      <div class="card">
        <div class="summary-row total" style="border:none;margin:0;padding:0">
          <span>合计</span><span class="v">¥${yuan(d.totalCents)}</span>
        </div>
        <div class="hint" style="font-size:12px;color:var(--text-dim)">共 ${d.totalCount} 笔</div>
      </div>
      ${d.entries.length === 0 ? `<div class="empty"><span class="emoji">💰</span>还没有流水</div>` : `
      <div class="list">${d.entries.map((e) => `
        <div class="list-item" ${e.orderId ? `onclick="go('orderDetail',{id:${e.orderId}})"` : 'style="cursor:default"'}>
          <div class="main">
            <div class="name">${esc(e.memberName || '散客')}${e.tableName ? ' · ' + esc(e.tableName) : ''}</div>
            <div class="meta">${esc(e.flowNo)} · ${fmtTime(e.createdAt)} · ${payText(e.paymentMethod)}${
              e.flowType === 'refund' ? ' · <span style="color:var(--coral)">退款</span>' : ''}${
              e.flowType === 'card_purchase' ? ' · 办卡' : ''}</div>
          </div>
          <div class="amount ${e.amountCents > 0 ? 'pos' : 'neg'}">${e.amountCents > 0 ? '+' : ''}¥${yuan(e.amountCents)}</div>
        </div>`).join('')}</div>`}`;
  }

  const d = await api.get('/api/v1/orders?limit=60');
  return d.orders.length === 0
    ? `<div class="empty"><span class="emoji">🧾</span>还没有订单</div>`
    : `<div class="list">${d.orders.map((o) => `
        <div class="list-item" onclick="go('orderDetail',{id:${o.id}})">
          <div class="main">
            <div class="name">${esc(o.memberName)}${o.tableName ? ' · ' + esc(o.tableName) : ''}${
              o.status !== 'completed' ? ' · <span style="color:var(--coral)">' + statusText(o.status) + '</span>' : ''}</div>
            <div class="meta">${esc(o.orderNo)} · ${fmtTime(o.completedAt)}${
              o.actualMinutes !== null ? ' · ' + humanMinutes(o.actualMinutes) : ''}${
              o.usedCard ? ' · 卡核销' : ''}${o.isDiscountDay ? ' · 打折日' : ''}</div>
          </div>
          <div class="amount">¥${yuan(o.paidCents)}</div>
        </div>`).join('')}</div>`;
}

function payText(p) {
  return { cash: '现金', wechat: '微信', alipay: '支付宝', card: '卡核销', free: '免费', other: '其他' }[p] || p;
}

// ---------------------------------------------------------------------------
// 订单详情
// ---------------------------------------------------------------------------
async function OrderDetailPage() {
  const id = state.route.params.id;
  const d = await api.get(`/api/v1/orders/${id}`);
  const o = d.order;
  const canVoid = o.status === 'completed' && state.user?.role === 'admin';

  return `
  ${topbar('订单详情', 'revenue')}
  <div class="page">
    <div id="od-error"></div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
        <div>
          <div style="font-weight:700">${esc(o.orderNo)}</div>
          <div style="font-size:12px;color:var(--text-mid)">${fmtTime(o.completedAt)} · ${esc(o.operatorName || '')}</div>
        </div>
        <div style="font-size:20px;font-weight:800;color:var(--pink)">¥${yuan(o.paidCents)}</div>
      </div>
      ${o.status !== 'completed' ? `<div class="alert warn">状态：${statusText(o.status)}${
        o.voidReason ? ' · 原因：' + esc(o.voidReason) : ''}</div>` : ''}
      <div style="font-size:14px;cursor:pointer" onclick="go('memberDetail',{id:${o.memberId}})">
        ${o.memberId ? `${esc(o.memberName)} · ${esc(o.memberNo)}` : esc(o.memberName)}
        ${o.tableName ? ' · ' + esc(o.tableName) : ''} ›
      </div>
    </div>

    ${o.startedAt ? `
    <div class="card">
      <h2>本次记录</h2>
      <div class="summary-row"><span>开始</span><span class="v">${fmtTime(o.startedAt)}</span></div>
      <div class="summary-row"><span>结束</span><span class="v">${fmtTime(o.endedAt)}</span></div>
      <div class="summary-row"><span>实际时长</span><span class="v">${humanMinutes(o.actualMinutes)}</span></div>
      ${o.overtimeUnits > 0 ? `<div class="summary-row"><span>超时档数</span>
        <span class="v" style="color:var(--coral)">${o.overtimeUnits} 档</span></div>` : ''}
    </div>` : ''}

    <div class="card">
      <h2>费用明细</h2>
      <div class="list" style="margin-bottom:10px">
        ${o.items.map((it) => `
          <div class="list-item" style="cursor:default">
            <div class="main">
              <div class="name">${esc(it.name)}</div>
              ${it.qty !== 1 ? `<div class="meta">数量 ${it.qty}</div>` : ''}
            </div>
            <div class="amount">¥${yuan(it.amountCents)}</div>
          </div>`).join('')}
      </div>
      <div class="summary-row"><span>套餐</span><span class="v">¥${yuan(o.productAmountCents)}</span></div>
      ${o.addonAmountCents > 0 ? `<div class="summary-row"><span>加购</span><span class="v">¥${yuan(o.addonAmountCents)}</span></div>` : ''}
      ${o.overtimeFeeCents > 0 ? `<div class="summary-row"><span>超时费</span><span class="v">¥${yuan(o.overtimeFeeCents)}</span></div>` : ''}
      ${o.discountCents > 0 ? `<div class="summary-row"><span>${o.isDiscountDay ? '🎉 打折日优惠' : '优惠'}</span>
        <span class="v" style="color:var(--pink)">-¥${yuan(o.discountCents)}</span></div>` : ''}
      <div class="summary-row total"><span>实收</span><span class="v">¥${yuan(o.paidCents)}</span></div>
      <div class="summary-row"><span>支付方式</span><span class="v">${payText(o.paymentMethod)}</span></div>
      ${o.usedCard ? `<div class="summary-row"><span>卡核销</span><span class="v" style="color:var(--mint)">是</span></div>` : ''}
      ${o.note ? `<div class="summary-row"><span>备注</span><span class="v">${esc(o.note)}</span></div>` : ''}
    </div>

    ${o.flows.length > 0 ? `
    <div class="card">
      <h2>关联流水</h2>
      ${o.flows.map((f) => `
        <div class="summary-row"><span>${esc(f.flowNo)} · ${f.flowType === 'refund' ? '退款' : '收款'}</span>
        <span class="v ${f.amountCents > 0 ? '' : ''}" style="color:${f.amountCents > 0 ? 'var(--mint)' : 'var(--coral)'}">
          ${f.amountCents > 0 ? '+' : ''}¥${yuan(f.amountCents)}</span></div>`).join('')}
    </div>` : ''}

    ${canVoid ? `
    <div class="card">
      <h2>售后（管理员）</h2>
      <div class="field">
        <label>作废原因 <span style="color:var(--pink)">*</span></label>
        <input id="voidReason" placeholder="必填，会记入审计日志">
      </div>
      <button class="btn danger" id="voidBtn" onclick="doVoidOrder(${o.id})">整单作废</button>
      <div class="hint" style="margin-top:8px">作废会写一条反向流水，原记录保留不删除。</div>
    </div>` : ''}
  </div>`;
}

/**
 * 作废订单。
 * 不用 confirm()：浏览器弹窗可能被拦截，被拦截时 confirm 返回 false，
 * 表现为"点了没反应"。改为按钮两段式确认，第二次点击才真正提交。
 */
async function doVoidOrder(id) {
  const errBox = $('#od-error');
  const reason = $('#voidReason').value.trim();
  if (!reason) { errBox.innerHTML = `<div class="alert error">请填写作废原因</div>`; return; }

  const btn = $('#voidBtn');
  if (!btn) return;

  // 第一次点击：变成确认态
  if (btn.dataset.confirmed !== '1') {
    btn.dataset.confirmed = '1';
    btn.textContent = '再点一次确认作废';
    errBox.innerHTML = `<div class="alert warn">
      作废后会写一条反向流水冲掉这笔收入，原记录保留不删除。确认请再点一次。
    </div>`;
    return;
  }

  btn.disabled = true;
  btn.textContent = '处理中…';
  try {
    await api.post(`/api/v1/orders/${id}/void`, { reason });
    toast('订单已作废');
    go('orderDetail', { id });
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
    btn.disabled = false;
    btn.dataset.confirmed = '';
    btn.textContent = '整单作废';
  }
}

// ---------------------------------------------------------------------------
// 我的
// ---------------------------------------------------------------------------
async function MePage() {
  const u = state.user;
  return `
  ${topbar('我的')}
  <div class="page">
    <div class="card">
      <div style="font-size:17px;font-weight:700">${esc(u.displayName || u.username)}</div>
      <div style="font-size:13px;color:var(--text-mid)">账号 ${esc(u.username)} · ${u.role === 'admin' ? '管理员' : '店员'}</div>
    </div>

    <div class="list" style="margin-bottom:12px">
      ${u.role === 'admin' ? `
      <div class="list-item" onclick="go('settings')">
        <div class="main"><div class="name">系统设置</div><div class="meta">价目表、桌位、打折规则</div></div>
        <div class="meta">›</div>
      </div>
      <div class="list-item" onclick="go('audit')">
        <div class="main"><div class="name">操作日志</div><div class="meta">谁在什么时候做了什么</div></div>
        <div class="meta">›</div>
      </div>` : ''}
      <div class="list-item" onclick="go('changePassword')">
        <div class="main"><div class="name">修改密码</div></div><div class="meta">›</div>
      </div>
    </div>

    <button class="btn secondary" onclick="doLogout()">退出登录</button>
    <div style="text-align:center;font-size:12px;color:var(--text-dim);margin-top:20px">
      请拼豆 · 会员管理系统 v0.2.0
    </div>
  </div>
  ${tabbar('me')}`;
}

async function doLogout() {
  try { await api.post('/api/v1/auth/logout'); } catch { /* 忽略 */ }
  state.user = null;
  go('login');
}

function ChangePasswordPage() {
  return `
  ${topbar('修改密码', 'me')}
  <div class="page">
    <div id="cp-error"></div>
    <div class="card">
      <div class="field"><label>原密码</label>
        <input id="cp-old" type="password" autocomplete="current-password"></div>
      <div class="field"><label>新密码</label>
        <input id="cp-new" type="password" autocomplete="new-password">
        <div class="hint">至少 10 位，需包含大小写字母和数字</div></div>
      <div class="field"><label>确认新密码</label>
        <input id="cp-new2" type="password" autocomplete="new-password"></div>
      <button class="btn" onclick="doChangePassword()">确认修改</button>
      <div class="hint" style="margin-top:10px">修改后需要重新登录</div>
    </div>
  </div>`;
}

async function doChangePassword() {
  const errBox = $('#cp-error');
  const oldP = $('#cp-old').value, newP = $('#cp-new').value, newP2 = $('#cp-new2').value;
  if (newP !== newP2) { errBox.innerHTML = `<div class="alert error">两次输入的新密码不一致</div>`; return; }
  if (newP.length < 10) { errBox.innerHTML = `<div class="alert error">新密码至少需要 10 位</div>`; return; }
  try {
    await api.post('/api/v1/auth/password', { oldPassword: oldP, newPassword: newP });
    state.user = null;
    go('login');
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
async function SettingsPage() {
  const d = await api.get('/api/v1/settings');
  // 带上已停用的套餐，店长才能看到哪些被下架了并重新启用
  const products = await api.get('/api/v1/products?includeInactive=true');
  const tables = await api.get('/api/v1/tables');
  const pricing = d.settings.pricing || {};

  const groups = [
    { key: 'timed', title: '限时套餐' },
    { key: 'board', title: '限板套餐' },
    { key: 'day', title: '日卡' },
    { key: 'card', title: '周卡' },
    { key: 'addon', title: '加购项' },
  ];

  return `
  ${topbar('系统设置', 'me')}
  <div class="page">
    <div id="st-error"></div>
    <div id="st-ok"></div>

    <div class="card">
      <h2>打折规则</h2>
      <div class="field">
        <label>打折日（每月几号，逗号分隔）</label>
        <input id="st-days" value="${(pricing.discount_days || [8,18,28]).join(',')}">
      </div>
      <div class="field">
        <label>折扣（几折）</label>
        <input id="st-rate" inputmode="decimal" value="${((pricing.discount_rate_bp || 8000) / 1000).toFixed(1)}">
      </div>
      <div class="field">
        <label>提前多少分钟提醒</label>
        <input id="st-remind" inputmode="numeric" value="${pricing.remind_before_minutes || 15}">
      </div>
      <button class="btn" onclick="savePricing()">保存规则</button>
    </div>

    <div class="card">
      <h2>超时规则</h2>
      <div class="field">
        <label>超时多久以内收打底费</label>
        <div class="row">
          <input id="st-otbase-min" inputmode="numeric" value="${pricing.overtime_base_minutes ?? 20}" oninput="previewOvertime()">
          <input id="st-otbase-fee" inputmode="decimal" value="${((pricing.overtime_base_fee_cents ?? 500) / 100).toFixed(2)}" oninput="previewOvertime()">
        </div>
        <div class="hint">分钟数 / 打底金额（元）</div>
      </div>
      <div class="field">
        <label>超出后每满多少分钟加收</label>
        <div class="row">
          <input id="st-otstep-min" inputmode="numeric" value="${pricing.overtime_step_minutes ?? 10}" oninput="previewOvertime()">
          <input id="st-otstep-fee" inputmode="decimal" value="${((pricing.overtime_step_fee_cents ?? 188) / 100).toFixed(2)}" oninput="previewOvertime()">
        </div>
        <div class="hint">分钟数 / 每段加收（元）</div>
      </div>
      <div class="field">
        <label>不足一段怎么算</label>
        <select id="st-otround" onchange="previewOvertime()">
          <option value="true" ${pricing.overtime_round_up !== false ? 'selected' : ''}>按一段算</option>
          <option value="false" ${pricing.overtime_round_up === false ? 'selected' : ''}>不计</option>
        </select>
      </div>
      <div id="st-ot-preview"></div>
      <button class="btn" onclick="saveOvertime()">保存超时规则</button>
    </div>

    <div class="card">
      <div class="sec-head">
        <h2 style="margin:0">价目表</h2>
        <button class="btn small" onclick="newProduct()">＋ 新增</button>
      </div>
      <div class="hint" style="margin-bottom:14px">每个项目一张卡片，点右下角「编辑」修改</div>
      ${groups.map((g) => {
        const items = products.products.filter((p) => p.category === g.key);
        if (items.length === 0) return '';
        return `<div class="pl-group">
          <div class="pl-group-title">${catIcon(g.key)} ${g.title}</div>
          <div class="pl-grid">${items.map((p) => `
            <div class="pl-card${p.isActive === false ? ' off' : ''}">
              <div class="pl-top">
                <span class="pl-cat cat-${p.category}">${catLabel(p.category)}</span>
                <span class="pl-price">¥${yuan(p.priceCents)}</span>
              </div>
              <div class="pl-name">${esc(p.name)}</div>
              <div class="pl-spec">${productSpec(p)}</div>
              <div class="pl-foot">
                <span class="pl-tags">
                  ${p.discountable ? '<i class="pl-tag">8折</i>' : ''}
                  ${p.overtimeApplicable ? '<i class="pl-tag">可超时</i>' : ''}
                  ${p.isActive === false ? '<i class="pl-tag off">已停用</i>' : ''}
                </span>
                <button class="pl-edit" onclick="editProduct(${p.id})">编辑</button>
              </div>
            </div>`).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>

    <div class="card">
      <h2>桌位（${tables.tables.length} 张）</h2>
      <div class="list">
        ${tables.tables.map((t) => `
          <div class="list-item" onclick="toggleTable(${t.id},'${t.status === 'maintenance' ? 'idle' : 'maintenance'}')">
            <div class="main">
              <div class="name">${esc(t.name)}</div>
              <div class="meta">${t.capacity} 人座 · ${t.status === 'maintenance' ? '维护中（点击恢复）' : '正常（点击设为维护）'}</div>
            </div>
          </div>`).join('')}
      </div>
      <div class="field" style="margin-top:12px">
        <label>新增桌位名称</label>
        <div class="row">
          <input id="st-tablename" placeholder="如：09号桌">
          <button class="btn secondary" style="flex:0 0 80px" onclick="addTable()">添加</button>
        </div>
      </div>
    </div>
  </div>`;
}

/** 保存打折规则与提醒设置（超时规则由 saveOvertime 单独保存） */
async function savePricing() {
  const errBox = $('#st-error');
  const days = $('#st-days').value.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1 && x <= 31);
  const rate = parseFloat($('#st-rate').value);
  const remind = parseInt($('#st-remind').value, 10);

  if (days.length === 0) { errBox.innerHTML = `<div class="alert error">至少填一个打折日</div>`; return; }
  if (!(rate > 0 && rate <= 10)) { errBox.innerHTML = `<div class="alert error">折扣应在 0-10 之间</div>`; return; }


  try {
    const cur = await api.get('/api/v1/settings');
    await api.put('/api/v1/settings/pricing', {
      value: {
        ...cur.settings.pricing,
        discount_days: days,
        discount_rate_bp: Math.round(rate * 1000),
        remind_before_minutes: remind || 15,
      },
    });
    toast('规则已保存');
    go('settings');
  } catch (e) {
    errBox.innerHTML = `<div class="alert error">${esc(e.message)}</div>`;
  }
}

/** 按当前表单值试算超时阶梯，让店主立刻看到效果 */
function previewOvertime() {
  const box = $('#st-ot-preview');
  if (!box) return;

  const baseMin = parseInt($('#st-otbase-min')?.value, 10) || 20;
  const baseFee = toCents($('#st-otbase-fee')?.value) || 0;
  const stepMin = parseInt($('#st-otstep-min')?.value, 10) || 10;
  const stepFee = toCents($('#st-otstep-fee')?.value) || 0;
  const roundUp = $('#st-otround')?.value !== 'false';

  const samples = [10, baseMin, baseMin + 1, baseMin + stepMin, baseMin + stepMin + 1, baseMin + stepMin * 3];
  const rows = samples.map((m) => {
    let fee = 0;
    fee = baseFee;
    const beyond = m - baseMin;
    if (beyond > 0) {
      const units = roundUp ? Math.ceil(beyond / stepMin) : Math.floor(beyond / stepMin);
      fee += units * stepFee;
    }
    return '<div class="ot-row"><span>超时 ' + m + ' 分钟</span><span>¥' + yuan(fee) + '</span></div>';
  });

  box.innerHTML = '<div class="ot-preview-box"><div class="ot-title">收费预览</div>' + rows.join('') + '</div>';
}

/** 保存超时阶梯规则 */
async function saveOvertime() {
  const errBox = $('#st-error');
  const baseMin = parseInt($('#st-otbase-min').value, 10);
  const baseFee = toCents($('#st-otbase-fee').value);
  const stepMin = parseInt($('#st-otstep-min').value, 10);
  const stepFee = toCents($('#st-otstep-fee').value);
  const roundUp = $('#st-otround').value === 'true';

  if (!Number.isInteger(baseMin) || baseMin <= 0) { errBox.innerHTML = '<div class="alert error">打底分钟数不正确</div>'; return; }
  if (Number.isNaN(baseFee) || baseFee < 0) { errBox.innerHTML = '<div class="alert error">打底金额不正确</div>'; return; }
  if (!Number.isInteger(stepMin) || stepMin <= 0) { errBox.innerHTML = '<div class="alert error">阶梯分钟数不正确</div>'; return; }
  if (Number.isNaN(stepFee) || stepFee < 0) { errBox.innerHTML = '<div class="alert error">阶梯金额不正确</div>'; return; }

  try {
    const cur = await api.get('/api/v1/settings');
    await api.put('/api/v1/settings/pricing', {
      value: {
        ...cur.settings.pricing,
        overtime_base_minutes: baseMin,
        overtime_base_fee_cents: baseFee,
        overtime_step_minutes: stepMin,
        overtime_step_fee_cents: stepFee,
        overtime_round_up: roundUp,
      },
    });
    toast('超时规则已保存');
    go('settings');
  } catch (e) {
    errBox.innerHTML = '<div class="alert error">' + esc(e.message) + '</div>';
  }
}

/* =========================================================================
   价目表编辑：新增 / 修改 / 停用 / 删除
   ========================================================================= */

/** 各分类对字段的要求，与后端校验保持一致 */
const CATEGORY_RULES = {
  timed: { label: '限时套餐', short: '限时', icon: '⏱', need: ['duration'], hint: '按时间计费，可超时' },
  board: { label: '限板套餐', short: '限板', icon: '📌', need: ['pins'], hint: '按钉数计费，不限时' },
  day:   { label: '日卡',     short: '日卡', icon: '☀️', need: [],        hint: '当天有效，不限时' },
  card:  { label: '周卡',     short: '周卡', icon: '🎫', need: ['card'],  hint: '按天数计算的权益卡' },
  addon: { label: '加购项',   short: '加购', icon: '🧩', need: [],        hint: '结账时可选购，按件计费' },
};

/** 分类短名（卡片徽章用） */
function catLabel(c) { return (CATEGORY_RULES[c] || {}).short || c; }
/** 分类图标（分组标题用） */
function catIcon(c) { return (CATEGORY_RULES[c] || {}).icon || '·'; }
/** 一句话描述套餐规格（卡片副标题用） */
function productSpec(p) {
  if (p.durationMinutes) return '⏱ ' + humanMinutes(p.durationMinutes);
  if (p.pins) return '📌 ' + p.pins + ' 钉';
  if (p.category === 'day') return '☀️ 当天不限时';
  if (p.cardValidDays) return '🎫 ' + p.cardValidDays + ' 天';
  return '按件计价';
}

/** 编辑面板里的开关：直接在 state 上翻转，再重绘 */
function toggleProdFlag(field) {
  const dlg = state.productDialog;
  if (!dlg) return;
  const p = dlg.product;
  if (field === 'discountable') p.discountable = !p.discountable;
  else if (field === 'overtimeApplicable') p.overtimeApplicable = !p.overtimeApplicable;
  else if (field === 'isActive') p.isActive = p.isActive !== false ? false : true;
  render();
}

/** 打开某个产品的编辑面板 */
async function editProduct(productId) {
  const products = await api.get('/api/v1/products?includeInactive=true');
  const p = products.products.find((x) => x.id === productId);
  if (!p) { toast('套餐不存在', 'error'); return; }

  // 查一下有没有被用过，决定显示「删除」还是「停用」
  let usage = { canDelete: false, orderCount: 0, sessionCount: 0 };
  try { usage = await api.get('/api/v1/products/' + productId + '/usage'); } catch { /* 忽略 */ }

  state.productDialog = { mode: 'edit', product: p, usage };
  render();
}

/** 打开新增面板 */
function newProduct(category) {
  state.productDialog = {
    mode: 'create',
    product: {
      code: '', name: '', category: category || 'timed',
      priceCents: 0, durationMinutes: category === 'timed' ? 60 : null,
      pins: category === 'board' ? 52 : null,
      peopleCount: 1, cardValidDays: null, cardType: null,
      discountable: true,
      overtimeApplicable: category === 'timed',
      sortOrder: 50, isActive: true,
    },
    usage: null,
  };
  render();
}

function closeProductDialog() {
  state.productDialog = null;
  render();
}

/** 切换分类时，把不适用的字段清掉，并调整默认值 */
function onCategoryChange(cat) {
  const dlg = state.productDialog;
  if (!dlg) return;
  const p = dlg.product;

  // 先把店员已经输入的名称和价格同步回 state，否则下面 render() 会用旧值重绘、
  // 把刚敲进去的内容冲掉。
  const nameEl = $('#prod-name');
  const priceEl = $('#prod-price');
  if (nameEl) p.name = nameEl.value.trim();
  if (priceEl) {
    const cents = toCents(priceEl.value);
    if (!Number.isNaN(cents)) p.priceCents = cents;
  }

  p.category = cat;

  // 每个分类只保留自己需要的字段，避免出现"限板套餐却有1小时时长"这种矛盾数据
  if (cat === 'timed') {
    p.durationMinutes = p.durationMinutes || 60;
    p.pins = null; p.cardValidDays = null; p.cardType = null;
    p.overtimeApplicable = true;
  } else if (cat === 'board') {
    p.pins = p.pins || 52;
    p.durationMinutes = null; p.cardValidDays = null; p.cardType = null;
    p.overtimeApplicable = false;
  } else if (cat === 'day') {
    p.durationMinutes = null; p.pins = null; p.cardValidDays = null; p.cardType = null;
    p.overtimeApplicable = false;
  } else if (cat === 'card') {
    p.cardValidDays = p.cardValidDays || 7;
    p.cardType = p.cardType || 'week';
    p.durationMinutes = null; p.pins = null;
    p.overtimeApplicable = false;
  } else if (cat === 'addon') {
    p.durationMinutes = null; p.pins = null; p.cardValidDays = null; p.cardType = null;
    p.overtimeApplicable = false;
  }
  render();
}

/** 保存（新增或修改） */
async function saveProduct() {
  const dlg = state.productDialog;
  if (!dlg) return;
  const errBox = $('#prod-error');
  const p = dlg.product;
  const isCreate = dlg.mode === 'create';

  const name = $('#prod-name').value.trim();
  const priceStr = $('#prod-price').value.trim();

  if (!name) { errBox.innerHTML = '<div class="alert error">名称不能为空</div>'; return; }
  const cents = toCents(priceStr);
  if (Number.isNaN(cents) || cents < 0) { errBox.innerHTML = '<div class="alert error">价格格式不正确</div>'; return; }

  // 组装提交数据，只带该分类需要的字段。
  // 打折/超时/上架 三个开关直接改的是 state.productDialog.product，
  // 所以这里从 state 读，而不是去读 DOM 里的下拉框。
  const body = {
    name,
    priceCents: cents,
    category: p.category,
    discountable: p.discountable !== false,
    overtimeApplicable: p.overtimeApplicable === true,
    isActive: p.isActive !== false,
  };

  const durEl = $('#prod-duration');
  const pinsEl = $('#prod-pins');
  const cvdEl = $('#prod-carddays');
  const ctEl = $('#prod-cardtype');

  if (durEl) {
    const v = parseInt(durEl.value, 10);
    if (!Number.isInteger(v) || v <= 0) { errBox.innerHTML = '<div class="alert error">时长必须是大于 0 的整数（分钟）</div>'; return; }
    body.durationMinutes = v;
  }
  if (pinsEl) {
    const v = parseInt(pinsEl.value, 10);
    if (!Number.isInteger(v) || v <= 0) { errBox.innerHTML = '<div class="alert error">钉数必须是大于 0 的整数</div>'; return; }
    body.pins = v;
  }
  if (cvdEl) {
    const v = parseInt(cvdEl.value, 10);
    if (!Number.isInteger(v) || v <= 0) { errBox.innerHTML = '<div class="alert error">有效天数必须是大于 0 的整数</div>'; return; }
    body.cardValidDays = v;
  }
  if (ctEl) body.cardType = ctEl.value;

  const btn = $('#prod-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }

  try {
    if (isCreate) {
      // 编号自动生成：店主不用关心，避免填重复报错
      body.code = 'P' + Date.now().toString(36).toUpperCase();
      body.sortOrder = p.sortOrder ?? 50;
      await api.post('/api/v1/products', body);
    } else {
      await api.patch('/api/v1/products/' + p.id, body);
    }
    state.productDialog = null;
    toast(isCreate ? ('已新增「' + name + '」') : ('已更新「' + name + '」'));
    go('settings');
  } catch (e) {
    errBox.innerHTML = '<div class="alert error">' + esc(e.message) + '</div>';
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }
}

/** 删除（只在没被用过时可用） */
async function deleteProduct() {
  const dlg = state.productDialog;
  if (!dlg || dlg.mode !== 'edit') return;
  const p = dlg.product;

  const confirmed = state.confirmDialog?.confirmFn === 'reallyDeleteProduct';
  if (!confirmed) {
    state.confirmDialog = {
      title: '确认删除',
      lines: ['套餐：' + p.name, '价格：¥' + yuan(p.priceCents)],
      note: '删除后无法恢复。如果只是暂时不卖，建议改用「停用」。',
      confirmText: '确认删除',
      confirmFn: 'reallyDeleteProduct',
      args: [p.id],
    };
    render();
    return;
  }
}

async function reallyDeleteProduct(productId) {
  const errBox = $('#prod-error');
  try {
    await api.del('/api/v1/products/' + productId);
    state.productDialog = null;
    toast('已删除');
    go('settings');
  } catch (e) {
    state.confirmDialog = null;
    if (errBox) errBox.innerHTML = '<div class="alert error">' + esc(e.message) + '</div>';
    render();
  }
}

/** 价目表编辑面板 */
function productDialogHtml() {
  const dlg = state.productDialog;
  if (!dlg) return '';
  const p = dlg.product;
  const isCreate = dlg.mode === 'create';

  // 分类按钮组（比下拉更直观，一眼看清五个分类）
  const catBtns = Object.keys(CATEGORY_RULES).map((k) =>
    '<button type="button" class="cat-btn' + (p.category === k ? ' on' : '') +
    '" onclick="onCategoryChange(\'' + k + '\')">' +
    CATEGORY_RULES[k].icon + ' ' + CATEGORY_RULES[k].label + '</button>').join('');

  // 规格字段：按分类显示，带单位后缀
  let specFields = '';
  if (p.category === 'timed') {
    specFields = '<div class="field"><label>时长</label>' +
      '<div class="input-suffix"><input id="prod-duration" inputmode="numeric" value="' + (p.durationMinutes || 60) + '"><span>分钟</span></div>' +
      '<div class="hint">例如 60 分钟 = 1 小时</div></div>';
  } else if (p.category === 'board') {
    specFields = '<div class="field"><label>钉数</label>' +
      '<div class="input-suffix"><input id="prod-pins" inputmode="numeric" value="' + (p.pins || 52) + '"><span>钉</span></div></div>';
  } else if (p.category === 'card') {
    specFields = '<div class="field"><label>有效天数</label>' +
      '<div class="input-suffix"><input id="prod-carddays" inputmode="numeric" value="' + (p.cardValidDays || 7) + '"><span>天</span></div></div>' +
      '<div class="field"><label>卡种</label>' +
      '<select id="prod-cardtype">' +
      '<option value="week"' + (p.cardType === 'week' ? ' selected' : '') + '>周卡</option>' +
      '<option value="month"' + (p.cardType === 'month' ? ' selected' : '') + '>月卡</option>' +
      '<option value="day"' + (p.cardType === 'day' ? ' selected' : '') + '>日卡</option>' +
      '</select></div>';
  }

  // 规则开关
  const ruleRows = [];
  ruleRows.push('<div class="rule-row" onclick="toggleProdFlag(\'discountable\')">' +
    '<div class="rule-info"><div class="rule-name">参与打折日 8 折</div>' +
    '<div class="rule-desc">每月 8 / 18 / 28 号自动打折</div></div>' +
    '<span class="switch' + (p.discountable !== false ? ' on' : '') + '"></span></div>');

  if (p.category === 'timed') {
    ruleRows.push('<div class="rule-row" onclick="toggleProdFlag(\'overtimeApplicable\')">' +
      '<div class="rule-info"><div class="rule-name">可超时</div>' +
      '<div class="rule-desc">超出时长按阶梯收费</div></div>' +
      '<span class="switch' + (p.overtimeApplicable !== false ? ' on' : '') + '"></span></div>');
  }

  // 状态开关
  const statusRow = '<div class="rule-row" onclick="toggleProdFlag(\'isActive\')">' +
    '<div class="rule-info"><div class="rule-name">上架销售</div>' +
    '<div class="rule-desc">停用后不会出现在开台页</div></div>' +
    '<span class="switch' + (p.isActive !== false ? ' on' : '') + '"></span></div>';

  // 删除 / 不可删除
  let dangerBlock = '';
  if (!isCreate) {
    if (dlg.usage && dlg.usage.canDelete) {
      dangerBlock = '<button class="btn danger small block" onclick="deleteProduct()">🗑 删除这个项目</button>';
    } else if (dlg.usage) {
      dangerBlock = '<div class="dz-muted">已用过 ' + dlg.usage.orderCount + ' 笔订单、' +
        dlg.usage.sessionCount + ' 次开台，不能删除（可改用「停用」）</div>';
    }
  }

  return '<div class="card-dialog-mask" onclick="closeProductDialog()"></div>' +
    '<div class="card-dialog">' +
      '<div class="cd-title">' + (isCreate ? '新增价目' : '编辑价目') + '</div>' +
      '<div id="prod-error"></div>' +

      '<div class="field"><label>名称</label>' +
        '<input id="prod-name" value="' + esc(p.name) + '" maxlength="40" placeholder="如：单人1小时"></div>' +

      '<div class="field"><label>价格（元）</label>' +
        '<input id="prod-price" inputmode="decimal" value="' + yuan(p.priceCents) + '">' +
        (isCreate ? '' : '<div class="hint">只影响之后的开台，已开台按原价结算</div>') + '</div>' +

      '<div class="field"><label>分类</label>' +
        '<div class="cat-group">' + catBtns + '</div></div>' +

      specFields +

      '<div class="field"><label>规则</label><div class="rule-list">' + ruleRows.join('') + '</div></div>' +

      '<div class="field"><label>状态</label><div class="rule-list">' + statusRow + '</div></div>' +

      dangerBlock +

      '<div class="btn-group">' +
        '<button class="btn" id="prod-save-btn" onclick="saveProduct()">' + (isCreate ? '新增' : '保存') + '</button>' +
        '<button class="btn secondary" onclick="closeProductDialog()">取消</button>' +
      '</div>' +
    '</div>';
}

async function toggleTable(id, status) {
  const isMaint = status === 'maintenance';
  state.confirmDialog = {
    title: isMaint ? '确认设为维护中' : '确认恢复使用',
    lines: [isMaint ? '该桌将暂时无法开台' : '该桌将恢复可开台状态'],
    note: isMaint ? '适合设备维修、清洁等情况。随时可以恢复。' : '',
    confirmText: isMaint ? '确认维护' : '确认恢复',
    confirmFn: 'reallyToggleTable',
    args: [id, status],
  };
  render();
}

async function reallyToggleTable(id, status) {
  try {
    await api.patch(`/api/v1/tables/${id}`, { status });
    toast(status === 'maintenance' ? '已设为维护中' : '已恢复使用');
    go('settings');
  } catch (e) { toast(e.message, 'error'); }
}

async function addTable() {
  const name = $('#st-tablename').value.trim();
  if (!name) { toast('请填写桌位名称', 'error'); return; }
  try {
    await api.post('/api/v1/tables', { name, capacity: 2, sortOrder: 99 });
    toast('桌位已添加');
    go('settings');
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------
async function AuditPage() {
  const d = await api.get('/api/v1/audit-logs?limit=100');
  return `
  ${topbar('操作日志', 'me')}
  <div class="page">
    ${d.logs.length === 0 ? `<div class="empty"><span class="emoji">📋</span>暂无记录</div>` : `
    <div class="list">${d.logs.map((l) => `
      <div class="list-item" style="cursor:default">
        <div class="main">
          <div class="name">${esc(l.summary || l.action)}</div>
          <div class="meta">${fmtTime(l.createdAt)} · ${esc(l.actorName || '系统')}</div>
        </div>
      </div>`).join('')}</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// 倒计时引擎
//
// 设计取舍：不靠定时重新渲染页面来更新倒计时 —— 那会导致画面闪烁、
// 打断滚动，并且每分钟发一次全量请求。改为：
//   · 页面渲染时把结束时间写进 data-* 属性
//   · 一个每秒运行的计时器只更新文字节点
//   · 每 5 分钟静默拉一次接口，同步其他终端（店员手机/前台电脑）的改动
// ---------------------------------------------------------------------------

/** 把毫秒差格式化成倒计时文本 */
function formatCountdown(ms) {
  const over = ms < 0;
  const abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;

  let text;
  if (h > 0) text = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  else text = `${m}:${String(sec).padStart(2, '0')}`;

  return { text: (over ? '+' : '') + text, over };
}

/**
 * 每秒更新倒计时与已玩时长。
 *
 * 避免看板每秒抖动的三个要点：
 *   1. 只在文本真正变化时才写 textContent —— 赋相同的值同样会触发样式重算。
 *   2. 状态类名与胶囊文字只在状态跨越边界时改，不每秒重设。
 *   3. 倒计时用等宽数字（见 CSS font-variant-numeric），
 *      否则 "53:04" → "53:03" 时字宽变化会让整行左右晃动。
 *   4. 已玩时长只精确到分钟，同一分钟内不写 DOM。
 */
function tickTimers() {
  const now = Date.now();

  // ---- 倒计时 ----
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    const end = new Date(el.dataset.countdown).getTime();
    if (Number.isNaN(end)) return;

    const { text, over } = formatCountdown(end - now);
    if (el.textContent !== text) el.textContent = text;

    const seat = el.closest('.seat');
    if (!seat) return;

    const wantWarn = !over && (end - now) <= warningThresholdMs;
    const wantState = over ? 'overtime' : wantWarn ? 'warning' : 'occupied';

    // 状态没变就到此为止，避免每秒重设类名与文字
    if (seat.dataset.state === wantState) return;
    seat.dataset.state = wantState;

    seat.classList.toggle('overtime', wantState === 'overtime');
    seat.classList.toggle('warning', wantState === 'warning');
    seat.classList.toggle('occupied', wantState === 'occupied');

    const label = seat.querySelector('.cd-label');
    if (label) {
      const labelText = over ? '已超时' : '剩余';
      if (label.textContent !== labelText) label.textContent = labelText;
    }

    const pill = seat.querySelector('.pill');
    if (pill) {
      const pillText = over ? '已超时' : wantWarn ? '即将到时' : '使用中';
      const pillCls = 'pill ' + (over ? 'over' : wantWarn ? 'warn' : 'busy');
      if (pill.textContent !== pillText) pill.textContent = pillText;
      if (pill.className !== pillCls) pill.className = pillCls;
    }
  });

  // ---- 已玩时长（只精确到分钟，同一分钟内不写 DOM） ----
  document.querySelectorAll('[data-elapsed]').forEach((el) => {
    const start = new Date(el.dataset.elapsed).getTime();
    if (Number.isNaN(start)) return;

    const text = humanMinutes(Math.floor((now - start) / 60000));
    const full = el.hasAttribute('data-plain') ? text : '已玩 ' + text;
    if (el.textContent !== full) el.textContent = full;
  });
}

/** 静默同步：拉取最新看板，只做必要的局部更新 */
let syncing = false;
async function silentSync() {
  if (syncing || state.route.name !== 'board') return;
  syncing = true;
  try {
    const d = await api.get('/api/v1/board');
    boardCache = d;

    // 若桌位数量或占用情况发生变化，才整页重绘；否则只刷新结束时间
    const occupiedCount = d.tables.filter((t) => t.status === 'occupied').length;
    if (occupiedCount !== lastOccupiedCount()) {
      render();
      return;
    }
    // 结束时间可能有变化（换套餐），同步到 DOM
    d.tables.forEach((t) => {
      if (!t.session) return;
      const seat = document.querySelector(`.seat[data-seat="${t.session.sessionId}"]`);
      if (!seat) return;
      const el = seat.querySelector('[data-countdown]');
      if (el && t.session.expectedEndAt) el.dataset.countdown = t.session.expectedEndAt;
      if (t.session.expectedEndAt) seat.dataset.end = t.session.expectedEndAt;
      // 状态胶囊若已结账则整页重绘
      if (t.status !== 'occupied') render();
    });
  } catch {
    // 静默失败：网络抖动不应打扰店员
  } finally {
    syncing = false;
  }
}

let boardCache = null;
let warningThresholdMs = 15 * 60 * 1000;

function lastOccupiedCount() {
  return boardCache ? boardCache.tables.filter((t) => t.status === 'occupied').length : -1;
}
const routes = {
  login: LoginPage,
  board: BoardPage,
  openTable: OpenTablePage,
  seatDetail: SeatDetailPage,
  members: MembersPage,
  newMember: NewMemberPage,
  memberDetail: MemberDetailPage,
  memberEdit: MemberEditPage,
  revenue: RevenuePage,
  orderDetail: OrderDetailPage,
  me: MePage,
  changePassword: ChangePasswordPage,
  settings: SettingsPage,
  audit: AuditPage,
};

let renderToken = 0;

async function render() {
  const app = $('#app');
  const token = ++renderToken;

  if (!state.user && state.route.name !== 'login') {
    state.route = { name: 'login', params: {} };
  }
  const routeName = state.route.name;
  const page = routes[routeName] || BoardPage;

  try {
    const result = page();
    if (result && typeof result.then === 'function') {
      app.innerHTML = loadingView();
      const html = await result;
      if (token !== renderToken) return;
      app.innerHTML = html + cardDialogHtml() + refundDialogHtml() + freezeDialogHtml() + confirmDialogHtml() + productDialogHtml() + settleDialogHtml() + toastHtml();
      afterRender(routeName);
    } else {
      app.innerHTML = result + cardDialogHtml() + refundDialogHtml() + freezeDialogHtml() + confirmDialogHtml() + productDialogHtml() + settleDialogHtml() + toastHtml();
      afterRender(routeName);
    }
  } catch (e) {
    if (token !== renderToken) return;
    if (e.status === 401) {
      state.user = null;
      state.route = { name: 'login', params: {} };
      app.innerHTML = LoginPage();
      return;
    }
    app.innerHTML = `<div class="page"><div class="alert error">${esc(e.message)}</div>
      <button class="btn secondary" onclick="go('board')">返回看板</button></div>`;
  }
}

function toastHtml() {
  if (!state.toast) return '';
  const bg = { success: '#6FD9C0', error: '#FF8A65', warn: '#FFD93D' }[state.toast.type] || '#6FD9C0';
  const color = state.toast.type === 'warn' ? '#6B4E00' : '#fff';
  return `<div style="position:fixed;bottom:calc(88px + env(safe-area-inset-bottom,0px));left:50%;
    transform:translateX(-50%);background:${bg};color:${color};padding:11px 22px;border-radius:22px;
    font-size:14px;font-weight:600;z-index:100;box-shadow:0 5px 18px rgba(0,0,0,.16);
    max-width:88vw;text-align:center">${esc(state.toast.msg)}</div>`;
}

/**
 * 页面切换后的定时器管理。
 *
 * 关于刷新频率的取舍：
 *   倒计时需要每秒可见变化，但"每秒写 DOM"是抖动的来源。
 *   因此这里做了三层收敛：
 *     1. 用 requestAnimationFrame 驱动，浏览器不可见时自动暂停，不空转。
 *     2. tickTimers 内部只在文本真正变化时才写 DOM。
 *     3. 跨设备同步降到 5 分钟一次，且只更新变化的部分。
 */
function afterRender(name) {
  clearInterval(state.boardTimer);
  clearInterval(state.clockTimer);
  stopTicker();

  if (name === 'board' || name === 'seatDetail') {
    tickTimers();
    startTicker();
  }
  if (name === 'board') {
    // 每 5 分钟静默同步一次，让多台设备（前台电脑 + 店员手机）看到一致状态
    state.boardTimer = setInterval(silentSync, 5 * 60_000);
  }
  if (name === 'seatDetail') {
    refreshPreview();
  }
  if (name === 'memberDetail' && state.route.params.tab === 'card') {
    loadCardRecords(state.route.params.id);
  }
  if (name === 'settings') {
    previewOvertime();
  }
}

/** 用 rAF 驱动秒级更新：标签页切到后台时浏览器会暂停，避免无谓开销 */
let tickerRaf = 0;
let lastTickSecond = 0;

function tickerLoop() {
  const sec = Math.floor(Date.now() / 1000);
  // 同一秒内多次回调只处理一次
  if (sec !== lastTickSecond) {
    lastTickSecond = sec;
    tickTimers();
  }
  tickerRaf = requestAnimationFrame(tickerLoop);
}

function startTicker() {
  stopTicker();
  lastTickSecond = 0;
  tickerRaf = requestAnimationFrame(tickerLoop);
}

function stopTicker() {
  if (tickerRaf) {
    cancelAnimationFrame(tickerRaf);
    tickerRaf = 0;
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const d = await api.get('/api/v1/auth/me');
    state.user = d.user;
    state.route = { name: 'board', params: {} };
  } catch {
    state.user = null;
    state.route = { name: 'login', params: {} };
  }
  render();
}

// 暴露给 HTML
Object.assign(window, {
  go, doLogin, doLogout,
  pickMember, pickGuest, openWithProduct, openWithCard,
  changeAddonQty, changeProduct, doSettle, refreshPreview,
  debouncedSearchMembers, searchMembers, debouncedMemberSearch,
  doCreateMember, doUpdateMember, buyCard, renewCard, confirmBuyCard, closeCardDialog,
  doVoidOrder, doChangePassword,
  savePricing, toggleTable, addTable,
  switchMemberTab, switchRevenueTab,
  closeConfirmDialog, runConfirmAction, reallyOpenWithProduct, reallyChangeProduct, reallyToggleTable, reallyDoSettle,
  pauseTiming, resumeTiming,
  previewOvertime, saveOvertime, editProduct, closeProductDialog, saveProduct,
  newProduct, onCategoryChange, deleteProduct, reallyDeleteProduct, toggleProdFlag,
  closeSettleDialog, onOverrideInput,
  pickPayMethod,
  openRefundCard, closeRefundDialog, confirmRefundCard,
  freezeCard, unfreezeCard, closeFreezeDialog, confirmFreezeCard, toggleMemberStatus,
});

boot();
