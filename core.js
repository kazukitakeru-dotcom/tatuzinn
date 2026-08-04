'use strict';
/* ============================================================================
   達人への道 — 共有コア
   Electron版（達人への道/core.js）とスマホ版（tatsujin/core.js）は同一内容。
   片方を直したらもう片方にもコピーすること。
   ブラウザではグローバル関数として、Node（main.js）では require で使う。
   ========================================================================== */

const TATSUJIN_SCHEMA = 2;
const DEFAULT_FIELDS  = ['絵', 'ストーリー', 'ゲーム制作', 'モデリング'];
const LIVE_STALE_MS   = 5 * 60 * 1000;   // これ以上更新がない「記録中」は反応なしとみなす

/* ── レベル曲線: 10,000h = Lv100、尻上がり ───────────────────────────────── */
function hoursForLevel(n) {
  if (n <= 0) return 0;
  if (n >= 100) return 10000;
  return 10000 * Math.pow(n / 100, 2.5);
}

function getLevel(totalHours) {
  let lo = 0, hi = 100;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (hoursForLevel(mid) <= totalHours) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, 100);
}

function getLevelInfo(totalHours) {
  const level = getLevel(totalHours);
  if (level >= 100) return { level: 100, progress: 1, hoursToNext: 0 };
  const cur  = hoursForLevel(level);
  const next = hoursForLevel(level + 1);
  return {
    level,
    progress:    Math.max(0, (totalHours - cur) / (next - cur)),
    hoursToNext: Math.max(0, next - totalHours),
  };
}

function getTitle(level) {
  if (level <= 10) return '初心者';
  if (level <= 30) return '練習生';
  if (level <= 55) return '中級者';
  if (level <= 75) return '上級者';
  if (level <= 95) return '特級者';
  return '達人';
}

/* ── 整形 ────────────────────────────────────────────────────────────────── */
function pad2(n) { return String(n).padStart(2, '0'); }

