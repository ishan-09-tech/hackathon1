// db.js - makes your existing localStorage-based pages save to Supabase.
// Load AFTER the supabase-js script tag. No other page code needs to change.
(function () {
  const URL_ = ' https://vtfajpunodcffkbcvrhv.supabase.co';   
  const KEY  = 'sb_publishable_JeFf-zkHTUqPqXjTsvJPWA_zehRYKiB';
  const sb = window.supabase.createClient(URL_, KEY);
  const ls = localStorage;
  const native = { set: Storage.prototype.setItem };
  const SYNC = k => k === 'users' || k.startsWith('chat_');
  const NO_DEL = ['chat_messages', 'chat_presence', 'chat_typing']; // never delete these rows from the DB
  const idOf = x => x && (x.id != null ? x.id : x.roll);
  const last = {};                    // key -> { itemId: json } = what the DB already has
  const sortTs = v => (v.every(x => x && typeof x.ts === 'number') ? v.sort((a, b) => a.ts - b.ts) : v);

  function split(v) {                 // one localStorage value -> rows
    if (Array.isArray(v) && v.every(x => x && typeof x === 'object' && idOf(x) != null))
      return { kind: 'list', items: Object.fromEntries(v.map(x => [String(idOf(x)), x])) };
    if (v && typeof v === 'object' && !Array.isArray(v)) return { kind: 'map', items: v };
    return { kind: 'value', items: { _: v } };
  }

  function push(key, v) {             // upload only the items that changed
    const { kind, items } = split(v), prev = last[key] || (last[key] = {}), up = [], del = [];
    for (const id in items) {
      const j = JSON.stringify(items[id]);
      if (prev[id] !== j) { prev[id] = j; up.push({ col: key, id, kind, data: items[id] }); }
    }
    if (!NO_DEL.includes(key)) for (const id in prev) if (!(id in items)) { del.push(id); delete prev[id]; }
    const log = r => r && r.error && console.error('DB error', r.error);
    if (up.length) sb.from('docs').upsert(up).then(log);
    if (del.length) sb.from('docs').delete().eq('col', key).in('id', del).then(log);
  }

  Storage.prototype.setItem = function (k, v) {
    native.set.call(this, k, v);
    if (this === ls && SYNC(k)) { try { push(k, JSON.parse(v)); } catch (e) {} }
  };

  function fetchAll() {               // synchronous, so pages see the data on first run
    const rows = [];
    for (let off = 0; ; off += 1000) {
      const x = new XMLHttpRequest();
      x.open('GET', URL_ + '/rest/v1/docs?select=col,id,kind,data&order=col,id&limit=1000&offset=' + off, false);
      x.setRequestHeader('apikey', KEY); x.setRequestHeader('Authorization', 'Bearer ' + KEY);
      x.send();
      if (x.status !== 200) throw new Error('DB status ' + x.status);
      const part = JSON.parse(x.responseText); rows.push(...part);
      if (part.length < 1000) return rows;
    }
  }

  try {                               // 1) pull everything from the DB into the local cache
    const cols = {};
    fetchAll().forEach(r => { (cols[r.col] = cols[r.col] || { kind: r.kind, items: {} }).items[r.id] = r.data; });
    for (const key in cols) {
      const { kind, items } = cols[key];
      const v = kind === 'list' ? sortTs(Object.values(items)) : kind === 'map' ? items : items._;
      native.set.call(ls, key, JSON.stringify(v));
      last[key] = Object.fromEntries(Object.entries(items).map(([id, d]) => [id, JSON.stringify(d)]));
    }
  } catch (e) { console.warn('Supabase load failed - using this browser\'s data only', e); }

  function apply(row, deleted) {      // 2) live updates from other users
    const key = row.col; let v; try { v = JSON.parse(ls.getItem(key)); } catch (e) {}
    const kind = row.kind || (Array.isArray(v) ? 'list' : 'map');
    const prev = last[key] || (last[key] = {});
    if (!deleted && prev[row.id] === JSON.stringify(row.data)) return;   // our own echo
    if (kind === 'list') {
      v = Array.isArray(v) ? v : [];
      const i = v.findIndex(x => String(idOf(x)) === row.id);
      if (deleted) { if (i > -1) v.splice(i, 1); } else if (i > -1) v[i] = row.data; else v.push(row.data);
      sortTs(v);
    } else if (kind === 'map') {
      v = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      if (deleted) delete v[row.id]; else v[row.id] = row.data;
    } else v = row.data;
    if (deleted) delete prev[row.id]; else prev[row.id] = JSON.stringify(row.data);
    native.set.call(ls, key, JSON.stringify(v));
    window.dispatchEvent(new StorageEvent('storage', { key }));          // the chat page already listens for this
  }
  sb.channel('docs-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' },
        p => (p.eventType === 'DELETE' ? apply(p.old, true) : apply(p.new, false)))
    .subscribe();

  const bucket = sb.storage.from('chat-files');   // 3) shared files (photos, videos, docs)
  window.DB = {
    putBlob: (id, blob) => bucket.upload(id, blob, { upsert: true, contentType: blob.type }).then(r => { if (r.error) throw r.error; }),
    getBlob: id => bucket.download(id).then(r => (r.error ? undefined : r.data)),
    delBlob: id => bucket.remove([id]).catch(() => {})
  };
})();

