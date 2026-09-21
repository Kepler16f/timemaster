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
    localStorage.setItem(localKey(code), JSON.stringify({ data: c.data, etag: c.etag, dirty: c.dirty }));
  }
  function loadLocal(code) {
    if (cache[code]) return cache[code];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(localKey(code))); } catch (e) { /* noop */ }
    cache[code] = saved ? { data: saved.data, etag: saved.etag, dirty: !!saved.dirty, syncing: false }
      : { data: null, etag: null, dirty: false, syncing: false };
    return cache[code];
  }

  function notify(code) { listeners.forEach((fn) => fn(code)); }
  function onChange(fn) { listeners.push(fn); }

  /* ---------- 同步状态机 ---------- */
  async function syncCode(code) {
    const c = loadLocal(code);
    if (c.syncing) return;
    c.syncing = true;
    try {
      let guard = 0;
      while (guard++ < 3) {
        const r = await Dav.get(code, c.etag);
        if (r.status === 304) break;
        if (r.status === 404) { c.etag = null; break; }
        c.data = c.data ? merge(c.data, JSON.parse(r.text)) : JSON.parse(r.text);
        c.etag = r.etag;
        if (!c.dirty) { persist(code); notify(code); break; }
      }
      if (c.dirty && c.data) {
        const p = await Dav.put(code, JSON.stringify(c.data), c.etag);
        if (p.status === 412) { // 他端已更新 → 重拉合并再试一轮
          c.etag = null;
          const r = await Dav.get(code);
          if (r.status === 200) {
            c.data = merge(c.data, JSON.parse(r.text));
            c.etag = r.etag;
          }
          const p2 = await Dav.put(code, JSON.stringify(c.data), c.etag);
          if (p2.status !== 412) { c.dirty = false; if (p2.etag) c.etag = p2.etag; }
          notify(code);
        } else {
          c.dirty = false;
          if (p.etag) c.etag = p.etag;
        }
        persist(code);
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
      members: { [id]: { name: App.me.name, color: App.me.color, joinedAt: Date.now(), updatedAt: Date.now(), by: id } },
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
    if (r.status === 404) throw new Error('邀请码无效（网盘上没有该空间）');
    return { data: JSON.parse(r.text), etag: r.etag };
  }

  function joinMember(data) {
    data.members[myId()] = {
      name: App.me.name, color: App.me.color, joinedAt: Date.now(), updatedAt: Date.now(), by: myId(),
    };
  }

  function upsertSpaceMeta(code, name) {
    const spaces = JSON.parse(localStorage.getItem('tm:spaces') || '[]');
    if (!spaces.some((s) => s.code === code)) spaces.push({ code, name });
    localStorage.setItem('tm:spaces', JSON.stringify(spaces));
    localStorage.setItem('tm:lastSpace', code);
  }

  async function attach(code, initialData, etag) {
    const c = loadLocal(code);
    if (initialData) { c.data = merge(c.data || initialData, initialData); }
    if (etag !== undefined) c.etag = etag;
    persist(code);
  }

  const api = {
    createSpace, openRemote, joinMember, upsertSpaceMeta, attach,
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
      mutate(code, (d) => {
        const known = new Set(Object.keys(d.events).map((k) => d.events[k].sourceUid + '|' + d.events[k].date + '|' + d.events[k].title));
        evs.forEach((ev) => {
          if (ev.sourceUid && known.has(ev.sourceUid + '|' + ev.date + '|' + ev.title)) return;
          const id = genId('e');
          d.events[id] = Object.assign({ id, ownerId: ownerId || myId(), type: 'normal' }, ev, { updatedAt: s.t, by: s.by });
        });
      });
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
    setProfile(code) {
      const id = myId();
      mutate(code, (d) => {
        d.members[id] = Object.assign(d.members[id] || {}, {
          name: App.me.name, color: App.me.color, updatedAt: Date.now(), by: id,
        });
      });
    },
    renameSpace,
    canRename(code) { const d = loadLocal(code).data; return !!d && creatorId(d) === myId(); },
  };
  window.Store = api;
})();
