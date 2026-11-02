/* 사진 보관함 — 구글 드라이브에 사진을 저장하고, 촬영 날짜별 달력으로 보여주고, 3×2cm A4 PDF로 인쇄한다. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id);
const CLIENT_ID = (window.APP_CONFIG && window.APP_CONFIG.googleClientId || '').trim();
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FIELDS = 'id,name,description,appProperties,createdTime,imageMediaMetadata(width,height)';
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
const S = Object.assign({ w: 30, h: 20, gap: 2, margin: 10, cut: true }, store.get('pa-size', {}));
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
    this.token = null; this.exp = 0; store.del('pa-token'); store.del('pa-linked'); store.del('pa-folder');
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

let folderId = store.get('pa-folder', null);
async function ensureFolder() {
  if (folderId) {
    try { const r = await api(`${API}/files/${folderId}?fields=id,trashed`); const j = await r.json(); if (!j.trashed) return folderId; } catch (e) { if (e instanceof AuthError) throw e; }
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
}
function fromFile(f) {
  const a = f.appProperties || {}; const im = f.imageMediaMetadata || {};
  const created = new Date(f.createdTime || Date.now());
  return {
    id: f.id, name: f.name, date: a.date || ymd(created), takenAt: a.takenAt || `${ymd(created)}T${hm(created)}`,
    caption: f.description || '', zoom: +a.zoom || 1, cx: a.cx != null ? +a.cx : 0.5, cy: a.cy != null ? +a.cy : 0.5, rot: +a.rot || 0,
    w: +a.w || im.width || 0, h: +a.h || im.height || 0
  };
}
async function listAll() {
  const fid = await ensureFolder();
  const out = []; let page = '';
  do {
    const r = await api(`${API}/files?q=${q(`'${fid}' in parents and trashed=false and mimeType contains 'image/'`)}&pageSize=1000&fields=nextPageToken,files(${FIELDS})${page ? '&pageToken=' + page : ''}`);
    const j = await r.json(); (j.files || []).forEach((f) => out.push(fromFile(f))); page = j.nextPageToken || '';
  } while (page);
  return out;
}
async function uploadPhoto(blob, mime, name, props, caption) {
  const fid = await ensureFolder();
  const meta = { name, parents: [fid], mimeType: mime, appProperties: props, description: caption || '' };
  const b = 'pa' + Math.random().toString(36).slice(2);
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`, blob, `\r\n--${b}--`]);
  const r = await api(`${UPLOAD}?uploadType=multipart&fields=${q(FIELDS)}`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  return fromFile(await r.json());
}
async function patchPhoto(id, props, caption) {
  const r = await api(`${API}/files/${id}?fields=${q(FIELDS)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appProperties: props, description: caption }) });
  return fromFile(await r.json());
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
  if (i0[0x8769]) { const ex = ifd(g32(i0[0x8769].val)); s = str(ex[0x9003]) || str(ex[0x9004]); }
  s = s || str(i0[0x0132]);
  const m = s && s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/); if (!m || m[1] === '0000') return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` };
}
function nameDate(name) {
  const m = (name || '').match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ ]?(\d{2})(\d{2}))?/);
  if (!m) return null; const mo = +m[2], d = +m[3]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, at: `${m[1]}-${m[2]}-${m[3]}T${m[4] || '12'}:${m[5] || '00'}` };
}

/* ---------------- 사진 추가 (한 번에 여러 장 → 날짜별 자동 분류) ---------------- */
async function addFiles(list) {
  const files = [...(list || [])].filter((f) => f && (!f.type || f.type.startsWith('image/')));
  if (!files.length) return 0;
  if (uploading) { note('지금 다른 사진을 올리는 중이에요. 끝난 뒤 다시 추가해 주세요.'); return 0; }
  if (!Auth.valid()) { try { await Auth.request(); } catch (_) { note('구글 드라이브에 연결해야 사진을 저장할 수 있어요.'); showConnect(); return 0; } }
  uploading = true; const original = $('optOriginal').checked;
  let ok = 0, bad = 0, done = 0; const dates = new Set(); let latest = null;
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const lm = new Date(f.lastModified || Date.now());
        const info = (await exifDate(f)) || nameDate(f.name) || { date: ymd(lm), at: `${ymd(lm)}T${hm(lm)}` };
        const im = await blobToImage(f);
        const [w0, h0] = dims(im);
        let blob = f, mime = f.type || 'image/jpeg', w = w0, h = h0;
        if (!original || !/^image\/(jpeg|png|webp)$/.test(mime)) {
          const c = scaled(im, original ? 6000 : 2000); blob = await toBlob(c, 'image/jpeg', 0.9); mime = 'image/jpeg'; w = c.width; h = c.height;
        }
        const thumb = await toBlob(scaled(im, 400), 'image/jpeg', 0.82);
        URL.revokeObjectURL(im.src);
        const base = (f.name || 'photo').replace(/\.[^.]+$/, '');
        const p = await uploadPhoto(blob, mime, `${info.date}_${base}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`,
          { date: info.date, takenAt: info.at, zoom: '1', cx: '0.5', cy: '0.5', rot: '0', w: String(w), h: String(h) }, '');
        await IDB.put('thumbs', thumb, p.id).catch(() => {});
        thumbURL.set(p.id, Promise.resolve(URL.createObjectURL(thumb)));
        photos.push(p); ok++; dates.add(p.date); if (!latest || p.date > latest) latest = p.date;
      } catch (e) {
        if (e instanceof AuthError) { queue.length = 0; note('구글 연결이 끊겼어요. 다시 연결한 뒤 남은 사진을 추가해 주세요.'); showConnect(); }
        else bad++;
      }
      done++; note(`사진 올리는 중 ${done} / ${files.length}`);
      if (done % 4 === 0) { savePhotos(); render(); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  uploading = false; savePhotos();
  if (latest) { selected = latest; viewY = +latest.slice(0, 4); viewM = +latest.slice(5, 7) - 1; }
  render();
  if (ok) note(`${ok}장을 ${dates.size}개 날짜에 나눠 넣었어요.` + (bad ? ` ${bad}장은 열 수 없는 형식이라 넣지 못했어요.` : ''));
  else if (bad) note('사진을 열 수 없었어요. JPG나 PNG 사진인지 확인해 주세요.');
  return ok;
}
const fileInput = $('file');
fileInput.addEventListener('change', () => { addFiles(fileInput.files).finally(() => { fileInput.value = ''; }); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer && e.dataTransfer.files); });

