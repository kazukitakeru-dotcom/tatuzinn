'use strict';
/* ============================================================================
   達人への道 — Supabase 同期
   Electron版（達人への道/supa.js）とスマホ版（tatsujin/supa.js）は同一内容。

   わんにゃんメモリーと同じプロジェクトに相乗りしている。
   テーブルは supabase.sql を参照（tatsujin_state / tatsujin_sessions / tatsujin_live）。

   設計
     - セッションは1件1行の追記のみ  → 端末間で衝突しない
     - 「いま記録中」は端末ごとに1行 → 上書き競合しない
     - 分野の構造（改名・削除）だけ小さな JSON を last-write-wins ＋ core.js のマージで扱う
   ========================================================================== */

const SUPA_URL = 'https://kafaarlosuvqxxlxpvgg.supabase.co';
/* publishable key は公開前提のもの。これ単体では何も読めない（anon は revoke 済み）。 */
const SUPA_KEY = 'sb_publishable_nSwOQo-YbEtDN_KTjBf80w_D6o0iLoA';

const _SK = (typeof module !== 'undefined' && module.exports)
  ? require('./core.js')
  : (typeof globalThis !== 'undefined' ? globalThis : window);

/* 日本語にしておくと原因が分かりやすいものだけ翻訳する */
function supaMessage(raw) {
  const s = String(raw || '');
  if (/invalid login credentials/i.test(s)) return 'メールアドレスかパスワードが違います';
  if (/email not confirmed/i.test(s))       return 'メールの確認がまだです。届いた確認メールのリンクを開いてください';
  if (/user already registered/i.test(s))   return 'このメールアドレスは登録済みです。ログインしてください';
  if (/password should be at least/i.test(s)) return 'パスワードが短すぎます（6文字以上）';
  if (/rate limit|too many/i.test(s))       return '試行が多すぎます。少し待ってからやり直してください';
  if (/schema cache|does not exist/i.test(s)) return 'テーブルがまだ作られていません（supabase.sql を実行してください）';
  if (/permission denied/i.test(s))         return 'テーブルの権限設定が足りません（supabase.sql を実行してください）';
  return s;
}

