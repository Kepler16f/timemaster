/**
 * 共享日程 APP · 免登录多用户版（零依赖 Node 后端）
 * 特性：打开即用（无账号密码）、共享空间（邀请码加入）、按成员标签色显示日程、系统日历(.ics)导入
 * 身份：每个设备本地生成 clientId 作为身份，无需注册登录
 * 运行：node server.js  ->  http://<本机IP 或 蒲公英虚拟IP>:3000  （同 WiFi 或蒲公英私有组网均可访问）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const PALETTE = ['#FF6B6B','#4ECDC4','#5B8FF9','#F6BD16','#9270CA','#73D13D','#FF9C6E','#36CFC9'];

// ---------------- 数据持久化 ----------------
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ spaces: [] }, null, 2));
}
function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ---------------- 工具 ----------------
function genId(p) { return (p || 'id') + crypto.randomBytes(6).toString('hex'); }
function genCode() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function getClientId(req) {
  const h = req.headers['x-client-id'] || '';
  return h.trim() || null;
}

// ---------------- 健壮 ICS 解析（循环/时区/全天/多账户） ----------------
function pad2(n){ return String(n).padStart(2,'0'); }

// 解析单个日期时间值（支持 VALUE=DATE 全天、Z 结尾的 UTC、TZID 当作本地）
function parseDt(val, params) {
  let v = (val || '').trim();
  const isUTC = v.endsWith('Z');
  const v2 = v.replace(/Z$/, '');
  const isDate = /VALUE=DATE/i.test(params || '') || /^\d{8}$/.test(v2);
  if (isDate) {
    return { date: `${v2.slice(0,4)}-${v2.slice(4,6)}-${v2.slice(6,8)}`, time: '', allDay: true };
  }
  const y = +v2.slice(0,4), mo = +v2.slice(4,6), d = +v2.slice(6,8);
  const hh = +v2.slice(9,11), mm = +v2.slice(11,13), ss = +(v2.slice(13,15) || '00');
  if (isUTC) { // 转成本地时区显示
    const dt = new Date(Date.UTC(y, mo-1, d, hh, mm, ss));
    return { date: `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`, time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`, allDay: false };
  }
  return { date: `${y}-${pad2(mo)}-${pad2(d)}`, time: `${pad2(hh)}:${pad2(mm)}`, allDay: false };
}
function addMins(t, mins){ const [h,m]=t.split(':').map(Number); let tot=((h*60+m+mins)%1440+1440)%1440; return pad2(Math.floor(tot/60))+':'+pad2(tot%60); }

// 将单条 VEVENT 展开为若干次具体日程（含 RRULE 循环、全天多日、DURATION）
function expandEvent(ev) {
  const out = [];
  const start = ev.start;
  const pushOne = (dateStr, timeStr, allDay) => {
    out.push({ title: ev.title, date: dateStr, allDay, start: allDay ? '' : timeStr,
      end: allDay ? '' : (ev.end ? ev.end.time : ''), desc: ev.desc || '', location: ev.location || '', uid: ev.uid });
  };
  let durDays = 1, durMins = 0, end = ev.end;
  if (start.allDay && end && end.allDay) {
    const sd = new Date(start.date + 'T00:00:00'), ed = new Date(end.date + 'T00:00:00');
    durDays = Math.max(1, Math.round((ed - sd) / 86400000));
  } else if (!start.allDay && end && !end.allDay) {
    const sm = start.time.split(':').map(Number), em = end.time.split(':').map(Number);
    durMins = (em[0]*60+em[1]) - (sm[0]*60+sm[1]); if (durMins < 0) durMins = 0;
  } else if (!end && ev.duration) { // DURATION 兜底
    const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(ev.duration || '');
    if (m) { const w=+m[1]||0,dd=+m[2]||0,hh=+m[3]||0,mm=+m[4]||0; const tot=w*10080+dd*1440+hh*60+mm;
      if (start.allDay) durDays=Math.max(1,Math.round(tot/1440)); else { durMins=tot; end={allDay:false,time:addMins(start.time,tot)}; } }
  }

  if (!ev.rrule) {
    if (start.allDay && durDays > 1) {
      for (let i=0;i<durDays;i++){ const dt=new Date(start.date+'T00:00:00'); dt.setDate(dt.getDate()+i);
        pushOne(`${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`, '', true); }
    } else pushOne(start.date, start.time, start.allDay);
    return out;
  }

  // ---- RRULE 循环展开 ----
  const o = {}; (ev.rrule||'').split(';').forEach(p=>{ const i=p.indexOf('='); if(i>-1) o[p.slice(0,i).toUpperCase()]=p.slice(i+1); });
  const freq = (o.FREQ||'DAILY').toUpperCase();
  const interval = parseInt(o.INTERVAL||'1',10)||1;
  const count = o.COUNT ? parseInt(o.COUNT,10) : null;
  let until = null;
  if (o.UNTIL){ const u=o.UNTIL.replace(/Z$/,'');
    until = u.length===8 ? new Date(u.slice(0,4)+'-'+u.slice(4,6)+'-'+u.slice(6,8)+'T23:59:59')
                         : new Date(u.slice(0,4)+'-'+u.slice(4,6)+'-'+u.slice(6,8)+'T'+u.slice(9,11)+':'+u.slice(11,13)+':00'); }
  const byDay = o.BYDAY ? o.BYDAY.split(',').map(s=>s.replace(/^[+-]?\d+/,'')) : null;
  const byMonthDay = o.BYMONTHDAY ? o.BYMONTHDAY.split(',').map(Number) : null;
  const dayMap = { SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6 };
  const horizon = new Date(start.date+'T00:00:00'); horizon.setFullYear(horizon.getFullYear()+3);
  const startD = new Date(start.date+'T00:00:00');
  let n = 0; const MAX = 800;
  const addOcc = (d) => {
    const ds = `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
    if (start.allDay && durDays>1){ for(let i=0;i<durDays;i++){ const dd=new Date(d); dd.setDate(dd.getDate()+i);
      pushOne(`${dd.getFullYear()}-${pad2(dd.getMonth()+1)}-${pad2(dd.getDate())}`,'',true); } }
    else pushOne(ds, start.time, start.allDay);
    n++;
  };
  const inRange = (d) => d >= startD && d <= (until||horizon) && (!count||n<count) && n<MAX;
  if (freq==='DAILY'){ let d=new Date(startD); while(inRange(d)){ addOcc(d); d.setDate(d.getDate()+interval); }
  } else if (freq==='WEEKLY'){ let wk=new Date(startD); while(inRange(wk)){ const monday=new Date(wk); monday.setDate(monday.getDate()-((monday.getDay()+6)%7));
      if(byDay){ byDay.forEach(bd=>{ const occ=new Date(monday); occ.setDate(occ.getDate()+((dayMap[bd]+6)%7)); if(inRange(occ)) addOcc(occ); }); }
      else addOcc(wk);
      wk.setDate(wk.getDate()+7*interval); }
  } else if (freq==='MONTHLY'){ let d=new Date(startD); while(inRange(d)){ if(byMonthDay){ byMonthDay.forEach(md=>{ const occ=new Date(d.getFullYear(),d.getMonth(),md); if(inRange(occ)) addOcc(occ); }); }
      else addOcc(d); d.setMonth(d.getMonth()+interval); }
  } else if (freq==='YEARLY'){ let d=new Date(startD); while(inRange(d)){ addOcc(d); d.setFullYear(d.getFullYear()+interval); }
  } else pushOne(start.date, start.time, start.allDay);
  return out;
}

function parseICS(text) {
  const lines = [];
  text.split(/\r\n|\n|\r/).forEach((raw) => {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else if (raw.trim() !== '') lines.push(raw);
  });
  const events = [];
  let inEvent = false, cur = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) { inEvent = true; cur = { title:'未命名日程', desc:'', location:'', rrule:null, duration:null, uid:null }; continue; }
    if (/^END:VEVENT$/i.test(line)) {
      if (inEvent && cur && cur.start) expandEvent(cur).forEach(e => events.push(e));
      inEvent = false; cur = null; continue;
    }
    if (!inEvent || !cur) continue;
    const idx = line.indexOf(':'); if (idx === -1) continue;
    const head = line.slice(0, idx), key = head.split(';')[0].toUpperCase(), val = line.slice(idx + 1);
    if (key === 'SUMMARY') cur.title = val.replace(/\\[nN]/g, '\n') || '未命名日程';
    else if (key === 'DESCRIPTION') cur.desc = val.replace(/\\[nN]/g, '\n');
    else if (key === 'LOCATION') cur.location = val;
    else if (key === 'UID') cur.uid = val;
    else if (key === 'RRULE') cur.rrule = val;
    else if (key === 'DURATION') cur.duration = val;
    else if (key === 'DTSTART') cur.start = parseDt(val, head);
    else if (key === 'DTEND') cur.end = parseDt(val, head);
  }
  return events;
}

// ---------------- HTTP 辅助 ----------------
function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Client-Id',
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.webmanifest':'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let fp = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (req.method === 'OPTIONS') { sendJSON(res, 204, {}); return; }

  try {
    // 静态资源（无需身份）
    if (!p.startsWith('/api/')) { serveStatic(req, res, p); return; }

    const clientId = getClientId(req);
    if (!clientId) return sendJSON(res, 400, { error: '缺少设备标识' });

    // 创建空间
    if (p === '/api/spaces' && req.method === 'POST') {
      const b = await readBody(req);
      const name = (b.name || '').trim() || '共享日程';
      const displayName = (b.displayName || '').trim() || '我';
      const color = b.color || PALETTE[Math.floor(Math.random()*PALETTE.length)];
      const space = {
        id: genId('s'), name, code: genCode(),
        members: [{ clientId, name: displayName, color }], events: [],
      };
      const db = readDb(); db.spaces.push(space); writeDb(db);
      return sendJSON(res, 201, spaceDetail(space));
    }
    // 加入空间（邀请码）
    if (p === '/api/spaces/join' && req.method === 'POST') {
      const b = await readBody(req);
      const code = (b.code || '').trim().toUpperCase();
      const db = readDb();
      const space = db.spaces.find((s) => s.code === code);
      if (!space) return sendJSON(res, 404, { error: '邀请码无效' });
      if (space.members.some((m) => m.clientId === clientId)) return sendJSON(res, 400, { error: '你已在该空间' });
      const displayName = (b.displayName || '').trim() || '我';
      const color = b.color || PALETTE[space.members.length % PALETTE.length];
      space.members.push({ clientId, name: displayName, color });
      writeDb(db);
      return sendJSON(res, 200, spaceDetail(space));
    }
    // 空间详情
    if (p.startsWith('/api/spaces/') && req.method === 'GET' && p.split('/').length === 4) {
      const sid = p.split('/')[3];
      const db = readDb();
      const space = db.spaces.find((s) => s.id === sid);
      if (!space) return sendJSON(res, 404, { error: '空间不存在' });
      if (!space.members.some((m) => m.clientId === clientId)) return sendJSON(res, 403, { error: '你不在该空间' });
      return sendJSON(res, 200, spaceDetail(space));
    }
    // 新增日程（归属于当前设备）
    if (p.startsWith('/api/spaces/') && p.endsWith('/events') && req.method === 'POST') {
      const sid = p.split('/')[3];
      const db = readDb();
      const space = db.spaces.find((s) => s.id === sid);
      if (!space || !space.members.some((m) => m.clientId === clientId)) return sendJSON(res, 403, { error: '无权访问' });
      const b = await readBody(req);
      if (!b.date) return sendJSON(res, 400, { error: '缺少日期' });
      const ev = {
        id: genId('e'), ownerId: clientId,
        title: (b.title || '').trim() || '未命名日程',
        date: b.date, allDay: !!b.allDay, start: b.allDay ? '' : (b.start || ''),
        end: b.allDay ? '' : (b.end || ''), type: b.type || 'normal', desc: b.desc || '',
      };
      space.events.push(ev); writeDb(db);
      return sendJSON(res, 201, ev);
    }
    // 删除日程（空间成员均可删，便于协作）
    if (p.startsWith('/api/spaces/') && p.includes('/events/') && req.method === 'DELETE') {
      const parts = p.split('/'); const sid = parts[3]; const eid = parts[5];
      const db = readDb();
      const space = db.spaces.find((s) => s.id === sid);
      if (!space || !space.members.some((m) => m.clientId === clientId)) return sendJSON(res, 403, { error: '无权访问' });
      space.events = space.events.filter((e) => e.id !== eid);
      writeDb(db);
      return sendJSON(res, 200, { ok: true });
    }
    // 导入 .ics（可多文件合并；支持指定归属成员；按 UID+日期去重）
    if (p.startsWith('/api/spaces/') && p.endsWith('/import') && req.method === 'POST') {
      const sid = p.split('/')[3];
      const db = readDb();
      const space = db.spaces.find((s) => s.id === sid);
      if (!space || !space.members.some((m) => m.clientId === clientId)) return sendJSON(res, 403, { error: '无权访问' });
      const b = await readBody(req);
      const texts = Array.isArray(b.ics) ? b.ics : [b.ics || ''];
      const owner = (b.asClientId && space.members.some((m) => m.clientId === b.asClientId)) ? b.asClientId : clientId;
      let added = 0; const seen = new Set();
      for (const ics of texts) {
        for (const pe of parseICS(ics || '')) {
          const key = (pe.uid || '') + '|' + pe.date + '|' + pe.title + '|' + pe.start;
          if (seen.has(key)) continue; seen.add(key);
          space.events.push({ id: genId('e'), ownerId: owner, title: pe.title, date: pe.date, allDay: pe.allDay, start: pe.start || '', end: pe.end || '', type: 'normal', desc: pe.desc || '', location: pe.location || '' });
          added++;
        }
      }
      writeDb(db);
      return sendJSON(res, 200, { added, total: space.events.length });
    }

    return sendJSON(res, 404, { error: 'API 不存在' });
  } catch (e) {
    sendJSON(res, 500, { error: String(e) });
  }
});

function spaceDetail(s) {
  return { id: s.id, name: s.name, code: s.code, members: s.members, events: s.events };
}

// ---------------- 启动 ----------------
function lanIP() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const i of ifs[k])
    if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
ensureDb();
server.listen(PORT, HOST, () => {
  const ip = lanIP();
  console.log('共享日程 APP（免登录多用户版）已启动');
  console.log('  本机访问 : http://localhost:' + PORT);
  console.log('  手机访问 : http://' + ip + ':' + PORT + '  （手机与电脑连同一 WiFi）');
});