/* 갤러리 앱의 '공유하기'로 받은 사진 */
async function processPending() {
  const items = await IDB.all('pending').catch(() => []);
  if (!items.length) return;
  if (!Auth.valid()) { note(`공유받은 사진 ${items.length}장이 기다리고 있어요. 구글 드라이브를 연결하면 바로 올라가요.`); showConnect(); return; }
  const files = items.map((x) => x.value);
  const n = await addFiles(files);
  if (n || files.length) await Promise.all(items.map((x) => IDB.del('pending', x.key))).catch(() => {});
}

/* ---------------- 달력 ---------------- */
function byDate() {
  const g = {}; photos.forEach((p) => { (g[p.date] = g[p.date] || []).push(p); });
  Object.values(g).forEach((a) => a.sort((x, y) => (x.takenAt || '').localeCompare(y.takenAt || '')));
  return g;
}
function render() { renderCal(); renderPanel(); updateTrayCount(); }
function renderCal() {
  const g = byDate();
  $('mNum').textContent = viewM + 1; $('mYear').textContent = viewY; $('mEn').textContent = MEN[viewM];
  const grid = $('grid'); grid.innerHTML = '';
  WK.forEach((w, i) => { const d = document.createElement('div'); d.className = 'wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''); d.textContent = w; grid.appendChild(d); });
  const start = new Date(viewY, viewM, 1).getDay(); const n = new Date(viewY, viewM + 1, 0).getDate();
  const cells = Math.ceil((start + n) / 7) * 7; const today = ymd(new Date()); let count = 0;
  for (let i = 0; i < cells; i++) {
    const dn = i - start + 1; const col = i % 7;
    if (dn < 1 || dn > n) { const e = document.createElement('div'); e.className = 'day out'; grid.appendChild(e); continue; }
    const key = `${viewY}-${String(viewM + 1).padStart(2, '0')}-${String(dn).padStart(2, '0')}`; const list = g[key] || []; count += list.length;
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'day' + (col === 0 ? ' sun' : col === 6 ? ' sat' : '') + (key === today ? ' today' : '') + (list.length ? ' has' : '');
    b.setAttribute('aria-pressed', String(key === selected)); b.setAttribute('aria-label', `${viewM + 1}월 ${dn}일, 사진 ${list.length}장`);
    const d = document.createElement('span'); d.className = 'd'; d.textContent = dn; b.appendChild(d);
    if (list.length) {
      const th = document.createElement('span'); th.className = 'th'; th.appendChild(thumbImg(list[0])); b.appendChild(th);
      const c = document.createElement('span'); c.className = 'c'; c.textContent = list.length; b.appendChild(c);
    }
    b.onclick = () => { selected = key; render(); if (window.innerWidth <= 820) $('panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    grid.appendChild(b);
  }
  $('monthSum').textContent = `이번 달 사진 ${count}장`;
}
function renderPanel() {
  const p = $('panel'); p.innerHTML = ''; const list = byDate()[selected] || []; const d = new Date(selected + 'T00:00:00');
  const h = document.createElement('div'); h.className = 'ph';
  h.innerHTML = `<span class="date">${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}</span><span class="wk">${WK[d.getDay()]} · ${d.getFullYear()}</span><span class="cnt num">${list.length}장</span>`;
  p.appendChild(h);
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.textContent = !loaded && Auth.valid() ? '드라이브에서 사진을 불러오는 중…'
      : photos.length ? '이 날에는 사진이 없어요. 달력에서 사진이 있는 날을 눌러보세요.'
      : '아직 저장된 사진이 없어요. ‘사진 추가’로 앨범에서 여러 장을 한 번에 고르면, 사진마다 찍은 날짜를 읽어 달력의 해당 날짜에 넣어드려요. 휴대폰에서는 갤러리에서 사진을 고른 뒤 공유 → 사진 보관함으로 보내도 돼요.';
    p.appendChild(e); return;
  }
  const acts = document.createElement('div'); acts.className = 'panelacts';
  const all = document.createElement('button'); all.type = 'button'; all.className = 'btn small';
  const allIn = list.every((x) => tray[x.id]);
  all.textContent = allIn ? '이 날 사진 인쇄 목록에서 빼기' : '이 날 사진 모두 인쇄 목록에 담기';
  all.onclick = () => { list.forEach((x) => { if (allIn) delete tray[x.id]; else tray[x.id] = tray[x.id] || 1; }); saveTray(); render(); };
  acts.appendChild(all); p.appendChild(acts);
  const tiles = document.createElement('div'); tiles.className = 'tiles';
  list.forEach((x) => {
    const f = document.createElement('figure'); f.className = 'tile';
    const o = document.createElement('button'); o.type = 'button'; o.className = 'open'; o.setAttribute('aria-label', (x.caption || '사진') + ' 편집');
    o.appendChild(thumbImg(x)); o.onclick = () => openPhoto(x.id);
    const pk = document.createElement('button'); pk.type = 'button'; pk.className = 'pick'; const n = tray[x.id] || 0;
    pk.setAttribute('aria-pressed', String(n > 0)); pk.textContent = n > 0 ? `인쇄 ${n}` : '＋ 인쇄';
    pk.onclick = () => { if (tray[x.id]) delete tray[x.id]; else tray[x.id] = 1; saveTray(); render(); };
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = x.caption || (x.takenAt || '').slice(11, 16);
    f.append(o, pk, cap); tiles.appendChild(f);
  });
  p.appendChild(tiles);
}
function updateTrayCount() {
  const ids = new Set(photos.map((p) => p.id)); let n = 0;
  for (const k of Object.keys(tray)) { if (loaded && !ids.has(k)) { delete tray[k]; continue; } n += tray[k]; }
  $('trayCount').textContent = n;
}
function shift(dm) { viewM += dm; if (viewM < 0) { viewM = 11; viewY--; } if (viewM > 11) { viewM = 0; viewY++; } renderCal(); }
$('prevM').onclick = () => shift(-1); $('nextM').onclick = () => shift(1);
$('todayM').onclick = () => { const t = new Date(); viewY = t.getFullYear(); viewM = t.getMonth(); selected = ymd(t); render(); };

/* ---------------- 사진 편집 ---------------- */
let ed = null;
async function openPhoto(id) {
  const p = photos.find((x) => x.id === id); if (!p) return;
  $('pmDate').value = p.date; $('pmCaption').value = p.caption || ''; $('pmCopies').value = tray[id] || 0; $('pmStatus').textContent = '';
  $('pmDelete').textContent = '사진 삭제'; $('pmDelete').dataset.armed = '';
  $('cropHint').textContent = `밝은 테두리 안이 ${S.w / 10}×${S.h / 10} cm로 인쇄될 부분이에요. 끌어서 위치를 맞추세요.`;
  $('photoModal').hidden = false; $('pmClose').focus();
  const c = $('cropCanvas'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  try {
    const im = await loadFull(p);
    ed = { id, img: im, rot: p.rot || 0, zoom: p.zoom || 1, cx: p.cx, cy: p.cy }; ed.src = rotated(im, ed.rot);
    $('zoom').value = ed.zoom; drawCrop();
  } catch (e) { $('pmStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 다시 연결해 주세요.' : '사진을 불러오지 못했어요.'; if (e instanceof AuthError) showConnect(); }
}
function drawCrop() {
  if (!ed) return; const c = $('cropCanvas'); const H0 = Math.round(360 * S.h / S.w); const k = Math.min(1, 300 / H0);
  c.width = Math.round(360 * k); c.height = Math.round(H0 * k); const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); const r = cropRect(ed, c.width, c.height); g.drawImage(ed.src, r.sx, r.sy, r.vw, r.vh, 0, 0, c.width, c.height);
}
function closePhoto() { $('photoModal').hidden = true; ed = null; }
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
  if (!ed) return; const p = photos.find((x) => x.id === ed.id); if (!p) return;
  const date = $('pmDate').value || p.date; const n = copiesVal();
  if (n > 0) tray[ed.id] = n; else delete tray[ed.id]; saveTray();
  $('pmSave').disabled = true; $('pmStatus').textContent = '저장 중…';
  try {
    const upd = await patchPhoto(ed.id, { date, takenAt: date === p.date ? p.takenAt : date + 'T12:00', zoom: ed.zoom.toFixed(3), cx: ed.cx.toFixed(4), cy: ed.cy.toFixed(4), rot: String(ed.rot) }, $('pmCaption').value.trim());
    if (ed.rot !== p.rot) { /* 회전이 바뀌면 썸네일은 CSS로 돌려 보여줌 */ }
    Object.assign(p, upd); savePhotos();
    if (date !== upd.date || date !== selected) { selected = upd.date; viewY = +upd.date.slice(0, 4); viewM = +upd.date.slice(5, 7) - 1; }
    closePhoto(); render();
  } catch (e) {
    $('pmStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 위의 연결 버튼을 누른 뒤 다시 저장해 주세요.' : '저장하지 못했어요. 잠시 후 다시 눌러주세요.';
    if (e instanceof AuthError) showConnect();
  } finally { $('pmSave').disabled = false; }
};
$('pmDelete').onclick = async () => {
  const b = $('pmDelete'); if (!ed) return;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 삭제돼요 (드라이브 휴지통으로 이동)'; return; }
  const id = ed.id; b.disabled = true;
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
  const ox = (A4W - (cols * S.w + (cols - 1) * S.gap)) / 2; const cells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: ox + c * (S.w + S.gap), y: S.margin + r * (S.h + S.gap) });
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
    const lb = document.createElement('div'); lb.className = 'lbl'; lb.textContent = `${p.date.replace(/-/g, '.')} ${p.caption || ''}`;
    const st = document.createElement('div'); st.className = 'stepper';
    const m = document.createElement('button'); m.type = 'button'; m.textContent = '−'; m.setAttribute('aria-label', '매수 줄이기');
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = '1'; inp.max = '999'; inp.value = tray[p.id]; inp.id = 'tc-' + p.id; inp.setAttribute('aria-label', '매수');
    const pl = document.createElement('button'); pl.type = 'button'; pl.textContent = '+'; pl.setAttribute('aria-label', '매수 늘리기');
    m.onclick = () => { tray[p.id] = Math.max(1, tray[p.id] - 1); saveTray(); renderPrint(); };
    pl.onclick = () => { tray[p.id] = Math.min(999, tray[p.id] + 1); saveTray(); renderPrint(); };
    inp.onchange = () => { tray[p.id] = Math.max(1, Math.min(999, parseInt(inp.value, 10) || 1)); saveTray(); renderPrint(); };
    st.append(m, inp, pl);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'btn small'; x.textContent = '빼기'; x.onclick = () => { delete tray[p.id]; saveTray(); renderPrint(); };
    li.append(im, lb, st, x); ul.appendChild(li);
  });
  document.querySelectorAll('#presets .btn').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.w === S.w && +b.dataset.h === S.h)));
  const L = layout(); const total = items.reduce((a, p) => a + tray[p.id], 0); const pages = L.per ? Math.max(1, Math.ceil(total / L.per)) : 0;
  $('prSummary').textContent = L.per ? `A4 한 장에 ${L.cols}×${L.rows} = ${L.per}칸 · ${total}장 · ${pages}페이지` : '사진이 A4에 들어가지 않아요. 크기나 여백을 줄여주세요.';
  $('prSave').disabled = !total || !L.per; render();
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
      const im = document.createElement('img'); im.alt = ''; im.src = urls[id]; d.appendChild(im); a4.appendChild(d);
    });
    box.append(lab, a4);
  }
}
function openPrint() {
  $('printModal').hidden = false; $('prStatus').textContent = '';
  $('sw').value = S.w; $('sh').value = S.h; $('sgap').value = S.gap; $('smargin').value = S.margin; $('scut').checked = S.cut;
  renderPrint(); $('prClose').focus();
}
function closePrint() { $('printModal').hidden = true; }
$('trayBtn').onclick = openPrint; $('prClose').onclick = closePrint;
$('printModal').addEventListener('click', (e) => { if (e.target === $('printModal')) closePrint(); });
['sw', 'sh', 'sgap', 'smargin'].forEach((id) => $(id).addEventListener('change', () => {
  const num = (k, a, b, d) => { const v = parseFloat($(k).value); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
  S.w = num('sw', 5, 190, 30); S.h = num('sh', 5, 277, 20); S.gap = num('sgap', 0, 20, 2); S.margin = num('smargin', 0, 40, 10); saveSize(); renderPrint();
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
    const name = `사진_${S.w / 10}x${S.h / 10}cm_${ymd(new Date()).replace(/-/g, '')}.pdf`;
    const url = URL.createObjectURL(doc.output('blob'));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    $('prStatus').textContent = `${name}을(를) 다운로드 폴더에 저장했어요. 실제 크기(100%)로 인쇄하세요.`;
  } catch (e) {
    $('prStatus').textContent = e instanceof AuthError ? '구글 연결이 끊겼어요. 다시 연결한 뒤 저장해 주세요.' : 'PDF를 만들지 못했어요. 다시 시도해 주세요.';
    if (e instanceof AuthError) showConnect();
  } finally { btn.disabled = false; }
};

/* ---------------- 메뉴 · 설치 · 연결 ---------------- */
$('optOriginal').checked = !!store.get('pa-original', false);
$('optOriginal').addEventListener('change', (e) => store.set('pa-original', e.target.checked));
$('menuBtn').onclick = () => { const m = $('menu'); m.hidden = !m.hidden; $('menuBtn').setAttribute('aria-expanded', String(!m.hidden)); };
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch (_) {} installEvt = null; $('installBtn').hidden = true; };
$('refreshBtn').onclick = () => sync(true);
$('signOutBtn').onclick = () => { Auth.signOut(); photos = []; loaded = false; savePhotos(); render(); showConnect(); note('드라이브 연결을 해제했어요. 드라이브에 저장된 사진은 그대로 남아 있어요.'); };

function showConnect() {
  if (!CLIENT_ID) { $('setup').hidden = false; $('connect').hidden = true; $('uploadBtn').hidden = true; return; }
  const linked = Auth.valid();
  $('connect').hidden = linked; $('uploadBtn').hidden = !linked;
  if (!linked && store.get('pa-linked', false)) {
    $('connect').querySelector('h2').textContent = '구글 드라이브 다시 연결';
    $('connectNote').textContent = '보안을 위해 연결은 1시간마다 새로 확인해요. 한 번 누르면 바로 이어져요.';
  }
  $('driveInfo').textContent = linked ? '구글 드라이브 ‘Photo Archive’ 폴더에 저장하고 있어요.' : '';
}
$('connectBtn').onclick = async () => {
  $('connectNote').textContent = '구글 창에서 계정을 고르고 허용을 눌러주세요.';
  try { await Auth.request(); showConnect(); note(''); await sync(true); await processPending(); }
  catch (e) { $('connectNote').textContent = e && e.type === 'popup_closed' ? '연결 창이 닫혔어요. 다시 눌러주세요.' : '연결하지 못했어요. 팝업이 막혀 있다면 허용한 뒤 다시 눌러주세요.'; }
};

async function sync(force) {
  if (!Auth.valid()) { showConnect(); return; }
  if (force) note('드라이브에서 사진 목록을 가져오는 중…');
  try {
    photos = await listAll(); loaded = true; savePhotos();
    if (!jumped && photos.length) {
      jumped = true; const mk = `${viewY}-${String(viewM + 1).padStart(2, '0')}`;
      if (!photos.some((p) => p.date.startsWith(mk))) { const last = photos.map((p) => p.date).sort().pop(); selected = last; viewY = +last.slice(0, 4); viewM = +last.slice(5, 7) - 1; }
    }
    render(); if (force) note('');
  } catch (e) {
    if (e instanceof AuthError) { showConnect(); note(''); }
    else note('드라이브에서 사진을 가져오지 못했어요. 인터넷 연결을 확인하고 설정 → 드라이브에서 새로고침을 눌러주세요.');
  }
}

/* ---------------- 시작 ---------------- */
if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch(() => {}); }
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
