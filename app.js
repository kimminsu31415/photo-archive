/* 사진 보관함 — 구글 드라이브에 사진을 저장하고, 촬영 날짜별 달력으로 보여주고, 3×2cm A4 PDF로 인쇄한다. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const CLIENT_ID = (window.APP_CONFIG && window.APP_CONFIG.googleClientId || '').trim();
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const UNDATED = 'undated'; // 찍은 날짜를 알 수 없는 사진
const APP_VERSION = '11.15-1'; // 설정 화면에 표시: 기기마다 같은 버전인지 확인용
const FIELDS = 'id,name,parents,description,appProperties,createdTime,imageMediaMetadata(width,height)';
const A4W = 210, A4H = 297, DPMM = 300 / 25.4;
const WK = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MEN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  del(k) { try { localStorage.removeItem(k); } catch (_) {} }
};

let photos = store.get('pa-photos', []);
let tray = store.get('pa-tray', {});
const S = Object.assign({ w: 34, h: 23, gap: 2, cut: true }, store.get('pa-size', {}));
// 예전 크기(3×2, 2×3, 3.4×3.1)를 쓰던 기기는 캘린더형 3.4×2.3으로
if ([[30, 20], [20, 30], [34, 31]].some(([w, h]) => S.w === w && S.h === h)) { S.w = 34; S.h = 23; }
S.margin = 10; // 스티커 용지라 가장자리 1cm는 항상 비워 둔다
const now = new Date();
let viewY = now.getFullYear(), viewM = now.getMonth(), selected = ymd(now);
let loaded = photos.length > 0, uploading = false, jumped = false;

function note(msg) { const n = $('note'); n.textContent = msg || ''; n.hidden = !msg; }
const saveTray = () => store.set('pa-tray', tray);
const saveSize = () => store.set('pa-size', S);
const savePhotos = () => store.set('pa-photos', photos);

/* ---------------- IndexedDB (썸네일 캐시, 공유받은 사진 대기열) ---------------- */
const IDB = {
  open() {
    if (this.p) return this.p;
    this.p = new Promise((res, rej) => {
      const r = indexedDB.open('photo-archive', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
        if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { autoIncrement: true });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.p;
  },
  async tx(name, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode); const st = t.objectStore(name); let out;
      Promise.resolve(fn(st)).then((v) => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(name, key) { return this.tx(name, 'readonly', (st) => new Promise((r) => { const q = st.get(key); q.onsuccess = () => r(q.result); q.onerror = () => r(undefined); })); },
  put(name, val, key) { return this.tx(name, 'readwrite', (st) => { st.put(val, key); }); },
  del(name, key) { return this.tx(name, 'readwrite', (st) => { st.delete(key); }); },
  all(name) {
    return this.tx(name, 'readonly', (st) => new Promise((r) => {
      const out = []; const c = st.openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { out.push({ key: cur.key, value: cur.value }); cur.continue(); } else r(out); };
      c.onerror = () => r(out);
    }));
  }
};

/* ---------------- 구글 로그인 + 드라이브 ---------------- */
const Auth = {
  token: null, exp: 0, client: null,
  restore() { const t = store.get('pa-token', null); if (t && t.exp > Date.now() + 60000) { this.token = t.token; this.exp = t.exp; } },
  valid() { return this.token && this.exp > Date.now() + 30000; },
  ready() {
    return new Promise((res) => {
      const check = () => (window.google && google.accounts && google.accounts.oauth2) ? res(true) : setTimeout(check, 100);
      check();
    });
  },
  async request() {
    await this.ready();
    return new Promise((res, rej) => {
      if (!this.client) {
        this.client = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: () => {} });
      }
      this.client.callback = (r) => {
        if (r.error) { rej(r); return; }
        this.token = r.access_token; this.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        store.set('pa-token', { token: this.token, exp: this.exp }); store.set('pa-linked', true); res(this.token);
      };
      this.client.error_callback = (e) => rej(e);
      this.client.requestAccessToken({ prompt: store.get('pa-linked', false) ? '' : 'consent' });
    });
  },
  signOut() {
    if (this.token && window.google && google.accounts) { try { google.accounts.oauth2.revoke(this.token, () => {}); } catch (_) {} }
    this.token = null; this.exp = 0; store.del('pa-token'); store.del('pa-linked'); resetFolders();
  }
};

class AuthError extends Error {}
async function api(url, opts = {}) {
  if (!Auth.valid()) throw new AuthError('auth');
  const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + Auth.token }, opts.headers || {}) }));
  if (res.status === 401) { Auth.token = null; store.del('pa-token'); throw new AuthError('auth'); }
  if (!res.ok) { const t = await res.text().catch(() => ''); const e = new Error('drive ' + res.status + ' ' + t.slice(0, 200)); e.status = res.status; throw e; }
  return res;
}
const q = (s) => encodeURIComponent(s);

/* 드라이브 폴더 구조: Photo Archive / 2026 / 2026-11 / 2026-11-02_사진.jpg */
let folderId = store.get('pa-folder', null);
let folderMap = store.get('pa-folders', {});
const locks = new Map();
function once(key, fn) {
  if (locks.has(key)) return locks.get(key);
  const p = fn().finally(() => locks.delete(key));
  locks.set(key, p); return p;
}
function resetFolders() { folderId = null; folderMap = {}; store.del('pa-folder'); store.del('pa-folders'); }
async function findOrCreate(name, parent, kind, key) {
  const qs = `appProperties has { key='photoArchive' and value='${kind}' } and appProperties has { key='paKey' and value='${key}' } and '${parent}' in parents and trashed=false`;
  const r = await api(`${API}/files?q=${q(qs)}&fields=files(id)&spaces=drive`); const j = await r.json();
  if (j.files && j.files.length) return j.files[0].id;
  const c = await api(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent], appProperties: { photoArchive: kind, paKey: key } }) });
  return (await c.json()).id;
}
function ensureFolder() {
  return once('root', async () => {
    if (folderId) {
      try { const r = await api(`${API}/files/${folderId}?fields=id,trashed`); const j = await r.json(); if (!j.trashed) return folderId; } catch (e) { if (e instanceof AuthError) throw e; }
      resetFolders();
    }
    const r = await api(`${API}/files?q=${q("appProperties has { key='photoArchive' and value='root' } and trashed=false")}&fields=files(id)&spaces=drive`);
    const j = await r.json();
    if (j.files && j.files.length) { folderId = j.files[0].id; }
    else {
      const c = await api(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Photo Archive', mimeType: 'application/vnd.google-apps.folder', appProperties: { photoArchive: 'root' } }) });
      folderId = (await c.json()).id;
    }
    store.set('pa-folder', folderId);
    return folderId;
  });
}
async function folderFor(date) {
  if (date === UNDATED) {
    if (folderMap[UNDATED]) return folderMap[UNDATED];
    const root = await ensureFolder();
    folderMap[UNDATED] = await once('undated', () => findOrCreate('언제의 사진', root, UNDATED, UNDATED)); store.set('pa-folders', folderMap);
    return folderMap[UNDATED];
  }
  const y = date.slice(0, 4), ym = date.slice(0, 7);
  if (folderMap[ym]) return folderMap[ym];
  const root = await ensureFolder();
  const yid = folderMap[y] || await once('y' + y, () => findOrCreate(y, root, 'year', y));
  folderMap[y] = yid;
  const mid = await once('m' + ym, () => findOrCreate(ym, yid, 'month', ym));
  folderMap[ym] = mid; store.set('pa-folders', folderMap);
  return mid;
}
function fromFile(f) {
  const a = f.appProperties || {}; const im = f.imageMediaMetadata || {};
  const created = new Date(f.createdTime || Date.now());
  return {
    id: f.id, name: f.name, parent: (f.parents || [])[0] || null, date: a.date || ymd(created), takenAt: a.takenAt || `${ymd(created)}T${hm(created)}`,
    caption: f.description || '', zoom: +a.zoom || 1, cx: a.cx != null ? +a.cx : 0.5, cy: a.cy != null ? +a.cy : 0.5, rot: +a.rot || 0,
    w: +a.w || im.width || 0, h: +a.h || im.height || 0, sha: a.sha || '', dh: a.dh || '',
    src: a.src || '', created: ymd(created),
    gx: a.gx != null ? +a.gx : null, gy: a.gy != null ? +a.gy : null, gw: a.gw != null ? +a.gw : null, // 주간 플래너 모눈 쪽 자리
    ot: a.ot || ((a.src === 'exif' || a.src === 'name' || a.src === 'file') ? (a.takenAt || '') : '') // 사진에 원래 적힌 찍은 시각 (중복 판별용)
  };
}
async function listAll() {
  await ensureFolder();
  // drive.file 권한이라 이 앱이 만든 사진만 보인다 (하위 폴더 포함)
  const out = []; let page = '';
  do {
    const r = await api(`${API}/files?q=${q("trashed=false and mimeType contains 'image/'")}&spaces=drive&pageSize=1000&fields=nextPageToken,files(${FIELDS})${page ? '&pageToken=' + page : ''}`);
    const j = await r.json(); (j.files || []).forEach((f) => out.push(fromFile(f))); page = j.nextPageToken || '';
  } while (page);
  return out;
}
const stripDate = (n) => /^\d{4}-\d{2}-\d{2}_/.test(n) ? n.slice(11) : n;
const datedName = (name, date) => date === UNDATED ? stripDate(name || 'photo.jpg') : `${date}_${stripDate(name || 'photo.jpg')}`;
async function uploadPhoto(blob, mime, name, props, caption, retried) {
  let parent;
  try { parent = await folderFor(props.date); } catch (e) { if (e instanceof AuthError || retried) throw e; resetFolders(); return uploadPhoto(blob, mime, name, props, caption, true); }
  const meta = { name, parents: [parent], mimeType: mime, appProperties: props, description: caption || '' };
  const b = 'pa' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
  try {
    const r = await api(`${UPLOAD}?uploadType=multipart&fields=${q(FIELDS)}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
    return fromFile(await r.json());
  } catch (e) {
    // 폴더를 드라이브에서 지웠다면 폴더를 다시 만들고 한 번 더 시도
    if (!retried && (e.status === 404 || e.status === 400)) { resetFolders(); return uploadPhoto(blob, mime, name, props, caption, true); }
    throw e;
  }
}
async function patchPhoto(p, props, caption) {
  const body = { appProperties: props };
  if (caption != null) body.description = caption;
  let extra = '';
  if (props.date) {
    const target = await folderFor(props.date);
    if (p.parent && p.parent !== target) extra = `&addParents=${target}&removeParents=${p.parent}`;
    else if (!p.parent) extra = `&addParents=${target}`;
    const nm = datedName(p.name, props.date); if (nm !== p.name) body.name = nm;
  }
  const r = await api(`${API}/files/${p.id}?fields=${q(FIELDS)}${extra}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return fromFile(await r.json());
}
/* 예전에 폴더 구분 없이 올린 사진을 연도/월 폴더로 옮긴다 */
let tidying = false;
async function tidyFolders() {
  if (tidying) return; tidying = true;
  try {
    const wrong = [];
    for (const p of photos) { const t = await folderFor(p.date); if (p.parent !== t || (p.date !== UNDATED && !/^\d{4}-\d{2}-\d{2}_/.test(p.name || ''))) wrong.push(p); }
    let n = 0;
    for (const p of wrong) {
      n++; note(`드라이브 폴더 정리 중 ${n} / ${wrong.length}`);
      try { const u = await patchPhoto(p, { date: p.date }); Object.assign(p, { parent: u.parent, name: u.name }); }
      catch (e) { if (e instanceof AuthError) throw e; }
    }
    if (wrong.length) { savePhotos(); note(`드라이브의 사진 ${wrong.length}장을 연도·월 폴더로 정리했어요.`); }
  } finally { tidying = false; }
}
async function trashPhoto(id) {
  await api(`${API}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
}

/* ---------------- 이미지 ---------------- */
const fullCache = new Map();
function fullBlob(id) {
  if (!fullCache.has(id)) {
    const p = api(`${API}/files/${id}?alt=media`).then((r) => r.blob());
    p.catch(() => fullCache.delete(id));
    fullCache.set(id, p);
    if (fullCache.size > 40) fullCache.delete(fullCache.keys().next().value);
  }
  return fullCache.get(id);
}
function blobToImage(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob); const im = new Image();
    im.onload = () => res(im); im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); }; im.src = url;
  });
}
function scaled(src, max) {
  const [w, h] = dims(src); const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height); return c;
}
const toBlob = (c, type, q) => new Promise((r, j) => c.toBlob((b) => b ? r(b) : j(new Error('encode')), type, q));
const dims = (s) => [s.naturalWidth || s.width, s.naturalHeight || s.height];

const thumbURL = new Map();
const thumbQueue = []; let thumbActive = 0;
function pumpThumbs() {
  while (thumbActive < 4 && thumbQueue.length) {
    const job = thumbQueue.shift(); thumbActive++;
    job().finally(() => { thumbActive--; pumpThumbs(); });
  }
}
function getThumb(id) {
  if (thumbURL.has(id)) return thumbURL.get(id);
  const p = (async () => {
    const cached = await IDB.get('thumbs', id).catch(() => undefined);
    if (cached) return URL.createObjectURL(cached);
    if (!Auth.valid()) throw new Error('offline');
    const blob = await new Promise((res, rej) => { thumbQueue.push(() => fullBlob(id).then(res, rej)); pumpThumbs(); });
    const im = await blobToImage(blob); const tb = await toBlob(scaled(im, 400), 'image/jpeg', 0.82);
    URL.revokeObjectURL(im.src); IDB.put('thumbs', tb, id).catch(() => {});
    return URL.createObjectURL(tb);
  })();
  p.catch(() => thumbURL.delete(id));
  thumbURL.set(id, p);
  return p;
}
function thumbImg(p, cls) {
  const im = document.createElement('img'); im.alt = p.caption || ''; if (cls) im.className = cls;
  if (p.rot) im.style.transform = `rotate(${p.rot * 90}deg)`;
  getThumb(p.id).then((u) => { im.src = u; }).catch(() => { im.alt = '불러오기 실패'; });
  return im;
}
async function loadFull(p) { const b = await fullBlob(p.id); return blobToImage(b); }

function rotated(src, rot) {
  if (!rot) return src;
  const [w, h] = dims(src); const c = document.createElement('canvas'); const odd = rot % 2 !== 0;
  c.width = odd ? h : w; c.height = odd ? w : h;
  const g = c.getContext('2d'); g.translate(c.width / 2, c.height / 2); g.rotate(rot * Math.PI / 2); g.drawImage(src, -w / 2, -h / 2); return c;
}
function cropRect(p, W, H) {
  const [sw, sh] = dims(p.src); const s = Math.max(W / sw, H / sh) * p.zoom; const vw = W / s, vh = H / s;
  let sx = p.cx * sw - vw / 2, sy = p.cy * sh - vh / 2;
  sx = Math.max(0, Math.min(sw - vw, sx)); sy = Math.max(0, Math.min(sh - vh, sy));
  p.cx = (sx + vw / 2) / sw; p.cy = (sy + vh / 2) / sh; return { sx, sy, vw, vh, s };
}
function renderCrop(p, W, H) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.imageSmoothingQuality = 'high';
  const r = cropRect(p, W, H); g.drawImage(p.src, r.sx, r.sy, r.vw, r.vh, 0, 0, W, H); return c;
}

/* ---------------- 촬영 날짜 읽기 ---------------- */
async function exifDate(file) {
  try {
    const v = new DataView(await file.slice(0, 262144).arrayBuffer());
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 10 < v.byteLength) {
      const m = v.getUint16(o); if ((m & 0xFF00) !== 0xFF00) break; const len = v.getUint16(o + 2);
      if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return parseTiff(v, o + 10);
      if (m === 0xFFDA) break; o += 2 + len;
    }
  } catch (_) {}
  return null;
}
function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949; const g16 = (p) => v.getUint16(p, le), g32 = (p) => v.getUint32(p, le);
  const ifd = (off) => { const n = g16(t + off); const tags = {}; for (let i = 0; i < n; i++) { const e = t + off + 2 + i * 12; tags[g16(e)] = { count: g32(e + 4), val: e + 8 }; } return tags; };
  const str = (tag) => { if (!tag) return null; const p = tag.count > 4 ? t + g32(tag.val) : tag.val; let s = ''; for (let i = 0; i < tag.count - 1 && p + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(p + i)); return s; };
  const i0 = ifd(g32(t + 4)); let s = null;
  let sub = '';
  if (i0[0x8769]) { const ex = ifd(g32(i0[0x8769].val)); s = str(ex[0x9003]) || str(ex[0x9004]); sub = (str(ex[0x9291]) || '').trim(); }
  s = s || str(i0[0x0132]);
  const m = s && s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):?(\d{2})?/); if (!m || m[1] === '0000') return null;
  // 초까지, 연속 촬영용 1초 미만 값(SubSecTimeOriginal)이 있으면 그것까지
  const sec = m[6] ? `:${m[6]}` + (/^\d+$/.test(sub) ? `.${sub}` : '') : '';
  return { date: `${m[1]}-${m[2]}-${m[3]}`, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}${sec}`, real: true };
}
function nameDate(name) {
  const m = (name || '').match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ ]?(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return null; const mo = +m[2], d = +m[3]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, at: `${m[1]}-${m[2]}-${m[3]}T${m[4] || '12'}:${m[5] || '00'}${m[6] ? ':' + m[6] : ''}`, real: !!m[4] };
}

/* ---------------- 중복 판별용 지문 ---------------- */
async function shaOf(file) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) { return ''; }
}
function dhashOf(src) {
  // 9×8 흑백으로 줄여 옆 칸과 밝기를 비교한 64비트 지문. 크기·압축이 달라도 같은 사진이면 거의 같다.
  const c = document.createElement('canvas'); c.width = 9; c.height = 8; const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, 9, 8);
  const d = g.getImageData(0, 0, 9, 8).data; const lum = (i) => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let nib = 0, bits = 0, row = '';
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4; nib = (nib << 1) | (lum(i) > lum(i + 4) ? 1 : 0); bits++;
      if (bits === 4) { row += nib.toString(16); nib = 0; bits = 0; }
    }
    hex += row;
  }
  return hex;
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 99; let n = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } }
  return n;
}
/* 같은 사진인지: ① 파일이 똑같거나 ② 모양 지문이 거의 같고 사진에 적힌 찍은 시각(초, 연속 촬영은 1초 미만까지)이 같을 때 */
function findDup(fp, pool) {
  return pool.find((p) => {
    if (fp.sha && p.sha && p.sha === fp.sha) return true;
    // 파일이 다르면: 모양 지문이 거의 같고, 사진에 원래 적힌 찍은 시각(분)까지 같을 때만 같은 사진
    // (찍은 시각이 없는 사진은 모양만으로 판단하지 않는다 — 어두운 사진·스크린샷끼리 잘못 묶이는 것을 막기 위해)
    if (!fp.dh || !p.dh || !fp.ot || !p.ot || /^(0+|f+)$/.test(fp.dh) || /^(0+|f+)$/.test(p.dh)) return false;
    // 두 시각 중 더 짧은 정밀도까지 같아야 한다. 초 이하까지 비교할 수 있으면 지문 차이 4까지, 분까지만이면 2까지 허용
    const n = Math.min(fp.ot.length, p.ot.length);
    if (n < 16 || fp.ot.slice(0, n) !== p.ot.slice(0, n)) return false;
    return hamming(fp.dh, p.dh) <= (n >= 19 ? 4 : 2);
  });
}
const dayLabel = (date) => date === UNDATED ? '‘언제의 사진?’' : (() => { const d = new Date(date + 'T00:00:00'); return `${d.getMonth() + 1}월 ${d.getDate()}일`; })();
/* 예전에 올려 지문이 없는 사진은 썸네일로 지문을 만들어 채운다 (중복 판별용) */
let backfilling = false;
async function backfillPrints() {
  if (backfilling) return; backfilling = true;
  try {
    for (const p of photos.filter((x) => !x.dh)) {
      try {
        const u = await getThumb(p.id); const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
        const dh = dhashOf(im); await patchPhoto(p, { dh }); p.dh = dh;
      } catch (e) { if (e instanceof AuthError) break; }
    }
    savePhotos();
  } finally { backfilling = false; }
}