function formatHours(h) {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${hh}h ${pad2(mm)}m`;
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isoDateTs(ts) { return ts ? isoDate(new Date(ts)) : ''; }
function monthKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ── データ生成・移行 ─────────────────────────────────────────────────────
   データ構造（v2）
   {
     schema: 2,
     devices: { <devId>: { name, lastSeen } },
     fields: {
       <分野名>: {
         created, order,
         legacy:   { <devId>: hours },      // v1 から引き継いだ端末不明分
         sessions: [ { id, start, end, hours, dev } ]
       }
     },
     deletedFields: { <分野名>: 削除時刻 },   // 端末間マージ用の墓標
     renames: { <旧分野名>: { to, at } },     // 改名の履歴（保存済みの記録を追跡するため）
     live:  { <devId>: { field, startedAt, updatedAt, active } },  // 記録中の端末
     updatedAt
   }
   live は停止しても消さず active:false にする。消してしまうと、相手が後から
   書いた「まだ記録中」に上書きされて幽霊セッションが復活してしまうため。
   ──────────────────────────────────────────────────────────────────────── */

function createDefaultData() {
  const fields = {};
  // created:0 = 「アプリが勝手に作った分野」の印。
  // 端末をまたいだとき、これを本人が作った分野と同格に扱うと、
  // 片方で改名・削除したものがもう片方の初期分野で復活してしまう。
  DEFAULT_FIELDS.forEach((n, i) => {
    fields[n] = { created: 0, order: i, legacy: {}, sessions: [] };
  });
  return {
    schema: TATSUJIN_SCHEMA,
    devices: {},
    fields,
    deletedFields: {},
    renames: {},
    live: {},
    updatedAt: Date.now(),
  };
}

function normalizeField(f, order) {
  const out = {
    created: Number.isFinite(Number(f && f.created)) ? Number(f.created) : Date.now(),
    order:   Number.isFinite(f && f.order) ? f.order : order,
    legacy:  {},
    sessions: [],
  };
  Object.entries((f && f.legacy) || {}).forEach(([dev, h]) => {
    const v = Number(h);
    if (v > 0) out.legacy[dev] = v;
  });
  const seen = new Set();
  ((f && f.sessions) || []).forEach(s => {
    if (!s || !s.id || seen.has(s.id)) return;
    const hours = Number(s.hours);
    if (!Number.isFinite(hours) || hours <= 0) return;
    seen.add(s.id);
    out.sessions.push({
      id: String(s.id),
      start: Number(s.start) || 0,
      end:   Number(s.end) || 0,
      hours,
      dev:   String(s.dev || '?'),
    });
  });
  out.sessions.sort((a, b) => b.start - a.start);
  return out;
}

function normalizeData(d) {
  if (!d || typeof d !== 'object') return createDefaultData();
  const out = {
    schema: TATSUJIN_SCHEMA,
    devices: {},
    fields: {},
    deletedFields: {},
    renames: {},
    live: {},
    updatedAt: Number(d.updatedAt) || Date.now(),
  };
  Object.entries(d.renames || {}).forEach(([from, r]) => {
    if (r && r.to) out.renames[from] = { to: String(r.to), at: Number(r.at) || 0 };
  });
  Object.entries(d.devices || {}).forEach(([id, dev]) => {
    out.devices[id] = { name: String((dev && dev.name) || id), lastSeen: Number(dev && dev.lastSeen) || 0 };
  });
  let i = 0;
  Object.entries(d.fields || {}).forEach(([name, f]) => { out.fields[name] = normalizeField(f, i++); });
  Object.entries(d.deletedFields || {}).forEach(([name, ts]) => {
    const v = Number(ts);
    if (v > 0) out.deletedFields[name] = v;
  });
  Object.entries(d.live || {}).forEach(([id, l]) => {
    if (!l || !l.field || !l.startedAt) return;
    out.live[id] = {
      field: String(l.field),
      startedAt: Number(l.startedAt),
      updatedAt: Number(l.updatedAt) || Number(l.startedAt),
      active: l.active !== false,
    };
  });
  return out;
}

/* v1（totalHours + sessionHistory）→ v2。既存時間は移行した端末の記録として扱う */
function migrateData(raw, deviceId) {
  if (!raw || typeof raw !== 'object') return createDefaultData();
  if (Number(raw.schema) >= 2) return normalizeData(raw);

  const out = createDefaultData();
  out.fields = {};
  let order = 0;
  Object.entries(raw.fields || {}).forEach(([name, fd]) => {
    const sessions = ((fd && fd.sessionHistory) || [])
      .filter(s => s && Number(s.durationHours) > 0)
      .map(s => ({
        id: 'v1-' + s.start,           // 決め打ちIDなので両端末で移行しても重複しない
        start: Number(s.start) || 0,
        end:   Number(s.end) || 0,
        hours: Number(s.durationHours),
        dev:   deviceId,
      }));
    const sum = sessions.reduce((t, s) => t + s.hours, 0);
    const rest = Math.max(0, (Number(fd && fd.totalHours) || 0) - sum);  // 500件上限で落ちた分
    out.fields[name] = {
      created:  sessions.length ? Math.min(...sessions.map(s => s.start)) : 0,
      order:    order++,
      legacy:   rest > 0.0001 ? { [deviceId]: rest } : {},
      sessions,
    };
  });
  if (!Object.keys(out.fields).length) out.fields = createDefaultData().fields;

  if (raw.isRunning && raw.startTimestamp && raw.currentField && out.fields[raw.currentField]) {
    out.live[deviceId] = {
      field: raw.currentField,
      startedAt: Number(raw.startTimestamp),
      updatedAt: Date.now(),
      active: true,
    };
  }
  out.updatedAt = Date.now();
  return out;
}

/* ── 集計 ────────────────────────────────────────────────────────────────── */
function fieldByDevice(field) {
  const out = {};
  if (!field) return out;
  Object.entries(field.legacy || {}).forEach(([dev, h]) => { out[dev] = (out[dev] || 0) + h; });
  (field.sessions || []).forEach(s => { out[s.dev] = (out[s.dev] || 0) + s.hours; });
  return out;
}

function fieldTotal(field) {
  return Object.values(fieldByDevice(field)).reduce((a, b) => a + b, 0);
}

function fieldSessionCount(field) { return ((field && field.sessions) || []).length; }

function totalByDevice(data) {
  const out = {};
  Object.values(data.fields || {}).forEach(f => {
    Object.entries(fieldByDevice(f)).forEach(([dev, h]) => { out[dev] = (out[dev] || 0) + h; });
  });
  return out;
}

function grandTotal(data) {
  return Object.values(totalByDevice(data)).reduce((a, b) => a + b, 0);
}

/* 実際に記録が存在する端末IDを、合計時間の多い順で返す */
function activeDeviceIds(data) {
  const totals = totalByDevice(data);
  const ids = new Set(Object.keys(totals));
  Object.entries(data.live || {}).forEach(([id, l]) => { if (l.active) ids.add(id); });
  return [...ids].sort((a, b) => (totals[b] || 0) - (totals[a] || 0));
}

function deviceName(data, id) {
  const d = (data.devices || {})[id];
  return (d && d.name) || (id === '?' ? '不明' : id.slice(0, 6));
}

function orderedFieldNames(data) {
  return Object.keys(data.fields || {}).sort((a, b) => {
    const fa = data.fields[a], fb = data.fields[b];
    return (fa.order - fb.order) || (fa.created - fb.created) || a.localeCompare(b, 'ja');
  });
}

/* 保存済みの記録に付いている分野名を、改名をたどって現在の名前に直す。
   たどった先が存在しなければ null（＝削除された分野の記録） */
function resolveFieldName(data, name) {
  let cur = name;
  for (let i = 0; i < 20; i++) {
    if (data.fields[cur]) return cur;
    const r = (data.renames || {})[cur];
    if (!r) return null;
    cur = r.to;
  }
  return null;
}

/* 記録中の端末一覧（自分も含む） */
function liveEntries(data, now) {
  now = now || Date.now();
  return Object.entries(data.live || {}).filter(([, l]) => l.active).map(([dev, l]) => ({
    dev,
    name: deviceName(data, dev),
    field: l.field,
    startedAt: l.startedAt,
    updatedAt: l.updatedAt,
    seconds: Math.max(0, Math.floor((now - l.startedAt) / 1000)),
    stale: (now - (l.updatedAt || l.startedAt)) > LIVE_STALE_MS,
  })).sort((a, b) => a.startedAt - b.startedAt);
}

/* 表示用: 分野の「今の時間」＝確定分 + 記録中セッションの経過分 */
function fieldLiveHours(data, name, now) {
  now = now || Date.now();
  let h = fieldTotal(data.fields[name]);
  Object.values(data.live || {}).forEach(l => {
    if (l.active && l.field === name && (now - (l.updatedAt || l.startedAt)) <= LIVE_STALE_MS) {
      h += Math.max(0, now - l.startedAt) / 3_600_000;
    }
  });
  return h;
}

function fieldLiveByDevice(data, name, now) {
  now = now || Date.now();
  const out = fieldByDevice(data.fields[name]);
  Object.entries(data.live || {}).forEach(([dev, l]) => {
    if (l.active && l.field === name && (now - (l.updatedAt || l.startedAt)) <= LIVE_STALE_MS) {
      out[dev] = (out[dev] || 0) + Math.max(0, now - l.startedAt) / 3_600_000;
    }
  });
  return out;
}

/* ── 変更操作（いずれも data を書き換えて data を返す） ────────────────── */
function touchDevice(data, deviceId, name) {
  if (!data.devices) data.devices = {};
  const cur = data.devices[deviceId] || {};
  data.devices[deviceId] = { name: name || cur.name || deviceId, lastSeen: Date.now() };
  data.updatedAt = Date.now();
  return data;
}

function startSession(data, deviceId, fieldName) {
  if (!data.fields[fieldName]) return data;
  data.live[deviceId] = { field: fieldName, startedAt: Date.now(), updatedAt: Date.now(), active: true };
  data.updatedAt = Date.now();
  return data;
}

function isRunningOn(data, deviceId) {
  const l = (data.live || {})[deviceId];
  return !!(l && l.active);
}

function heartbeat(data, deviceId) {
  const l = data.live[deviceId];
  if (l && l.active) { l.updatedAt = Date.now(); data.updatedAt = Date.now(); }
  return data;
}

/* 記録を確定。戻り値は追加されたセッション（記録中でなければ null） */
function stopSession(data, deviceId) {
  const l = data.live[deviceId];
  if (!l || !l.active) return null;
  const now = Date.now();
  const hours = Math.max(0, now - l.startedAt) / 3_600_000;
  // 消さずに停止印を付ける（消すとマージで「まだ記録中」に巻き戻される）
  data.live[deviceId] = { field: l.field, startedAt: l.startedAt, updatedAt: now, active: false };
  data.updatedAt = now;
  const f = data.fields[l.field];
  if (!f || hours <= 0) return null;
  const session = { id: uid(), start: l.startedAt, end: now, hours, dev: deviceId };
  f.sessions.unshift(session);
  return session;
}

function addFieldTo(data, name) {
  name = String(name || '').trim();
  if (!name) return { ok: false, error: '名前を入力してください' };
  if (data.fields[name]) return { ok: false, error: 'その名前はすでに存在します' };
  const orders = Object.values(data.fields).map(f => f.order);
  data.fields[name] = {
    created: Date.now(),
    order: orders.length ? Math.max(...orders) + 1 : 0,
    legacy: {},
    sessions: [],
  };
  delete data.deletedFields[name];
  data.updatedAt = Date.now();
  return { ok: true };
}

function deleteFieldFrom(data, name) {
  if (!data.fields[name]) return { ok: false, error: '分野が見つかりません' };
  if (Object.keys(data.fields).length <= 1) return { ok: false, error: '分野は1つ以上必要です' };
  if (Object.values(data.live || {}).some(l => l.active && l.field === name)) {
    return { ok: false, error: 'この分野は記録中です' };
  }
  delete data.fields[name];
  data.deletedFields[name] = Date.now();
  data.updatedAt = Date.now();
  return { ok: true };
}

function renameFieldIn(data, oldName, newName) {
  newName = String(newName || '').trim();
  if (!data.fields[oldName]) return { ok: false, error: '分野が見つかりません' };
  if (!newName) return { ok: false, error: '名前を入力してください' };
  if (newName === oldName) return { ok: true };
  if (data.fields[newName]) return { ok: false, error: 'その名前はすでに存在します' };

  data.fields[newName] = data.fields[oldName];
  delete data.fields[oldName];
  data.deletedFields[oldName] = Date.now();
  delete data.deletedFields[newName];
  // 保存済みの記録は旧名で残っているので、たどれるように印を残す
  if (!data.renames) data.renames = {};
  data.renames[oldName] = { to: newName, at: Date.now() };
  delete data.renames[newName];
  Object.values(data.live || {}).forEach(l => { if (l.field === oldName) l.field = newName; });
  data.updatedAt = Date.now();
  return { ok: true };
}

/* ── マージ（端末間同期の要） ────────────────────────────────────────────
   セッションはIDで和集合を取る = 追加しか起きないので衝突しない。
   分野の削除・改名は墓標（deletedFields）で伝える。
   墓標より後のセッションがある分野は「消された後にまた使われた」とみなし復活させる。
   ────────────────────────────────────────────────────────────────────── */
function mergeData(a, b) {
  a = normalizeData(a);
  b = normalizeData(b);

  const out = {
    schema: TATSUJIN_SCHEMA,
    devices: {},
    fields: {},
    deletedFields: {},
    renames: {},
    live: {},
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };

  // 改名の履歴: 同じ旧名なら新しい方を採用
  [a, b].forEach(src => {
    Object.entries(src.renames || {}).forEach(([from, r]) => {
      const cur = out.renames[from];
      if (!cur || r.at > cur.at) out.renames[from] = { to: r.to, at: r.at };
    });
  });

  // 端末一覧: lastSeen が新しい方の名前を採用
  [a, b].forEach(src => {
    Object.entries(src.devices).forEach(([id, dev]) => {
      const cur = out.devices[id];
      if (!cur || dev.lastSeen > cur.lastSeen) out.devices[id] = { ...dev };
    });
  });

  // 墓標: 新しい方の時刻
  [a, b].forEach(src => {
    Object.entries(src.deletedFields).forEach(([name, ts]) => {
      out.deletedFields[name] = Math.max(out.deletedFields[name] || 0, ts);
    });
  });

  // 分野
  const names = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  names.forEach(name => {
    const fa = a.fields[name], fb = b.fields[name];
    const created = Math.min(fa ? fa.created : Infinity, fb ? fb.created : Infinity);
    const order   = Math.min(
      fa && Number.isFinite(fa.order) ? fa.order : Infinity,
      fb && Number.isFinite(fb.order) ? fb.order : Infinity
    );
    const legacy = {};
    [fa, fb].forEach(f => {
      if (!f) return;
      Object.entries(f.legacy).forEach(([dev, h]) => { legacy[dev] = Math.max(legacy[dev] || 0, h); });
    });
    const byId = new Map();
    [fa, fb].forEach(f => { if (f) f.sessions.forEach(s => byId.set(s.id, s)); });
    const sessions = [...byId.values()].sort((x, y) => y.start - x.start);

    // 墓標より後に「本人が作り直した」か「記録が付いた」場合だけ復活させる。
    // アプリが勝手に作った初期分野（created:0）では復活しない。
    const tomb = out.deletedFields[name] || 0;
    if (tomb) {
      const createdByUser = Math.max(fa ? fa.created : 0, fb ? fb.created : 0);
      const newest = Math.max(createdByUser, ...sessions.map(s => s.end || s.start), 0);
      if (newest <= tomb) return;              // 削除されたまま
      delete out.deletedFields[name];          // 復活したので墓標を外す
      delete out.renames[name];
    }
    out.fields[name] = {
      created: Number.isFinite(created) ? created : Date.now(),
      order:   Number.isFinite(order) ? order : 0,
      legacy,
      sessions,
    };
  });

  if (!Object.keys(out.fields).length) out.fields = createDefaultData().fields;

  // 記録中: 端末ごとに updatedAt が新しい方を採用。
  // 停止は削除ではなく active:false で伝わるので、これだけで矛盾なく合流する。
  const now = Date.now();
  const liveIds = new Set([...Object.keys(a.live), ...Object.keys(b.live)]);
  liveIds.forEach(id => {
    const la = a.live[id], lb = b.live[id];
    const pick = (la && lb) ? (la.updatedAt >= lb.updatedAt ? la : lb) : (la || lb);
    if (!pick) return;
    // 停止済みの古い印はいつまでも持ち回らない
    if (!pick.active && (now - pick.updatedAt) > 24 * 60 * 60 * 1000) return;
    if (out.fields[pick.field] || !pick.active) out.live[id] = { ...pick };
  });

  return out;
}

/* ── Node（Electron main）用エクスポート ─────────────────────────────── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TATSUJIN_SCHEMA, DEFAULT_FIELDS, LIVE_STALE_MS,
    hoursForLevel, getLevel, getLevelInfo, getTitle,
    formatHours, formatDuration, formatDate, isoDate, isoDateTs, monthKey, uid, pad2,
    createDefaultData, normalizeData, migrateData,
    fieldByDevice, fieldTotal, fieldSessionCount, totalByDevice, grandTotal,
    activeDeviceIds, deviceName, orderedFieldNames, liveEntries, resolveFieldName,
    fieldLiveHours, fieldLiveByDevice,
    touchDevice, startSession, heartbeat, stopSession, isRunningOn,
    addFieldTo, deleteFieldFrom, renameFieldIn, mergeData,
  };
}
