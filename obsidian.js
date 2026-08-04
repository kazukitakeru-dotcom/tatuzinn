'use strict';
/* ============================================================================
   達人への道 — Obsidian 書き出し
   Electron版（達人への道/obsidian.js）とスマホ版（tatsujin/obsidian.js）は同一内容。

   出力するノート
     達人への道.md        … 全分野のサマリー（端末ごとの内訳つき）
     分野/<分野名>.md      … 分野ごとの詳細（端末別・月別・全セッション履歴）
   ========================================================================== */

const _OK = (typeof module !== 'undefined' && module.exports)
  ? require('./core.js')
  : (typeof globalThis !== 'undefined' ? globalThis : window);

const OBS_FOLDER = '達人への道';

/* ── 小道具 ───────────────────────────────────────────────────────────── */
function obsFileName(name) {
  return String(name || '無題')
    .replace(/[\\\/:*?"<>|#^\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '無題';
}
function obsLink(name) { return obsFileName(name); }

function yamlStr(v) {
  const s = String(v == null ? '' : v);
  if (s === '') return '""';
  if (/^[-?:,\[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^\s|^(true|false|null|yes|no|on|off)$/i.test(s) || /^[\d.+-]+$/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}
function yamlKey(s) {
  return String(s || '').replace(/[:#\[\]{}",]/g, '').replace(/\s+/g, '_').trim() || 'x';
}
function cell(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
function h2(h) { return Number(h || 0).toFixed(2); }
function pct(part, whole) { return whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : '—'; }

/* ── サマリーノート ───────────────────────────────────────────────────── */
function obsSummaryNote(data, ctx) {
  const now = ctx.now || Date.now();
  const names = _OK.orderedFieldNames(data);
  const devIds = _OK.activeDeviceIds(data);
  const devTotals = _OK.totalByDevice(data);
  const total = _OK.grandTotal(data);
  const L = [];

  L.push('---');
  L.push(`tags: [達人への道, 記録]`);
  L.push(`書き出し日: ${yamlStr(_OK.isoDate(new Date(now)))}`);
  L.push(`書き出し端末: ${yamlStr(ctx.deviceLabel || '')}`);
  L.push(`総計h: ${h2(total)}`);
  devIds.forEach(id => L.push(`${yamlKey('端末_' + _OK.deviceName(data, id))}_h: ${h2(devTotals[id] || 0)}`));
  L.push(`分野数: ${names.length}`);
  L.push('---');
  L.push('');
  L.push('# 達人への道');
  L.push('');
  L.push(`書き出し日時: ${_OK.formatDate(now)}（${ctx.deviceLabel || '—'} から）`);
  L.push('');

  // 記録中
  const live = _OK.liveEntries(data, now).filter(e => !e.stale);
  L.push('## 記録中');
  L.push('');
  if (live.length) {
    live.forEach(e => {
      L.push(`- **${e.name}** — ${e.field} を ${_OK.formatDuration(e.seconds)} 記録中（開始 ${_OK.formatDate(e.startedAt)}）`);
    });
  } else {
    L.push('現在、記録中の端末はありません。');
  }
  L.push('');

  // 分野別
  L.push('## 分野別');
  L.push('');
  L.push(`| 分野 | Lv | 称号 | 合計 | ${devIds.map(id => cell(_OK.deviceName(data, id))).join(' | ')} | セッション |`);
  L.push(`| --- | ---: | --- | ---: | ${devIds.map(() => '---:').join(' | ')} | ---: |`);
  names.forEach(name => {
    const f = data.fields[name];
    const t = _OK.fieldTotal(f);
    const by = _OK.fieldByDevice(f);
    const li = _OK.getLevelInfo(t);
    const cols = devIds.map(id => by[id] ? _OK.formatHours(by[id]) : '—');
    L.push(`| [[${obsLink(name)}]] | ${li.level} | ${cell(_OK.getTitle(li.level))} | ${_OK.formatHours(t)} | ${cols.join(' | ')} | ${_OK.fieldSessionCount(f)} |`);
  });
  L.push(`| **総計** |  |  | **${_OK.formatHours(total)}** | ${devIds.map(id => '**' + _OK.formatHours(devTotals[id] || 0) + '**').join(' | ')} |  |`);
  L.push('');

  // 端末別
  L.push('## 端末別 合計');
  L.push('');
  L.push('| 端末 | 合計 | 割合 | セッション数 | 最終記録 |');
  L.push('| --- | ---: | ---: | ---: | --- |');
  devIds.forEach(id => {
    let count = 0, last = 0;
    Object.values(data.fields).forEach(f => {
      (f.sessions || []).forEach(s => {
        if (s.dev !== id) return;
        count++;
        if (s.end > last) last = s.end;
      });
    });
    L.push(`| ${cell(_OK.deviceName(data, id))} | ${_OK.formatHours(devTotals[id] || 0)} | ${pct(devTotals[id] || 0, total)} | ${count} | ${last ? _OK.formatDate(last) : '—'} |`);
  });
  L.push('');
  L.push(`> 総計 ${_OK.formatHours(total)}（Lv.100 まで残り ${_OK.formatHours(Math.max(0, 10000 - total))}）`);
  L.push('');
  return L.join('\n');
}

/* ── 分野ノート ───────────────────────────────────────────────────────── */
function obsFieldNote(data, name, ctx) {
  const now = ctx.now || Date.now();
  const f = data.fields[name];
  const sessions = [...(f.sessions || [])].sort((a, b) => b.start - a.start);
  const total = _OK.fieldTotal(f);
  const by = _OK.fieldByDevice(f);
  const li = _OK.getLevelInfo(total);
  const devIds = Object.keys(by).sort((a, b) => by[b] - by[a]);
  const L = [];

  L.push('---');
  L.push(`分野: ${yamlStr(name)}`);
  L.push(`レベル: ${li.level}`);
  L.push(`称号: ${yamlStr(_OK.getTitle(li.level))}`);
  L.push(`合計時間h: ${h2(total)}`);
  devIds.forEach(id => L.push(`${yamlKey('端末_' + _OK.deviceName(data, id))}_h: ${h2(by[id])}`));
  L.push(`セッション数: ${sessions.length}`);
  L.push(`初回記録: ${yamlStr(sessions.length ? _OK.isoDateTs(sessions[sessions.length - 1].start) : '')}`);
  L.push(`最終記録: ${yamlStr(sessions.length ? _OK.isoDateTs(sessions[0].end) : '')}`);
  L.push(`書き出し日: ${yamlStr(_OK.isoDate(new Date(now)))}`);
  L.push('tags: [達人への道, 分野]');
  L.push('---');
  L.push('');
  L.push(`# ${name}`);
  L.push('');
  L.push(`[[${OBS_FOLDER}]] に戻る`);
  L.push('');

  // 概要
  L.push('## 概要');
  L.push('');
  L.push('| 項目 | 内容 |');
  L.push('| --- | --- |');
  L.push(`| レベル | Lv.${li.level} — ${cell(_OK.getTitle(li.level))} |`);
  L.push(`| 合計時間 | ${_OK.formatHours(total)} |`);
  L.push(`| 次のレベルまで | ${_OK.formatHours(li.hoursToNext)} |`);
  L.push(`| レベル内進捗 | ${(li.progress * 100).toFixed(1)}% |`);
  L.push(`| セッション数 | ${sessions.length} |`);
  if (sessions.length) {
    L.push(`| 初回記録 | ${cell(_OK.formatDate(sessions[sessions.length - 1].start))} |`);
    L.push(`| 最終記録 | ${cell(_OK.formatDate(sessions[0].end))} |`);
    L.push(`| 1回あたり平均 | ${_OK.formatHours(sessions.reduce((t, s) => t + s.hours, 0) / sessions.length)} |`);
  }
  L.push('');

  // 記録中
  const live = _OK.liveEntries(data, now).filter(e => !e.stale && e.field === name);
  if (live.length) {
    live.forEach(e => L.push(`> 🟢 **${e.name}** が現在 ${_OK.formatDuration(e.seconds)} 記録中（この時間は下の表にはまだ含まれていません）`));
    L.push('');
  }

  // 端末別
  L.push('## 端末別');
  L.push('');
  L.push('| 端末 | 時間 | 割合 | セッション数 | 最終記録 |');
  L.push('| --- | ---: | ---: | ---: | --- |');
  devIds.forEach(id => {
    const ss = sessions.filter(s => s.dev === id);
    const last = ss.length ? Math.max(...ss.map(s => s.end)) : 0;
    L.push(`| ${cell(_OK.deviceName(data, id))} | ${_OK.formatHours(by[id])} | ${pct(by[id], total)} | ${ss.length} | ${last ? cell(_OK.formatDate(last)) : '—'} |`);
  });
  L.push('');
  const legacyDevs = Object.entries(f.legacy || {});
  if (legacyDevs.length) {
    legacyDevs.forEach(([id, h]) => {
      L.push(`> ※ 旧バージョンから引き継いだ内訳不明の ${_OK.formatHours(h)} を「${_OK.deviceName(data, id)}」に計上しています（下の履歴には出ません）。`);
    });
    L.push('');
  }

  // 月別
  if (sessions.length) {
    const months = {};
    sessions.forEach(s => {
      const k = _OK.monthKey(s.start);
      if (!months[k]) months[k] = { total: 0, by: {}, count: 0 };
      months[k].total += s.hours;
      months[k].by[s.dev] = (months[k].by[s.dev] || 0) + s.hours;
      months[k].count++;
    });
    L.push('## 月別');
    L.push('');
    L.push(`| 月 | 合計 | ${devIds.map(id => cell(_OK.deviceName(data, id))).join(' | ')} | 回数 |`);
    L.push(`| --- | ---: | ${devIds.map(() => '---:').join(' | ')} | ---: |`);
    Object.keys(months).sort().reverse().forEach(k => {
      const m = months[k];
      L.push(`| ${k} | ${_OK.formatHours(m.total)} | ${devIds.map(id => m.by[id] ? _OK.formatHours(m.by[id]) : '—').join(' | ')} | ${m.count} |`);
    });
    L.push('');
  }

  // セッション履歴
  L.push('## セッション履歴');
  L.push('');
  if (!sessions.length) {
    L.push('記録はまだありません。');
  } else {
    L.push('| 開始 | 終了 | 時間 | 端末 |');
    L.push('| --- | --- | ---: | --- |');
    sessions.forEach(s => {
      L.push(`| ${cell(_OK.formatDate(s.start))} | ${cell(_OK.formatDate(s.end))} | ${_OK.formatDuration(Math.round(s.hours * 3600))} | ${cell(_OK.deviceName(data, s.dev))} |`);
    });
  }
  L.push('');
  return L.join('\n');
}

/* ── 書き出すノート一式を組み立てる ─────────────────────────────────────
   戻り値: [{ path: '達人への道.md', text: '...' }, ...]
   path は書き出し先フォルダからの相対パス。
   ────────────────────────────────────────────────────────────────────── */
function buildObsidianNotes(data, ctx) {
  ctx = ctx || {};
  if (!ctx.now) ctx.now = Date.now();
  const notes = [{ path: `${OBS_FOLDER}.md`, text: obsSummaryNote(data, ctx) }];
  _OK.orderedFieldNames(data).forEach(name => {
    notes.push({ path: `分野/${obsFileName(name)}.md`, text: obsFieldNote(data, name, ctx) });
  });
  return notes;
}

/* ── ZIP（無圧縮 store 方式・外部ライブラリ不要／スマホ版で使用） ────── */
let _crcTbl = null;
function _crc32(bytes) {
  if (!_crcTbl) {
    _crcTbl = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTbl[i] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _crcTbl[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

function buildZip(files) {
  const enc = new TextEncoder();
  const { time, date } = _dosDateTime(new Date());
  const parts = [], central = [];
  let offset = 0;

  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const crc = _crc32(f.data);
    const size = f.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, f.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  });

  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
}

/* iOS は共有シート、それ以外はダウンロード */
async function shareOrDownload(blob, fileName) {
  const type = blob.type || 'application/octet-stream';
  if (navigator.share && navigator.canShare) {
    try {
      const file = new File([blob], fileName, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: '達人への道' });
        return 'shared';
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  return 'downloaded';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { OBS_FOLDER, obsFileName, buildObsidianNotes, obsSummaryNote, obsFieldNote };
}
