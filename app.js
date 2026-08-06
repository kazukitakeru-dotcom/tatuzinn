'use strict';
/* ============================================================================
   達人への道 — スマホ版
   データは端末内（localStorage）に保存し、ログインすれば Supabase 経由で
   PC版と合流する。core.js / supa.js / obsidian.js は PC版と同一ファイル。
   ========================================================================== */

const DATA_KEY = 'tatsujin_data';
const SET_KEY  = 'tatsujin_settings';

let data = null;
let settings = null;
let tickTimer = null;
let confirmDeleteField = null;
let editingField = null;
let syncing = false;

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

const me = () => settings.deviceId;
const curField = () => settings.currentField;
const iAmRunning = () => isRunningOn(data, me());

/* ── 保存 / 読み込み ─────────────────────────────────────────────────── */
function defaultSettings() {
  return {
    deviceId: 'mb-' + uid(),
    deviceName: 'スマホ',
    currentField: '',
    autoSync: true,
    auth: null,        // Supabase のログイン状態
    pending: [],       // まだ送れていないセッション
    pendingOps: [],    // まだ送れていない分野の改名・削除
  };
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch (e) {}
  settings = Object.assign(defaultSettings(), s);
  if (!settings.deviceId) settings.deviceId = 'mb-' + uid();
  if (!Array.isArray(settings.pending))    settings.pending = [];
  if (!Array.isArray(settings.pendingOps)) settings.pendingOps = [];
  saveSettings();
}
function saveSettings() {
  try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {}
}

/* Supabase（わんにゃんメモリーと同じプロジェクト） */
const supa = createSupa({
  load: () => (settings ? settings.auth : null),
  save: (s) => { if (settings) { settings.auth = s; saveSettings(); } },
});

function queueSession(field, s) {
  settings.pending.push({ id: s.id, field, start: s.start, end: s.end, hours: s.hours, dev: s.dev });
  saveSettings();
}
function queueOp(op) { settings.pendingOps.push(op); saveSettings(); }

/* サーバーにまだ無いセッションを、分野名を添えて集める。
   data.fields[名前].sessions は分野名を持たないので、ここで付け直す。 */
function missingSessions(d, remoteIds) {
  const have = new Set(remoteIds || []);
  const out = [];
  Object.entries((d && d.fields) || {}).forEach(([name, f]) => {
    (f.sessions || []).forEach(s => {
      if (!have.has(s.id)) out.push({ id: s.id, field: name, start: s.start, end: s.end, hours: s.hours, dev: s.dev });
    });
  });
  return out;
}

function loadData() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(DATA_KEY)); } catch (e) {}
  data = raw ? migrateData(raw, settings.deviceId) : createDefaultData();
  touchDevice(data, settings.deviceId, settings.deviceName);
}
function saveData() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) {}
}

/* ── トースト ────────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
function msg(id, text, ok) {
  const el = $(id);
  el.className = ok ? 'msg-ok' : 'msg-err';
  el.textContent = text;
  el.style.display = 'block';
}

/* ── 同期 ────────────────────────────────────────────────────────────── */
function syncEnabled() { return supa.signedIn(); }

function setSyncUI(state, text) {
  const btn = $('sync-btn'), line = $('sync-line');
  btn.className = state === 'syncing' ? 'busy' : state === 'error' ? 'err' : state === 'ok' ? 'ok' : '';
  line.className = state === 'error' ? 'err' : '';
  const n = settings.pending.length + settings.pendingOps.length;
  line.textContent = text + (n && state !== 'syncing' ? `（未送信 ${n}件）` : '');
}

