/* ===== Store：v2 数据模型 + 确定性合并引擎 + ETag 同步状态机 + 离线队列 ===== */
(function () {
  'use strict';

  const listeners = [];
  const cache = {}; // code -> { data, etag, dirty, syncing }

  function localKey(code) { return 'tm:space:' + code; }
  /* 身份键：登录账户后跨设备一致，未登录回退设备 id */
  function myId() { return (window.Auth && Auth.memberKey()) || App.clientId; }

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
    const out = { v: 2, code: remote.code || local.code, members: {}, events: {}, deletions: {} };
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
    }
    for (const id in out.events) {
      if (out.deletions[id] && out.deletions[id] >= out.events[id].updatedAt) delete out.events[id];
    }
    return out;
  }

  /* ---------- 本地缓存 ---------- */
  function persist(code) {
    const c = cache[code];
    localStorage.setItem(localKey(code), JSON.stringify({ data: c.data, etag: c.etag, dirty: c.dirty, seeds: c.seeds }));
  }
  function loadLocal(code) {
    if (cache[code]) return cache[code];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(localKey(code))); } catch (e) { /* noop */ }
    cache[code] = saved ? { data: saved.data, etag: saved.etag, dirty: !!saved.dirty, seeds: saved.seeds || {}, syncing: false }
      : { data: null, etag: null, dirty: false, seeds: {}, syncing: false };
    return cache[code];
  }

  /* 成员名单按「只增不减」处理：网盘没有事务，一次过期覆写就能把刚加入的人抹掉
     （三方同时用同一个配置码时最容易踩到）。本机见过的成员一律留档，
     合并/写回时补回去，被谁覆盖掉都能自愈。 */
  function rememberMembers(c, data) {
    for (const id in data.members) {
      if (!(id in c.seeds) || newer(data.members[id], c.seeds[id])) c.seeds[id] = data.members[id];
    }
  }
  function restoreMembers(c, data) {
    let added = 0;
    for (const id in c.seeds) {
      if (!data.members[id]) { data.members[id] = c.seeds[id]; added++; }
    }
    return added;
  }
  function memberRecord() {
    return { name: App.me.name, color: App.me.color, joinedAt: Date.now(), updatedAt: Date.now(), by: myId() };
  }
  /* 早期版本（以及身份迁移的中途）在成员表里留下过「既没名字也没颜色」的空记录，
     合并是并集清不掉它，于是同一个人会并排显示成两个标签。
     空记录且名下没有任何日程的直接清掉，本机留档一起清，免得下次写回又把它带回去。 */
  function pruneBlank(code, data) {
    const c = loadLocal(code);
    let changed = false;
    const owned = {};
    for (const id in data.events) owned[data.events[id].ownerId] = 1;
    const blank = (m) => !m || !m.name;
    for (const id in data.members) {
      if (!blank(data.members[id]) || owned[id] || id === data.createdBy) continue;
      if (id === myId()) { data.members[id] = memberRecord(); changed = true; continue; } // 自己的补全，别把自己删了
      delete data.members[id];
      changed = true;
    }
    for (const id in c.seeds) {
      if (blank(c.seeds[id]) && !data.members[id]) { delete c.seeds[id]; changed = true; }
    }
    return changed;
  }
  /* 自己掉出成员表（被别人覆写掉了）就补回来，并标脏让下一轮写回云端 */
  function ensureSelf(c) {
    const id = myId();
    if (!c.data || c.data.members[id]) return false;
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
     写回 412（他端抢先更新）就把 etag 作废，下一轮重拉合并再写，最多 3 轮。 */
  async function syncCode(code) {
    const c = loadLocal(code);
    if (c.syncing) return;
    c.syncing = true;
    try {
      for (let round = 0; round < 3; round++) {
        const r = await Dav.get(code, (c.dirty || !c.data) ? null : c.etag);
        if (r.status === 200) {
          const remote = JSON.parse(r.text);
          const remoteMembers = Object.keys(remote.members || {});
          c.data = c.data ? merge(c.data, remote) : remote;
          if (!c.data.members) c.data.members = {};
          c.etag = r.etag || null;
          rememberMembers(c, c.data);
          restoreMembers(c, c.data);
          ensureSelf(c);
          if (pruneBlank(code, c.data)) c.dirty = true;
          /* 合并结果比云端多成员 = 有人（包括自己）被旧版覆盖挤掉了，得把名单推回去；
             只补本机不写回的话，云端会一直缺人，别人看到的还是旧人数 */
          if (Object.keys(c.data.members).some((id) => remoteMembers.indexOf(id) < 0)) c.dirty = true;
        } else if (r.status === 404) {
          c.etag = null;
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
      events: {}, deletions: {},
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
    if (!d || creatorId(d) !== myId()) return false;
    mutate(code, (dd) => { dd.name = name; dd.nameUpdatedAt = Date.now(); });
    const spaces = api.listSpaces();
    const s = spaces.find((x) => x.code === code);
    if (s) { s.name = name; localStorage.setItem('tm:spaces', JSON.stringify(spaces)); }
    return true;
  }

  async function openRemote(code) { // 加入前读取远端
    const r = await Dav.get(code);
    if (r.status === 404) throw new Error('网盘上没有该房间：邀请码有误，或对方连的是另一个网盘账号/目录');
    return { data: JSON.parse(r.text), etag: r.etag };
  }

  /* 加入/回到一个空间时确保自己在成员表里；若已被别人的过期覆写挤掉，会自动补回并写回云端 */
  function ensureMember(code) {
    const c = loadLocal(code);
    if (!c.data || c.data.members[myId()]) return false;
    mutate(code, (d) => { d.members[myId()] = memberRecord(); });
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
      c.data = merge(c.data || initialData, initialData);
      restoreMembers(c, c.data);
      rememberMembers(c, c.data);
      pruneBlank(code, c.data);
    }
    if (etag !== undefined) c.etag = etag;
    persist(code);
  }

  const api = {
    createSpace, openRemote, ensureMember, upsertSpaceMeta, attach,
    get(code) { return loadLocal(code).data; },
    status(code) { const c = loadLocal(code); return { dirty: c.dirty, syncing: c.syncing, lastSync: c.lastSync, exists: !!c.data }; },
    syncCode, scheduleSync, onChange, mutate,
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
      mutate(code, (d) => { d.events[id] = Object.assign({ id, ownerId: myId(), type: 'normal' }, ev, { updatedAt: s.t, by: s.by }); });
      return id;
    },
    addEvents(code, evs, ownerId) {
      const s = stamp();
      let added = 0;
      mutate(code, (d) => {
        const key = (e) => e.sourceUid + '|' + e.date + '|' + e.title;
        const known = new Set(Object.keys(d.events).map((k) => key(d.events[k])));
        evs.forEach((ev) => {
          const k = ev.sourceUid ? key(ev) : null;
          if (k) {
            if (known.has(k)) return;
            known.add(k); // 增量去重：同一批内的重复项（如循环日程多行）也只进一条
          }
          const id = genId('e');
          d.events[id] = Object.assign({ id, ownerId: ownerId || myId(), type: 'normal' }, ev, { updatedAt: s.t, by: s.by });
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
      if (d.events[id].ownerId !== myId()) return false; // 仅创建者可改
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
      if (d.events[id].ownerId !== myId()) return false; // 仅创建者可删自己的日程
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
      const mine = ids.filter((id) => d.events[id] && d.events[id].ownerId === myId());
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
    /* 登录/绑定邮箱：把此前本地身份名下的成员资料与日程整体迁移到新身份，而不是另建一个账户 */
    migrateIdentity(oldKey, newKey) {
      if (!oldKey || !newKey || oldKey === newKey) return;
      api.listSpaces().forEach((s) => {
        const d = loadLocal(s.code).data;
        if (!d) return;
        const hasOld = (d.members[oldKey] !== undefined) || d.createdBy === oldKey
          || Object.keys(d.events).some((id) => d.events[id].ownerId === oldKey);
        if (!hasOld) return;
        mutate(s.code, (dd) => {
          if (dd.members[oldKey]) {
            dd.members[newKey] = Object.assign({}, dd.members[oldKey], { updatedAt: Date.now(), by: newKey });
            delete dd.members[oldKey];
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
        const c = loadLocal(s.code);
        if (c.seeds[oldKey]) {
          c.seeds[newKey] = Object.assign({}, c.seeds[oldKey], { by: newKey, updatedAt: Date.now() });
          delete c.seeds[oldKey];
          persist(s.code);
        }
      });
    },
    setProfile(code) {
      const id = myId();
      mutate(code, (d) => {
        d.members[id] = Object.assign(memberRecord(), d.members[id] || {}, {
          name: App.me.name, color: App.me.color, updatedAt: Date.now(), by: id,
        });
      });
    },
    renameSpace,
    canRename(code) { const d = loadLocal(code).data; return !!d && creatorId(d) === myId(); },
  };
  window.Store = api;
})();