/* ---------------- 사진 추가 (한 번에 여러 장 → 날짜별 자동 분류) ---------------- */
async function addFiles(list, forceDate) {
  const files = [...(list || [])].filter((f) => f && (!f.type || f.type.startsWith('image/')));
  if (!files.length) return 0;
  if (uploading) { note('지금 다른 사진을 올리는 중이에요. 끝난 뒤 다시 추가해 주세요.'); return 0; }
  if (!Auth.valid()) { try { await Auth.request(); } catch (_) { note('구글 드라이브에 연결해야 사진을 저장할 수 있어요.'); showConnect(); return 0; } }
  const skipDup = $('optSkipDup').checked;
  if (skipDup && Date.now() - lastSync > 10000) { note('중복 확인을 위해 드라이브 목록을 먼저 확인하는 중…'); await sync(false); }
  uploading = true; const original = $('optOriginal').checked;
  const inFlight = []; const toMove = [], dupWhere = []; let dup = 0, undatedN = 0;
  let ok = 0, bad = 0, done = 0; const dates = new Set(); let latest = null;
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        // 찍은 날짜: 사진 정보(EXIF) → 파일 이름 → 오래된 파일 날짜. 모두 없으면 '언제의 사진?'으로
        const lm = new Date(f.lastModified || 0);
        const ex = await exifDate(f), nd = !ex && nameDate(f.name);
        const lmOk = f.lastModified && Date.now() - f.lastModified > 3600 * 1000;
        const info = forceDate ? { date: forceDate, at: `${forceDate}T${(ex || nd) ? (ex || nd).at.slice(11) : '12:00'}`, src: 'user' } // 날짜를 정해서 올릴 때: 그 날짜에, 시각은 사진 정보가 있으면 유지
          : ex ? Object.assign(ex, { src: 'exif' }) : nd ? Object.assign(nd, { src: 'name' })
          : lmOk ? { date: ymd(lm), at: `${ymd(lm)}T${hm(lm)}`, src: 'file' } : { date: UNDATED, at: '', src: 'none' };
        const sha = await shaOf(f);
        const im = await blobToImage(f);
        const dh = dhashOf(im); const ot = (ex || nd) && (ex || nd).real ? (ex || nd).at : '';
        const fp = { sha, dh, date: info.date, ot, ar: dims(im)[0] / dims(im)[1] };
        const same = skipDup && findDup(fp, photos.concat(inFlight));
        if (same) {
          URL.revokeObjectURL(im.src); dup++; done++; note(`사진 올리는 중 ${done} / ${files.length}`);
          // 날짜를 정해서 올렸는데 같은 사진이 다른 날에 있으면: 마음대로 옮기지 않고 옮길지 물어본다
          if (forceDate && same.id && same.date !== forceDate) { if (!toMove.includes(same.id)) toMove.push(same.id); }
          else dupWhere.push(same.date || info.date);
          continue;
        }
        inFlight.push(fp);
        const [w0, h0] = dims(im);
        let blob = f, mime = f.type || 'image/jpeg', w = w0, h = h0;
        if (!original || !/^image\/(jpeg|png|webp)$/.test(mime)) {
          const c = scaled(im, original ? 6000 : 2000); blob = await toBlob(c, 'image/jpeg', 0.9); mime = 'image/jpeg'; w = c.width; h = c.height;
        }
        const thumb = await toBlob(scaled(im, 400), 'image/jpeg', 0.82);
        URL.revokeObjectURL(im.src);
        const base = (f.name || 'photo').replace(/\.[^.]+$/, '');
        const p = await uploadPhoto(blob, mime, datedName(`${base}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`, info.date),
          { date: info.date, takenAt: info.at, zoom: '1', cx: '0.5', cy: '0.5', rot: '0', w: String(w), h: String(h), sha, dh, src: info.src, ot }, '');
        await IDB.put('thumbs', thumb, p.id).catch(() => {});
        thumbURL.set(p.id, Promise.resolve(URL.createObjectURL(thumb)));
        photos.push(p); ok++; if (p.date === UNDATED) undatedN++; else { dates.add(p.date); if (!latest || p.date > latest) latest = p.date; }
      } catch (e) {
        if (e instanceof AuthError) { queue.length = 0; note('구글 연결이 끊겼어요. 다시 연결한 뒤 남은 사진을 추가해 주세요.'); showConnect(); }
        else bad++;
      }
      done++; note(`사진 올리는 중 ${done} / ${files.length}`);
      if (done % 4 === 0) { savePhotos(); render(); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  uploading = false; savePhotos(); lastSync = Date.now(); setSyncLabel('동기화됨 ' + hm(new Date()));
  if (forceDate) { selected = forceDate; viewY = +forceDate.slice(0, 4); viewM = +forceDate.slice(5, 7) - 1; if (mode === 'undated') mode = 'week'; }
  else if (latest) { selected = latest; viewY = +latest.slice(0, 4); viewM = +latest.slice(5, 7) - 1; }
  else if (undatedN) { mode = 'undated'; selectMode = false; }
  render();
  if (toMove.length) { dupAsk = { date: forceDate, ids: toMove.slice() }; renderPanel(); }
  const whereDup = (() => {
    if (!dupWhere.length) return '';
    const c = {}; dupWhere.forEach((d) => { c[d] = (c[d] || 0) + 1; });
    return ` 이미 있는 사진 ${dupWhere.length}장은 건너뛰었어요 (` + Object.keys(c).sort().map((d) => `${dayLabel(d)} ${c[d]}장`).join(', ') + '에 있어요).';
  })();
  const moved = toMove.length ? ` 고른 사진 중 ${toMove.length}장은 이미 다른 날에 있어서 올리지 않았어요. 아래에서 옮길지 정해주세요.` : '';
  const extra = (undatedN ? ` 찍은 날짜를 알 수 없는 ${undatedN}장은 ‘언제의 사진?’에 넣었어요.` : '') + moved + whereDup + (bad ? ` ${bad}장은 열 수 없는 형식이라 넣지 못했어요.` : '');
  const where = forceDate ? (() => { const d = new Date(forceDate + 'T00:00:00'); return `${d.getMonth() + 1}월 ${d.getDate()}일에 넣었어요.`; })() : `${dates.size}개 날짜에 나눠 넣었어요.`;
  if (ok) note((ok - undatedN ? `${ok - undatedN}장을 ${where}` : '') + extra);
  else if (dup && !bad) note((moved + whereDup).trim());
  else if (bad) note('사진을 열 수 없었어요. JPG나 PNG 사진인지 확인해 주세요.' + moved + whereDup);
  return ok;
}
const fileInput = $('file');
fileInput.addEventListener('change', () => { addFiles(fileInput.files).finally(() => { fileInput.value = ''; }); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

/* 갤러리 앱의 '공유하기'로 받은 사진 */
async function processPending() {
  const items = await IDB.all('pending').catch(() => []);
  if (!items.length) return;
  if (!Auth.valid()) { note(`공유받은 사진 ${items.length}장이 기다리고 있어요. 구글 드라이브를 연결하면 바로 올라가요.`); showConnect(); return; }
  // 갤러리 앱에서 공유한 사진: 찍은 날짜대로 넣을지, 날짜를 정해 넣을지 고른다
  const files = items.map((x) => x.value);
  $('shInfo').textContent = `갤러리에서 보낸 사진 ${files.length}장이에요. 어떻게 넣을까요?`;
  $('shDate').value = selected !== UNDATED ? selected : ymd(new Date());
  const th = $('shThumbs'); th.innerHTML = '';
  files.slice(0, 8).forEach((f) => { const im = document.createElement('img'); im.alt = ''; im.src = URL.createObjectURL(f); th.appendChild(im); });
  $('shareModal').hidden = false; $('shAuto').focus();
  const clear = () => Promise.all(items.map((x) => IDB.del('pending', x.key))).catch(() => {});
  const done = () => { $('shareModal').hidden = true; th.querySelectorAll('img').forEach((i) => URL.revokeObjectURL(i.src)); };
  $('shAuto').onclick = async () => { done(); await addFiles(files); await clear(); };
  $('shDay').onclick = async () => { const d = $('shDate').value; if (!d) return; done(); await addFiles(files, d); await clear(); };
  $('shDrop').onclick = async () => { done(); await clear(); note('공유받은 사진을 올리지 않았어요.'); };
}
/* 사진 고르는 화면: 기본은 휴대폰 사진 선택기, 설정을 켜면 갤러리·파일 앱 화면 */
const GALLERY_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif';
const pickerAccept = () => (store.get('pa-gallery', false) ? GALLERY_ACCEPT : 'image/*');

/* ---------------- 다른 날로 옮기기 ---------------- */
let dupAsk = null; // { date, ids } 이 날에 추가하려던 사진 중 다른 날에 이미 있는 것
let selectMode = false; const chosen = new Set(); const candChosen = new Set();
/* 날짜 정보가 없어 업로드한 날로 들어갔을 수 있는 사진 (이 기능 전에 올린 사진) */
const suspects = () => photos.filter((p) => !p.src && p.date !== UNDATED && p.date === p.created);
async function movePhotos(ids, date) {
  ids = ids.filter((id) => { const p = photos.find((x) => x.id === id); return p && p.date !== date; });
  if (!ids.length || !(date === UNDATED || /^\d{4}-\d{2}-\d{2}$/.test(date))) return;
  let ok = 0, fail = 0; const log = [];
  for (const id of ids) {
    const p = photos.find((x) => x.id === id); if (!p) continue;
    note(`사진 옮기는 중 ${ok + fail + 1} / ${ids.length}`);
    try {
      const time = (p.takenAt || '').slice(11) || '12:00';
      const before = { id, date: p.date, takenAt: p.takenAt || '', src: p.src || '' };
      const props = { date, takenAt: date === UNDATED ? '' : `${date}T${time}`, src: date === UNDATED ? 'none' : 'user' };
      if (p.ot) props.ot = p.ot; // 원래 찍은 시각은 옮겨도 남겨 둔다 (되돌리기·중복 판별용)
      const u = await patchPhoto(p, props);
      Object.assign(p, { date: u.date, takenAt: u.takenAt, src: u.src, ot: u.ot || p.ot, parent: u.parent, name: u.name }); ok++; log.push(before);
    } catch (e) { if (e instanceof AuthError) { showConnect(); note('구글 연결이 끊겼어요. 다시 연결한 뒤 옮겨주세요.'); break; } fail++; }
  }
  savePhotos(); chosen.clear(); candChosen.clear(); selectMode = false;
  const label = date === UNDATED ? '‘언제의 사진?’' : (() => { const d = new Date(date + 'T00:00:00'); return `${d.getMonth() + 1}월 ${d.getDate()}일`; })();
  if (date !== UNDATED && mode !== 'undated') { if (mode === 'week') selected = date; viewY = +date.slice(0, 4); viewM = +date.slice(5, 7) - 1; }
  render();
  if (ok) { note(`${ok}장을 ${label}${date === UNDATED ? '에' : '로'} 옮겼어요.` + (fail ? ` ${fail}장은 옮기지 못했어요.` : '')); showUndo(log); }
}
/* 방금 옮긴 사진 되돌리기 */
let undoTimer = null;
function showUndo(log) {
  const bar = $('undoBar'); if (!log.length) return;
  bar.hidden = false; clearTimeout(undoTimer); undoTimer = setTimeout(() => { bar.hidden = true; }, 60000);
  $('undoBtn').onclick = async () => {
    bar.hidden = true; let n = 0;
    for (const b of log) {
      const p = photos.find((x) => x.id === b.id); if (!p) continue;
      try {
        const props = { date: b.date, takenAt: b.takenAt, src: b.src }; if (p.ot) props.ot = p.ot;
        const u = await patchPhoto(p, props); Object.assign(p, { date: u.date, takenAt: u.takenAt, src: u.src, parent: u.parent, name: u.name }); n++;
      } catch (e) { if (e instanceof AuthError) { showConnect(); break; } }
    }
    savePhotos(); const d = log[0].date; if (d !== UNDATED && mode !== 'undated') { if (mode === 'week') selected = d; viewY = +d.slice(0, 4); viewM = +d.slice(5, 7) - 1; }
    render(); note(`${n}장을 원래 날짜로 되돌렸어요.`);
  };
}
const canDrag = window.matchMedia('(pointer: fine)').matches;

/* ---------------- 플래너: 연간 달력 → 주간 플래너(주간 쪽 + 모눈 쪽) ---------------- */
const WKM = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MEN2 = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let mode = 'month';          // 'month' 연간 달력 · 'week' 주간 플래너 · 'undated' 언제의 사진?
let phonePage = 0;           // 휴대폰 주간 플래너: 0 주간 쪽, 1 모눈 쪽
let zTop = 10;
const wideMQ = window.matchMedia('(min-width: 1100px)');
const isWide = () => wideMQ.matches;
const onWide = () => { if (!editingNow()) render(); };
if (wideMQ.addEventListener) wideMQ.addEventListener('change', onWide); else if (wideMQ.addListener) wideMQ.addListener(onWide);
const pad2 = (n) => String(n).padStart(2, '0');
const parseD = (s) => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monIdx = (d) => (d.getDay() + 6) % 7;
const mondayOf = (d) => addDays(d, -monIdx(d));
// 주 번호: 1월 1일이 들어 있는 주가 1주 (플래너 표기)
const weekNo = (mon) => { const sun = addDays(mon, 6); const j = mondayOf(new Date(sun.getFullYear(), 0, 1)); return Math.round((mon - j) / 604800000) + 1; };
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const mkb = (txt, cls, fn, aria) => { const b = el('button', 'btn ' + (cls || ''), txt); b.type = 'button'; if (fn) b.onclick = fn; if (aria) b.setAttribute('aria-label', aria); return b; };
const editingNow = () => { const a = document.activeElement; return !!(a && /^(TEXTAREA|INPUT)$/.test(a.tagName) && a.closest && a.closest('#calView')); };

/* ---- 날짜 메모와 대표 사진: 드라이브 Photo Archive/planner.json ---- */
let planner = Object.assign({ v: 1, rep: {}, notes: {} }, store.get('pa-planner', {}));
let plannerId = store.get('pa-planner-id', null), plannerT = null, plannerDirty = false, plannerSaving = false;
function savePlannerSoon() {
  store.set('pa-planner', planner); plannerDirty = true;
  clearTimeout(plannerT); plannerT = setTimeout(savePlanner, 1200);
}
async function savePlanner() {
  if (!plannerDirty || plannerSaving || !Auth.valid()) return;
  plannerSaving = true; plannerDirty = false;
  const body = JSON.stringify(planner);
  try {
    if (plannerId) {
      try { await api(`${UPLOAD}/${plannerId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }); }
      catch (e) { if (e.status === 404) plannerId = null; else throw e; }
    }
    if (!plannerId) {
      const fid = await ensureFolder(); const b = 'pl' + Math.random().toString(36).slice(2);
      const meta = { name: 'planner.json', parents: [fid], mimeType: 'application/json', appProperties: { photoArchive: 'planner' } };
      const r = await api(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` },
        body: new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n`, body, `\r\n--${b}--`]) });
      plannerId = (await r.json()).id; store.set('pa-planner-id', plannerId);
    }
  } catch (e) { plannerDirty = true; if (!(e instanceof AuthError)) { clearTimeout(plannerT); plannerT = setTimeout(savePlanner, 5000); } }
  finally { plannerSaving = false; }
}
async function loadPlanner() {
  if (plannerDirty || plannerSaving) return false;
  const r = await api(`${API}/files?q=${q("appProperties has { key='photoArchive' and value='planner' } and trashed=false")}&spaces=drive&fields=files(id)`);
  const f = ((await r.json()).files || [])[0]; if (!f) return false;
  plannerId = f.id; store.set('pa-planner-id', plannerId);
  const d = await (await api(`${API}/files/${f.id}?alt=media`)).json();
  if (plannerDirty) return false;
  const next = Object.assign({ v: 1, rep: {}, notes: {} }, d);
  const changed = JSON.stringify(next) !== JSON.stringify(planner);
  planner = next; store.set('pa-planner', planner); return changed;
}

/* 그날 사진은 찍은 시각 순서. 대표 사진은 고른 사진, 고르지 않았으면 가장 먼저 찍은 사진 */
function byDate() {
  const g = {}; photos.forEach((p) => { (g[p.date] = g[p.date] || []).push(p); });
  Object.values(g).forEach((a) => a.sort((x, y) => (x.takenAt || '').localeCompare(y.takenAt || '')));
  return g;
}
function repOf(key, list) { const id = planner.rep[key]; const c = id && list.find((p) => p.id === id); return { rep: c || list[0] || null, auto: !c }; }
function dropTarget(elm, key) {
  if (!canDrag) return;
  elm.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-pa-ids')) { e.preventDefault(); e.stopPropagation(); elm.classList.add('drop'); } });
  elm.addEventListener('dragleave', () => elm.classList.remove('drop'));
  elm.addEventListener('drop', (e) => { const ids = e.dataTransfer.getData('text/x-pa-ids'); if (!ids) return; e.preventDefault(); e.stopPropagation(); elm.classList.remove('drop'); movePhotos(ids.split(','), key); });
}
/* 두 줄을 넘기는 입력은 받지 않는다 (줄바꿈으로 저절로 넘어간 줄까지 칸 높이로 잰다) */
function twoLineLimit(ta, onOk) {
  ta.dataset.prev = ta.value;
  ta.addEventListener('input', () => {
    if (ta.value.split('\n').length > 2 || ta.scrollHeight > ta.clientHeight + 1) { ta.value = ta.dataset.prev; return; }
    ta.dataset.prev = ta.value; onOk(ta.value);
  });
}
const fullUrl = new Map();
function cardImg(p) {
  const im = el('img'); im.alt = p.caption || ''; im.draggable = false;
  if (fullUrl.has(p.id)) { im.src = fullUrl.get(p.id); return im; }
  getThumb(p.id).then((u) => { if (!im.dataset.full) im.src = u; }).catch(() => {});
  fullBlob(p.id).then((b) => { if (!fullUrl.has(p.id)) fullUrl.set(p.id, URL.createObjectURL(b)); im.dataset.full = '1'; im.src = fullUrl.get(p.id); }).catch(() => {});
  return im;
}
function openWeek(key) { mode = 'week'; selected = key; phonePage = 0; render(); window.scrollTo({ top: 0 }); }
function toMonth(key) { const d = parseD(key); mode = 'month'; viewY = d.getFullYear(); viewM = d.getMonth(); render(); }

function render() { renderPlanner(); updateTrayCount(); }
function renderPanel() { render(); }
function renderPlanner() {
  if (!Number.isInteger(viewY) || !Number.isInteger(viewM) || viewM < 0 || viewM > 11) { const t = new Date(); viewY = t.getFullYear(); viewM = t.getMonth(); }
  if (mode === 'week' && (!selected || selected === UNDATED)) mode = 'month';
  const g = byDate();
  $('panel').hidden = mode !== 'undated'; $('book').hidden = mode === 'undated';
  if (mode === 'month') renderMonth(g); else if (mode === 'week') renderWeek(g); else renderUndated(g);
}
function undatedButton(g) {
  const und = g[UNDATED] || []; const sus = suspects();
  if (!und.length && !sus.length) return null;
  const u = mkb(`언제의 사진? ${und.length}장` + (sus.length ? ` · 확인할 사진 ${sus.length}장` : ''), 'small dashed', () => { mode = 'undated'; selectMode = false; render(); });
  dropTarget(u, UNDATED); return u;
}

/* ---- 연간 달력: 펼침면 한 장 = 한 달 (왼쪽: 메모 칸 + 월화수, 오른쪽: 목금토일) ---- */
function renderMonth(g) {
  const tool = $('ptool'); tool.innerHTML = '';
  const shiftM = (d) => { viewM += d; if (viewM < 0) { viewM = 11; viewY--; } if (viewM > 11) { viewM = 0; viewY++; } render(); };
  tool.append(mkb('‹', 'small', () => shiftM(-1), '이전 달'));
  if (isWide()) {
    const tabs = el('nav', 'mtabs'); tabs.setAttribute('aria-label', '달 선택');
    for (let i = 0; i < 12; i++) { const b = mkb(String(i + 1), 'small mtab', () => { viewM = i; render(); }, `${viewY}년 ${i + 1}월`); b.setAttribute('aria-pressed', String(i === viewM)); tabs.append(b); }
    tool.append(tabs, mkb('›', 'small', () => shiftM(1), '다음 달'), el('span', 'ptool-y num', String(viewY)));
  } else tool.append(el('span', 'ptool-y num', `${viewY}.${pad2(viewM + 1)}`), mkb('›', 'small', () => shiftM(1), '다음 달'));
  tool.append(mkb('오늘', 'small', () => { const t = new Date(); viewY = t.getFullYear(); viewM = t.getMonth(); render(); }));
  const u = undatedButton(g); if (u) { u.classList.add('spacer'); tool.append(u); }

  const book = $('book'); book.innerHTML = ''; const wide = isWide();
  book.className = 'book' + (wide ? ' wide' : ' narrow');
  const first = monIdx(new Date(viewY, viewM, 1)); const nd = new Date(viewY, viewM + 1, 0).getDate(); const today = ymd(new Date());
  const cell = (i) => {
    const d = i - first + 1; const col = i % 7;
    if (i < 0 || d < 1 || d > nd) return el('div', 'pc out');
    const k = `${viewY}-${pad2(viewM + 1)}-${pad2(d)}`; const list = g[k] || []; const { rep } = repOf(k, list);
    const w = el('div', 'pc' + (col === 6 ? ' sun' : '') + (k === today ? ' today' : ''));
    const hit = el('button', 'pc-hit'); hit.type = 'button';
    hit.setAttribute('aria-label', `${viewM + 1}월 ${d}일, 사진 ${list.length}장, 주간 플래너 열기`); hit.onclick = () => openWeek(k); dropTarget(hit, k);
    w.append(hit, el('span', 'pc-n', String(d)));
    if (list.length) { const th = el('span', 'pc-th'); th.appendChild(thumbImg(rep)); w.append(th, el('span', 'pc-c', String(list.length))); }
    const memo = el('textarea', 'pc-memo' + (d < 10 ? ' one' : '')); memo.rows = 2; memo.maxLength = 24; memo.value = planner.notes[k] || '';
    memo.setAttribute('aria-label', `${viewM + 1}월 ${d}일 메모 (두 줄)`);
    twoLineLimit(memo, (v) => { if (v) planner.notes[k] = v; else delete planner.notes[k]; savePlannerSoon(); });
    w.append(memo);
    return w;
  };
  const head = (labels) => { const h = el('div', 'mlabels'); labels.forEach((t) => { if (t && typeof t === 'object') h.append(t); else h.append(el('span', 'wdl' + (t === 'SUN' ? ' sun' : ''), t || '')); }); return h; };
  if (wide) {
    const mt = el('div', 'mhead'); mt.append(el('span', 'mbig', String(viewM + 1)), el('span', 'men', MEN2[viewM]));
    const L = el('section', 'pp'); L.setAttribute('aria-label', `${viewY}년 ${viewM + 1}월 달력 왼쪽 쪽`);
    const R = el('section', 'pp'); R.setAttribute('aria-label', `${viewY}년 ${viewM + 1}월 달력 오른쪽 쪽`);
    const gl = el('div', 'pgrid'), gr = el('div', 'pgrid');
    for (let r = 0; r < 6; r++) {
      gl.append(el('div', 'pc note'), cell(r * 7), cell(r * 7 + 1), cell(r * 7 + 2));
      gr.append(cell(r * 7 + 3), cell(r * 7 + 4), cell(r * 7 + 5), cell(r * 7 + 6));
    }
    L.append(head([mt, 'MON', 'TUE', 'WED']), gl); R.append(head(['THU', 'FRI', 'SAT', 'SUN']), gr);
    book.append(L, R);
  } else {
    const P = el('section', 'pp'); P.setAttribute('aria-label', `${viewY}년 ${viewM + 1}월 달력`);
    const mt = el('div', 'mhead'); mt.append(el('span', 'mbig', String(viewM + 1)), el('span', 'men', MEN2[viewM]));
    const h = el('div', 'mlabels seven'); WKM.forEach((t) => h.append(el('span', 'wdl' + (t === 'SUN' ? ' sun' : ''), t)));
    const gd = el('div', 'pgrid seven'); for (let i = 0; i < 42; i++) gd.append(cell(i));
    P.append(mt, h, gd, el('p', 'note', '날짜를 누르면 그 주 플래너로 넘어가요. 날짜 옆 빈 곳에 메모를 적을 수 있어요.'));
    book.append(P);
  }
}

/* ---- 주간 플래너 ---- */
function miniCal(month, mon, sun) {
  const box = el('div', 'mini'); box.append(el('b', '', String(month.getMonth() + 1)));
  const gd = el('div', 'mini-g'); 'MTWTFSS'.split('').forEach((h, i) => gd.append(el('span', 'h' + (i === 6 ? ' sun' : ''), h)));
  const f = monIdx(month); const n = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  for (let i = 0; i < Math.ceil((f + n) / 7) * 7; i++) {
    const d = i - f + 1; const inM = d >= 1 && d <= n; const dt = new Date(month.getFullYear(), month.getMonth(), d); const col = i % 7;
    const s = el('span', col === 6 ? 'sun' : '', inM ? String(d) : '');
    if (inM && dt >= mon && dt <= sun) { s.classList.add('in'); if (col === 0 || d === 1) s.classList.add('l'); if (col === 6 || d === n) s.classList.add('r'); }
    gd.append(s);
  }
  box.append(gd); return box;
}
function buildWeekPage(g, mon, sun, day) {
  const s = el('section', 'pp'); s.setAttribute('aria-label', `${mon.getMonth() + 1}월 ${weekNo(mon)}주`);
  const head = el('div', 'wkhead'); const t = el('div', 'wkt'); t.append(el('span', 'mbig', String(mon.getMonth() + 1)), el('span', 'wkno', `week ${weekNo(mon)}`));
  const minis = el('div', 'minis'); minis.append(miniCal(new Date(mon.getFullYear(), mon.getMonth(), 1), mon, sun));
  if (isWide()) minis.append(miniCal(new Date(mon.getFullYear(), mon.getMonth() + 1, 1), mon, sun));
  head.append(t, minis); s.append(head);
  const rows = el('div', 'wrows'); const maxN = isWide() ? 5 : 4;
  for (let i = 0; i < 7; i++) {
    const dt = addDays(mon, i); const k = ymd(dt); const list = g[k] || []; const { rep } = repOf(k, list);
    const row = el('div', 'wr' + (k === day ? ' on' : ''));
    [7.4, 37, 66.7].forEach((x) => { const dot = el('span', 'dot'); dot.style.left = x + '%'; dot.setAttribute('aria-hidden', 'true'); row.append(dot); });
    const pick = () => { selected = k; if (!isWide()) phonePage = 1; render(); };
    const db = el('button', 'wr-d' + (i === 6 ? ' sun' : '')); db.type = 'button'; db.setAttribute('aria-label', `${dt.getMonth() + 1}월 ${dt.getDate()}일 사진 보기`); db.onclick = pick;
    db.append(el('span', 'wr-n', String(dt.getDate())), el('span', 'wr-w', WKM[i]));
    const th = el('div', 'wr-th');
    list.slice(0, maxN).forEach((p) => {
      const b = el('button', 'wr-p'); b.type = 'button'; b.setAttribute('aria-label', `${dt.getMonth() + 1}월 ${dt.getDate()}일 ${(p.takenAt || '').slice(11, 16)} 사진`); b.onclick = pick;
      b.appendChild(thumbImg(p)); if (p === rep) b.append(el('span', 'tag', '대표'));
      if (canDrag) { b.draggable = true; b.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-pa-ids', p.id); e.dataTransfer.effectAllowed = 'move'; }); }
      th.append(b);
    });
    if (list.length > maxN) th.append(el('span', 'wr-more', `+${list.length - maxN}`));
    dropTarget(row, k);
    row.append(db, th); rows.append(row);
  }
  s.append(rows);
  if (!isWide()) s.append(el('p', 'note', '날짜를 누르거나 왼쪽으로 밀면 그날 사진이 모눈 쪽에 펼쳐져요.'));
  return s;
}
const pendingCap = {}, pendingGeom = {};
function buildDayPage(g, day) {
  const dd = parseD(day); const list = g[day] || []; const { rep, auto } = repOf(day, list);
  const s = el('section', 'pp gp'); s.setAttribute('aria-label', `${dd.getMonth() + 1}월 ${dd.getDate()}일 사진`);
  const head = el('div', 'dphead'); head.append(el('span', 'dpdate', `${dd.getMonth() + 1}.${pad2(dd.getDate())}`), el('span', 'dpwk', `${WKM[monIdx(dd)]} · ${dd.getFullYear()}`), el('span', 'dpcnt', `${list.length}장${list.length ? ' · 사진은 끌어서 옮기고, 모서리를 끌어 크기를 바꿔요' : ''}`));
  s.append(head);
  if (planner.notes[day]) s.append(el('p', 'dpnote onpaper', '달력 메모 · ' + planner.notes[day].replace(/\n/g, ' / ')));
  if (dupAsk && dupAsk.date === day) renderDupAsk(s);
  const area = el('div', 'cards'); s.append(area);
  if (!list.length) area.append(el('p', 'empty onpaper', '이 날에는 사진이 없어요. 아래 ‘사진 추가’로 갤러리에서 골라 넣을 수 있어요.'));
  const foot = el('div', 'dpfoot');
  if (CLIENT_ID && Auth.valid()) {
    const lab = el('label', 'btn small upload', `＋ ${dd.getMonth() + 1}월 ${dd.getDate()}일에 사진 추가`);
    const inp = el('input'); inp.type = 'file'; inp.accept = pickerAccept(); inp.multiple = true; inp.setAttribute('aria-label', '이 날에 사진 추가');
    inp.addEventListener('change', () => { const fs = [...inp.files]; inp.value = ''; addFiles(fs, day); });
    lab.append(inp); foot.append(lab);
  }
  if (list.length) {
    const allIn = list.every((x) => tray[x.id]);
    foot.append(mkb(allIn ? '이 날 사진 인쇄 목록에서 빼기' : '이 날 사진 모두 인쇄 목록에 담기', 'small', () => { list.forEach((x) => { if (allIn) delete tray[x.id]; else tray[x.id] = tray[x.id] || 1; }); saveTray(); render(); }));
  }
  if (auto && list.length > 1) foot.append(el('span', 'note onpaper', '대표 사진을 고르지 않아 가장 먼저 찍은 사진이 대표예요'));
  s.append(foot);
  s._cards = { area, list, rep, auto, day };
  return s;
}
/* 모눈 쪽 사진 카드: 위치(gx, gy)와 너비(gw)는 쪽 크기에 대한 비율로 사진마다 드라이브에 저장 */
function placeCards(info) {
  const { area, list, rep, auto, day } = info; const AW = area.clientWidth, AH = area.clientHeight; const n = list.length;
  if (!AW || !AH) return;
  const baseF = n <= 1 ? 0.78 : n === 2 ? 0.54 : n === 3 ? 0.46 : n === 4 ? 0.41 : 0.31;
  const defPos = (i) => {
    if (n <= 1) return { x: 0.11, y: 0.02 };
    if (n === 2) return [{ x: 0, y: 0 }, { x: 0.43, y: 0.5 }][i];
    if (n === 3) return [{ x: 0, y: 0 }, { x: 0.53, y: 0.09 }, { x: 0.24, y: 0.55 }][i];
    if (n === 4) return [{ x: 0, y: 0 }, { x: 0.565, y: 0.05 }, { x: 0.04, y: 0.52 }, { x: 0.565, y: 0.57 }][i];
    return { x: (i % 3) * 0.343, y: Math.floor(i / 3) * 0.36 };
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  list.forEach((p, i) => {
    const ar = p.w && p.h ? clamp(p.w / p.h, 0.6, 1.8) : 4 / 3;
    const def = defPos(i);
    const card = el('figure', 'card'); card.style.zIndex = String(i + 1);
    const ph = el('div', 'card-ph'); ph.style.aspectRatio = String(ar); ph.setAttribute('role', 'img'); ph.setAttribute('aria-label', `${(p.takenAt || '').slice(11, 16)} 사진, 끌어서 옮기기`);
    ph.append(cardImg(p)); if (p === rep) ph.append(el('span', 'tag big', '대표 사진'));
    const rs = el('button', 'card-rs'); rs.type = 'button'; rs.setAttribute('aria-label', '사진 크기 조절 (끌기)');
    rs.innerHTML = '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><path d="M9 3L3 9M9 6L6 9"/></svg>';
    ph.append(rs);
    const cap = el('figcaption', 'card-cap');
    const ta = el('textarea', 'card-txt'); ta.rows = 2; ta.placeholder = '사진 설명을 적어보세요'; ta.value = p.caption || ''; ta.setAttribute('aria-label', `${(p.takenAt || '').slice(11, 16)} 사진 설명`);
    ta.addEventListener('input', () => {
      p.caption = ta.value; pendingCap[p.id] = ta.value; clearTimeout(ta._t);
      ta._t = setTimeout(() => { patchPhoto(p, {}, p.caption).then(() => { if (pendingCap[p.id] === p.caption) delete pendingCap[p.id]; savePhotos(); }).catch((e) => { if (e instanceof AuthError) showConnect(); }); }, 900);
    });
    const row = el('div', 'card-row');
    row.append(el('span', 'card-time', (p.takenAt || '').slice(11, 16) + (p === rep && auto && n > 1 ? ' · 가장 먼저 찍음' : '')));
    const rb = mkb(p === rep ? '대표 사진' : '대표로', 'small card-b' + (p === rep ? ' on' : ''), () => { planner.rep[day] = p.id; savePlannerSoon(); render(); }); rb.setAttribute('aria-pressed', String(p === rep));
    const cnt = tray[p.id] || 0;
    const pb = mkb(cnt ? `인쇄 ${cnt}` : '＋ 인쇄', 'small card-b' + (cnt ? ' on' : ''), () => { if (tray[p.id]) delete tray[p.id]; else tray[p.id] = 1; saveTray(); render(); });
    const ib = mkb('정보', 'small card-b', () => openPhoto(p.id), '사진 정보 · 날짜 바꾸기 · 삭제');
    row.append(rb, pb, ib); cap.append(ta, row); card.append(ph, cap); area.append(card);

    let w = clamp((p.gw != null ? p.gw : def.x != null ? baseF : baseF) * AW, 100, AW);
    let x = clamp((p.gx != null ? p.gx : def.x) * AW, 0, Math.max(0, AW - w));
    let y = (p.gy != null ? p.gy : def.y) * AH;
    const apply = () => { card.style.width = w + 'px'; card.style.left = x + 'px'; card.style.top = y + 'px'; };
    apply();
    const capH = () => card.offsetHeight - ph.offsetHeight;
    y = clamp(y, 0, Math.max(0, AH - card.offsetHeight)); apply();
    const saveGeom = () => {
      p.gx = x / AW; p.gy = y / AH; p.gw = w / AW; pendingGeom[p.id] = { gx: p.gx, gy: p.gy, gw: p.gw };
      clearTimeout(card._t);
      card._t = setTimeout(() => {
        patchPhoto(p, { gx: p.gx.toFixed(4), gy: p.gy.toFixed(4), gw: p.gw.toFixed(4) }).then(() => { delete pendingGeom[p.id]; savePhotos(); }).catch((e) => { if (e instanceof AuthError) showConnect(); });
      }, 600);
    };
    const drag = (e, onMove) => {
      e.preventDefault(); e.stopPropagation(); card.style.zIndex = String(++zTop);
      const sx = e.clientX, sy = e.clientY, x0 = x, y0 = y, w0 = w; const t = e.currentTarget; try { t.setPointerCapture(e.pointerId); } catch (_) {}
      const mv = (ev) => { onMove(ev.clientX - sx, ev.clientY - sy, x0, y0, w0); apply(); };
      const up = () => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); saveGeom(); };
      t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
    };
    ph.addEventListener('pointerdown', (e) => {
      if (e.target === rs || rs.contains(e.target)) return;
      drag(e, (dx, dy, x0, y0) => { x = clamp(x0 + dx, 0, Math.max(0, AW - w)); y = clamp(y0 + dy, 0, Math.max(0, AH - card.offsetHeight)); });
    });
    rs.addEventListener('pointerdown', (e) => drag(e, (dx, dy, x0, y0, w0) => {
      const dw = Math.abs(dx) > Math.abs(dy * ar) ? dx : dy * ar;          // 비율은 그대로, 더 많이 움직인 쪽 기준
      const maxByH = (AH - y - capH()) * ar + 12;
      w = clamp(w0 + dw, 100, Math.max(100, Math.min(AW - x, maxByH)));
    }));
  });
}
function renderWeek(g) {
  const day = selected; const dd = parseD(day); const mon = mondayOf(dd); const sun = addDays(mon, 6); const wide = isWide();
  const tool = $('ptool'); tool.innerHTML = '';
  tool.append(mkb(`‹ ${dd.getMonth() + 1}월 달력으로`, 'small primary', () => toMonth(day)));
  const shiftW = (n) => { const nm = addDays(mon, n); let pick = nm; for (let i = 0; i < 7; i++) { const t = addDays(nm, i); if ((g[ymd(t)] || []).length) { pick = t; break; } } selected = ymd(pick); render(); };
  tool.append(mkb('‹ 이전 주', 'small', () => shiftW(-7)), mkb('다음 주 ›', 'small', () => shiftW(7)));
  tool.append(el('span', 'rng', `${mon.getMonth() + 1}.${pad2(mon.getDate())} — ${sun.getMonth() + 1}.${pad2(sun.getDate())}`));
  const u = undatedButton(g); if (u) { u.classList.add('spacer'); tool.append(u); }

  const book = $('book'); book.innerHTML = '';
  const left = buildWeekPage(g, mon, sun, day), right = buildDayPage(g, day);
  if (wide) {
    book.className = 'book wide'; book.append(left, right);
  } else {
    book.className = 'book narrow';
    const seg = el('div', 'seg'); seg.setAttribute('aria-label', '쪽 선택');
    const bW = mkb('주간', 'small', () => setPage(0)), bG = mkb('모눈', 'small', () => setPage(1)); seg.append(bW, bG);
    if (!u) seg.classList.add('spacer'); tool.append(seg);
    const view = el('div', 'swipe'); const track = el('div', 'track'); track.append(left, right); view.append(track); book.append(view);
    const setPage = (n) => {
      phonePage = n; track.style.transform = `translateX(${n ? '-50%' : '0'})`;
      bW.setAttribute('aria-pressed', String(n === 0)); bG.setAttribute('aria-pressed', String(n === 1));
      if (n === 1 && !right._placed) { right._placed = true; requestAnimationFrame(() => placeCards(right._cards)); }
    };
    // 왼쪽으로 밀면 모눈 쪽, 오른쪽으로 밀면 주간 쪽 (사진 옮기기·글쓰기와는 겹치지 않게)
    view.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.card, textarea, input, label')) return;
      const sx = e.clientX, sy = e.clientY;
      const up = (ev) => {
        window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) setPage(dx < 0 ? 1 : 0);
      };
      window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    track.style.transition = 'none'; setPage(phonePage); requestAnimationFrame(() => { track.style.transition = ''; });
    return;
  }
  right._placed = true; placeCards(right._cards);
}

/* ---- 언제의 사진? ---- */
function renderUndated() {
  const tool = $('ptool'); tool.innerHTML = '';
  tool.append(mkb('‹ 달력으로', 'small primary', () => { mode = 'month'; render(); }));
  renderUndatedPanel();
}
function renderUndatedPanel() {
  const p = $('panel'); p.innerHTML = ''; const list = byDate()[UNDATED] || [];
  const h = el('div', 'ph'); h.append(el('span', 'date', '언제의 사진?'), el('span', 'cnt num', `${list.length}장`)); p.append(h);
  p.append(el('p', 'note', '찍은 날짜를 알 수 없는 사진이에요. 골라서 날짜를 정하면 달력으로 옮겨져요.'));
  if (!list.length) { p.append(el('div', 'empty', '날짜를 알 수 없는 사진이 없어요.')); renderSuspects(p); return; }
  const acts = el('div', 'panelacts');
  if (!selectMode) {
    const allIn = list.every((x) => tray[x.id]);
    acts.append(
      mkb(allIn ? '모두 인쇄 목록에서 빼기' : '모두 인쇄 목록에 담기', 'small', () => { list.forEach((x) => { if (allIn) delete tray[x.id]; else tray[x.id] = tray[x.id] || 1; }); saveTray(); render(); }),
      mkb('골라서 날짜 정하기', 'small', () => { selectMode = true; chosen.clear(); render(); })
    );
  } else {
    const ids = list.map((x) => x.id); [...chosen].forEach((id) => { if (!ids.includes(id)) chosen.delete(id); });
    const di = el('input', 'datein'); di.type = 'date'; di.id = 'moveDate'; di.setAttribute('aria-label', '옮길 날짜');
    const go = mkb('이 날짜로 옮기기', 'small primary', () => { if (di.value) movePhotos([...chosen], di.value); }); go.disabled = true;
    di.addEventListener('input', () => { go.disabled = !chosen.size || !di.value; });
    acts.append(mkb(chosen.size === list.length ? '선택 해제' : '전체 선택', 'small', () => { if (chosen.size === list.length) chosen.clear(); else ids.forEach((id) => chosen.add(id)); render(); }),
      el('span', 'note', `${chosen.size}장 선택`), di, go, mkb('취소', 'small', () => { selectMode = false; chosen.clear(); render(); }));
  }
  p.append(acts);
  const tiles = el('div', 'tiles');
  list.forEach((x) => {
    const f = el('figure', 'tile'); const o = el('button', 'open'); o.type = 'button'; o.setAttribute('aria-label', (x.caption || '사진') + ' 정보'); o.appendChild(thumbImg(x));
    if (selectMode) { f.classList.toggle('chosen', chosen.has(x.id)); o.setAttribute('aria-pressed', String(chosen.has(x.id))); o.onclick = () => { if (chosen.has(x.id)) chosen.delete(x.id); else chosen.add(x.id); render(); }; }
    else o.onclick = () => openPhoto(x.id);
    if (canDrag && !selectMode) { o.draggable = true; o.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-pa-ids', x.id); e.dataTransfer.effectAllowed = 'move'; }); }
    const n = tray[x.id] || 0; const pk = el('button', 'pick', n ? `인쇄 ${n}` : '＋ 인쇄'); pk.type = 'button'; pk.setAttribute('aria-pressed', String(n > 0));
    pk.onclick = () => { if (tray[x.id]) delete tray[x.id]; else tray[x.id] = 1; saveTray(); render(); };
    const cap = el('div', 'cap', x.caption || '');
    if (selectMode) { const ck = el('span', 'ck', chosen.has(x.id) ? '✓' : ''); f.append(o, ck, cap); } else f.append(o, pk, cap);
    tiles.append(f);
  });
  p.append(tiles); renderSuspects(p);
}
function renderDupAsk(p) {
  const items = dupAsk.ids.map((id) => photos.find((x) => x.id === id)).filter((x) => x && x.date !== dupAsk.date);
  if (!items.length) { dupAsk = null; return; }
  const box = document.createElement('div'); box.className = 'suspects';
  const h = document.createElement('div'); h.className = 'sh';
  h.innerHTML = `<b>이미 다른 날에 있는 사진 ${items.length}장</b><span class="note">이 날에 넣으려던 사진과 같은 사진이 다른 날짜에 있어요. 이 날로 옮길지, 원래 날짜에 둘지 정해주세요.</span>`;
  box.appendChild(h);
  const tiles = document.createElement('div'); tiles.className = 'tiles';
  items.forEach((x) => {
    const f = document.createElement('figure'); f.className = 'tile';
    const o = document.createElement('button'); o.type = 'button'; o.className = 'open'; o.appendChild(thumbImg(x)); o.onclick = () => openPhoto(x.id);
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = `지금: ${dayLabel(x.date)}`;
    f.append(o, cap); tiles.appendChild(f);
  });
  box.appendChild(tiles);
  const acts = document.createElement('div'); acts.className = 'panelacts';
  const mv = document.createElement('button'); mv.type = 'button'; mv.className = 'btn small primary'; mv.textContent = `${dayLabel(dupAsk.date)}로 옮기기`;
  mv.onclick = () => { const ids = items.map((x) => x.id), d = dupAsk.date; dupAsk = null; movePhotos(ids, d); };
  const keep = document.createElement('button'); keep.type = 'button'; keep.className = 'btn small'; keep.textContent = '원래 날짜에 그대로 두기';
  keep.onclick = () => { dupAsk = null; note(''); renderPanel(); };
  acts.append(mv, keep); box.appendChild(acts); p.appendChild(box);
}
function renderSuspects(p) {
  const sus = suspects(); if (!sus.length) return;
  const sec = document.createElement('div'); sec.className = 'suspects';
  const h = document.createElement('div'); h.className = 'sh';
  h.innerHTML = `<b>업로드한 날로 들어갔을 수 있는 사진 ${sus.length}장</b><span class="note">이 기능 전에 올린 사진 중 찍은 날짜를 못 읽어 올린 날 칸에 들어갔을 수 있는 사진이에요. 실제로 그날 찍은 사진은 그냥 두세요.</span>`;
  sec.appendChild(h);
  const acts = document.createElement('div'); acts.className = 'panelacts';
  const mk = (t, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small' + (cls ? ' ' + cls : ''); b.textContent = t; b.onclick = fn; return b; };
  const ids = sus.map((x) => x.id); [...candChosen].forEach((id) => { if (!ids.includes(id)) candChosen.delete(id); });
  const go = mk(`선택한 ${candChosen.size}장을 언제의 사진?으로`, () => movePhotos([...candChosen], UNDATED), 'primary'); go.disabled = !candChosen.size;
  const keep = mk('선택한 사진은 날짜가 맞아요', async () => {
    for (const id of [...candChosen]) { const x = photos.find((q) => q.id === id); if (!x) continue; try { await patchPhoto(x, { src: 'user' }); x.src = 'user'; } catch (e) { if (e instanceof AuthError) break; } }
    candChosen.clear(); savePhotos(); render();
  }); keep.disabled = !candChosen.size;
  acts.append(mk(candChosen.size === sus.length ? '선택 해제' : '전체 선택', () => { if (candChosen.size === sus.length) candChosen.clear(); else ids.forEach((id) => candChosen.add(id)); renderPanel(); }), go, keep);
  sec.appendChild(acts);
  const tiles = document.createElement('div'); tiles.className = 'tiles';
  sus.forEach((x) => {
    const f = document.createElement('figure'); f.className = 'tile' + (candChosen.has(x.id) ? ' chosen' : '');
    const o = document.createElement('button'); o.type = 'button'; o.className = 'open'; o.setAttribute('aria-pressed', String(candChosen.has(x.id))); o.setAttribute('aria-label', '사진 선택');
    o.appendChild(thumbImg(x)); o.onclick = () => { if (candChosen.has(x.id)) candChosen.delete(x.id); else candChosen.add(x.id); renderPanel(); };
    const ck = document.createElement('span'); ck.className = 'ck'; ck.textContent = candChosen.has(x.id) ? '✓' : '';
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = x.date.slice(5).replace('-', '.') + ' 칸';
    f.append(o, ck, cap); tiles.appendChild(f);
  });
  sec.appendChild(tiles); p.appendChild(sec);
}
function updateTrayCount() {
  const ids = new Set(photos.map((p) => p.id)); let n = 0;
  for (const k of Object.keys(tray)) { if (loaded && !ids.has(k)) { delete tray[k]; continue; } n += tray[k]; }
  $('trayCount').textContent = n;
}

/* ---------------- 사진 편집 ---------------- */
let ed = null, pmId = null;
async function openPhoto(id) {
  const p = photos.find((x) => x.id === id); if (!p) return; pmId = id;
  $('pmDate').value = p.date === UNDATED ? '' : p.date; $('pmCaption').value = p.caption || ''; $('pmCopies').value = tray[id] || 0; $('pmStatus').textContent = '';
  $('pmDelete').textContent = '사진 삭제'; $('pmDelete').dataset.armed = '';
  const back = $('pmRestore'); const od = (p.ot || '').slice(0, 10);
  back.hidden = !(od && /^\d{4}-\d{2}-\d{2}$/.test(od) && od !== p.date);
  if (!back.hidden) { back.textContent = `찍은 날짜(${dayLabel(od)})로 되돌리기`; back.onclick = () => { closePhoto(); movePhotos([p.id], od); }; }
  const img = $('pmImg'); img.removeAttribute('src'); img.style.transform = p.rot ? `rotate(${p.rot * 90}deg)` : '';
  $('photoModal').hidden = false; $('pmClose').focus();
  getThumb(id).then((u) => { if (pmId === id && !img.src) img.src = u; }).catch(() => {});
  try { const b = await fullBlob(id); if (pmId === id) img.src = URL.createObjectURL(b); }
  catch (e) { if (e instanceof AuthError) { $('pmStatus').textContent = '구글 연결이 끊겼어요. 다시 연결해 주세요.'; showConnect(); } }
}
/* 인쇄 목록 안의 인쇄 영역 편집 */
async function openCrop(id) {
  const p = photos.find((x) => x.id === id); if (!p) return;
  const box = $('cropEdit'); box.hidden = false; $('ceStatus').textContent = '사진 불러오는 중…';
  $('ceTitle').textContent = `${p.date === UNDATED ? '날짜 모름' : p.date.replace(/-/g, '.')} ${p.caption || ''}`.trim();
  $('ceSize').textContent = `${S.w / 10}×${S.h / 10} cm`;
  $('cropHint').textContent = '밝은 테두리 안이 인쇄될 부분이에요. 끌어서 위치를 맞추고 확대·회전할 수 있어요.';
  const c = $('cropCanvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const im = await loadFull(p);
    ed = { id, img: im, rot: p.rot || 0, zoom: p.zoom || 1, cx: p.cx, cy: p.cy }; ed.src = rotated(im, ed.rot);
    $('zoom').value = ed.zoom; drawCrop(); $('ceStatus').textContent = '';
  } catch (e) { $('ceStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 다시 연결해 주세요.' : '사진을 불러오지 못했어요.'; if (e instanceof AuthError) showConnect(); }
}
function closeCrop() { $('cropEdit').hidden = true; ed = null; }
$('ceCancel').onclick = closeCrop;
$('ceSave').onclick = async () => {
  if (!ed) return; const p = photos.find((x) => x.id === ed.id); if (!p) return;
  $('ceSave').disabled = true; $('ceStatus').textContent = '저장 중…';
  try {
    const upd = await patchPhoto(p, { zoom: ed.zoom.toFixed(3), cx: ed.cx.toFixed(4), cy: ed.cy.toFixed(4), rot: String(ed.rot) });
    Object.assign(p, { zoom: upd.zoom, cx: upd.cx, cy: upd.cy, rot: upd.rot }); savePhotos();
    closeCrop(); renderPrint();
  } catch (e) {
    $('ceStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 다시 연결한 뒤 저장해 주세요.' : '저장하지 못했어요. 잠시 후 다시 눌러주세요.';
    if (e instanceof AuthError) showConnect();
  } finally { $('ceSave').disabled = false; }
};
function drawCrop() {
  if (!ed) return; const c = $('cropCanvas'); const H0 = Math.round(360 * S.h / S.w); const k = Math.min(1, 300 / H0);
  c.width = Math.round(360 * k); c.height = Math.round(H0 * k); const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); const r = cropRect(ed, c.width, c.height); g.drawImage(ed.src, r.sx, r.sy, r.vw, r.vh, 0, 0, c.width, c.height);
}
function closePhoto() { $('photoModal').hidden = true; pmId = null; }
$('pmClose').onclick = closePhoto;
$('photoModal').addEventListener('click', (e) => { if (e.target === $('photoModal')) closePhoto(); });
$('zoom').addEventListener('input', (e) => { if (!ed) return; ed.zoom = +e.target.value; drawCrop(); });
function rot(d) { if (!ed) return; ed.rot = (ed.rot + d + 4) % 4; ed.src = rotated(ed.img, ed.rot); ed.cx = 0.5; ed.cy = 0.5; drawCrop(); }
$('rotL').onclick = () => rot(-1); $('rotR').onclick = () => rot(1);
$('recenter').onclick = () => { if (!ed) return; ed.cx = 0.5; ed.cy = 0.5; ed.zoom = 1; $('zoom').value = 1; drawCrop(); };
(function () {
  const box = $('cropbox'); let drag = null;
  box.addEventListener('pointerdown', (e) => { if (!ed) return; drag = { x: e.clientX, y: e.clientY }; box.setPointerCapture(e.pointerId); });
  box.addEventListener('pointermove', (e) => {
    if (!drag || !ed) return; const c = $('cropCanvas'); const k = c.width / c.getBoundingClientRect().width; const r = cropRect(ed, c.width, c.height); const [sw, sh] = dims(ed.src);
    ed.cx -= (e.clientX - drag.x) * k / r.s / sw; ed.cy -= (e.clientY - drag.y) * k / r.s / sh; drag = { x: e.clientX, y: e.clientY }; drawCrop();
  });
  const end = () => { drag = null; }; box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  box.addEventListener('wheel', (e) => { if (!ed) return; e.preventDefault(); ed.zoom = Math.max(1, Math.min(4, ed.zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06))); $('zoom').value = ed.zoom; drawCrop(); }, { passive: false });
})();
const copiesVal = () => Math.max(0, Math.min(999, parseInt($('pmCopies').value, 10) || 0));
$('pmMinus').onclick = () => { $('pmCopies').value = Math.max(0, copiesVal() - 1); };
$('pmPlus').onclick = () => { $('pmCopies').value = Math.min(999, copiesVal() + 1); };
$('pmSave').onclick = async () => {
  if (!pmId) return; const p = photos.find((x) => x.id === pmId); if (!p) return;
  const date = $('pmDate').value || p.date; const n = copiesVal(); const dateChanged = date !== p.date;
  if (n > 0) tray[p.id] = n; else delete tray[p.id]; saveTray();
  $('pmSave').disabled = true; $('pmStatus').textContent = '저장 중…';
  try {
    const upd = await patchPhoto(p, { date, takenAt: !dateChanged ? p.takenAt : `${date}T${(p.takenAt || '').slice(11) || '12:00'}`, src: dateChanged ? 'user' : (p.src || '') }, $('pmCaption').value.trim());
    Object.assign(p, upd); savePhotos();
    if (dateChanged && upd.date !== UNDATED && mode !== 'undated') { if (mode === 'week') selected = upd.date; viewY = +upd.date.slice(0, 4); viewM = +upd.date.slice(5, 7) - 1; }
    closePhoto(); render();
  } catch (e) {
    $('pmStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 위의 연결 버튼을 누른 뒤 다시 저장해 주세요.' : '저장하지 못했어요. 잠시 후 다시 눌러주세요.';
    if (e instanceof AuthError) showConnect();
  } finally { $('pmSave').disabled = false; }
};
$('pmDelete').onclick = async () => {
  const b = $('pmDelete'); if (!pmId) return;
  if (!b.dataset.armed) {
    b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 삭제돼요 (드라이브 휴지통으로 이동)'; return;
  }
  const id = pmId; b.disabled = true;
  try {
    await trashPhoto(id); photos = photos.filter((x) => x.id !== id); delete tray[id]; saveTray(); savePhotos();
    IDB.del('thumbs', id).catch(() => {}); closePhoto(); render(); note('사진을 드라이브 휴지통으로 옮겼어요. 30일 안에는 드라이브에서 되살릴 수 있어요.');
  } catch (e) { $('pmStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 다시 연결해 주세요.' : '삭제하지 못했어요. 다시 시도해 주세요.'; }
  finally { b.disabled = false; }
};
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (!$('photoModal').hidden) closePhoto(); else if (!$('printModal').hidden) closePrint(); });

/* ---------------- 인쇄 (A4 PDF) ---------------- */
function layout() {
  const aw = A4W - 2 * S.margin, ah = A4H - 2 * S.margin;
  const cols = Math.max(0, Math.floor((aw + S.gap) / (S.w + S.gap))), rows = Math.max(0, Math.floor((ah + S.gap) / (S.h + S.gap)));
  // 사진 묶음을 용지 가운데에 둔다 (가장자리는 최소 1cm)
  const ox = (A4W - (cols * S.w + (cols - 1) * S.gap)) / 2, oy = (A4H - (rows * S.h + (rows - 1) * S.gap)) / 2; const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: ox + c * (S.w + S.gap), y: oy + r * (S.h + S.gap) });
  return { cols, rows, per: cols * rows, cells };
}
const trayItems = () => Object.keys(tray).map((id) => photos.find((p) => p.id === id)).filter(Boolean).sort((a, b) => (a.takenAt || '').localeCompare(b.takenAt || ''));
async function prepared() {
  const out = [];
  for (const p of trayItems()) { const im = await loadFull(p); out.push({ p, n: tray[p.id], src: rotated(im, p.rot || 0), zoom: p.zoom || 1, cx: p.cx, cy: p.cy }); }
  return out;
}
let tok = 0;
async function renderPrint() {
  const ul = $('tray'); ul.innerHTML = ''; const items = trayItems();
  if (!items.length) { const li = document.createElement('li'); li.style.gridTemplateColumns = '1fr'; li.className = 'note'; li.textContent = '담긴 사진이 없어요. 날짜를 눌러 사진의 ‘＋ 인쇄’를 눌러주세요.'; ul.appendChild(li); }
  items.forEach((p) => {
    const li = document.createElement('li'); const im = thumbImg(p);
    const lb = document.createElement('div'); lb.className = 'lbl'; lb.textContent = `${p.date === UNDATED ? '날짜 모름' : p.date.replace(/-/g, '.')} ${p.caption || ''}`;
    const st = document.createElement('div'); st.className = 'stepper';
    const m = document.createElement('button'); m.type = 'button'; m.textContent = '−'; m.setAttribute('aria-label', '매수 줄이기');
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '1'; inp.max = '999'; inp.value = tray[p.id]; inp.id = 'tc-' + p.id; inp.setAttribute('aria-label', '매수');
    const pl = document.createElement('button'); pl.type = 'button'; pl.textContent = '+'; pl.setAttribute('aria-label', '매수 늘리기');
    m.onclick = () => { tray[p.id] = Math.max(1, tray[p.id] - 1); saveTray(); renderPrint(); };
    pl.onclick = () => { tray[p.id] = Math.min(999, tray[p.id] + 1); saveTray(); renderPrint(); };
    inp.onchange = () => { tray[p.id] = Math.max(1, Math.min(999, parseInt(inp.value, 10) || 1)); saveTray(); renderPrint(); };
    st.append(m, inp, pl);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'btn small'; x.textContent = '빼기'; x.onclick = () => { if (ed && ed.id === p.id) closeCrop(); delete tray[p.id]; saveTray(); renderPrint(); };
    const edb = document.createElement('button'); edb.type = 'button'; edb.className = 'btn small'; edb.textContent = '편집'; edb.onclick = () => openCrop(p.id);
    const acts = document.createElement('div'); acts.className = 'tacts'; acts.append(edb, x);
    li.append(im, lb, st, acts); ul.appendChild(li);
  });
  document.querySelectorAll('#presets .btn').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.w === S.w && +b.dataset.h === S.h)));
  const L = layout(); const total = items.reduce((a, p) => a + tray[p.id], 0); const pages = L.per ? Math.max(1, Math.ceil(total / L.per)) : 0;
  $('prSummary').textContent = L.per ? `A4 한 장에 ${L.cols}×${L.rows} = ${L.per}칸 · ${total}장 · ${pages}페이지` : '사진이 A4에 들어가지 않아요. 크기나 여백을 줄여주세요.';
  $('prSave').disabled = !total || !L.per; render();
  if (ed) { $('ceSize').textContent = `${S.w / 10}×${S.h / 10} cm`; drawCrop(); }
  const t = ++tok; const box = $('prPages');
  let prep; try { prep = await prepared(); } catch (e) { if (t === tok) { box.innerHTML = ''; $('prStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겨서 미리보기를 못 만들었어요. 다시 연결해 주세요.' : '사진을 불러오지 못했어요.'; } return; }
  if (t !== tok) return;
  box.innerHTML = ''; if (!L.per) return;
  const urls = {}; prep.forEach((it) => { urls[it.p.id] = renderCrop(it, Math.round(S.w * 4), Math.round(S.h * 4)).toDataURL('image/jpeg', 0.8); });
  const all = []; prep.forEach((it) => { for (let i = 0; i < it.n; i++) all.push(it.p.id); });
  for (let pg = 0; pg < Math.max(1, Math.ceil(all.length / L.per)); pg++) {
    const lab = document.createElement('div'); lab.className = 'plabel'; lab.textContent = `PAGE ${pg + 1}`;
    const a4 = document.createElement('div'); a4.className = 'a4';
    L.cells.forEach((c, i) => {
      const id = all[pg * L.per + i]; if (!id) return; const d = document.createElement('div'); d.className = 'cell' + (S.cut ? ' cut' : '');
      d.style.left = c.x / A4W * 100 + '%'; d.style.top = c.y / A4H * 100 + '%'; d.style.width = S.w / A4W * 100 + '%'; d.style.height = S.h / A4H * 100 + '%';
      const im = document.createElement('img'); im.alt = ''; im.src = urls[id]; d.appendChild(im); d.title = '눌러서 편집'; d.onclick = () => openCrop(id); a4.appendChild(d);
    });
    box.append(lab, a4);
  }
}
function openPrint() {
  $('printModal').hidden = false; $('prStatus').textContent = '';
  $('sw').value = S.w; $('sh').value = S.h; $('sgap').value = S.gap; $('scut').checked = S.cut;
  renderPrint(); $('prClose').focus();
}
function closePrint() { $('printModal').hidden = true; closeCrop(); }
$('trayBtn').onclick = openPrint; $('prClose').onclick = closePrint;
$('printModal').addEventListener('click', (e) => { if (e.target === $('printModal')) closePrint(); });
['sw', 'sh', 'sgap'].forEach((id) => $(id).addEventListener('change', () => {
  const num = (k, a, b, d) => { const v = parseFloat($(k).value); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
  S.w = num('sw', 5, 210, 30); S.h = num('sh', 5, 297, 20); S.gap = num('sgap', 0, 20, 2); saveSize(); renderPrint();
}));
$('scut').addEventListener('change', (e) => { S.cut = e.target.checked; saveSize(); renderPrint(); });
document.querySelectorAll('#presets .btn').forEach((b) => { b.onclick = () => { S.w = +b.dataset.w; S.h = +b.dataset.h; $('sw').value = S.w; $('sh').value = S.h; saveSize(); renderPrint(); }; });
$('prClear').onclick = () => { tray = {}; saveTray(); renderPrint(); };
$('prSave').onclick = async () => {
  const L = layout(); const btn = $('prSave'); if (!L.per) return;
  if (!window.jspdf) { $('prStatus').textContent = 'PDF 도구를 불러오지 못했어요. 앱을 새로고침해 주세요.'; return; }
  btn.disabled = true; $('prStatus').textContent = 'PDF 만드는 중…';
  try {
    const prep = await prepared(); const W = Math.round(S.w * DPMM), H = Math.round(S.h * DPMM);
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    const data = {}; prep.forEach((it) => { data[it.p.id] = renderCrop(it, W, H).toDataURL('image/jpeg', 0.92); });
    const all = []; prep.forEach((it) => { for (let i = 0; i < it.n; i++) all.push(it.p.id); });
    for (let pg = 0; pg < Math.ceil(all.length / L.per); pg++) {
      if (pg) doc.addPage('a4', 'portrait');
      L.cells.forEach((c, i) => {
        const id = all[pg * L.per + i]; if (!id) return;
        doc.addImage(data[id], 'JPEG', c.x, c.y, S.w, S.h, 'i' + id, 'NONE');
        if (S.cut) { doc.setDrawColor(185); doc.setLineWidth(0.1); doc.rect(c.x, c.y, S.w, S.h); }
      });
    }
    const label = (document.querySelector('#presets .btn[aria-pressed="true"]') || {}).textContent || '';
    const kind = label.startsWith('캘린더형') ? '캘린더형_' : label.startsWith('리스트형') ? '리스트형_' : '';
    const name = `사진_${kind}${S.w / 10}x${S.h / 10}cm_${ymd(new Date()).replace(/-/g, '')}.pdf`;
    const url = URL.createObjectURL(doc.output('blob'));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('prStatus').textContent = `${name}을(를) 다운로드 폴더에 저장했어요. 실제 크기(100%)로 인쇄하세요.`;
  } catch (e) {
    $('prStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 다시 연결한 뒤 저장해 주세요.' : 'PDF를 만들지 못했어요. 다시 시도해 주세요.';
    if (e instanceof AuthError) showConnect();
  } finally { btn.disabled = false; }
};

/* ---------------- 메모지 인쇄 (A4 위 76×76mm 6칸) ---------------- */
const NOTE = 76;                         // 메모지 한 변 (mm)
const NOTE_GX = 14, NOTE_GY = 14;        // 칸 사이 간격 (mm)
const NOTE_X0 = (A4W - (2 * NOTE + NOTE_GX)) / 2;   // 22mm
const NOTE_Y0 = (A4H - (3 * NOTE + 2 * NOTE_GY)) / 2; // 20.5mm
const WEEK_KO = ['월', '화', '수', '목', '금', '토', '일'];
const defSlot = () => ({ tpl: 'todo', title: '', items: '', spacing: 7, date: false });
const memo = Object.assign({ slots: [], dx: 0, dy: 0, outline: false, cur: 0 }, store.get('pa-memo', {}));
while (memo.slots.length < 6) memo.slots.push(defSlot());
memo.slots = memo.slots.slice(0, 6).map((x) => Object.assign(defSlot(), x));
const saveMemo = () => store.set('pa-memo', memo);
function noteSlots(withOffset) {
  const dx = withOffset ? +memo.dx || 0 : 0, dy = withOffset ? +memo.dy || 0 : 0; const out = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) out.push({ x: NOTE_X0 + c * (NOTE + NOTE_GX) + dx, y: NOTE_Y0 + r * (NOTE + NOTE_GY) + dy });
  return out;
}
/* 한 칸을 캔버스에 그린다. pxmm = 1mm당 픽셀 수 */
function drawNote(slot, pxmm) {
  const S0 = Math.round(NOTE * pxmm); const c = document.createElement('canvas'); c.width = S0; c.height = S0;
  const g = c.getContext('2d'); const mm = (v) => v * pxmm;
  // 배경은 투명: 템플릿 칸에는 선과 글자만 찍히고 메모지 바탕은 건드리지 않는다
  if (slot.tpl === 'off') {
    // 붙일 자리 가이드: 테두리, 접착 부분 점선, 가운데 십자선
    g.strokeStyle = '#555'; g.lineWidth = Math.max(1, mm(0.25)); g.strokeRect(mm(0.15), mm(0.15), S0 - mm(0.3), S0 - mm(0.3));
    g.setLineDash([mm(1), mm(1)]); g.strokeStyle = '#999'; g.lineWidth = Math.max(1, mm(0.15));
    g.beginPath(); g.moveTo(0, mm(15)); g.lineTo(S0, mm(15)); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#999'; g.font = `400 ${mm(2.4)}px sans-serif`; g.fillText('접착 부분', mm(2), mm(13.5));
    g.strokeStyle = '#777'; g.lineWidth = Math.max(1, mm(0.15)); g.beginPath();
    g.moveTo(mm(NOTE / 2 - 4), mm(NOTE / 2 + 8)); g.lineTo(mm(NOTE / 2 + 4), mm(NOTE / 2 + 8));
    g.moveTo(mm(NOTE / 2), mm(NOTE / 2 + 4)); g.lineTo(mm(NOTE / 2), mm(NOTE / 2 + 12)); g.stroke();
    g.fillStyle = '#c8c6bf'; g.font = `500 ${mm(9)}px sans-serif`; g.textAlign = 'center'; g.fillText('메모지 붙이기', mm(NOTE / 2), mm(NOTE / 2 + 1)); g.textAlign = 'left';
    return c;
  }
  const pad = 5; const ink = '#2f2f2d', soft = '#a9a7a0', faint = '#cfcdc6';
  const font = (sz, w) => `${w || 400} ${mm(sz)}px "Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif`;
  g.textBaseline = 'alphabetic'; g.lineCap = 'round';
  let top = pad;
  if (slot.title || slot.date) {
    const base = pad + 5;
    if (slot.title) { g.fillStyle = ink; g.font = font(4.2, 500); g.fillText(slot.title, mm(pad), mm(base), mm(NOTE - pad * 2 - (slot.date ? 22 : 0))); }
    if (slot.date) {
      g.fillStyle = soft; g.font = font(2.6); g.textAlign = 'right';
      g.fillText('.      .', mm(NOTE - pad), mm(base)); g.textAlign = 'left';
      g.strokeStyle = faint; g.lineWidth = mm(0.2); g.beginPath(); g.moveTo(mm(NOTE - pad - 20), mm(base + 1)); g.lineTo(mm(NOTE - pad), mm(base + 1)); g.stroke();
    }
    g.strokeStyle = ink; g.lineWidth = mm(0.3); g.beginPath(); g.moveTo(mm(pad), mm(base + 2.2)); g.lineTo(mm(NOTE - pad), mm(base + 2.2)); g.stroke();
    top = base + 2.2;
  }
  const sp = Math.max(5, Math.min(12, +slot.spacing || 7)); const bottom = NOTE - pad;
  if (slot.tpl === 'lines' || slot.tpl === 'todo') {
    const items = slot.tpl === 'todo' ? (slot.items || '').split('\n').map((t) => t.trim()).filter(Boolean) : [];
    let i = 0;
    for (let y = top + sp; y <= bottom + 0.01; y += sp, i++) {
      g.strokeStyle = faint; g.lineWidth = mm(0.2); g.beginPath();
      if (slot.tpl === 'todo') {
        const box = Math.min(3.4, sp - 2.4); const bx = pad, by = y - box - 1;
        g.strokeStyle = soft; g.lineWidth = mm(0.25); g.strokeRect(mm(bx), mm(by), mm(box), mm(box));
        g.strokeStyle = faint; g.lineWidth = mm(0.2); g.beginPath(); g.moveTo(mm(pad + box + 2), mm(y)); g.lineTo(mm(NOTE - pad), mm(y)); g.stroke();
        if (items[i]) { g.fillStyle = ink; g.font = font(Math.min(3.3, sp * 0.48)); g.fillText(items[i], mm(pad + box + 2.6), mm(y - 1.1), mm(NOTE - pad * 2 - box - 3)); }
      } else { g.moveTo(mm(pad), mm(y)); g.lineTo(mm(NOTE - pad), mm(y)); g.stroke(); }
    }
  } else if (slot.tpl === 'grid' || slot.tpl === 'dots') {
    const step = 5; const x0 = pad, x1 = NOTE - pad, y0 = top + 2, y1 = bottom;
    const nx = Math.floor((x1 - x0) / step), ny = Math.floor((y1 - y0) / step);
    const ox = x0 + ((x1 - x0) - nx * step) / 2, oy = y0 + ((y1 - y0) - ny * step) / 2;
    if (slot.tpl === 'grid') {
      g.strokeStyle = faint; g.lineWidth = mm(0.18); g.beginPath();
      for (let i = 0; i <= nx; i++) { g.moveTo(mm(ox + i * step), mm(oy)); g.lineTo(mm(ox + i * step), mm(oy + ny * step)); }
      for (let j = 0; j <= ny; j++) { g.moveTo(mm(ox), mm(oy + j * step)); g.lineTo(mm(ox + nx * step), mm(oy + j * step)); }
      g.stroke();
    } else {
      g.fillStyle = soft;
      for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) { g.beginPath(); g.arc(mm(ox + i * step), mm(oy + j * step), mm(0.32), 0, Math.PI * 2); g.fill(); }
    }
  } else if (slot.tpl === 'week') {
    const rows = 7; const h = (bottom - top) / rows;
    for (let i = 0; i < rows; i++) {
      const y = top + h * (i + 1);
      g.fillStyle = i === 6 ? '#a3333d' : i === 5 ? '#4c6a8a' : ink; g.font = font(Math.min(3.4, h * 0.42), 500);
      g.fillText(WEEK_KO[i], mm(pad), mm(y - h * 0.32));
      g.strokeStyle = faint; g.lineWidth = mm(0.2); g.beginPath(); g.moveTo(mm(pad), mm(y)); g.lineTo(mm(NOTE - pad), mm(y)); g.stroke();
    }
    g.strokeStyle = faint; g.beginPath(); g.moveTo(mm(pad + 6), mm(top)); g.lineTo(mm(pad + 6), mm(bottom)); g.stroke();
  }
  return c;
}
let fontsReady = null;
function ensureFonts() {
  if (!fontsReady) fontsReady = (document.fonts && document.fonts.load ? Promise.all([document.fonts.load('400 16px "Noto Sans KR"', '가'), document.fonts.load('500 16px "Noto Sans KR"', '가')]) : Promise.resolve()).catch(() => {});
  return fontsReady;
}
async function renderMemo() {
  await ensureFonts();
  const pv = $('mmPreview'); pv.innerHTML = '';
  const top = document.createElement('div'); top.className = 'toplabel'; top.textContent = '▲ 위쪽 (프린터에 먼저 들어가는 쪽)'; pv.appendChild(top);
  noteSlots(false).forEach((pos, i) => {
    const sl = memo.slots[i]; const b = document.createElement('button'); b.type = 'button';
    b.className = 'slot' + (sl.tpl === 'off' ? ' guide' : ' tpl'); b.setAttribute('aria-pressed', String(i === memo.cur)); b.setAttribute('aria-label', `${i + 1}번 칸 편집`);
    b.style.left = pos.x / A4W * 100 + '%'; b.style.top = pos.y / A4H * 100 + '%'; b.style.width = NOTE / A4W * 100 + '%'; b.style.height = NOTE / A4H * 100 + '%';
    b.appendChild(drawNote(sl, 4));
    const no = document.createElement('span'); no.className = 'no'; no.textContent = i + 1; b.appendChild(no);
    b.onclick = () => { memo.cur = i; saveMemo(); loadSlotForm(); renderMemo(); };
    pv.appendChild(b);
  });
  const ss = $('mmSlotSel'); ss.innerHTML = '';
  memo.slots.forEach((sl, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = i + 1;
    b.setAttribute('aria-pressed', String(i === memo.cur)); b.setAttribute('aria-label', `${i + 1}번 칸`);
    b.onclick = () => { memo.cur = i; saveMemo(); loadSlotForm(); renderMemo(); }; ss.appendChild(b);
  });
}
function loadSlotForm() {
  const sl = memo.slots[memo.cur];
  $('mmTpl').value = sl.tpl; $('mmTitleIn').value = sl.title; $('mmItems').value = sl.items; $('mmSpacing').value = sl.spacing; $('mmDate').checked = !!sl.date;
  $('mmItemsWrap').hidden = sl.tpl !== 'todo';
  $('mmSpacing').closest('.field').hidden = !(sl.tpl === 'todo' || sl.tpl === 'lines');
  $('mmDx').value = memo.dx; $('mmDy').value = memo.dy;
}
function readSlotForm() {
  const sl = memo.slots[memo.cur];
  sl.tpl = $('mmTpl').value; sl.title = $('mmTitleIn').value.trim(); sl.items = $('mmItems').value;
  sl.spacing = Math.max(5, Math.min(12, parseFloat($('mmSpacing').value) || 7)); sl.date = $('mmDate').checked;
  saveMemo(); loadSlotForm(); renderMemo();
}
['mmTpl', 'mmDate'].forEach((id) => $(id).addEventListener('change', readSlotForm));
['mmTitleIn', 'mmItems', 'mmSpacing'].forEach((id) => { let t; $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(readSlotForm, 250); }); });
['mmDx', 'mmDy'].forEach((id) => $(id).addEventListener('change', () => {
  const v = (k) => { const n = parseFloat($(k).value); return isFinite(n) ? Math.max(-15, Math.min(15, n)) : 0; };
  memo.dx = v('mmDx'); memo.dy = v('mmDy'); saveMemo(); loadSlotForm();
}));
$('mmApplyAll').onclick = () => {
  const src = memo.slots[memo.cur]; memo.slots = memo.slots.map(() => Object.assign({}, src)); saveMemo(); renderMemo();
  $('mmStatus').textContent = `${memo.cur + 1}번 칸 설정을 6칸 모두에 적용했어요.`;
};
function savePdf(doc, name, statusEl) {
  const url = URL.createObjectURL(doc.output('blob'));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  statusEl.textContent = `${name}을(를) 다운로드 폴더에 저장했어요. 실제 크기(100%)로 인쇄하세요.`;
}
function guideSlot(doc, p, i) {
  doc.setDrawColor(70); doc.setLineWidth(0.25); doc.rect(p.x, p.y, NOTE, NOTE);
  doc.setDrawColor(170); doc.setLineWidth(0.15); doc.setLineDashPattern([1, 1], 0); doc.line(p.x, p.y + 15, p.x + NOTE, p.y + 15); doc.setLineDashPattern([], 0);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(150); doc.text('GLUE', p.x + 2, p.y + 13.5);
  doc.setFontSize(16); doc.setTextColor(200); doc.text(String(i + 1), p.x + NOTE / 2, p.y + NOTE / 2 + 2, { align: 'center' });
  doc.setDrawColor(120); doc.setLineWidth(0.15);
  doc.line(p.x + NOTE / 2 - 4, p.y + NOTE / 2 + 8, p.x + NOTE / 2 + 4, p.y + NOTE / 2 + 8);
  doc.line(p.x + NOTE / 2, p.y + NOTE / 2 + 4, p.x + NOTE / 2, p.y + NOTE / 2 + 12);
  for (let k = -8; k <= 8; k++) {
    const L = k % 5 === 0 ? 2.5 : 1.2;
    doc.line(p.x + 10 + k, p.y - L, p.x + 10 + k, p.y);
    doc.line(p.x - L, p.y + 30 + k, p.x, p.y + 30 + k);
  }
}
function topMark(doc) {
  doc.setDrawColor(60); doc.setLineWidth(0.4); doc.line(105, 4, 105, 12); doc.line(105, 4, 102, 7.5); doc.line(105, 4, 108, 7.5);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(110); doc.text('TOP  /  STICKY EDGE UP', 111, 9);
}
$('mmGuide').onclick = () => {
  if (!window.jspdf) { $('mmStatus').textContent = 'PDF 도구를 불러오지 못했어요. 앱을 새로고침해 주세요.'; return; }
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  topMark(doc); noteSlots(false).forEach((p, i) => guideSlot(doc, p, i));
  doc.setFontSize(7); doc.setTextColor(120); doc.text('Note 76 x 76 mm  |  print at 100% (actual size)', 105, 292, { align: 'center' });
  savePdf(doc, '메모지_위치가이드_A4.pdf', $('mmStatus'));
};
$('mmPrint').onclick = async () => {
  if (!window.jspdf) { $('mmStatus').textContent = 'PDF 도구를 불러오지 못했어요. 앱을 새로고침해 주세요.'; return; }
  $('mmStatus').textContent = 'PDF 만드는 중…'; await ensureFonts();
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const pos = noteSlots(true), base = noteSlots(false);
  const used = memo.slots.filter((x) => x.tpl !== 'off').length, guides = 6 - used;
  if (guides) topMark(doc);
  memo.slots.forEach((sl, i) => {
    if (sl.tpl === 'off') { guideSlot(doc, base[i], i); return; }   // 템플릿 없는 칸: 메모지 붙일 자리 가이드
    const c = drawNote(sl, DPMM);                                    // 템플릿 칸: 메모지 안 템플릿만
    doc.addImage(c.toDataURL('image/png'), 'PNG', pos[i].x, pos[i].y, NOTE, NOTE, 'note' + i, 'FAST');
  });
  const name = used ? `메모지_템플릿${used}칸${guides ? '_가이드' + guides + '칸' : ''}_${ymd(new Date()).replace(/-/g, '')}.pdf` : '메모지_위치가이드_A4.pdf';
  savePdf(doc, name, $('mmStatus'));
};
function openMemo() { $('memoModal').hidden = false; $('mmStatus').textContent = ''; loadSlotForm(); renderMemo(); $('mmClose').focus(); }
function closeMemo() { $('memoModal').hidden = true; }
$('memoBtn').onclick = openMemo; $('mmClose').onclick = closeMemo;
$('memoModal').addEventListener('click', (e) => { if (e.target === $('memoModal')) closeMemo(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('memoModal').hidden) closeMemo(); });

/* ---------------- 메뉴 · 설치 · 연결 ---------------- */
$('optGallery').checked = !!store.get('pa-gallery', false); $('file').accept = pickerAccept();
$('optGallery').addEventListener('change', (e) => { store.set('pa-gallery', e.target.checked); $('file').accept = pickerAccept(); renderPanel(); });
$('optOriginal').checked = !!store.get('pa-original', false);
$('optOriginal').addEventListener('change', (e) => store.set('pa-original', e.target.checked));
$('appVersion').textContent = `앱 버전 ${APP_VERSION}`;
$('menuBtn').onclick = () => { const m = $('menu'); m.hidden = !m.hidden; $('menuBtn').setAttribute('aria-expanded', String(!m.hidden)); };
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (_) {} installEvt = null; $('installBtn').hidden = true; };
$('refreshBtn').onclick = () => sync(true);
$('signOutBtn').onclick = () => { Auth.signOut(); accountEmail = ''; store.del('pa-email'); photos = []; loaded = false; savePhotos(); render(); showConnect(); note('드라이브 연결을 해제했어요. 드라이브에 저장된 사진은 그대로 남아 있어요.'); };

function showConnect() {
  if (!CLIENT_ID) { $('setup').hidden = false; $('connect').hidden = true; $('uploadBtn').hidden = true; return; }
  const linked = Auth.valid();
  $('connect').hidden = linked; $('uploadBtn').hidden = !linked;
  if (!linked && store.get('pa-linked', false)) {
    $('connect').querySelector('h2').textContent = '구글 드라이브 다시 연결';
    $('connectNote').textContent = '보안을 위해 연결은 1시간마다 새로 확인해요. 한 번 누르면 바로 이어져요.';
  }
  $('syncBtn').hidden = !CLIENT_ID;
  $('driveInfo').textContent = linked ? `구글 드라이브 ‘Photo Archive’ 폴더에 저장하고 있어요.${accountEmail ? ' 연결된 계정: ' + accountEmail + ' (휴대폰과 노트북이 같은 계정이어야 사진이 같이 보여요)' : ''}` : '';
}
$('connectBtn').onclick = async () => {
  $('connectNote').textContent = '구글 창에서 계정을 고르고 허용을 눌러주세요.';
  try { await Auth.request(); accountEmail = ''; store.del('pa-email'); showConnect(); note(''); await sync(true); await processPending(); }
  catch (e) { $('connectNote').textContent = e && e.type === 'popup_closed' ? '연결 창이 닫혔어요. 다시 눌러주세요.' : '연결하지 못했어요. 팝업이 막혀 있다면 허용한 뒤 다시 눌러주세요.'; }
};

let syncing = false, lastSync = 0, accountEmail = store.get('pa-email', '');
function setSyncLabel(text) { $('syncLabel').textContent = text; }
async function loadAccount() {
  try {
    const r = await api(`${API}/about?fields=user(emailAddress)`); const j = await r.json();
    accountEmail = (j.user && j.user.emailAddress) || ''; store.set('pa-email', accountEmail); showConnect();
  } catch (_) {}
}
const sig = (list) => list.map((p) => [p.id, p.date, p.caption, p.rot, p.zoom, p.cx, p.cy, p.parent].join('|')).sort().join('#');
async function sync(force) {
  if (!Auth.valid()) { showConnect(); setSyncLabel('연결 필요'); return; }
  if (syncing || uploading) return;
  syncing = true; setSyncLabel('동기화 중…');
  if (force) note('드라이브에서 사진 목록을 가져오는 중…');
  try {
    const fresh = await listAll();
    // 아직 드라이브에 저장 중인 설명·모눈 위치는 덮어쓰지 않는다
    fresh.forEach((p) => { if (pendingCap[p.id] != null) p.caption = pendingCap[p.id]; if (pendingGeom[p.id]) Object.assign(p, pendingGeom[p.id]); });
    let plChanged = false; try { plChanged = await loadPlanner(); } catch (e) { if (e instanceof AuthError) throw e; }
    const changed = sig(fresh) !== sig(photos) || !loaded;
    const added = fresh.filter((p) => !photos.some((x) => x.id === p.id)).length;
    photos = fresh; loaded = true; savePhotos(); lastSync = Date.now();
    if (!jumped && photos.length && mode === 'month') {
      jumped = true; const mk = `${viewY}-${String(viewM + 1).padStart(2, '0')}`;
      const dated = photos.map((p) => p.date).filter((d) => d !== UNDATED).sort();
      if (dated.length && !dated.some((d) => d.startsWith(mk))) { const last = dated.pop(); selected = last; viewY = +last.slice(0, 4); viewM = +last.slice(5, 7) - 1; }
    }
    if ((changed || plChanged) && $('photoModal').hidden && !editingNow()) render(); else updateTrayCount();
    if (force) note('');
    else if (added && changed && document.visibilityState === 'visible') note(`다른 기기에서 추가한 사진 ${added}장을 가져왔어요.`);
    setSyncLabel('동기화됨 ' + hm(new Date()));
    if (!accountEmail) loadAccount();
    await tidyFolders();
    backfillPrints();
  } catch (e) {
    if (e instanceof AuthError) { showConnect(); note(''); setSyncLabel('연결 필요'); }
    else { setSyncLabel('동기화 실패'); if (force) note('드라이브에서 사진을 가져오지 못했어요. 인터넷 연결을 확인하고 ↻ 동기화를 눌러주세요.'); }
  } finally { syncing = false; }
}
$('syncBtn').onclick = async () => {
  if (!Auth.valid()) { try { await Auth.request(); showConnect(); } catch (_) { return; } }
  sync(true);
};
// 다른 기기에서 올린 사진이 자동으로 따라오게: 화면으로 돌아올 때 + 보고 있는 동안 40초마다
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastSync > 10000) sync(false); });
window.addEventListener('focus', () => { if (Date.now() - lastSync > 10000) sync(false); });
setInterval(() => { if (document.visibilityState === 'visible' && Auth.valid()) sync(false); }, 40000);

/* ---------------- 시작 ---------------- */
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}
Auth.restore();
render();
showConnect();
const params = new URLSearchParams(location.search);
if (params.has('shared')) { history.replaceState(null, '', location.pathname); if (params.get('shared') === 'error') note('공유받은 사진을 받지 못했어요. 앱에서 ‘사진 추가’로 다시 골라주세요.'); }
(async () => {
  if (Auth.valid()) { await sync(false); }
  await processPending();
})();
})();