async function doSync(push) {
  if (!syncEnabled()) { setSyncUI('off', '未ログイン（設定タブから）'); return { ok: false, error: 'ログインしてください' }; }
  if (syncing) return { ok: false, error: '同期中です' };
  syncing = true;
  setSyncUI('syncing', '同期中…');
  try {
    touchDevice(data, me(), settings.deviceName);

    if (push) {
      // 分野の改名・削除を先に反映してから記録を送る
      while (settings.pendingOps.length) {
        const op = settings.pendingOps[0];
        if (op.type === 'rename') await supa.renameFieldRows(op.from, op.to);
        else if (op.type === 'delete') await supa.deleteFieldRows(op.field);
        settings.pendingOps.shift();
        saveSettings();
      }
      // 送信漏れの拾い直し。
      // 送信待ちキューに入った分しか送っていなかったので、ログインする前に記録した
      // セッションが永久に上がらなかった。サーバーにあるIDと突き合わせて、
      // 足りないものを毎回送り直す。同じIDは上書きされるだけなので重複しない。
      await supa.uploadSessions(missingSessions(data, await supa.fetchSessionIds()));
      settings.pending = [];
      saveSettings();
      await supa.pushState(data);
      await supa.upsertLive(me(), settings.deviceName, (data.live || {})[me()]);
    }

    data = mergeData(data, await supa.pull());
    if (!data.fields[settings.currentField]) {
      settings.currentField = orderedFieldNames(data)[0] || '';
    }
    saveSettings();
    saveData();
    renderAll();
    renderSettingsInputs();
    setSyncUI('ok', '同期済み ' + formatDate(Date.now()));
    return { ok: true };
  } catch (e) {
    saveSettings();
    setSyncUI('error', String(e.message || e));
    return { ok: false, error: String(e.message || e) };
  } finally {
    syncing = false;
  }
}

let pushTimer = null;
function schedulePush() {
  if (!syncEnabled() || !settings.autoSync) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => doSync(true), 1500);
}

function startSyncLoops() {
  // 画面を見ている間は定期的に取りに行く
  setInterval(() => {
    if (document.visibilityState === 'visible' && syncEnabled() && settings.autoSync && !syncing) doSync(false);
  }, 60 * 1000);

  // 記録中は生存を知らせる（送るのは1行だけなので軽い）
  setInterval(async () => {
    if (!iAmRunning()) return;
    heartbeat(data, me());
    saveData();
    if (!syncEnabled() || !settings.autoSync || syncing) return;
    try { await supa.upsertLive(me(), settings.deviceName, data.live[me()]); }
    catch (e) { setSyncUI('error', String(e.message || e)); }
  }, 45 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && syncEnabled() && settings.autoSync) doSync(false);
  });
}

/* ── 描画 ────────────────────────────────────────────────────────────── */
function devChip(devId) {
  return `<span class="chip-d ${devId === me() ? 'me' : 'other'}">${esc(deviceName(data, devId))}</span>`;
}
/* 端末別の内訳。
   合計は呼び出し側がすでに出しているので、ここは内訳だけを畳んで持つ。
   端末を2台以上使うと、チップが横に並んで時間が読み取りづらくなっていた。
   1台しか記録が無いときは畳む意味がないのでそのまま出す。 */
function devFoldHTML(byDev) {
  const ids = Object.keys(byDev).sort((a, b) => byDev[b] - byDev[a]);
  if (!ids.length) return '<div class="devfold-none">記録なし</div>';
  if (ids.length === 1) {
    return `<div class="devfold-flat">${devChip(ids[0])} <b>${formatHours(byDev[ids[0]])}</b></div>`;
  }
  const total = ids.reduce((t, id) => t + byDev[id], 0);
  return `<details class="devfold">
    <summary>端末別の内訳（${ids.length}台）</summary>
    <div class="devfold-body">${ids.map(id => {
      const pct = total > 0 ? Math.round((byDev[id] / total) * 100) : 0;
      return `<div class="devfold-row">${devChip(id)}<b>${formatHours(byDev[id])}</b><span class="devfold-pct">${pct}%</span></div>`;
    }).join('')}</div>
  </details>`;
}

function renderAll() {
  if (!data || !settings) return;
  renderChips('field-chips');
  renderChips('hist-chips');
  renderLevel();
  renderTimer();
  renderLive();
  renderSummary();
  renderHistory();
  renderFieldsList();
  renderStats();
  renderDeviceList();
}

function renderChips(containerId) {
  const c = $(containerId);
  c.innerHTML = '';
  const running = {};
  Object.values(data.live || {}).forEach(l => { if (l.active) running[l.field] = true; });
  orderedFieldNames(data).forEach(name => {
    const b = document.createElement('button');
    b.className = 'chip-f' + (name === curField() ? ' on' : '') + (iAmRunning() && name !== curField() ? ' locked' : '');
    b.innerHTML = (running[name] ? '<span class="dot">●</span>' : '') + esc(name);
    b.addEventListener('click', () => switchField(name));
    c.appendChild(b);
  });
}

