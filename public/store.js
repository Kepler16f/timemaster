/* ===== Store：v2 数据模型 + 确定性合并引擎 + ETag 同步状态机 + 离线队列 ===== */
(function () {
  'use strict';

  const listeners = [];
  const goneListeners = []; // 云端空间被创建者删除时的回调
  const cache = {}; // code -> { data, etag, dirty, seeds, syncing }

  function localKey(code) { return 'tm:space:' + code; }
  /* 身份键：登录账户后跨设备一致，未登录回退设备 id */
  function myId() { return (window.Auth && Auth.memberKey()) || App.clientId; }

  /* 「我」往往不止一个键：登录/退出邮箱、设备号被原生存储接管、网页存储被系统清理，
     都会让同一个人先后用不同的键写下日程。只认当前键的话，旧键那几条就成了
     「别人创建的、无法删除」，所以把见过的自己的键都记一份，判定归属时全部算数。 */
  function ownKeys() {
    let a;
    try { a = JSON.parse(localStorage.getItem('tm:myKeys') || '[]'); } catch (e) { a = []; }
    return Array.isArray(a) ? a : [];
  }
  function noteKey(k) {
    if (!k) return;
    const a = ownKeys();
    if (a.indexOf(k) >= 0) return;
    localStorage.setItem('tm:myKeys', JSON.stringify(a.concat(k).slice(-16)));
  }
  function myAcct() {
    const s = window.Auth && Auth.session && Auth.session();
    return s && s.email ? String(s.email).toLowerCase() : '';
  }
  /* 成员被折叠/迁移时留下「旧键 → 新键」的退休记录（见 retire()）。
     日程归属判定要先顺着这张表走：旧键名下的日程其实就是新键那个人写的，
     别人设备上把旧键补回成员表时也不该再当成多出来一个人 */
  function retiredMap(d) { return (d && d.retired) || {}; }
  function resolveId(d, id) {
    const r = retiredMap(d);
    const seen = {};
    while (r[id] && !seen[id]) { seen[id] = 1; id = r[id]; }
    return id;
  }
  function isMine(id, data) {
    if (!id) return false;
    noteKey(myId());
    const rid = resolveId(data, id);
    if (rid === myId() || id === myId() || ownKeys().indexOf(id) >= 0 || ownKeys().indexOf(rid) >= 0) return true;
    const m = data && data.members && data.members[id];
    if (!m) return false;
    const acct = myAcct();
    const macct = m.acct ? String(m.acct).toLowerCase() : '';
    if (acct && macct) return macct === acct; // 两边都登录过：邮箱说了算，同昵称的同桌也不算我的
    if (macct) return false;                 // 对方绑了邮箱、我没有：那条不是本机身份
    if (m.name !== App.me.name) return false;
    if (m.dev) return m.dev === App.clientId;         // 带设备号的新记录：同一台机器就是我的
    return !!m.color && m.color === App.me.color;     // 没设备号的老记录：同昵称 + 同颜色认作同一人
  }

  function stamp() {
    return { t: Date.now(), by: App.clientId };
  }

  /* ---------- 合并（确定性，多设备收敛） ---------- */
  function newer(a, b) { // a,b: {updatedAt, by}
    if (!a) return true;
    if (!b) return false;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
    return (a.by || '') > (b.by || '');
  }
  function merge(local, remote) {
    const out = { v: 2, code: remote.code || local.code, members: {}, events: {}, deletions: {}, retired: {} };
    /* 名称按 nameUpdatedAt LWW；均无时间戳时远端优先（兼容旧数据） */
    const ln = local.nameUpdatedAt || 0, rn = remote.nameUpdatedAt || 0;
    out.name = (rn >= ln && remote.name) ? remote.name : (local.name || remote.name);
    out.nameUpdatedAt = Math.max(ln, rn);
    out.createdBy = remote.createdBy || local.createdBy;
    for (const src of [remote, local]) {
      for (const id in src.members) {
        if (!(id in out.members) || newer(src.members[id], out.members[id])) out.members[id] = src.members[id];
      }
      for (const id in src.events) {
        if (!(id in out.events) || newer(src.events[id], out.events[id])) out.events[id] = src.events[id];
      }
      for (const id in src.deletions) {
        out.deletions[id] = Math.max(out.deletions[id] || 0, src.deletions[id]);
      }
      /* 退休记录只增不删、且同一旧键的目标键必然一致（谁折叠谁写），直接取非空值 */
      for (const id in (src.retired || {})) {
        if (!out.retired[id]) out.retired[id] = src.retired[id] || '';
      }
    }
    for (const id in out.events) {
      if (out.deletions[id] && out.deletions[id] >= out.events[id].updatedAt) delete out.events[id];
    }
    return out;
  }

  /* ---------- 本地缓存 ---------- */
  function persist(code) {
    const c = cache[code];
    localStorage.setItem(localKey(code), JSON.stringify({ data: c.data, etag: c.etag, dirty: c.dirty, seeds: c.seeds, gone: c.gone || 0 }));
  }
  function loadLocal(code) {
    if (cache[code]) return cache[code];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(localKey(code))); } catch (e) { /* noop */ }
    cache[code] = saved ? { data: saved.data, etag: saved.etag, dirty: !!saved.dirty, seeds: saved.seeds || {}, syncing: false, gone: saved.gone || 0 }
      : { data: null, etag: null, dirty: false, seeds: {}, syncing: false, gone: 0 };
    return cache[code];
  }

  /* 成员名单按「只增不减」处理：网盘没有事务，一次过期覆写就能把刚加入的人抹掉
     （三方同时用同一个配置码时最容易踩到）。本机见过的成员一律留档，
     合并/写回时补回去，被谁覆盖掉都能自愈。
     但「退休过的人」除外：那是同一人换了身份键或重复条目被折掉，
     拿留档把他复活就等于又变出第二个账号（用户反馈的「同一账号显示为多个」）。 */
  function rememberMembers(c, data) {
    const r = (data.retired) || {};
    for (const id in data.members) {
      if (id in r) continue;
      if (!(id in c.seeds) || newer(data.members[id], c.seeds[id])) c.seeds[id] = data.members[id];
    }
  }
  function restoreMembers(c, data) {
    const r = (data && data.retired) || {};
    let added = 0;
    for (const id in c.seeds) {
      if (data.members[id] || id in r) continue;
      data.members[id] = c.seeds[id]; added++;
    }
    return added;
  }
  function memberRecord() {
    const rec = { name: App.me.name, color: App.me.color, dev: App.clientId, joinedAt: Date.now(), updatedAt: Date.now(), by: myId() };
    const acct = myAcct();
    if (acct) rec.acct = acct; // 登录过就把邮箱写进成员资料：跨设备认人不再靠昵称猜
    return rec;
  }
  /* 把一个成员键标记为退休（into=接手的新键，可为空）。删成员必须留痕，
     否则别人本机留过档就会在下一轮把它补回来，同一个账号又显示成两条 */
  function retire(d, oldId, into) {
    if (!d.retired) d.retired = {};
    if (d.retired[oldId] && !into) { delete d.members[oldId]; return false; }
    const next = into || '';
    if (d.retired[oldId] === next && !d.members[oldId]) return false;
    d.retired[oldId] = d.retired[oldId] || next;
    delete d.members[oldId];
    return true;
  }
  /* 按退休记录收口：成员表里去掉旧键、日程归属改写到新键。
     每台设备算出的结果一致（映射来自同一份云端数据），所以不会来回摆动 */
  function applyRetired(d) {
    let changed = false;
    const r = d.retired || {};
    Object.keys(r).forEach((oldId) => {
      const into = resolveId(d, oldId);
      if (d.members[oldId]) { delete d.members[oldId]; changed = true; }
      if (into && into !== oldId) {
        if (d.createdBy === oldId) { d.createdBy = into; changed = true; }
        Object.keys(d.events).forEach((id) => {
          if (d.events[id].ownerId === oldId) { d.events[id].ownerId = into; changed = true; }
        });
      }
    });
    return changed;
  }
  /* 同一个人出现两条成员：身份键换过（登录/退出邮箱、换设备、网页存储被系统清过）
     就会留下旧键那一条，看起来像空间里多出来一个人，旧键名下的日程还会被当成别人写的而删不掉。
     这里是合并而不是丢弃：先把「确认是我」的旧键名下日程并到当前身份键上，
     再折掉名下零日程的重复项；本机自己那条永远保留。折掉/迁走一律写退休记录（retire），
     别的设备靠它收口归属，也不会拿本机留档把人复活。 */
  function foldMembers(code, data) {
    const c = loadLocal(code);
    const mine = resolveId(data, myId());
    let changed = false;
    /* 旧键名下还压着日程时，先把它们并到当前身份键上：认人按「设备号相同」或「邮箱相同」，
       昵称不参与判断——换过昵称、或另一台设备上的昵称不一样，之前就会漏折 */
    Object.keys(data.members).forEach((x) => {
      if (x === mine || resolveId(data, x) !== x) return; // 已经退休过的键不再处理
      const m = data.members[x];
      if (!m || !samePerson(m, (data.members[mine] || {}))) return;
      Object.keys(data.events).forEach((id) => {
        const e = data.events[id];
        if (e.ownerId !== x) return;
        e.ownerId = mine;
        e.updatedAt = Math.max(Date.now(), (e.updatedAt || 0) + 1);
        e.by = App.clientId;
        changed = true;
      });
      if (data.createdBy === x) { data.createdBy = mine; changed = true; }
      noteKey(x);
      if (retire(data, x, mine)) changed = true;
      delete c.seeds[x];
    });
    const owned = {};
    for (const id in data.events) owned[resolveId(data, data.events[id].ownerId)] = (owned[resolveId(data, data.events[id].ownerId)] || 0) + 1;
    const ids = Object.keys(data.members);
    /* 保留优先级：本机自己 > 名下日程多的 > 更早加入的 */
    const score = (id) => (id === mine ? 1e18 : 0) + (owned[id] || 0) * 1e15 - ((data.members[id] && data.members[id].joinedAt) || 0);
    ids.forEach((id) => {
      if (!data.members[id]) return; // 已被前一组折掉
      const group = ids.filter((x) => data.members[x] && samePerson(data.members[id], data.members[x]));
      if (group.length < 2) return;
      const keep = group.reduce((a, b) => (score(a) >= score(b) ? a : b));
      group.forEach((x) => {
        if (x === keep || (owned[x] || 0) > 0) return;
        if (retire(data, x, keep)) changed = true; // 折掉的键指向保留的那条，别处复活也无害
        delete c.seeds[x]; // 留档一起清，否则下一轮又被 restore 回来
      });
    });
    const self = data.members[mine];
    if (self && (!self.dev || !self.acct)) { // 老数据补一次设备号/邮箱
      self.dev = self.dev || App.clientId;
      const acct = myAcct();
      if (acct) self.acct = self.acct || acct;
      self.updatedAt = Date.now();
      changed = true;
    }
    if (applyRetired(data)) changed = true;
    return changed;
  }
  /* 两个人是不是同一个：邮箱是强证据（同邮箱即同人，不同邮箱必是两人），
     没登录过就退回「同一设备 + 同昵称」，再退回老数据的同昵称 + 同颜色。
     设备号不能单独定人：共用平板的两个人都未登录时设备号相同，靠昵称才分得开 */
  function samePerson(m, n) {
    if (!m || !n) return false;
    if (m.acct && n.acct) return String(m.acct).toLowerCase() === String(n.acct).toLowerCase();
    if (m.dev && n.dev) return m.dev === n.dev && !!m.name && m.name === n.name;
    return !!m.name && m.name === n.name && !!m.color && m.color === n.color;
  }
  /* 自己掉出成员表（被别人覆写掉了）就补回来，并标脏让下一轮写回云端。
     本机当前键若已被退休指向另一个键（例如退出登录后回到设备号，而日程早就记在邮箱名下），
     补的是那个后继键——否则一轮补、下一轮又按退休记录删，永远收敛不了 */
  function ensureSelf(c) {
    if (!c.data) return false;
    const id = resolveId(c.data, myId());
    if (c.data.members[id]) return false;
    c.data.members[id] = memberRecord();
    rememberMembers(c, c.data);
    c.dirty = true;
    return true;
  }

  function notify(code) { listeners.forEach((fn) => fn(code)); }
  function onChange(fn) { listeners.push(fn); }

  /* ---------- 同步状态机 ----------
     每轮：拉远端 → 合并 → 若有本地改动则写回。
     只读不写时带 etag（304 零流量）；一旦要写回就无条件拉一次全量再合并——
     很多网盘的 If-None-Match/If-Match 并不可靠，拿 304 的缓存去覆写整篇文档
     会把别人刚写入的日程和成员一起吃掉。
     写回 412（他端抢先更新）就把 etag 作废，下一轮重拉合并再写，最多 3 轮。
     读到 404（文件不见/账号或目录不对）时绝不再写回：本机脏数据无条件 PUT 出去，
     会在另一个网盘里凭空建出一份同名文档，两个人从此各写一份、谁也看不见新加入的成员。 */
  async function syncCode(code) {
    const c = loadLocal(code);
    if (c.syncing) return;
    c.syncing = true;
    try {
      for (let round = 0; round < 3; round++) {
        const r = await Dav.get(code, (c.dirty || !c.data) ? null : c.etag);
        if (r.status === 200) {
          c.missing = 0;
          c.lastError = '';
          const remote = JSON.parse(r.text);
          const remoteMembers = Object.keys(remote.members || {});
          c.gone = 0;
          c.data = c.data ? merge(c.data, remote) : remote;
          if (!c.data.members) c.data.members = {};
          if (!c.data.retired) c.data.retired = remote.retired || {};
          applyRetired(c.data);
          c.etag = r.etag || null;
          if (window.Dav && Dav.autoBind) Dav.autoBind(code); // 第一次同步成功就把网盘账号钉在这个空间上
          rememberMembers(c, c.data);
          restoreMembers(c, c.data);
          ensureSelf(c);
          if (foldMembers(code, c.data)) c.dirty = true;
          /* 合并结果比云端多成员 = 有人（包括自己）被旧版覆盖挤掉了，得把名单推回去；
             只补本机不写回的话，云端会一直缺人，别人看到的还是旧人数 */
          if (Object.keys(c.data.members).some((id) => remoteMembers.indexOf(id) < 0)) c.dirty = true;
        } else if (r.status === 404) {
          /* 云端文档不见了。要连续两轮（且本机没有待写入的改动）才判定「被创建者删除」——
             换网盘账号、改了目录、服务端抖动都会瞬时 404，第一轮就删本机副本太危险 */
          c.etag = null;
          if (c.data) {
            c.missing = (c.missing || 0) + 1;
            c.lastError = '网盘上找不到这个空间的文件' + (window.Dav && Dav.acctLabel ? '（账号 ' + Dav.acctLabel(code) + '）' : '');
            if (!c.dirty) {
              persist(code); notify(code);
              if (c.gone) { c.gone = 0; persist(code); goneListeners.forEach((fn) => fn(code)); }
              else { c.gone = 1; persist(code); }
              break;
            }
            /* 本机还有待写入的内容：只能「仅新建」式写回（If-None-Match:*）。
               无条件覆盖会在错的网盘里凭空造一份同名文档，两人从此各写各的、
               谁也看不见对方新加入的成员；文件真在的话必定 412，下一轮正常拉取合并。
               清空云端后的重建走的也是这条路。 */
            const p = await Dav.put(code, JSON.stringify(c.data), null);
            if (p.status === 412) { persist(code); notify(code); continue; }
            c.dirty = false; c.missing = 0; c.lastError = '';
            if (p.etag) c.etag = p.etag;
            persist(code); notify(code); break;
          }
        }
        if (!c.dirty || !c.data) { persist(code); notify(code); break; }
        /* etag 缺失时宁可无条件覆盖（文档已经过上面的全量合并），
           也不能退回 If-None-Match:* 的「仅新建」——文件本来就在，必定 412 */
        const p = await Dav.put(code, JSON.stringify(c.data), c.etag || undefined);
        if (p.status === 412) { c.etag = null; continue; }
        c.dirty = false;
        if (p.etag) c.etag = p.etag;
        persist(code); notify(code);
        break;
      }
      c.lastSync = Date.now();
    } catch (e) {
      c.lastError = e.message;
      console.warn('sync failed (offline ok):', e.message); // 离线/弱网：保持 dirty，下次重试
    } finally {
      c.syncing = false;
    }
  }

  let debounceTimer = null;
  function scheduleSync() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const spaces = JSON.parse(localStorage.getItem('tm:spaces') || '[]');
      spaces.forEach((s) => { if (loadLocal(s.code).dirty) syncCode(s.code); });
    }, 3000);
  }

  function mutate(code, fn) {
    const c = loadLocal(code);
    if (!c.data) return;
    fn(c.data);
    c.dirty = true;
    persist(code);
    notify(code);
    scheduleSync();
  }

  /* ---------- 对外业务 API ---------- */
  function genId(p) {
    const b = new Uint8Array(8); crypto.getRandomValues(b);
    return p + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function createSpace(code, name) {
    const id = myId();
    return {
      v: 2, code, name, createdBy: id, nameUpdatedAt: 0,
      members: { [id]: memberRecord() },
      events: {}, deletions: {}, retired: {},
    };
  }

  function creatorId(d) {
    if (d.createdBy) return d.createdBy;
    let best = null, ts = Infinity; // 旧空间无 createdBy：取最早加入的成员
    for (const id in d.members) {
      const j = d.members[id].joinedAt || 0;
      if (j < ts) { ts = j; best = id; }
    }
    return best;
  }

  function renameSpace(code, name) {
    const d = loadLocal(code).data;
    if (!d || !isMine(creatorId(d), d)) return false;
    mutate(code, (dd) => { dd.name = name; dd.nameUpdatedAt = Date.now(); });
    const spaces = api.listSpaces();
    const s = spaces.find((x) => x.code === code);
    if (s) { s.name = name; localStorage.setItem('tm:spaces', JSON.stringify(spaces)); }
    return true;
  }

  async function openRemote(code) { // 加入前读取远端
    const r = await Dav.get(code);
    if (r.status === 404) {
      const at = window.Dav && Dav.acctLabel ? '（当前网盘账号：' + Dav.acctLabel(code) + '）' : '';
      throw new Error('这个网盘账号下没有邀请码 ' + code + ' 的空间文件' + at + '。要么邀请码有误，要么对方用的是另一个网盘账号——请让家人发「配置码」给你。');
    }
    return { data: JSON.parse(r.text), etag: r.etag };
  }

  /* 加入/回到一个空间时确保自己在成员表里；若已被别人的过期覆写挤掉，会自动补回并写回云端 */
  function ensureMember(code) {
    const c = loadLocal(code);
    if (!c.data) return false;
    const id = resolveId(c.data, myId());
    if (c.data.members[id]) return false;
    mutate(code, (d) => { d.members[id] = memberRecord(); });
    return true;
  }

  function upsertSpaceMeta(code, name) {
    const spaces = JSON.parse(localStorage.getItem('tm:spaces') || '[]');
    if (!spaces.some((s) => s.code === code)) spaces.push({ code, name });
    localStorage.setItem('tm:spaces', JSON.stringify(spaces));
    localStorage.setItem('tm:lastSpace', code);
  }

  async function attach(code, initialData, etag) {
    const c = loadLocal(code);
    if (initialData) {
      if (!initialData.members) initialData.members = {};
      if (!initialData.retired) initialData.retired = {};
      c.data = merge(c.data || initialData, initialData);
      applyRetired(c.data);
      restoreMembers(c, c.data);
      rememberMembers(c, c.data);
      foldMembers(code, c.data);
    }
    if (etag !== undefined) c.etag = etag;
    persist(code);
  }

  const api = {
    createSpace, openRemote, ensureMember, upsertSpaceMeta, attach,
    get(code) { return loadLocal(code).data; },
    status(code) { const c = loadLocal(code); return { dirty: c.dirty, syncing: c.syncing, lastSync: c.lastSync, exists: !!c.data, lastError: c.lastError || '', missing: c.missing || 0 }; },
    syncCode, scheduleSync, onChange, onSpaceGone: (fn) => goneListeners.push(fn), mutate,
    listSpaces() { try { return JSON.parse(localStorage.getItem('tm:spaces') || '[]'); } catch (e) { return []; } },
    removeSpace(code) {
      const spaces = api.listSpaces().filter((s) => s.code !== code);
      localStorage.setItem('tm:spaces', JSON.stringify(spaces));
      if (localStorage.getItem('tm:lastSpace') === code) localStorage.removeItem('tm:lastSpace');
      localStorage.removeItem(localKey(code));
      delete cache[code];
    },
    addEvent(code, ev) {
      const s = stamp();
      const id = genId('e');
      mutate(code, (d) => { d.events[id] = Object.assign({ id, ownerId: resolveId(d, myId()), type: 'normal' }, ev, { updatedAt: s.t, by: s.by }); });
      return id;
    },
    addEvents(code, evs, ownerId) {
      const s = stamp();
      let added = 0;
      mutate(code, (d) => {
        const me = resolveId(d, ownerId || myId());
        const key = (e) => e.sourceUid + '|' + e.date + '|' + e.title;
        const known = new Set(Object.keys(d.events).map((k) => key(d.events[k])));
        evs.forEach((ev) => {
          const k = ev.sourceUid ? key(ev) : null;
          if (k) {
            if (known.has(k)) return;
            known.add(k); // 增量去重：同一批内的重复项（如循环日程多行）也只进一条
          }
          const id = genId('e');
          d.events[id] = Object.assign({ id, ownerId: me, type: 'normal' }, ev, { updatedAt: s.t, by: s.by });
          added++;
        });
      });
      return added;
    },
    /* 清理历史遗留的重复导入（同 sourceUid+date+title 的多条），只保留一条并广播删除 */
    dedupe(code) {
      const d = loadLocal(code).data;
      if (!d) return 0;
      const seen = new Set();
      const dup = [];
      Object.keys(d.events).forEach((id) => {
        const e = d.events[id];
        if (!e.sourceUid) return;
        const k = e.sourceUid + '|' + e.date + '|' + e.title;
        if (seen.has(k)) dup.push({ id, ts: e.updatedAt || 0 }); else seen.add(k);
      });
      if (!dup.length) return 0;
      mutate(code, (dd) => {
        dup.forEach(({ id, ts }) => {
          if (!dd.events[id]) return;
          dd.deletions[id] = Math.max(Date.now(), ts + 1);
          delete dd.events[id];
        });
      });
      return dup.length;
    },
    /* patch 里值为 null 的键会被删除（例如把「重复」改回不重复） */
    updateEvent(code, id, patch) {
      const d = loadLocal(code).data;
      if (!d || !d.events[id]) return false;
      if (!isMine(d.events[id].ownerId, d)) return false; // 仅创建者可改（换过身份键的旧记录也算自己）
      const s = stamp();
      mutate(code, (dd) => {
        const cur = dd.events[id];
        if (!cur) return;
        const next = Object.assign({}, cur, patch, { id, ownerId: cur.ownerId, updatedAt: Math.max(s.t, (cur.updatedAt || 0) + 1), by: s.by });
        Object.keys(patch).forEach((k) => { if (patch[k] === null) delete next[k]; });
        dd.events[id] = next;
      });
      return true;
    },
    deleteEvent(code, id) {
      const d = loadLocal(code).data;
      if (!d || !d.events[id]) return false;
      if (!isMine(d.events[id].ownerId, d)) return false; // 仅创建者可删自己的日程
      mutate(code, (dd) => {
        const ts = Math.max(Date.now(), (dd.events[id] ? dd.events[id].updatedAt : 0) + 1);
        dd.deletions[id] = ts;
        delete dd.events[id];
      });
      return true;
    },
    /* 批量删除（一次 mutate，只删自己的），返回实际删除条数 */
    deleteEvents(code, ids) {
      const d = loadLocal(code).data;
      if (!d || !ids.length) return 0;
      const mine = ids.filter((id) => d.events[id] && isMine(d.events[id].ownerId, d));
      if (!mine.length) return 0;
      mutate(code, (dd) => {
        mine.forEach((id) => {
          if (!dd.events[id]) return;
          dd.deletions[id] = Math.max(Date.now(), dd.events[id].updatedAt + 1);
          delete dd.events[id];
        });
      });
      return mine.length;
    },
    /* 登录/绑定邮箱：把此前本地身份名下的成员资料与日程整体迁移到新身份，而不是另建一个账户。
       若云端这个账户名下已经有资料（别的设备用同一邮箱加入过），保留账户原有的那一条，
       只把本机旧键的日程并过去并让它退休——昵称冲突交给界面弹窗问用户要哪一个。
       返回 { conflicts:[{code,mine,theirs}] } 供调用方决定后续提示。 */
    migrateIdentity(oldKey, newKey) {
      if (!oldKey || !newKey || oldKey === newKey) return { conflicts: [] };
      noteKey(oldKey); noteKey(newKey); // 换键前后的两个键都算自己的，漏迁的空间里旧日程也不会被认成别人的
      const conflicts = [];
      api.listSpaces().forEach((s) => {
        const c = loadLocal(s.code);
        const d = c.data;
        if (!d) return;
        const hasOld = (d.members[oldKey] !== undefined) || d.createdBy === oldKey
          || Object.keys(d.events).some((id) => d.events[id].ownerId === oldKey);
        if (!hasOld) return;
        mutate(s.code, (dd) => {
          const src = dd.members[oldKey];
          const tgt = dd.members[newKey];
          if (src) {
            if (!tgt) {
              dd.members[newKey] = Object.assign({}, src, { acct: myAcct() || src.acct, updatedAt: Date.now(), by: newKey });
            } else if ((tgt.name || '') !== (src.name || '')) {
              conflicts.push({ code: s.code, mine: src.name, theirs: tgt.name });
              dd.members[newKey] = Object.assign({}, tgt, {
                joinedAt: Math.min(tgt.joinedAt || Date.now(), src.joinedAt || Date.now()),
                acct: myAcct() || tgt.acct, by: newKey,
              });
            }
            retire(dd, oldKey, newKey); // 留痕：别人的留档不会再把旧键复活成「第二个人」
          }
          if (dd.createdBy === oldKey) dd.createdBy = newKey;
          Object.keys(dd.events).forEach((id) => {
            const e = dd.events[id];
            if (e.ownerId === oldKey) {
              e.ownerId = newKey;
              e.updatedAt = Math.max(Date.now(), e.updatedAt + 1);
              e.by = newKey;
            }
          });
        });
        /* 成员名单是「只增不减」的，唯一该改名/并身份的地方就是这里：本机留档也要一起并过去 */
        if (c.seeds[oldKey]) {
          c.seeds[newKey] = Object.assign({}, c.seeds[newKey] || {}, c.seeds[oldKey], { by: newKey, updatedAt: Date.now() });
          delete c.seeds[oldKey];
          persist(s.code);
        }
      });
      return { conflicts };
    },
    /* 换设备登录后自动补回该账户已加入的空间：扫本机已知网盘账号下的同步目录，
       逐个读出成员表，凡是这个身份键在里面的空间就加回本机列表（不写云端，不猜密码）。
       返回 { added:[code], nick, seen:{code:{name}} } */
    async followAccount(key) {
      const out = { added: [], nick: '', nickAt: 0, seen: {}, scanned: 0 };
      const id = key || myId();
      if (!window.Dav || !Dav.scanCodes || !Dav.getWith) return out;
      const scan = await Dav.scanCodes();
      for (const code of Object.keys(scan.codes)) {
        const acct = scan.codes[code];
        let data = null;
        try { data = JSON.parse((await Dav.getWith(acct, code)).text); out.scanned++; } catch (e) { continue; }
        if (!data || !data.members) continue;
        if (!data.retired) data.retired = {};
        const known = Object.keys(data.members).filter((x) => isMine(x, data) || resolveId(data, x) === id);
        if (!known.length) continue;
        out.seen[code] = { name: data.name || '共享空间' };
        known.forEach((x) => {
          const m = data.members[x];
          if (m && m.name && (m.updatedAt || 0) > out.nickAt) { out.nick = m.name; out.nickAt = m.updatedAt || 0; }
        });
        if (api.listSpaces().some((s) => s.code === code)) continue;
        if (Dav.bindSpace) Dav.bindSpace(code, acct);
        await attach(code, data);
        upsertSpaceMeta(code, data.name || '共享空间');
        out.added.push(code);
      }
      return out;
    },
    /* 统一改昵称：本机资料 + 所有已加入空间的成员记录一起改，别只改当前空间 */
    setMyName(name) {
      const n = String(name || '').trim();
      if (!n) return false;
      App.me.name = n;
      localStorage.setItem('tm:myName', n);
      api.listSpaces().forEach((s) => { if (loadLocal(s.code).data) api.setProfile(s.code); });
      return true;
    },
    setProfile(code) {
      const c = loadLocal(code);
      const id = c.data ? resolveId(c.data, myId()) : myId();
      mutate(code, (d) => {
        d.members[id] = Object.assign(memberRecord(), d.members[id] || {}, {
          name: App.me.name, color: App.me.color, dev: App.clientId, acct: myAcct() || undefined,
          updatedAt: Date.now(), by: id,
        });
        if (!myAcct()) delete d.members[id].acct;
      });
    },
    renameSpace,
    owns(id, data) { return isMine(id, data); },
    resolve(data, id) { return resolveId(data, id); }, // 旧身份键 → 现在的那条成员
    canRename(code) { const d = loadLocal(code).data; return !!d && isMine(creatorId(d), d); },
  };
  window.Store = api;
})();
