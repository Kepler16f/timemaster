/* 同步诊断、系统提醒状态与时间投票；独立维护新增交互，复用现有界面组件。 */
(function () {
  'use strict';
  let candidates = [], candidateCode = '', pollCode = '';
  function timeText(ms) { return ms ? new Date(ms).toLocaleString() : '尚无记录'; }
  function renderSync() {
    const box = $('#syncSummary'), pending = $('#syncPending'); box.textContent = ''; pending.textContent = '';
    if (!state.code) { box.appendChild(el('p','set-note','请先进入一个空间')); return; }
    const data = Store.get(state.code), s = Store.status(state.code);
    const lines = [
      '空间：' + (data && data.name || state.code),
      '网盘账号：' + Dav.acctLabel(state.code),
      '当前状态：' + (s.syncing ? '正在同步' : s.dirty ? '还有改动等待上传' : s.lastError ? '连接失败' : '本机没有待上传改动'),
      '最近成功：' + timeText(s.lastSync), '最近尝试：' + timeText(s.lastAttempt),
      '已自动重试的并发冲突：' + s.conflicts + ' 次',
      '本机日程：' + Object.keys(data && data.events || {}).length + ' 条',
    ];
    if (s.lastError) lines.push('最近问题：' + s.lastError);
    if (s.dirty && !s.pending.length) lines.push('待上传：空间资料、成员或投票等更改');
    lines.forEach((text) => box.appendChild(el('div','dm-row',text)));
    s.pending.forEach((change) => pending.appendChild(el('div','batch-row',change.kind + ' · ' + change.title)));
    $('#syncRetry').disabled = s.syncing;
  }
  $('#syncState').onclick = () => { renderSync(); $('#syncModal').hidden = false; };
  $('#syncClose').onclick = () => { $('#syncModal').hidden = true; };
  $('#syncRetry').onclick = async () => { if (state.code) { await Store.syncCode(state.code); renderSync(); } };

  function renderReminders() {
    const code = state.code, s = ReminderSync.status(code);
    $('#calendarAuto').disabled = !code || !s.available;
    $('#calendarAuto').checked = !!s.enabled;
    $('#calendarRetry').disabled = !code || !s.available || s.syncing;
    $('#calendarPermission').classList.toggle('hidden', !s.needSettings || !s.available);
    let note = !code ? '进入空间后可设置。' : !s.available ? '此设备暂不支持系统日历回写。' :
      s.syncing ? '正在更新系统日历…' : s.error ? '回写未完成：' + s.error :
      s.enabled ? '已开启本空间自动回写。最近成功：' + timeText(s.lastSync) : '尚未开启本空间自动回写。';
    note += ' 提醒由系统日历处理，请确认它的通知已开启；农历或单次调整会写入未来一年，打开应用时刷新。';
    $('#calendarAutoStatus').textContent = note;
  }
  function renderReminderDetail(ev, code) {
    const s = ReminderSync.status(code);
    $('#detailReminderState').textContent = ev.rem == null ? '' : CalBridge.sysHandle(ev.sourceUid) ? '此日程来自系统日历，请在原日历确认提醒设置。' :
      !s.available ? '此设备暂不支持系统日历提醒，请在手机 App 中回写。' : s.error ? '提醒回写未完成：' + s.error :
      s.syncing ? '正在把日程写入系统日历…' : s.enabled && ReminderSync.current(code) ? '日程已写入系统日历；提醒由系统日历负责。' : '提醒尚待回写：请在设置中开启自动回写，或立即更新系统日历。';
  }
  $('#calendarAuto').onchange = async (e) => {
    if (!state.code) return;
    e.target.disabled = true;
    try { await ReminderSync.enable(state.code, e.target.checked); }
    catch (error) { toast(error.message); }
    renderReminders();
  };
  $('#calendarRetry').onclick = async () => {
    if (!state.code) return;
    $('#calendarRetry').disabled = true;
    try { await ReminderSync.sync(state.code); toast('已更新系统日历，请确认它的通知已开启'); }
    catch (error) { toast(error.message); }
    renderReminders();
  };
  $('#calendarPermission').onclick = () => CalBridge.openSettings();
  window.onReminderStatus = (code) => {
    if (code !== state.code) return;
    renderReminders();
    if (detailEvent && !$('#detailModal').hidden) renderReminderDetail(detailEvent, detailCode || code);
  };

  function candidateLabel(o) { return o.date + ' ' + o.start + '–' + o.end; }
  function updateDraftCount() { $('#pollDraftOpen').textContent = '用已选候选时间发起投票（' + candidates.length + '/8）'; }
  function addCandidateButton(box, date, slot) {
    if (candidateCode !== state.code) { candidates = []; candidateCode = state.code; }
    const duration = Number($('#freeMin').value) || 60;
    const end = Math.min(slot.sMin + duration, slot.eMin);
    const o = { date, start: slot.s, end: String(Math.floor(end / 60)).padStart(2,'0') + ':' + String(end % 60).padStart(2,'0') };
    if (o.end === '24:00') o.end = '23:59';
    const button = el('button','candidate-add','加入投票候选 · ' + o.start + '–' + o.end); button.type = 'button';
    const exists = () => candidates.some((v) => candidateLabel(v) === candidateLabel(o));
    if (exists()) button.textContent = '已加入候选';
    button.onclick = () => {
      if (exists()) return toast('这个时间已在候选里');
      if (candidates.length >= 8) return toast('最多选择 8 个候选时间');
      candidates.push(o); button.textContent = '已加入候选'; updateDraftCount();
    };
    box.appendChild(button); updateDraftCount();
  }
  function renderCandidates() {
    const box = $('#pollCandidates'); box.textContent = '';
    candidates.forEach((o, index) => {
      const row = el('div','poll-candidate');
      for (const key of ['date','start','end']) {
        const input = document.createElement('input'); input.type = key === 'date' ? 'date' : 'time'; input.value = o[key];
        input.setAttribute('aria-label', key === 'date' ? '候选日期' : key === 'start' ? '候选开始时间' : '候选结束时间');
        input.onchange = () => { o[key] = input.value; }; row.appendChild(input);
      }
      const remove = el('button','action-btn','移除'); remove.onclick = () => { candidates.splice(index,1); renderCandidates(); updateDraftCount(); };
      row.appendChild(remove); box.appendChild(row);
    });
  }
  function renderPolls() {
    const data = Store.get(pollCode), box = $('#pollList'); box.textContent = '';
    if (!data) return;
    const polls = Object.values(data.polls || {}).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!polls.length) box.appendChild(el('p','set-note','还没有时间投票。在“找共同空闲”里加入两个候选时间即可发起。'));
    polls.forEach((poll) => {
      const card = el('section','poll-card'); card.appendChild(el('h4','',poll.title));
      const votes = Store.pollVotes(data, poll), mine = (votes[Store.resolve(data,myId())] || {}).choices || [];
      card.appendChild(el('p','set-note',poll.resolution ? '已确定时间并生成日程' : '选择你能参加的时间，可多选。发起人最后确定一个时间。'));
      poll.options.forEach((option) => {
        const row = el('div','poll-option'); row.appendChild(el('span','',candidateLabel(option)));
        const people = Object.keys(votes).filter((key) => (votes[key].choices || []).includes(option.id) && data.members[Store.resolve(data,key)] && !data.members[Store.resolve(data,key)].out);
        const names = [...new Set(people.map((key) => memberName(pollCode,key) || '成员'))];
        row.appendChild(el('span','set-note',people.length + ' 人有空' + (names.length ? ' · ' + names.join('、') : '')));
        if (!poll.resolution) {
          const vote = el('button','action-btn' + (mine.includes(option.id) ? ' primary' : ''),mine.includes(option.id) ? '已选 · 取消' : '我有空');
          vote.onclick = () => { const next = mine.includes(option.id) ? mine.filter((id) => id !== option.id) : mine.concat(option.id); if (!Store.votePoll(pollCode,poll.id,next)) toast('投票已结束或你已退出空间'); renderPolls(); };
          row.appendChild(vote);
          if (Store.owns(poll.createdBy,data)) {
            const confirm = el('button','action-btn','定为日程');
            confirm.onclick = async () => {
              if (!await uiConfirm('确定时间','把“'+poll.title+'”定在 '+candidateLabel(option)+'？确定后生成一条日程。','确定')) return;
              const id = Store.confirmPoll(pollCode,poll.id,option.id);
              if (!id) return toast('这项投票已经结束');
              toast('已确定时间并生成日程'); renderPolls();
            };
            row.appendChild(confirm);
          }
        } else if (poll.resolution.optionId === option.id) row.appendChild(el('strong','', '已选定'));
        card.appendChild(row);
      });
      box.appendChild(card);
    });
  }
  function openPolls(draft) {
    if (!state.code || state.view === 'all') return toast('请先切回一个具体空间');
    if (draft && (candidateCode !== state.code || candidates.length < 2)) return toast('先在共同空闲结果里加入至少两个候选时间');
    pollCode = state.code; $('#pollDraft').hidden = !draft;
    if (draft) { $('#pollTitle').value = ''; renderCandidates(); }
    $('#freeModal').hidden = true; renderPolls(); $('#pollModal').hidden = false;
  }
  $('#pollsOpen').onclick = () => openPolls(false);
  $('#pollDraftOpen').onclick = () => openPolls(true);
  $('#pollCreate').onclick = () => {
    try { Store.createPoll(pollCode,$('#pollTitle').value,candidates); candidates=[]; updateDraftCount(); $('#pollDraft').hidden=true; renderPolls(); toast('已发起投票，稍后同步给成员'); }
    catch (error) { toast(error.message); }
  };
  $('#pollClose').onclick = () => { $('#pollModal').hidden = true; };
  Store.onChange((code) => {
    if (code === state.code && !$('#syncModal').hidden) renderSync();
    if (code === pollCode && !$('#pollModal').hidden) renderPolls();
  });
  window.FeaturesUI = { renderReminders, renderReminderDetail, addCandidateButton };
})();