/* store: { load(): session|null, save(session|null): void } */
function createSupa(store) {
  let session = store.load() || null;

  function setSession(s) {
    session = s || null;
    store.save(session);
  }

  function normalizeSession(j) {
    if (!j || !j.access_token) return null;
    return {
      access_token:  j.access_token,
      refresh_token: j.refresh_token,
      expires_at:    j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
      user:          j.user ? { id: j.user.id, email: j.user.email } : (session && session.user) || null,
    };
  }

  async function request(url, opts) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      // 「サーバーに届かなかった」のか「サーバーに断られた」のかを、
      // 呼び出し側が区別できるようにしておく。混同するとログイン情報を捨ててしまう。
      const err = new Error('ネットワークに接続できません');
      err.offline = true;
      throw err;
    }
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = { message: text }; } }
    if (!res.ok) {
      const m = body && (body.error_description || body.msg || body.message || body.error);
      const err = new Error(supaMessage(m || `${res.status} ${res.statusText}`));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /* ── 認証 ── */
  async function authPost(path, body) {
    return request(SUPA_URL + '/auth/v1/' + path, {
      method: 'POST',
      headers: { 'apikey': SUPA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function signUp(email, password) {
    const j = await authPost('signup', { email, password });
    if (j && j.access_token) { setSession(normalizeSession(j)); return { confirmed: true }; }
    return { confirmed: false };   // 確認メール待ち
  }

  async function signIn(email, password) {
    const j = await authPost('token?grant_type=password', { email, password });
    setSession(normalizeSession(j));
    return session.user;
  }

  async function refresh() {
    if (!session || !session.refresh_token) throw new Error('ログインが必要です');
    try {
      const j = await authPost('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
      setSession(normalizeSession(j));
    } catch (e) {
      // 通信できなかっただけならログイン情報は捨てない。
      // ここで捨てていたので、電波の悪い場所や機内モードで開くたびにログインし直しになっていた。
      if (e.offline) throw new Error('オフラインのため同期できません');
      // サーバーが「その更新トークンは無効」と答えたときだけログアウト扱いにする
      if (e.status === 400 || e.status === 401) {
        setSession(null);
        throw new Error('ログインの有効期限が切れました。もう一度ログインしてください');
      }
      throw e;   // サーバー側の一時的な不調（5xxなど）はそのまま伝える
    }
  }

  async function accessToken() {
    if (!session) throw new Error('ログインが必要です');
    if (session.expires_at - Math.floor(Date.now() / 1000) < 90) await refresh();
    return session.access_token;
  }

  function signOut() { setSession(null); }
  function signedIn() { return !!(session && session.access_token); }
  function currentUser() { return session ? session.user : null; }

  /* ── PostgREST ── */
  async function rest(path, opts) {
    opts = opts || {};
    const token = await accessToken();
    const headers = {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json',
    };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (opts.prefer) headers['Prefer'] = opts.prefer;
    return request(SUPA_URL + '/rest/v1/' + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
    });
  }

  // 1回のGETには件数上限（1000件）がある。超えたぶんは静かに落ちるだけで
  // エラーにならないので、全部取れるまでページを送る。
  // 積み上げを続けるとセッションはいくらでも増えるため、これが無いと古い記録が消えて見える。
  const PAGE_SIZE = 1000;
  async function restAll(path) {
    const out = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
      out.push(...(page || []));
      if (!page || page.length < PAGE_SIZE) return out;
    }
  }

  const uid = () => (session && session.user ? session.user.id : null);
  const ts  = ms => new Date(ms).toISOString();
  const ms  = s  => (s ? Date.parse(s) : 0);

  /* ── 取得: 3つのテーブルを v2 データ構造に組み立てる ── */
  async function pull() {
    const [stateRows, sessionRows, liveRows] = await Promise.all([
      rest('tatsujin_state?select=doc,updated_at&limit=1'),
      restAll('tatsujin_sessions?select=id,field,started_at,ended_at,hours,device_id&order=started_at.desc,id.asc'),
      rest('tatsujin_live?select=device_id,device_name,field,started_at,active,updated_at'),
    ]);

    const doc = (stateRows && stateRows[0] && stateRows[0].doc) || {};
    const d = _SK.normalizeData(doc);

    (sessionRows || []).forEach(r => {
      // 行には保存当時の分野名が入っているので、改名をたどって今の名前に直す
      const name = _SK.resolveFieldName(d, r.field);
      const f = name ? d.fields[name] : null;
      if (!f) return;                       // 消された分野の残骸は取り込まない
      f.sessions.push({
        id: r.id, start: ms(r.started_at), end: ms(r.ended_at),
        hours: Number(r.hours), dev: r.device_id,
      });
    });

    (liveRows || []).forEach(r => {
      if (r.device_name) {
        d.devices[r.device_id] = { name: r.device_name, lastSeen: ms(r.updated_at) };
      }
      if (!r.field || !r.started_at) return;
      d.live[r.device_id] = {
        field: r.field,
        startedAt: ms(r.started_at),
        updatedAt: ms(r.updated_at),
        active: !!r.active,
      };
    });

    return _SK.normalizeData(d);
  }

  /* ── 送信: 分野の構造（セッションは含めない小さな箱） ── */
  async function pushState(data) {
    const fields = {};
    Object.entries(data.fields || {}).forEach(([name, f]) => {
      fields[name] = { created: f.created, order: f.order, legacy: f.legacy, sessions: [] };
    });
    const doc = {
      schema: data.schema,
      devices: data.devices,
      fields,
      deletedFields: data.deletedFields,
      renames: data.renames,
      updatedAt: data.updatedAt,
    };
    await rest('tatsujin_state?on_conflict=user_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      // updated_at は送らない。サーバー側のトリガが now() を入れる。
      // 端末の時計で入れると、時計がずれた端末の「最後に見た時刻」が狂う。
      body: JSON.stringify([{ user_id: uid(), doc }]),
    });
  }

  /* ── 送信: セッション（同じIDは上書きされるだけなので何度送っても安全） ── */
  async function uploadSessions(list) {
    if (!list || !list.length) return;
    const rows = list.map(s => ({
      user_id: uid(), id: s.id, field: s.field,
      started_at: ts(s.start), ended_at: ts(s.end),
      hours: s.hours, device_id: s.dev,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await rest('tatsujin_sessions?on_conflict=user_id,id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify(rows.slice(i, i + 200)),
      });
    }
  }

  /* ── 送信: この端末の「いま記録中」 ── */
  async function upsertLive(deviceId, deviceName, live) {
    await rest('tatsujin_live?on_conflict=user_id,device_id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: JSON.stringify([{
        user_id: uid(),
        device_id: deviceId,
        device_name: deviceName || '',
        field:      live ? live.field : null,
        started_at: live ? ts(live.startedAt) : null,
        active:     !!(live && live.active),
        // updated_at は送らない。サーバー側のトリガが now() を入れる。
      }]),
    });
  }

  /* ── サーバーに既にあるセッションIDの一覧 ──
     送信待ちキュー（settings.pending）だけに頼ると、ログインする前に記録した分や、
     キューを取りこぼしたときの分が永久に上がらない。
     毎回これと突き合わせて、足りないものを送り直す。 */
  async function fetchSessionIds() {
    const rows = await restAll('tatsujin_sessions?select=id&order=id.asc');
    return (rows || []).map(r => r.id);
  }

  /* ── 分野の削除・改名をセッション行にも反映 ── */
  async function deleteFieldRows(field) {
    await rest(`tatsujin_sessions?user_id=eq.${uid()}&field=eq.${encodeURIComponent(field)}`, {
      method: 'DELETE', prefer: 'return=minimal',
    });
  }

  async function renameFieldRows(oldName, newName) {
    await rest(`tatsujin_sessions?user_id=eq.${uid()}&field=eq.${encodeURIComponent(oldName)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ field: newName }),
    });
  }

  return {
    signUp, signIn, signOut, signedIn, currentUser, refresh,
    pull, pushState, uploadSessions, upsertLive, deleteFieldRows, renameFieldRows,
    fetchSessionIds,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPA_URL, SUPA_KEY, createSupa, supaMessage };
}
