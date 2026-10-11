/* =========================================================================
   演示模式的数据层（离线单文件版）

   作用：拦截 fetch，把后端接口替换为内存中的真实数据快照。
   前端代码无需任何改动即可完整运行；所有写操作只在内存生效，
   刷新页面即恢复到快照状态。

   注意：本文件会被构建脚本原样内联进 HTML，因此不要在此处使用
   任何需要转义的写法，避免构建时被加工。
   ========================================================================= */
(function () {
  var snapshot = JSON.parse(document.getElementById('demo-data').textContent);
  var DB = JSON.parse(JSON.stringify(snapshot));

  /*
   * 时间平移策略
   * ─────────────────────────────────────────────────────────────
   * 快照是在导出那一刻抓取的，字段都是绝对时间。直接使用会有两个问题：
   *   1. 打开演示时倒计时早已走完，全部显示"已超时几百分钟"
   *   2. 但若简单地把开始时间统一改成"刚才"，又会抹掉"已超时 40 分钟"
   *      这种刻意构造的演示场景
   *
   * 因此对每个会话单独处理：
   *   · 限时套餐 —— 保留它相对现在的剩余/超时分钟数，只把绝对时间平移到今天
   *   · 用卡会话 —— 同样平移开始时间
   *   · 结束时间按平移后的开始时间重新推算
   */
  var DEMO_BASE = Date.now();

  /** 快照的抓取时刻，用于计算每个会话"距今已进行多久" */
  var snapshotAt = new Date(snapshot.board.serverTime).getTime();

  function shiftSessionKeepRelative(s) {
    var out = JSON.parse(JSON.stringify(s));

    // 原始记录里该会话距今多少分钟（用导出时刻做基准）
    var origStart = new Date(s.startedAt).getTime();
    var elapsedMin = Math.round((snapshotAt - origStart) / 60000);

    // 新的开始时间 = 现在 - 相同的已进行时长
    var newStart = DEMO_BASE - elapsedMin * 60000;
    out.startedAt = new Date(newStart).toISOString();

    if (s.expectedEndAt) {
      var origEnd = new Date(s.expectedEndAt).getTime();
      var totalMin = Math.round((origEnd - origStart) / 60000);
      out.expectedEndAt = new Date(newStart + totalMin * 60000).toISOString();
    } else {
      out.expectedEndAt = null;
    }

    out.elapsedMinutes = elapsedMin;
    out.remainingMinutes = out.expectedEndAt
      ? Math.round((new Date(out.expectedEndAt).getTime() - DEMO_BASE) / 60000)
      : null;
    return out;
  }

  // 启动时对快照中的会话做时间平移
  DB.board.tables.forEach(function (t) {
    if (t.session) t.session = shiftSessionKeepRelative(t.session);
  });
  // 历史记录的时间只需整体平移，不涉及倒计时
  (function shiftHistory() {
    var delta = DEMO_BASE - snapshotAt;
    function shift(iso) {
      if (!iso) return iso;
      return new Date(new Date(iso).getTime() + delta).toISOString();
    }
    DB.memberDetails.forEach(function (m) {
      (m.visits || []).forEach(function (v) {
        v.startedAt = shift(v.startedAt);
        v.endedAt = shift(v.endedAt);
      });
      (m.orders || []).forEach(function (o) { o.completedAt = shift(o.completedAt); });
    });
    DB.orders.orders.forEach(function (o) { o.completedAt = shift(o.completedAt); });
    DB.ledger.entries.forEach(function (e) { e.createdAt = shift(e.createdAt); });
  })();

  function ok(body) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  function fail(message, status) {
    return Promise.resolve(new Response(
      JSON.stringify({ error: { code: 'DEMO', message: message } }),
      { status: status || 400, headers: { 'Content-Type': 'application/json' } }
    ));
  }

  /* 把开台记录组装成看板需要的结构 */
  function buildBoard() {
    var pricing = (DB.settings && DB.settings.pricing) || {};
    var tables = DB.tables.tables.map(function (t) {
      var hit = null;
      DB.board.tables.forEach(function (x) {
        if (x.tableId === t.id) hit = x;
      });
      if (hit && hit.session) return JSON.parse(JSON.stringify(hit));
      return { tableId: t.id, tableName: t.name, capacity: t.capacity, status: 'idle', session: null };
    });

    var occupied = 0;
    tables.forEach(function (x) { if (x.status === 'occupied') occupied++; });

    return {
      summary: {
        total: tables.length,
        occupied: occupied,
        idle: tables.length - occupied,
        maintenance: 0,
      },
      tables: tables,
      pricing: pricing,
      serverTime: new Date().toISOString(),
    };
  }

  function todayStamp() {
    var d = new Date();
    return '' + d.getFullYear()
      + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0');
  }

  function matchId(url, prefix, suffix) {
    if (url.indexOf(prefix) !== 0) return null;
    var rest = url.slice(prefix.length);
    if (suffix) {
      if (rest.slice(-suffix.length) !== suffix) return null;
      rest = rest.slice(0, -suffix.length);
    }
    if (!/^[0-9]+$/.test(rest)) return null;
    return parseInt(rest, 10);
  }

  function findAllSession(sessionId) {
    var found = null;
    DB.board.tables.forEach(function (t) {
      if (t.session && t.session.sessionId === sessionId) found = t;
    });
    return found;
  }

  function handle(method, path, body) {
    var qi = path.indexOf('?');
    var url = qi >= 0 ? path.slice(0, qi) : path;
    var query = {};
    if (qi >= 0) {
      path.slice(qi + 1).split('&').forEach(function (kv) {
        var eq = kv.indexOf('=');
        var k = eq >= 0 ? kv.slice(0, eq) : kv;
        var v = eq >= 0 ? kv.slice(eq + 1) : '';
        query[decodeURIComponent(k)] = decodeURIComponent(v);
      });
    }

    /* ---------- 认证 ---------- */
    if (url === '/api/v1/auth/me') {
      return ok({ user: { id: 1, username: 'admin', displayName: '店主', role: 'admin' } });
    }
    if (url === '/api/v1/auth/login') {
      return ok({ user: { id: 1, username: 'admin', displayName: '店主', role: 'admin' } });
    }
    if (url === '/api/v1/auth/logout') return ok({ ok: true });

    /* ---------- 看板与基础数据 ---------- */
    if (url === '/api/v1/board') return ok(buildBoard());
    if (url === '/api/v1/tables') return ok(DB.tables);

    if (url === '/api/v1/products') {
      // 与后端一致：
      //   · 默认只返回在售套餐（开台/结账用）
      //   · includeInactive=true 时连停用的一起返回（设置页用）
      // 少了这个过滤，已下架的套餐仍会出现在开台页，
      // 店员点下去就会撞上"套餐不存在"。
      var showAll = query.includeInactive === 'true';
      var list = DB.products.products.filter(function (p) {
        return showAll || p.isActive !== false;
      });
      if (query.category) {
        list = list.filter(function (p) { return p.category === query.category; });
      }
      return ok({ products: list });
    }

    // 新增套餐：写入内存快照，让演示里的增删改真正生效
    if (url === '/api/v1/products' && method === 'POST') {
      var maxId = 0;
      DB.products.products.forEach(function (p) { if (p.id > maxId) maxId = p.id; });
      var np = {
        id: maxId + 1,
        code: body.code || ('P' + Date.now().toString(36).toUpperCase()),
        name: body.name, category: body.category,
        priceCents: body.priceCents,
        durationMinutes: body.durationMinutes || null,
        pins: body.pins || null,
        peopleCount: body.peopleCount || 1,
        cardValidDays: body.cardValidDays || null,
        cardType: body.cardType || null,
        discountable: body.discountable !== false,
        overtimeApplicable: body.overtimeApplicable === true,
        sortOrder: body.sortOrder || 50,
        isActive: body.isActive !== false,
      };
      DB.products.products.push(np);
      return ok({ id: np.id });
    }

    // 查某个套餐能否删除（演示里都视为未使用）
    var prodUsageId = matchId(url, '/api/v1/products/', '/usage');
    if (prodUsageId !== null) {
      return ok({ orderCount: 0, sessionCount: 0, canDelete: true });
    }

    // 修改套餐
    var prodEditId = matchId(url, '/api/v1/products/');
    if (prodEditId !== null && method === 'PATCH') {
      var prod = null;
      DB.products.products.forEach(function (p) { if (p.id === prodEditId) prod = p; });
      if (!prod) return fail('套餐不存在', 404);
      if (body.name !== undefined) prod.name = body.name;
      if (body.priceCents !== undefined) prod.priceCents = body.priceCents;
      if (body.durationMinutes !== undefined) prod.durationMinutes = body.durationMinutes;
      if (body.pins !== undefined) prod.pins = body.pins;
      if (body.peopleCount !== undefined) prod.peopleCount = body.peopleCount;
      if (body.cardValidDays !== undefined) prod.cardValidDays = body.cardValidDays;
      if (body.cardType !== undefined) prod.cardType = body.cardType;
      if (body.discountable !== undefined) prod.discountable = body.discountable;
      if (body.overtimeApplicable !== undefined) prod.overtimeApplicable = body.overtimeApplicable;
      if (body.isActive !== undefined) prod.isActive = body.isActive;
      if (body.sortOrder !== undefined) prod.sortOrder = body.sortOrder;
      return ok({ ok: true });
    }

    // 删除套餐
    if (prodEditId !== null && method === 'DELETE') {
      var di = -1;
      DB.products.products.forEach(function (p, i) { if (p.id === prodEditId) di = i; });
      if (di < 0) return fail('套餐不存在', 404);
      DB.products.products.splice(di, 1);
      return ok({ ok: true, deleted: true });
    }

    /* ---------- 会员 ---------- */
    if (url === '/api/v1/members') {
      var ms = DB.members.members.slice();
      if (query.q) {
        var q = query.q.toLowerCase();
        ms = ms.filter(function (m) {
          var nick = (m.nickname || '').toLowerCase();
          var tail = m.phoneTail || '';
          var no = (m.memberNo || '').toLowerCase();
          return nick.indexOf(q) >= 0 || tail.indexOf(q) >= 0 || no.indexOf(q) >= 0;
        });
      }
      return ok({ members: ms.slice(0, parseInt(query.limit, 10) || 50) });
    }

    if (url === '/api/v1/members/reminders') {
      var out = [];
      DB.members.members.forEach(function (m) {
        if (!m.cardValid) return;
        var left = Math.round((new Date(m.cardExpiresAt) - new Date()) / 86400000);
        if (left >= 0 && left <= 7) {
          out.push({
            id: m.id, memberNo: m.memberNo, nickname: m.nickname, phoneTail: m.phoneTail,
            displayName: m.displayName, cardType: m.cardType,
            cardExpiresAt: m.cardExpiresAt, daysLeft: left,
          });
        }
      });
      return ok({ reminders: out });
    }

    var mid = matchId(url, '/api/v1/members/');
    if (mid !== null) {
      var found = null;
      DB.memberDetails.forEach(function (m) { if (m.id === mid) found = m; });
      if (!found) {
        DB.members.members.forEach(function (m) { if (m.id === mid) found = m; });
      }
      if (!found) return fail('会员不存在', 404);
      return ok({ member: found });
    }

    var recId = matchId(url, '/api/v1/members/', '/card-records');
    if (recId !== null) {
      return ok({ records: DB.cardRecords[String(recId)] || [] });
    }

    var ledId = matchId(url, '/api/v1/members/', '/ledger');
    if (ledId !== null) {
      var md = null;
      DB.memberDetails.forEach(function (m) { if (m.id === ledId) md = m; });
      var type = query.type || 'visits';
      if (type === 'orders') {
        var os = (md && md.orders) || [];
        return ok({ entries: os.map(function (o) {
          return {
            id: o.id, orderNo: o.orderNo, status: o.status,
            totalCents: o.totalCents, paidBalanceCents: 0, paidCashCents: o.paidCents,
            pointsEarned: 0, completedAt: o.completedAt, operatorName: '店主',
          };
        }) });
      }
      if (type === 'recharges' || type === 'balance') return ok({ entries: [] });
      return ok({ entries: [] });
    }

    /* ---------- 开台 ---------- */
    if (url === '/api/v1/sessions' && method === 'POST') {
      var table = null;
      DB.tables.tables.forEach(function (t) { if (t.id === body.tableId) table = t; });
      if (!table) return fail('桌位不存在', 404);

      var prod = null;
      DB.products.products.forEach(function (p) { if (p.id === body.productId) prod = p; });
      if (!prod) return fail('套餐不存在', 404);

      var slot = null;
      DB.board.tables.forEach(function (x) { if (x.tableId === body.tableId) slot = x; });
      if (slot && slot.session) return fail(table.name + ' 正在使用中');

      var member = null;
      if (body.memberId) {
        DB.members.members.forEach(function (m) { if (m.id === body.memberId) member = m; });
      }

      var now = new Date();
      var endAt = prod.durationMinutes
        ? new Date(now.getTime() + prod.durationMinutes * 60000)
        : null;

      var newSession = {
        sessionId: Date.now(),
        memberId: member ? member.id : null,
        memberNo: member ? member.memberNo : null,
        displayName: member ? member.displayName : (body.guestName || '散客'),
        phoneTail: member ? member.phoneTail : null,
        productName: prod.name,
        category: prod.category,
        startedAt: now.toISOString(),
        expectedEndAt: endAt ? endAt.toISOString() : null,
        remainingMinutes: prod.durationMinutes || null,
        elapsedMinutes: 0,
        usedCard: !!body.useCard,
        cardType: member ? member.cardType : null,
        cardExpiresAt: member ? member.cardExpiresAt : null,
        alertLevel: 'normal',
      };

      if (slot) {
        slot.status = 'occupied';
        slot.session = newSession;
      } else {
        DB.board.tables.push({
          tableId: body.tableId, tableName: table.name, capacity: table.capacity,
          status: 'occupied', session: newSession,
        });
      }

      return ok({
        sessionId: newSession.sessionId, tableName: table.name, productName: prod.name,
        startedAt: newSession.startedAt, expectedEndAt: newSession.expectedEndAt,
        useCard: !!body.useCard,
      });
    }

    var sessId = matchId(url, '/api/v1/sessions/');
    if (sessId !== null && method === 'GET') {
      var hit = findAllSession(sessId);
      if (!hit) return fail('开台记录不存在', 404);
      var s = Object.assign({
        tableId: hit.tableId, tableName: hit.tableName,
        productId: 1, productPriceCents: 0, status: 'active',
      }, hit.session);
      return ok({ session: s });
    }

    // 暂停计时（内存态：标记 paused，倒计时冻结）
    var pauseId = matchId(url, '/api/v1/sessions/', '/pause');
    if (pauseId !== null && method === 'POST') {
      var hitP = findAllSession(pauseId);
      if (!hitP) return fail('开台记录不存在', 404);
      if (hitP.session.paused) return fail('无法暂停：已经处于暂停中', 400);
      hitP.session.paused = true;
      hitP.session.pausedAt = new Date().toISOString();
      return ok({ pausedAt: hitP.session.pausedAt });
    }

    // 恢复计时（把暂停时长折算进 startedAt / expectedEndAt）
    var resumeId = matchId(url, '/api/v1/sessions/', '/resume');
    if (resumeId !== null && method === 'POST') {
      var hitR = findAllSession(resumeId);
      if (!hitR) return fail('开台记录不存在', 404);
      if (!hitR.session.paused) return fail('无法恢复：并未处于暂停', 400);
      var pausedAtMs = new Date(hitR.session.pausedAt).getTime();
      var delta = Date.now() - pausedAtMs;
      hitR.session.startedAt = new Date(new Date(hitR.session.startedAt).getTime() + delta).toISOString();
      if (hitR.session.expectedEndAt) {
        hitR.session.expectedEndAt = new Date(new Date(hitR.session.expectedEndAt).getTime() + delta).toISOString();
      }
      hitR.session.paused = false;
      hitR.session.pausedAt = null;
      return ok({ startedAt: hitR.session.startedAt, expectedEndAt: hitR.session.expectedEndAt });
    }

    var prevId = matchId(url, '/api/v1/sessions/', '/preview');
    if (prevId !== null) {
      var hit2 = findAllSession(prevId);
      if (!hit2) return fail('开台记录不存在', 404);
      var ss = hit2.session;

      var prod2 = { priceCents: 0, discountable: true };
      DB.products.products.forEach(function (p) { if (p.name === ss.productName) prod2 = p; });

      // 必须用 floor：round 会让超时费提前 30 秒触发（与后端 elapsedMinutes 一致）
      var elapsed = Math.max(0, Math.floor((Date.now() - new Date(ss.startedAt)) / 60000));

      /*
       * 超时：只计时、不计费（与后端一致）。
       * 超时费改由店家线下自行决定，系统只算出「超了多少分钟」供界面提示；
       * 需要加收时，店员在结账弹窗里手动填实收金额。
       */
      var overtimeMinutes = 0;
      var overtimeUnits = 0;
      var overtimeFee = 0;
      if (!ss.usedCard && prod2.overtimeApplicable) {
        var productMinutes = prod2.durationMinutes || null;
        if (productMinutes && elapsed > productMinutes) {
          overtimeMinutes = elapsed - productMinutes;
        }
      }

      // 加购：解析 "id:qty"，与后端 resolveAddons 行为一致 ——
      // 不存在的项、已下架的项、数量超限一律报错，不静默忽略。
      // 静默忽略会让预览价低于结账价，是"看着便宜、收着贵"的温床。
      var addonCents = 0;
      var addonDiscountable = 0;
      if (query.addons) {
        var qtyMap = {};
        var badMsg = null;

        query.addons.split(',').forEach(function (raw) {
          if (badMsg) return;
          var seg = raw.split(':');
          var aid = parseInt(seg[0], 10);
          var qty = seg.length > 1 ? parseInt(seg[1], 10) : 1;
          if (!(qty > 0)) return;
          qtyMap[aid] = (qtyMap[aid] || 0) + qty;
        });

        Object.keys(qtyMap).forEach(function (k) {
          if (badMsg) return;
          var aid = parseInt(k, 10);
          var qty = qtyMap[k];
          var prod = null;
          DB.products.products.forEach(function (x) { if (x.id === aid) prod = x; });

          if (!prod) { badMsg = '部分加购项不存在，请重新选择'; return; }
          if (prod.category !== 'addon') { badMsg = '「' + prod.name + '」不是加购项'; return; }
          if (prod.isActive === false) { badMsg = '加购项「' + prod.name + '」已下架，请重新选择'; return; }
          if (qty > 99) { badMsg = '加购项「' + prod.name + '」数量超出上限（最多 99 件）'; return; }

          var line = prod.priceCents * qty;
          addonCents += line;
          if (prod.discountable !== false) addonDiscountable += line;
        });

        if (badMsg) return fail(badMsg, 400);
      }

      var day = new Date().getDate();
      var discountDays = cfg.discount_days || [8, 18, 28];
      var rateBp = cfg.discount_rate_bp != null ? cfg.discount_rate_bp : 8000;

      var canDiscountProduct = discountDays.indexOf(day) >= 0
        && prod2.discountable !== false && !ss.usedCard;
      var discountedProduct = ss.usedCard
        ? 0
        : (canDiscountProduct ? Math.floor(prod2.priceCents * rateBp / 10000) : prod2.priceCents);
      var productDiscountCents = (ss.usedCard ? 0 : prod2.priceCents) - discountedProduct;

      var canDiscountAddon = discountDays.indexOf(day) >= 0 && addonDiscountable > 0;
      var discountedAddon = canDiscountAddon
        ? Math.floor(addonCents * rateBp / 10000)
        : addonCents;
      var addonDiscountCents = addonCents - discountedAddon;

      var discountCents = productDiscountCents + addonDiscountCents;
      var isDiscountDay = canDiscountProduct || canDiscountAddon;
      var total = Math.max(0, discountedProduct + discountedAddon + overtimeFee);

      return ok({ preview: {
        productAmountCents: discountedProduct,
        productOriginalCents: ss.usedCard ? 0 : prod2.priceCents,
        discountCents: discountCents,
        isDiscountDay: isDiscountDay,
        discountRateBp: isDiscountDay ? rateBp : null,
        addonAmountCents: discountedAddon,
        addonOriginalCents: addonCents,
        addonDiscountCents: addonDiscountCents,
        overtimeUnits: overtimeUnits,
        overtimeMinutes: overtimeMinutes,
        overtimeFeeCents: overtimeFee,
        totalCents: total,
        actualMinutes: elapsed,
        usedCard: ss.usedCard,
      } });
    }

    var settleId = matchId(url, '/api/v1/sessions/', '/settle');
    if (settleId !== null && method === 'POST') {
      var hit3 = findAllSession(settleId);
      if (!hit3) return fail('开台记录不存在', 404);

      // 复算一遍金额，让演示里的结账结果与预览一致。
      // 若前端传了实收调整（overrideTotalCents），以它为准 ——
      // 这与后端语义相同：差额记成一笔人工优惠。
      var ss3 = hit3.session;
      var prod3 = { priceCents: 0, discountable: true };
      DB.products.products.forEach(function (p) { if (p.name === ss3.productName) prod3 = p; });

      var elapsed3 = Math.max(0, Math.floor((Date.now() - new Date(ss3.startedAt)) / 60000));
      // 超时：只计时不计费（与后端一致）。店家线下自行决定收多少，
      // 需要加收时店员在结账弹窗里手动填实收。
      var otFee3 = 0, otUnits3 = 0;

      // 与预览共用同一套校验，保证两个接口结论一致
      var addonSum3 = 0;
      var addonQty3 = {};
      var bad3 = null;
      (body.addonItems || []).forEach(function (it) {
        addonQty3[it.id] = (addonQty3[it.id] || 0) + it.qty;
      });
      Object.keys(addonQty3).forEach(function (k) {
        if (bad3) return;
        var aid = parseInt(k, 10);
        var qty = addonQty3[k];
        var prod = null;
        DB.products.products.forEach(function (x) { if (x.id === aid) prod = x; });

        if (!prod) { bad3 = '部分加购项不存在，请重新选择'; return; }
        if (prod.category !== 'addon') { bad3 = '「' + prod.name + '」不是加购项'; return; }
        if (prod.isActive === false) { bad3 = '加购项「' + prod.name + '」已下架，请重新选择'; return; }
        if (qty > 99) { bad3 = '加购项「' + prod.name + '」数量超出上限（最多 99 件）'; return; }

        addonSum3 += prod.priceCents * qty;
      });
      if (bad3) return fail(bad3, 400);

      var days3 = cfg3.discount_days || [8, 18, 28];
      var rate3 = cfg3.discount_rate_bp != null ? cfg3.discount_rate_bp : 8000;
      var isDD3 = days3.indexOf(new Date().getDate()) >= 0;
      var prodPaid3 = ss3.usedCard ? 0
        : (isDD3 && prod3.discountable !== false
            ? Math.floor(prod3.priceCents * rate3 / 10000) : prod3.priceCents);
      var addonPaid3 = isDD3 ? Math.floor(addonSum3 * rate3 / 10000) : addonSum3;

      var computed3 = prodPaid3 + addonPaid3 + otFee3;
      var paid3 = (body.overrideTotalCents !== undefined && body.overrideTotalCents !== null)
        ? body.overrideTotalCents
        : computed3;

      hit3.status = 'idle';
      hit3.session = null;
      hit3.tableId = hit3.tableId;

      // 结账后把这一笔加进收入流水，让"收入"页能看到刚结的账
      var flowNo3 = 'F' + todayStamp() + String(DB.ledger.entries.length + 1).padStart(4, '0');
      if (paid3 > 0) {
        DB.ledger.entries.unshift({
          id: DB.ledger.entries.length + 1,
          flowNo: flowNo3,
          orderNo: 'O' + todayStamp() + String(DB.orders.orders.length + 1).padStart(4, '0'),
          memberName: ss3.displayName || '散客',
          tableName: hit3.tableName,
          amountCents: paid3,
          paymentMethod: body.paymentMethod || 'wechat',
          createdAt: new Date().toISOString(),
          note: body.note || (body.overrideReason ? '实收调整：' + body.overrideReason : ''),
        });
      }

      // 折扣与人工调整分列返回，与后端 settleSession 保持一致：
      //   discountCents      只含打折日优惠（恒 >= 0）
      //   manualAdjustCents  人工调整 = 应收 - 实收，正数少收、负数多收
      // 混在一起会让前端把"熟人优惠"显示成"打折日优惠"。
      var autoDiscount3 = (ss3.usedCard ? 0 : prod3.priceCents - prodPaid3)
                        + (addonSum3 - addonPaid3);
      var manualAdjust3 = computed3 - paid3;

      return ok({
        orderId: Date.now(),
        orderNo: 'O' + todayStamp() + String(DB.orders.orders.length + 1).padStart(4, '0'),
        flowNo: flowNo3,
        totalCents: paid3, paidCents: paid3,
        productAmountCents: prodPaid3, addonAmountCents: addonPaid3,
        overtimeFeeCents: otFee3,
        discountCents: autoDiscount3,
        manualAdjustCents: manualAdjust3,
        actualMinutes: elapsed3, overtimeUnits: otUnits3,
        isDiscountDay: isDD3, usedCard: ss3.usedCard,
      });
    }

    var changeId = matchId(url, '/api/v1/sessions/', '/product');
    if (changeId !== null && method === 'PATCH') {
      var hit4 = findAllSession(changeId);
      if (!hit4) return fail('开台记录不存在', 404);
      var np = null;
      DB.products.products.forEach(function (p) { if (p.id === body.productId) np = p; });
      if (!np) return fail('套餐不存在', 404);
      hit4.session.productName = np.name;
      if (np.durationMinutes) {
        var s0 = new Date(hit4.session.startedAt).getTime();
        hit4.session.expectedEndAt = new Date(s0 + np.durationMinutes * 60000).toISOString();
      }
      return ok({ productName: np.name, expectedEndAt: hit4.session.expectedEndAt });
    }

    /* ---------- 收入 ---------- */
    if (url === '/api/v1/revenue/summary') return ok(DB.summary);
    if (url === '/api/v1/revenue/ledger') return ok(DB.ledger);
    if (url === '/api/v1/revenue/reconcile') {
      return ok({ consumeLedgerCents: 0, consumeOrdersCents: 0, consumeDiffCents: 0,
                  cardLedgerCents: 0, cardRecordsCents: 0, cardDiffCents: 0,
                  ledgerTotalCents: 0, diffCents: 0, balanced: true });
    }
    if (url === '/api/v1/orders') return ok(DB.orders);

    var oid = matchId(url, '/api/v1/orders/');
    if (oid !== null) {
      var od = null;
      DB.orders.orders.forEach(function (o) { if (o.id === oid) od = o; });
      if (!od) return fail('订单不存在', 404);
      return ok({ order: Object.assign({}, od, {
        items: [{ id: 1, name: od.tableName || '消费', category: 'timed', qty: 1,
                  unitPriceCents: od.totalCents, amountCents: od.totalCents }],
        refunds: [], flows: [],
        subtotalCents: od.totalCents, discountCents: 0, pointsDeductCents: 0,
        paidOtherCents: 0, pointsEarned: 0, pointsRedeemed: 0,
        operatorName: '店主', startedAt: od.completedAt, endedAt: od.completedAt,
      }) });
    }

    /* ---------- 设置与日志 ---------- */
    if (url === '/api/v1/settings') return ok({ settings: DB.settings });
    if (url === '/api/v1/levels') return ok({ levels: [] });
    if (url === '/api/v1/audit-logs') return ok({ logs: [] });

    return fail('演示版不支持该操作，数据为快照', 501);
  }

  /* ---- 拦截 fetch ---- */
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var raw = typeof input === 'string' ? input : input.url;
    if (raw.indexOf('/api/v1/') < 0) return realFetch.apply(window, arguments);

    var method = (init && init.method) || 'GET';
    var path = raw.replace(/^[a-z]+:\/\/[^/]+/i, '');
    var body = null;
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (e) { body = null; }
    }
    return handle(method, path, body);
  };

  /* ---- 顶部提示，说明这是演示 ---- */
  window.addEventListener('DOMContentLoaded', function () {
    var tip = document.createElement('div');
    tip.className = 'demo-toast';
    tip.textContent = '界面演示 · 数据为真实快照，可自由点击查看';
    document.body.appendChild(tip);
    setTimeout(function () {
      tip.style.transition = 'opacity .6s';
      tip.style.opacity = '0';
    }, 4200);
    setTimeout(function () { tip.remove(); }, 5000);
  });
})();
