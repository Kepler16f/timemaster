/* ===== Store：v2 数据模型 + 确定性合并引擎 + ETag 同步状态机 + 离线队列 ===== */
(function () {
  'use strict';

  const listeners = [];
  const goneListeners = []; // 云端空间被创建者删除时的回调
  const kickedListeners = []; // 自己被空间管理员移出时的回调
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
  function memberRecord(code) {
    const rec = { name: App.me.name, color: App.me.color, dev: App.clientId, joinedAt: Date.now(), updatedAt: Date.now(), by: myId() };
    const acct = myAcct();
    if (acct) rec.acct = acct; // 登录过就把邮箱写进成员资料：跨设备认人不再靠昵称猜
    /* 这个成员用的是哪个网盘账号：与创建者同账号的人（拿配置码进来的家人）算管理员 */
    if (window.Dav && Dav.acctId) {
      const davId = Dav.acctId(code);
      if (davId) rec.davId = davId;
    }
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
    if (self && !self.out && (!self.dev || !self.acct || !self.davId)) { // 老数据补一次设备号/邮箱/网盘账号
      self.dev = self.dev || App.clientId;
      const acct = myAcct();
      if (acct) self.acct = self.acct || acct;
      if (window.Dav && Dav.acctId) {
        const davId = Dav.acctId(code);
        if (davId && self.davId !== davId) self.davId = davId;
      }
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
  function ensureSelf(code, c) {
    if (!c.data) return false;
    const id = resolveId(c.data, myId());
    if (c.data.members[id]) return false;
    c.data.members[id] = memberRecord(code);
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
          ensureSelf(code, c);
          if (foldMembers(code, c.data)) c.dirty = true;
          /* 被管理员移出：成员表里自己那条带着别人写的 out 标记。
             本机不做任何静默删除——交给界面问用户要不要移除本机副本 */
          const meKey = resolveId(c.data, myId());
          const myRec = c.data.members[meKey];
          const kicked = myRec && myRec.out && myRec.outBy !== meKey ? myRec.out : 0;
          if (kicked !== c.kicked) { c.kicked = kicked; if (kicked) kickedListeners.forEach((fn) => fn(code)); }
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
      members: { [id]: memberRecord(code) },
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

  /* ---------- 角色与「已退出」标记 ----------
     网盘没有服务器鉴权，所以管理员不是权限，只是「谁有义务整理这个空间」：
     创建者，以及和创建者用同一个网盘账号的人（拿配置码进来的家人）自动算管理员。
     老数据里没有 davId，认不出同账号的人，那种情况下只有创建者是管理员。 */
  function roleOf(d, id) {
    if (!d) return 'member';
    const me = resolveId(d, id);
    const c = creatorId(d);
    if (c && me === c) return 'creator';
    const mine = d.members[me];
    if (!mine) return 'member';
    if (mine.adm) return 'admin'; // 创建者手动指定的管理员（这人只有自己那台网盘账号时认不出同账号）
    /* 创建者撤销过的人只能由创建者再给回来：同网盘账号这条自动路一律不再认。
       否则「取消管理员」在这台设备上点完，对方下次同步又自己变回管理员，等于没取消 */
    if (mine.admOff && mine.admOffBy === c) return 'member';
    if (!c || !mine.davId) return 'member';
    const cm = d.members[c] || {};
    return cm.davId && cm.davId === mine.davId ? 'admin' : 'member';
  }
  function isManager(d, id) { const r = roleOf(d, id); return r === 'creator' || r === 'admin'; }
  /* 成员记录上的 out 就是「已退出 / 已被移出」：名片和名下日程都留着，
     只是不再出现在成员标签里——历史日程显示成「未知」比留着名字难看得多 */
  function outAt(d, id) { const m = d && d.members[resolveId(d, id)]; return (m && m.out) || 0; }
  /* 把某个人标记为已退出（by=做这件事的身份键：自己退出或被管理员移出） */
  function markOut(d, id, by) {
    const m = d.members[id];
    if (!m || m.out) return false;
    m.out = Date.now(); m.outBy = by; m.updatedAt = Date.now(); m.by = by;
    return true;
  }
  /* 谁退出了、谁被移出了，在别人眼里该提几次？规则按「TA 的日程还在不在」分两种：
     - 日程已清空：第一次画一行「已退出/已被移出」，第二次只弹一句提示（连人带行一起消失），第三次起彻底安静
     - 日程还留着：一直正常显示（日历上那些色块总得说清是谁写的），但绝不弹提示——以后 TA 那边再怎么动，
       都不该再打扰这个空间里的其他人
     已读次数记在本机（键 = 空间|成员），云端那条成员记录照旧留着不动。 */
  function outSeen() { try { return JSON.parse(localStorage.getItem('tm:outSeen') || '{}'); } catch (e) { return {}; } }
  function bumpOutSeen(code, ids) {
    if (!ids.length) return;
    const seen = outSeen();
    ids.forEach((id) => { const k = code + '|' + id; seen[k] = (seen[k] || 0) + 1; });
    localStorage.setItem('tm:outSeen', JSON.stringify(seen));
  }
  function seenTimes(code, id) { return outSeen()[code + '|' + id] || 0; }

  function renameSpace(code, name) {
    const d = loadLocal(code).data;
    if (!d || !isManager(d, myId())) return false;
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

  /* 加入/回到一个空间时确保自己在成员表里；若已被别人的过期覆写挤掉，会自动补回并写回云端。
     被移出的人重新拿邀请码进来时，是把他原来那条记录的 out 标记清掉，而不是另建一条 */
  function ensureMember(code) {
    const c = loadLocal(code);
    if (!c.data) return false;
    const id = resolveId(c.data, myId());
    const cur = c.data.members[id];
    if (cur && !cur.out) return false;
    mutate(code, (d) => {
      const rec = d.members[id] || memberRecord(code);
      if (window.Dav && Dav.acctId) {
        const davId = Dav.acctId(code);
        if (davId) rec.davId = davId;
      }
      d.members[id] = Object.assign(rec, { joinedAt: rec.joinedAt || Date.now(), out: null, outBy: null, updatedAt: Date.now(), by: myId() });
    });
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
        d.members[id] = Object.assign(memberRecord(code), d.members[id] || {}, {
          name: App.me.name, color: App.me.color, dev: App.clientId, acct: myAcct() || undefined,
          updatedAt: Date.now(), by: id,
        });
        if (!myAcct()) delete d.members[id].acct;
      });
    },
    renameSpace,
    owns(id, data) { return isMine(id, data); },
    resolve(data, id) { return resolveId(data, id); }, // 旧身份键 → 现在的那条成员
    canRename(code) { const d = loadLocal(code).data; return !!d && isManager(d, myId()); },
    /* ---------- 角色 / 退出 / 移出 ---------- */
    role(code, id) { return roleOf(loadLocal(code).data, id === undefined ? myId() : id); },
    isManager(code) { const d = loadLocal(code).data; return !!d && isManager(d, myId()) && !outAt(d, myId()); },
    members(code) {
      const d = loadLocal(code).data;
      if (!d) return [];
      const cr = creatorId(d);
      return Object.keys(d.members).map((id) => {
        const m = d.members[id];
        let n = 0;
        Object.keys(d.events).forEach((e) => { if (resolveId(d, d.events[e].ownerId) === id) n++; });
        return {
          id, name: m.name || '未命名', color: m.color || '', role: id === cr ? 'creator' : roleOf(d, id),
          davId: m.davId || '', out: m.out || 0, outBy: m.outBy || '', mine: isMine(id, d), events: n, joinedAt: m.joinedAt || 0,
          adm: !!m.adm, // 手动指定的管理员（区别于同网盘账号自动认定的那位）
          gone: !!(m.out && !n), // 已退出/被移出且名下再无日程：这种人才会淡出名单
          seen: m.out ? seenTimes(code, id) : 0, // 这个面板已经为 TA 打开过几次
        };
      }).sort((a, b) => (a.out - b.out) || (a.role === 'creator' ? -1 : b.role === 'creator' ? 1 : (a.role === 'admin' ? -1 : b.role === 'admin' ? 1 : a.joinedAt - b.joinedAt)));
    },
    /* 打开成员面板时调一次：要画的人 + 这一次该弹的提示，顺手把「见过几次」推进一格。
       日程还在的退出者永远在名单里且不弹提示；日程已清空的：第一次画行，第二次只弹提示，第三次起不再出现。 */
    lookMembers(code) {
      const all = api.members(code);
      const rows = [], notices = [], bump = [];
      all.forEach((m) => {
        if (!m.out) return rows.push(m);
        if (!m.gone) return rows.push(m); // 日程还在，正常显示，不打扰
        if (m.seen === 0) { rows.push(m); bump.push(m.id); }
        else if (m.seen === 1) { notices.push(m); bump.push(m.id); }
      });
      bumpOutSeen(code, bump);
      return { rows, notices };
    },
    /* 管理员能移出的只有「普通成员」：创建者动不得，同为管理员的也动不得（同一网盘账号本来就是一家人） */
    /* 谁能移出谁：创建者说了算——管理员和普通成员他都能移出去（自己除外）；
       管理员只能动普通成员，动不了创建者，也动不了另一位管理员（同一网盘账号本来就是一家人） */
    canKick(code, id) {
      const d = loadLocal(code).data;
      if (!d) return false;
      const t = resolveId(d, id);
      if (t === resolveId(d, myId())) return false;
      const mine = roleOf(d, myId()), target = roleOf(d, t);
      if (outAt(d, t) || target === 'creator') return false;
      return mine === 'creator' ? true : mine === 'admin' && target === 'member';
    },
    kickMember(code, id, opts) {
      if (!api.canKick(code, id)) return false;
      const d = loadLocal(code).data;
      const t = resolveId(d, id);
      mutate(code, (dd) => {
        const tgt = resolveId(dd, t);
        markOut(dd, tgt, resolveId(dd, myId()));
        if (opts && opts.dropMine) {
          Object.keys(dd.events).forEach((eid) => {
            const e = dd.events[eid];
            if (resolveId(dd, e.ownerId) !== tgt) return;
            dd.deletions[eid] = Math.max(Date.now(), (e.updatedAt || 0) + 1);
            delete dd.events[eid];
          });
        }
      });
      return true;
    },
    /* 管理员资格只由创建者给、也只由创建者收：'set' / 'unset' / ''。
       靠 davId 自动认定的那位一样能被创建者撤销——撤销后写 admOff + admOffBy，
       roleOf 见此标记就不再走 davId 那条自动路，除非创建者重新指定 */
    adminAction(code, id) {
      const d = loadLocal(code).data;
      if (!d || roleOf(d, myId()) !== 'creator') return '';
      const t = resolveId(d, id), m = d.members[t];
      if (!m || outAt(d, t) || t === creatorId(d) || t === resolveId(d, myId())) return '';
      return isManager(d, t) ? 'unset' : 'set';
    },
    canSetAdmin(code, id) { return api.adminAction(code, id) !== ''; },
    setAdmin(code, id, on) {
      if (api.adminAction(code, id) !== (on ? 'set' : 'unset')) return false;
      mutate(code, (d) => {
        const t = resolveId(d, id), m = d.members[t];
        if (on) { m.adm = Date.now(); delete m.admOff; delete m.admOffBy; }
        else {
          delete m.adm;
          m.admOff = Date.now(); m.admOffBy = resolveId(d, myId());
        }
        m.updatedAt = Date.now();
      });
      return true;
    },
    /* 退出空间：在云端成员表里把自己标记为已退出（可选把自己名下的日程一起打墓碑），
       本机副本要等云端写成功之后再清，否则离线退出等于这件事从没发生过 */
    async leave(code, opts) {
      const c = loadLocal(code);
      const d = c.data;
      if (!d) return false;
      const me = resolveId(d, myId());
      if (roleOf(d, me) === 'creator') return false; // 创建者该走「清空云端」，空间不能没有主人
      mutate(code, (dd) => {
        markOut(dd, me, me);
        if (opts && opts.dropMine) {
          Object.keys(dd.events).forEach((id) => {
            const e = dd.events[id];
            if (resolveId(dd, e.ownerId) !== me) return;
            dd.deletions[id] = Math.max(Date.now(), (e.updatedAt || 0) + 1);
            delete dd.events[id];
          });
        }
      });
      await syncCode(code);
      if (c.dirty) throw new Error('网盘没连上，云端还不知道你退出了——请联网后重试');
      return true;
    },
    /* 拿着配置码进来的人＝和创建者共用同一台网盘账号：自己给自己记一笔管理员。
       不等 davId 比对（换设备、清过数据时本机算出的哈希可能对不上），也不额外弹层问人。
       创建者收走过的资格，配置码给不回来——管理员这件事最终以创建者为准 */
    claimAdmin(code) {
      const d = loadLocal(code).data;
      if (!d) return false;
      const me = resolveId(d, myId()), m = d.members[me];
      if (!m || roleOf(d, me) === 'creator' || m.adm) return false;
      if (m.admOff) return false;
      mutate(code, (dd) => { const t = resolveId(dd, me); if (dd.members[t]) dd.members[t].adm = Date.now(); });
      return true;
    },
    /* 别人（创建者）把我移出过没有：out 是别人标的算被移出，自己标的算自己退出，两回事 */
    kickedOut(code) {
      const d = loadLocal(code).data;
      if (!d) return false;
      const me = resolveId(d, myId()), m = d.members[me];
      return !!(m && m.out && m.outBy && m.outBy !== me);
    },
    onKicked: (fn) => kickedListeners.push(fn),
  };
  window.Store = api;
})();