function renderLevel() {
  const name = curField();
  if (!data.fields[name]) return;
  const h = fieldLiveHours(data, name);
  const li = getLevelInfo(h);
  $('m-level').textContent     = li.level;
  $('m-title').textContent     = getTitle(li.level);
  $('m-field-sub').textContent = `${name} — Lv.${li.level} / 100`;
  $('m-xp').style.width        = `${li.progress * 100}%`;
  $('m-total').textContent     = `累計 ${formatHours(h)}`;
  $('m-pct').textContent       = `${(li.progress * 100).toFixed(1)}%`;
  $('m-next').textContent      = `次Lv ${formatHours(li.hoursToNext)}`;
  $('m-devline').innerHTML     = devFoldHTML(fieldLiveByDevice(data, name));
}

function renderTimer() {
  const el = $('m-timer-area');
  if (iAmRunning()) {
    const sec = Math.max(0, Math.floor((Date.now() - data.live[me()].startedAt) / 1000));
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:6px;">
        <span class="pulse-dot"></span><span class="elapsed">${formatDuration(sec)}</span>
      </div>
      <div style="font-size:10px;color:var(--dim);margin-bottom:16px;letter-spacing:2px;">
        ＋${(sec/3600).toFixed(5)} h — ${esc(curField())}
      </div>
      <button class="btn-big btn-stop" id="btn-toggle">■ STOP</button>`;
  } else {
    el.innerHTML = `
      <div style="font-size:11px;color:var(--dim);margin-bottom:18px;letter-spacing:2px;">作業を開始してください</div>
      <button class="btn-big btn-start" id="btn-toggle">▶ START</button>`;
  }
  $('btn-toggle').addEventListener('click', () => { iAmRunning() ? handleStop() : handleStart(); });
}

function renderLive() {
  const entries = liveEntries(data).filter(e => e.dev !== me());
  const panel = $('live-panel');
  if (!entries.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  $('m-live').innerHTML = entries.map(e => `
    <div class="live-box">
      <div class="top">
        <div>
          <span class="pulse-dot blue" style="${e.stale ? 'animation:none;opacity:.3;' : ''}"></span>
          <span style="color:var(--blue);margin-left:6px;">${esc(e.name)}</span>
          <span style="color:var(--dim);"> が </span>
          <span style="color:var(--text);">${esc(e.field)}</span>
        </div>
        <span class="t">${formatDuration(e.seconds)}</span>
      </div>
      <div class="sub">開始 ${formatDate(e.startedAt)}${e.stale ? ' — <span style="color:var(--red)">しばらく応答がありません</span>' : ''}</div>
    </div>`).join('');
}

function renderSummary() {
  $('m-summary').innerHTML = orderedFieldNames(data).map(name => {
    const h = fieldLiveHours(data, name);
    const li = getLevelInfo(h);
    return `
      <div style="margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px;gap:8px;">
          <span style="font-family:'Cinzel',serif;color:${name === curField() ? 'var(--goldb)' : 'var(--text)'};">${esc(name)}</span>
          <span style="color:var(--dim);font-size:10px;">Lv.${li.level} ${getTitle(li.level)} — ${formatHours(h)}</span>
        </div>
        <div class="xp-track"><div class="xp-fill" style="width:${li.progress*100}%"></div></div>
        ${devFoldHTML(fieldLiveByDevice(data, name))}
      </div>`;
  }).join('');
}

function renderHistory() {
  const name = curField();
  const f = data.fields[name];
  if (!f) return;
  const sessions = [...f.sessions].sort((a, b) => b.start - a.start);
  $('hist-title').textContent = `${name} — ${sessions.length}件`;
  $('hist-devline').innerHTML = devFoldHTML(fieldByDevice(f));
  $('hist-list').innerHTML = sessions.length
    ? sessions.map(s => `
        <div class="srow">
          <div class="srow-top">
            <span>${formatDate(s.start)} ${devChip(s.dev)}</span>
            <span style="color:var(--gold);">${formatDuration(Math.round(s.hours * 3600))}</span>
          </div>
        </div>`).join('')
    : '<div style="color:var(--dim);text-align:center;padding:20px 0;">履歴なし</div>';
}

function renderFieldsList() {
  const c = $('fields-list');
  c.innerHTML = '';
  const names = orderedFieldNames(data);
  const gTotal = grandTotal(data);   // 「全体の何%か」を出すため
  names.forEach(name => {
    const f = data.fields[name];
    const h = fieldTotal(f);
    const li = getLevelInfo(h);
    const share = gTotal > 0 ? Math.round((h / gTotal) * 100) : 0;
    const isCur  = name === curField();
    const isConf = confirmDeleteField === name;
    const isEdit = editingField === name;
    const running = Object.values(data.live || {}).some(l => l.active && l.field === name);

    let actions = '';
    if (!iAmRunning() && !isCur) actions += `<button class="btn btn-sm" data-a="select">選択</button>`;
    actions += `<button class="btn btn-sm" data-a="edit">名前</button>`;
    if (!isCur && !running && names.length > 1) actions += `<button class="btn btn-red" data-a="delete">削除</button>`;

    let extra = '';
    if (isEdit) {
      extra = `<div class="edit-row">
        <input class="inp" id="edit-inp" value="${esc(name)}" placeholder="新しい名前">
        <button class="btn btn-sm" data-a="save-edit">保存</button>
        <button class="btn btn-sm" data-a="cancel-edit">✕</button></div>`;
    }
    if (isConf) {
      extra = `<div class="confirm-zone">
        <span>削除するとこの分野の記録は消えます。</span>
        <button class="btn btn-red" data-a="confirm-delete">はい</button>
        <button class="btn btn-sm" data-a="cancel-delete">やめる</button></div>`;
    }

    const card = document.createElement('div');
    card.className = `fcard${isCur ? ' sel' : ''}`;
    card.innerHTML = `
      <div class="fcard-top">
        <span class="fcard-name ${isCur ? 'cur' : ''}">${esc(name)}${isCur ? ' <span style="font-size:9px;color:var(--goldd);">◆</span>' : ''}${running ? ' <span style="font-size:9px;color:var(--green);">●</span>' : ''}</span>
        <div class="fcard-actions">${actions}</div>
      </div>
      <div class="fcard-meta">Lv.${li.level} — ${esc(getTitle(li.level))} — ${formatHours(h)} — ${fieldSessionCount(f)}回 — 全体の${share}%</div>
      <div class="xp-track"><div class="xp-fill" style="width:${li.progress*100}%"></div></div>
      ${devFoldHTML(fieldByDevice(f))}
      ${extra}`;

    card.querySelectorAll('[data-a]').forEach(btn => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.a;
        if (a === 'select')             switchField(name);
        else if (a === 'edit')          { editingField = name; confirmDeleteField = null; renderFieldsList(); }
        else if (a === 'delete')        { confirmDeleteField = name; editingField = null; renderFieldsList(); }
        else if (a === 'cancel-delete') { confirmDeleteField = null; renderFieldsList(); }
        else if (a === 'cancel-edit')   { editingField = null; renderFieldsList(); }
        else if (a === 'confirm-delete') doDeleteField(name);
        else if (a === 'save-edit')     { const i = $('edit-inp'); if (i) doRenameField(name, i.value.trim()); }
      });
    });
    c.appendChild(card);
  });
}

function renderStats() {
  const total = grandTotal(data);
  $('data-stats').innerHTML =
    orderedFieldNames(data).map(name => {
      const h = fieldTotal(data.fields[name]);
      return `<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-bottom:5px;gap:8px;">
        <span style="font-family:'Cinzel',serif;color:var(--text);">${esc(name)}</span>
        <span>${formatHours(h)} / Lv.${getLevel(h)}</span></div>`;
    }).join('') +
    `<hr class="divider">
     ${devFoldHTML(totalByDevice(data))}
     <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--gold);margin-top:9px;">
       <span>総計</span><span>${formatHours(total)}</span></div>`;
}

function renderDeviceList() {
  const ids = activeDeviceIds(data);
  const totals = totalByDevice(data);
  $('device-list').innerHTML = ids.length
    ? ids.map(id => {
        const d = (data.devices || {})[id] || {};
        return `<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:8px;gap:8px;">
          <span>${devChip(id)} ${id === me() ? '<span style="font-size:9px;color:var(--goldd)">この端末</span>' : ''}</span>
          <span style="color:var(--dim);text-align:right;">${formatHours(totals[id] || 0)}${d.lastSeen ? '<br>最終 ' + formatDate(d.lastSeen) : ''}</span>
        </div>`;
      }).join('')
    : '<div class="note">まだ記録がありません。</div>';
}

/* ── 操作 ────────────────────────────────────────────────────────────── */
function handleStart() {
  if (iAmRunning()) return;
  startSession(data, me(), curField());
  touchDevice(data, me(), settings.deviceName);
  saveData(); renderAll(); schedulePush();
}

function handleStop() {
  if (!iAmRunning()) return;
  const field = data.live[me()].field;
  const s = stopSession(data, me());
  if (s) queueSession(field, s);
  saveData(); renderAll(); schedulePush();
  if (s) toast(`${formatDuration(Math.round(s.hours * 3600))} 記録しました`);
}

function switchField(name) {
  if (iAmRunning() || name === curField() || !data.fields[name]) return;
  settings.currentField = name;
  saveSettings();
  confirmDeleteField = null; editingField = null;
  renderAll();
}

function doDeleteField(name) {
  const r = deleteFieldFrom(data, name);
  confirmDeleteField = null;
  if (!r.ok) { toast(r.error); renderFieldsList(); return; }
  queueOp({ type: 'delete', field: name });
  settings.pending = settings.pending.filter(s => s.field !== name);
  if (curField() === name) { settings.currentField = orderedFieldNames(data)[0] || ''; }
  saveSettings();
  saveData(); renderAll(); schedulePush();
}

function doRenameField(oldName, newName) {
  const r = renameFieldIn(data, oldName, newName);
  if (!r.ok) { toast(r.error); return; }
  editingField = null;
  queueOp({ type: 'rename', from: oldName, to: newName });
  settings.pending.forEach(s => { if (s.field === oldName) s.field = newName; });
  if (curField() === oldName) { settings.currentField = newName; }
  saveSettings();
  saveData(); renderAll(); schedulePush();
}

$('btn-add-field').addEventListener('click', () => {
  const inp = $('new-field-inp');
  const r = addFieldTo(data, inp.value);
  if (!r.ok) { msg('add-field-msg', r.error, false); return; }
  $('add-field-msg').style.display = 'none';
  inp.value = '';
  saveData(); renderAll(); schedulePush();
  toast('追加しました');
});

/* ── Obsidian 書き出し ───────────────────────────────────────────────── */
function notesNow() {
  return buildObsidianNotes(data, { deviceLabel: settings.deviceName });
}
function stamp() { return isoDate(new Date()); }

$('btn-obs-zip').addEventListener('click', async () => {
  const enc = new TextEncoder();
  const files = notesNow().map(n => ({ name: `${OBS_FOLDER}/${n.path}`, data: enc.encode(n.text) }));
  const r = await shareOrDownload(buildZip(files), `達人への道_obsidian_${stamp()}.zip`);
  if (r !== 'cancelled') msg('obs-msg', `${files.length}件のノートを書き出しました`, true);
});

$('btn-obs-single').addEventListener('click', async () => {
  const notes = notesNow();
  const parts = [notes[0].text];
  notes.slice(1).forEach(n => {
    parts.push('\n---\n');
    parts.push(n.text.replace(/^---[\s\S]*?\n---\n/, ''));   // frontmatter は先頭だけ有効
  });
  const blob = new Blob([parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const r = await shareOrDownload(blob, `達人への道_${stamp()}.md`);
  if (r !== 'cancelled') msg('obs-msg', '1ファイルにまとめて書き出しました', true);
});

$('btn-obs-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(notesNow()[0].text);
    msg('obs-msg', 'サマリーをコピーしました。Obsidianで貼り付けてください。', true);
  } catch (e) {
    msg('obs-msg', 'コピーできませんでした: ' + (e.message || e), false);
  }
});

/* ── JSON ────────────────────────────────────────────────────────────── */
$('btn-json-export').addEventListener('click', async () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  await shareOrDownload(blob, `tatsujin_${stamp()}.json`);
});

$('btn-json-import').addEventListener('click', () => $('json-file').click());
$('json-file').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported.fields) throw new Error('無効なフォーマットです');
    const before = grandTotal(data);
    const had = new Set();
    Object.values(data.fields).forEach(f => f.sessions.forEach(s => had.add(s.id)));
    data = mergeData(data, migrateData(imported, 'imported'));
    // 増えた分は未送信として積んでおく
    Object.entries(data.fields).forEach(([name, f]) =>
      f.sessions.forEach(s => { if (!had.has(s.id)) queueSession(name, s); }));
    saveData(); renderAll(); schedulePush();
    msg('json-msg', `合流しました（${formatHours(before)} → ${formatHours(grandTotal(data))}）`, true);
  } catch (err) {
    msg('json-msg', String(err.message || err), false);
  }
  e.target.value = '';
});

/* ── 設定 ────────────────────────────────────────────────────────────── */
function renderSettingsInputs() {
  $('device-name').value = settings.deviceName || '';
  $('device-id').textContent = settings.deviceId;
  $('auto-sync').checked = settings.autoSync !== false;
  const user = supa.currentUser();
  $('auth-out').style.display = supa.signedIn() ? 'none' : '';
  $('auth-in').style.display  = supa.signedIn() ? '' : 'none';
  $('auth-who').textContent   = user ? user.email : '';
  $('pending-count').textContent = settings.pending.length + settings.pendingOps.length;
}

$('btn-save-device').addEventListener('click', () => {
  settings.deviceName = $('device-name').value.trim() || 'スマホ';
  saveSettings();
  touchDevice(data, me(), settings.deviceName);
  saveData(); renderAll(); schedulePush();
  toast('保存しました');
});

$('auto-sync').addEventListener('change', () => { settings.autoSync = $('auto-sync').checked; saveSettings(); });

function authInputs() {
  return { email: $('auth-email').value.trim(), password: $('auth-pass').value };
}

$('btn-signin').addEventListener('click', async () => {
  const { email, password } = authInputs();
  if (!email || !password) { msg('sync-msg', 'メールアドレスとパスワードを入力してください', false); return; }
  msg('sync-msg', 'ログイン中…', true);
  try {
    const user = await supa.signIn(email, password);
    $('auth-pass').value = '';
    renderSettingsInputs();
    msg('sync-msg', `ログインしました（${user.email}）`, true);
    await doSync(true);
  } catch (e) {
    $('auth-pass').value = '';
    msg('sync-msg', String(e.message || e), false);
  }
});

$('btn-signup').addEventListener('click', async () => {
  const { email, password } = authInputs();
  if (!email || !password) { msg('sync-msg', 'メールアドレスとパスワードを入力してください', false); return; }
  msg('sync-msg', '登録中…', true);
  try {
    const r = await supa.signUp(email, password);
    $('auth-pass').value = '';
    renderSettingsInputs();
    if (r.confirmed) { msg('sync-msg', '登録してログインしました', true); await doSync(true); }
    else msg('sync-msg', '確認メールを送りました。メール内のリンクを開いてから、もう一度ログインしてください', true);
  } catch (e) {
    $('auth-pass').value = '';
    msg('sync-msg', String(e.message || e), false);
  }
});

$('btn-signout').addEventListener('click', () => {
  supa.signOut();
  renderSettingsInputs();
  setSyncUI('off', '未ログイン（設定タブから）');
  msg('sync-msg', 'ログアウトしました（この端末の記録は消えません）', true);
});

$('btn-sync-now').addEventListener('click', async () => {
  msg('sync-msg', '同期中…', true);
  const r = await doSync(true);
  msg('sync-msg', r.ok ? '同期しました' : r.error, r.ok);
});

$('sync-btn').addEventListener('click', () => doSync(true));

/* ── タブ ────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const s = btn.dataset.screen;
    document.querySelectorAll('.screen').forEach(el => el.classList.toggle('active', el.id === 'screen-' + s));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    if (s === 'fields') { confirmDeleteField = null; editingField = null; }
    renderAll();
    document.querySelector('main').scrollTop = 0;
  });
});

/* ── 起動 ────────────────────────────────────────────────────────────── */
function init() {
  loadSettings();
  loadData();
  if (!data.fields[settings.currentField]) {
    settings.currentField = orderedFieldNames(data)[0] || '';
    saveSettings();
  }
  saveData();
  renderSettingsInputs();
  renderAll();
  setSyncUI(syncEnabled() ? 'idle' : 'off', syncEnabled() ? '同期の準備ができています' : '未ログイン（設定タブから）');

  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (Object.values(data.live || {}).some(l => l.active)) { renderLevel(); renderTimer(); renderLive(); }
  }, 1000);

  startSyncLoops();
  if (syncEnabled()) doSync(true);
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
