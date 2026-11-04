/* 수첩 — 달력 사진을 골라 한 권의 잡지형 책으로 꾸민다.
   사진은 드라이브 파일 ID로만 연결한다: 달력에서 날짜를 옮겨도(폴더·이름이 바뀌어도) ID는 그대로라 수첩은 영향이 없다.
   수첩 내용은 드라이브 Photo Archive/수첩 폴더에 JSON 파일로 저장한다. */
(function () {
'use strict';
const PA = window.PA; if (!PA) return;
const $ = (id) => document.getElementById(id);
const W = 592, H = 840;               // 페이지 설계 크기: A5(148×210mm) × 4px/mm
const BASE = { mast: 96, mast2: 62, title: 40, sub: 19, body: 14, cap: 11, num: 24, cover: 22 };
const PAPERS = [
  { c: '#fbfaf7', n: '종이' }, { c: '#f2ebdf', n: '크림' }, { c: '#efe1e1', n: '블러시' },
  { c: '#e2e9e1', n: '세이지' }, { c: '#1d1c1a', n: '먹색' }, { c: '#22304a', n: '네이비' }
];
const DARK_PAPERS = ['#1d1c1a', '#22304a'];
const T = {
  cover: { name: '표지', bleed: true, ink: 'light', regions: [
    { k: 'p1', t: 'photo', x: 0, y: 0, w: W, h: H },
    { k: 'mast', s: 'mast', x: 28, y: 22, w: 536, h: 176, ph: 'MY ISSUE' },
    { k: 'sub', s: 'sub', x: 30, y: 196, w: 532, h: 36, ph: '부제를 적어보세요' },
    { k: 'line', s: 'cover', x: 30, y: 600, w: 330, h: 150, ph: '표지에 넣을 한마디' },
    { k: 'date', s: 'cap', x: 30, y: 792, w: 532, h: 22, ph: '2026. 11' }] },
  note: { name: '에디터 노트', regions: [
    { k: 'title', s: 'mast2', x: 40, y: 38, w: 512, h: 128, ph: "EDITOR'S NOTE" },
    { k: 'sub', s: 'sub', x: 42, y: 166, w: 508, h: 30, ph: 'from me, with love' },
    { k: 'body', s: 'body', x: 42, y: 206, w: 508, h: 310, ph: '이 수첩을 만든 이유, 그날의 이야기를 적어보세요.' },
    { k: 'p1', t: 'photo', x: 40, y: 534, w: 512, h: 266 }] },
  collage: { name: '무드보드', regions: [
    { k: 'title', s: 'mast2', x: 40, y: 34, w: 512, h: 112, ph: 'Moodboard' },
    { k: 'p1', t: 'photo', x: 42, y: 168, w: 248, h: 304, rot: -5, tape: 1 },
    { k: 'p2', t: 'photo', x: 304, y: 150, w: 246, h: 290, rot: 4, tape: 1 },
    { k: 'p3', t: 'photo', x: 58, y: 500, w: 226, h: 284, rot: 3, tape: 1 },
    { k: 'p4', t: 'photo', x: 306, y: 468, w: 238, h: 300, rot: -4, tape: 1 },
    { k: 'p5', t: 'photo', x: 198, y: 340, w: 196, h: 216, rot: 7, tape: 1 }] },
  grid4: { name: '사진 네 장', regions: [
    { k: 'title', s: 'title', x: 40, y: 34, w: 512, h: 78, ph: '그날의 장면' },
    { k: 'p1', t: 'photo', x: 40, y: 124, w: 250, h: 316 },
    { k: 'p2', t: 'photo', x: 302, y: 124, w: 250, h: 316 },
    { k: 'p3', t: 'photo', x: 40, y: 452, w: 250, h: 316 },
    { k: 'p4', t: 'photo', x: 302, y: 452, w: 250, h: 316 },
    { k: 'cap', s: 'cap', x: 40, y: 784, w: 512, h: 24, ph: '사진 설명' }] },
  duo: { name: '사진 두 장', regions: [
    { k: 'title', s: 'title', x: 40, y: 36, w: 512, h: 86, ph: '제목' },
    { k: 'p1', t: 'photo', x: 40, y: 134, w: 512, h: 322 },
    { k: 'p2', t: 'photo', x: 40, y: 474, w: 300, h: 326 },
    { k: 'body', s: 'body', x: 358, y: 474, w: 194, h: 326, ph: '짧은 글을 적어보세요.' }] },
  list: { name: '넘버 리스트', regions: [
    { k: 'title', s: 'mast2', x: 40, y: 34, w: 512, h: 120, ph: 'Top 3' },
    { k: 'p1', t: 'photo', x: 40, y: 172, w: 190, h: 196 }, { k: 'n1', s: 'num', x: 250, y: 172, w: 302, h: 40, ph: '1  첫 번째' }, { k: 'b1', s: 'body', x: 250, y: 216, w: 302, h: 152, ph: '설명을 적어보세요.' },
    { k: 'p2', t: 'photo', x: 40, y: 384, w: 190, h: 196 }, { k: 'n2', s: 'num', x: 250, y: 384, w: 302, h: 40, ph: '2  두 번째' }, { k: 'b2', s: 'body', x: 250, y: 428, w: 302, h: 152, ph: '설명을 적어보세요.' },
    { k: 'p3', t: 'photo', x: 40, y: 596, w: 190, h: 196 }, { k: 'n3', s: 'num', x: 250, y: 596, w: 302, h: 40, ph: '3  세 번째' }, { k: 'b3', s: 'body', x: 250, y: 640, w: 302, h: 152, ph: '설명을 적어보세요.' }] },
  full: { name: '사진 한 장', bleed: true, ink: 'light', regions: [
    { k: 'p1', t: 'photo', x: 0, y: 0, w: W, h: H },
    { k: 'title', s: 'title', x: 32, y: 676, w: 528, h: 76, ph: '제목' },
    { k: 'cap', s: 'cap', x: 32, y: 764, w: 528, h: 40, ph: '사진 설명' }] },
  text: { name: '글', regions: [
    { k: 'title', s: 'title', x: 40, y: 60, w: 512, h: 100, ph: '제목' },
    { k: 'body', s: 'body', x: 40, y: 180, w: 512, h: 620, ph: '자유롭게 적어보세요.' }] }
};
const TPL_ORDER = ['cover', 'note', 'collage', 'grid4', 'duo', 'list', 'full', 'text'];
const uid = () => Math.random().toString(36).slice(2, 10);
const newPage = (tpl) => ({ id: uid(), tpl, bg: T[tpl].bleed ? '#1d1c1a' : '#fbfaf7', ink: T[tpl].ink || 'dark', texts: {}, sizes: {}, slots: {} });

/* ---------------- 상태 ---------------- */
let books = PA.store.get('pa-books', []);          // [{ id, title, modified, data }]
let cur = null, curPage = 0, sel = null;            // 열린 수첩, 페이지 번호, 선택한 칸 키
let saveTimer = null, saving = false, dirty = false, bookFolder = null;
const saveCache = () => PA.store.set('pa-books', books);
const photoOf = (pid) => PA.photos.find((p) => p.id === pid);
function setSaved(t) { $('bkSaved').textContent = t || ''; }

/* ---------------- 드라이브 저장 ---------------- */
async function folder() {
  if (bookFolder) return bookFolder;
  const root = await PA.ensureFolder();
  bookFolder = await PA.findOrCreate('수첩', root, 'books', 'books');
  return bookFolder;
}
function multipart(meta, json) {
  const b = 'pb' + uid();
  return { body: new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n`, JSON.stringify(json), `\r\n--${b}--`]), type: `multipart/related; boundary=${b}` };
}
async function listBooks() {
  const r = await PA.api(`${PA.API}/files?q=${PA.q("appProperties has { key='photoArchive' and value='book' } and trashed=false")}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime,appProperties)`);
  const j = await r.json(); const out = [];
  for (const f of j.files || []) {
    const old = books.find((b) => b.id === f.id);
    if (old && old.modified === f.modifiedTime && old.data) { out.push(old); continue; }
    try { const d = await (await PA.api(`${PA.API}/files/${f.id}?alt=media`)).json(); out.push({ id: f.id, title: d.title || f.name.replace(/\.json$/, ''), modified: f.modifiedTime, data: d }); }
    catch (e) { if (e instanceof PA.AuthError) throw e; }
  }
  books = out; saveCache(); return out;
}
async function createBook(title) {
  const data = { v: 1, title, created: Date.now(), pool: [], pages: ['cover', 'note', 'collage', 'grid4', 'list', 'full', 'text'].map(newPage) };
  data.pages[0].texts.mast = title;
  const fid = await folder();
  const m = multipart({ name: `${title}.json`, parents: [fid], mimeType: 'application/json', appProperties: { photoArchive: 'book' } }, data);
  const r = await PA.api(`${PA.UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': m.type }, body: m.body });
  const j = await r.json(); const b = { id: j.id, title, modified: j.modifiedTime, data };
  books.unshift(b); saveCache(); return b;
}
function markDirty() {
  if (!cur) return; dirty = true; setSaved('저장 중…');
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200);
}
async function save() {
  if (!cur || !dirty || saving) return; saving = true; dirty = false;
  const b = cur; b.data.title = b.title;
  try {
    const m = multipart({ name: `${b.title}.json` }, b.data);
    const r = await PA.api(`${PA.UPLOAD}/${b.id}?uploadType=multipart&fields=modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': m.type }, body: m.body });
    b.modified = (await r.json()).modifiedTime; saveCache(); setSaved('저장됨 ' + PA.hm(new Date()));
  } catch (e) {
    dirty = true; setSaved(e instanceof PA.AuthError ? '구글 연결이 끊겨 저장 못 했어요' : '저장 실패, 다시 시도할게요');
    if (e instanceof PA.AuthError) PA.showConnect(); else { clearTimeout(saveTimer); saveTimer = setTimeout(save, 5000); }
  } finally { saving = false; if (dirty && !saveTimer) markDirty(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) { clearTimeout(saveTimer); save(); } });

/* ---------------- 사진 표시 ---------------- */
const hiUrl = new Map();
function hiRes(pid) {
  if (!hiUrl.has(pid)) { const p = PA.fullBlob(pid).then((b) => URL.createObjectURL(b)); p.catch(() => hiUrl.delete(pid)); hiUrl.set(pid, p); }
  return hiUrl.get(pid);
}
function place(img, sw, sh, c) {
  const iw = img.naturalWidth || +img.dataset.w || sw, ih = img.naturalHeight || +img.dataset.h || sh;
  const s = Math.max(sw / iw, sh / ih) * (c.zoom || 1); const w = iw * s, h = ih * s;
  let l = sw / 2 - (c.cx ?? 0.5) * w, t = sh / 2 - (c.cy ?? 0.5) * h;
  l = Math.min(0, Math.max(sw - w, l)); t = Math.min(0, Math.max(sh - h, t));
  c.cx = (sw / 2 - l) / w; c.cy = (sh / 2 - t) / h;
  img.style.width = w + 'px'; img.style.height = h + 'px'; img.style.left = l + 'px'; img.style.top = t + 'px';
  return { w, h };
}
/* hi: 'none' 썸네일만, 'lazy' 썸네일 먼저 → 원본, 'wait' 원본을 다 받은 뒤 끝냄(PDF용) */
function fillPhoto(box, r, slot, hi) {
  const ph = photoOf(slot.pid);
  if (!ph) { const m = document.createElement('span'); m.className = 'bk-missing'; m.textContent = PA.photos.length ? '삭제된 사진' : '불러오는 중'; (box.querySelector('.bk-in') || box).appendChild(m); return Promise.resolve(); }
  const img = document.createElement('img'); img.alt = ''; img.draggable = false;
  if (ph.w && ph.h) { img.dataset.w = ph.w; img.dataset.h = ph.h; }
  (box.querySelector('.bk-in') || box).appendChild(img);
  const show = (u) => new Promise((res) => { img.onload = () => { place(img, r.w, r.h, slot); res(); }; img.onerror = () => res(); img.src = u; });
  place(img, r.w, r.h, slot);
  if (hi === 'wait') return hiRes(slot.pid).then(show).catch(() => PA.getThumb(slot.pid).then(show)).catch(() => {});
  const first = PA.getThumb(slot.pid).then(show).catch(() => {});
  if (hi === 'lazy') first.then(() => hiRes(slot.pid)).then(show).catch(() => {});
  return first;
}

/* ---------------- 페이지 그리기 ---------------- */
function inkOf(pg) { return pg.ink === 'light' ? '#ffffff' : '#1c1a17'; }
/* mode: 'edit' | 'view' | 'thumb' | 'export' — 반환: { el, ready } */
function buildPage(pg, mode) {
  const tpl = T[pg.tpl] || T.text; const el = document.createElement('div');
  el.className = 'bk-page' + (mode === 'edit' || mode === 'thumb' ? ' showph' : '') + (mode === 'edit' ? ' editing' : '') + (pg.ink === 'light' ? ' light' : '');
  el.style.background = pg.bg || '#fbfaf7'; el.style.color = inkOf(pg);
  const waits = [];
  tpl.regions.forEach((r) => {
    if (r.t === 'photo') {
      const box = document.createElement('div'); box.className = 'bk-ph' + (r.tape ? ' taped' : '') + (r.w === W ? ' bleed' : '');
      Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', transform: r.rot ? `rotate(${r.rot}deg)` : '' });
      box.dataset.k = r.k;
      const inner = document.createElement('div'); inner.className = 'bk-in'; box.appendChild(inner);
      const slot = pg.slots[r.k];
      if (slot && slot.pid) waits.push(fillPhoto(box, r, slot, mode === 'export' ? 'wait' : mode === 'thumb' ? 'none' : 'lazy'));
      else if (mode === 'edit' || mode === 'thumb') { const e = document.createElement('span'); e.className = 'bk-empty'; e.textContent = mode === 'edit' ? '사진 칸 · 눌러서 고르기' : ''; box.appendChild(e); }
      if (r.tape) { const t = document.createElement('span'); t.className = 'bk-tape'; box.appendChild(t); }
      el.appendChild(box);
    } else {
      const t = document.createElement('div'); t.className = `bk-t s-${r.s}`; t.dataset.k = r.k; t.dataset.ph = r.ph || '';
      Object.assign(t.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', fontSize: (BASE[r.s] * (pg.sizes[r.k] || 1)) + 'px' });
      t.textContent = pg.texts[r.k] || '';
      el.appendChild(t);
    }
  });
  return { el, ready: Promise.all(waits) };
}
function scaled(pg, mode, scale) {
  const wrap = document.createElement('div'); wrap.className = 'bk-scale';
  wrap.style.width = W * scale + 'px'; wrap.style.height = H * scale + 'px';
  const { el, ready } = buildPage(pg, mode); el.style.transform = `scale(${scale})`; wrap.appendChild(el);
  return { wrap, el, ready };
}

/* ---------------- 화면 전환 ---------------- */
function setTab(book) {
  document.body.classList.toggle('mode-book', book);
  $('tabCal').setAttribute('aria-pressed', String(!book)); $('tabBook').setAttribute('aria-pressed', String(book));
  $('bookView').hidden = !book;
  if (book) { if (cur) openEditor(); else showShelf(); }
  else if (dirty) { clearTimeout(saveTimer); save(); }
  try { history.replaceState(null, '', book ? '#book' : location.pathname); } catch (_) {}
}
$('tabCal').onclick = () => setTab(false);
$('tabBook').onclick = () => setTab(true);

/* ---------------- 수첩 목록 ---------------- */
function renderShelf() {
  const g = $('books'); g.innerHTML = '';
  if (!books.length) { const e = document.createElement('p'); e.className = 'empty'; e.textContent = '아직 수첩이 없어요. 제목을 적고 ‘새 수첩 만들기’를 눌러 시작하세요.'; g.appendChild(e); return; }
  books.forEach((b) => {
    const c = document.createElement('button'); c.type = 'button'; c.className = 'bookcard';
    const cover = b.data && b.data.pages[0];
    if (cover) c.appendChild(scaled(cover, 'thumb', 160 / W).wrap);
    const t = document.createElement('span'); t.className = 'bc-t'; t.textContent = b.title;
    const n = document.createElement('span'); n.className = 'bc-n note'; n.textContent = `${(b.data && b.data.pages.length) || 0}쪽 · 사진 ${(b.data && b.data.pool.length) || 0}장`;
    c.append(t, n); c.onclick = () => { cur = b; curPage = 0; sel = null; openEditor(); };
    g.appendChild(c);
  });
}
async function showShelf() {
  $('shelf').hidden = false; $('editor').hidden = true; renderShelf();
  if (!PA.Auth.valid()) { $('shelfNote').textContent = '수첩은 구글 드라이브에 저장돼요. 달력 화면에서 구글 드라이브를 먼저 연결해 주세요.'; return; }
  $('shelfNote').textContent = '';
  try { await listBooks(); renderShelf(); } catch (e) { $('shelfNote').textContent = e instanceof PA.AuthError ? '구글 연결이 끊겼어요. 달력 화면에서 다시 연결해 주세요.' : '수첩 목록을 불러오지 못했어요.'; }
}
$('newBook').addEventListener('submit', async (e) => {
  e.preventDefault(); const title = $('newTitle').value.trim() || '이름 없는 수첩';
  if (!PA.Auth.valid()) { $('shelfNote').textContent = '달력 화면에서 구글 드라이브를 먼저 연결해 주세요.'; return; }
  $('shelfNote').textContent = '수첩 만드는 중…';
  try { cur = await createBook(title); $('newTitle').value = ''; curPage = 0; sel = null; $('shelfNote').textContent = ''; openEditor(); }
  catch (err) { $('shelfNote').textContent = err instanceof PA.AuthError ? '구글 연결이 끊겼어요. 달력 화면에서 다시 연결해 주세요.' : '수첩을 만들지 못했어요. 다시 시도해 주세요.'; }
});

/* ---------------- 편집 화면 ---------------- */
const tplOptions = (selEl) => { selEl.innerHTML = ''; TPL_ORDER.forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = T[k].name; selEl.appendChild(o); }); };
tplOptions($('bkTpl')); tplOptions($('bkNewTpl')); $('bkNewTpl').value = 'grid4';
PAPERS.forEach((p) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sw'; b.style.background = p.c; b.title = p.n; b.dataset.c = p.c; b.setAttribute('aria-label', `바탕색 ${p.n}`); b.onclick = () => setBg(p.c); $('bkBg').appendChild(b); });

function openEditor() {
  $('shelf').hidden = true; $('editor').hidden = false;
  $('bkTitle').value = cur.title; setSaved(''); $('bkDelete').textContent = '수첩 삭제'; $('bkDelete').dataset.armed = '';
  curPage = Math.max(0, Math.min(curPage, cur.data.pages.length - 1));
  renderThumbs(); renderStage(); renderPool(); renderPagePanel();
}
const page = () => cur.data.pages[curPage];
function renderThumbs() {
  const box = $('bkThumbs'); box.innerHTML = '';
  cur.data.pages.forEach((pg, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'bk-thumb'; b.setAttribute('aria-pressed', String(i === curPage)); b.setAttribute('aria-label', `${i + 1}쪽 ${T[pg.tpl].name}`);
    b.appendChild(scaled(pg, 'thumb', 84 / W).wrap);
    const n = document.createElement('span'); n.className = 'num'; n.textContent = i + 1; b.appendChild(n);
    b.onclick = () => { curPage = i; sel = null; renderThumbs(); renderStage(); renderPagePanel(); };
    box.appendChild(b);
  });
}
function refreshThumb(i) {
  const b = $('bkThumbs').children[i]; if (!b) return;
  const old = b.querySelector('.bk-scale'); const n = scaled(cur.data.pages[i], 'thumb', 84 / W).wrap; b.replaceChild(n, old);
}
let stageScale = 1;
function renderStage() {
  const st = $('bkStage'); st.innerHTML = '';
  const avail = Math.min(st.clientWidth || 520, 620); stageScale = Math.min(avail / W, (window.innerHeight * 0.78) / H);
  const { wrap, el } = scaled(page(), 'edit', stageScale);
  st.appendChild(wrap); wireEdit(el); markSel();
}
window.addEventListener('resize', () => { if (cur && !$('editor').hidden) renderStage(); });

function wireEdit(el) {
  const pg = page();
  el.querySelectorAll('.bk-t').forEach((t) => {
    t.contentEditable = 'plaintext-only'; if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    t.spellcheck = false;
    t.addEventListener('focus', () => { sel = t.dataset.k; markSel(); });
    t.addEventListener('input', () => { pg.texts[t.dataset.k] = t.innerText.replace(/\n$/, ''); markDirty(); });
    t.addEventListener('blur', () => refreshThumb(curPage));
    t.addEventListener('paste', (e) => { e.preventDefault(); const tx = (e.clipboardData || window.clipboardData).getData('text'); document.execCommand('insertText', false, tx); });
  });
  el.querySelectorAll('.bk-ph').forEach((box) => {
    const k = box.dataset.k; let drag = null;
    box.addEventListener('pointerdown', (e) => {
      sel = k; markSel(); const slot = pg.slots[k]; const img = box.querySelector('img');
      if (!slot || !slot.pid || !img) return;
      e.preventDefault(); drag = { x: e.clientX, y: e.clientY }; box.setPointerCapture(e.pointerId);
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return; const slot = pg.slots[k]; const img = box.querySelector('img'); const r = T[pg.tpl].regions.find((q) => q.k === k);
      const w = parseFloat(img.style.width), h = parseFloat(img.style.height);
      const rot = (r.rot || 0) * Math.PI / 180; const dx0 = (e.clientX - drag.x) / stageScale, dy0 = (e.clientY - drag.y) / stageScale;
      const dx = dx0 * Math.cos(rot) + dy0 * Math.sin(rot), dy = -dx0 * Math.sin(rot) + dy0 * Math.cos(rot);
      slot.cx -= dx / w; slot.cy -= dy / h; place(img, r.w, r.h, slot); drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => { if (drag) { drag = null; markDirty(); refreshThumb(curPage); } };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('wheel', (e) => {
      const slot = pg.slots[k]; if (!slot || !slot.pid) return; e.preventDefault();
      slot.zoom = Math.max(1, Math.min(3, (slot.zoom || 1) * (e.deltaY < 0 ? 1.06 : 1 / 1.06)));
      const r = T[pg.tpl].regions.find((q) => q.k === k); place(box.querySelector('img'), r.w, r.h, slot); $('bkZoom').value = slot.zoom; markDirty();
    }, { passive: false });
  });
}
function markSel() {
  const st = $('bkStage'); st.querySelectorAll('[data-k]').forEach((n) => n.classList.toggle('sel', n.dataset.k === sel));
  const pg = page(); const r = sel && T[pg.tpl].regions.find((q) => q.k === sel);
  $('bkSelPanel').hidden = !r;
  if (!r) return;
  const isPhoto = r.t === 'photo';
  $('bkSelTitle').textContent = isPhoto ? '선택한 사진 칸' : '선택한 글';
  $('bkSelPhoto').hidden = !isPhoto; $('bkSelText').hidden = isPhoto;
  if (isPhoto) { const s = pg.slots[sel]; $('bkZoom').value = (s && s.zoom) || 1; $('bkZoom').disabled = !(s && s.pid); $('bkClearSlot').disabled = !(s && s.pid); }
}
$('bkZoom').addEventListener('input', (e) => {
  const pg = page(); const s = pg.slots[sel]; if (!s) return; s.zoom = +e.target.value;
  const r = T[pg.tpl].regions.find((q) => q.k === sel); const img = $('bkStage').querySelector(`.bk-ph[data-k="${sel}"] img`); if (img) place(img, r.w, r.h, s); markDirty();
});
$('bkZoom').addEventListener('change', () => refreshThumb(curPage));
$('bkClearSlot').onclick = () => { delete page().slots[sel]; markDirty(); renderStage(); refreshThumb(curPage); renderPool(); };
const fontStep = (d) => { const pg = page(); if (!sel) return; pg.sizes[sel] = Math.max(0.5, Math.min(2.2, +((pg.sizes[sel] || 1) + d).toFixed(2))); markDirty(); renderStage(); refreshThumb(curPage); };
$('bkFontDown').onclick = () => fontStep(-0.1); $('bkFontUp').onclick = () => fontStep(0.1);

function renderPagePanel() {
  const pg = page(); $('bkTpl').value = pg.tpl; $('bkInk').checked = pg.ink === 'light';
  $('bkBg').querySelectorAll('.sw').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === pg.bg)));
  $('bkUp').disabled = curPage === 0; $('bkDown').disabled = curPage === cur.data.pages.length - 1;
  $('bkDelPage').textContent = '페이지 삭제'; $('bkDelPage').dataset.armed = ''; $('bkDelPage').disabled = cur.data.pages.length <= 1;
}
function setBg(c) { const pg = page(); pg.bg = c; pg.ink = DARK_PAPERS.includes(c) ? 'light' : (T[pg.tpl].bleed ? pg.ink : 'dark'); markDirty(); renderStage(); refreshThumb(curPage); renderPagePanel(); }
$('bkInk').addEventListener('change', (e) => { page().ink = e.target.checked ? 'light' : 'dark'; markDirty(); renderStage(); refreshThumb(curPage); });
$('bkTpl').addEventListener('change', (e) => {
  const pg = page(); const was = T[pg.tpl]; pg.tpl = e.target.value; const now = T[pg.tpl];
  if (now.bleed && !was.bleed) { pg.ink = 'light'; } else if (!now.bleed && was.bleed && !DARK_PAPERS.includes(pg.bg)) { pg.ink = 'dark'; }
  sel = null; markDirty(); renderStage(); refreshThumb(curPage); renderPagePanel(); renderPool();
});
function movePage(d) { const a = cur.data.pages; const j = curPage + d; if (j < 0 || j >= a.length) return; [a[curPage], a[j]] = [a[j], a[curPage]]; curPage = j; markDirty(); renderThumbs(); renderPagePanel(); }
$('bkUp').onclick = () => movePage(-1); $('bkDown').onclick = () => movePage(1);
$('bkDup').onclick = () => { const c = JSON.parse(JSON.stringify(page())); c.id = uid(); cur.data.pages.splice(curPage + 1, 0, c); curPage++; markDirty(); renderThumbs(); renderStage(); renderPagePanel(); };
$('bkDelPage').onclick = () => {
  const b = $('bkDelPage'); if (cur.data.pages.length <= 1) return;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 삭제'; return; }
  cur.data.pages.splice(curPage, 1); curPage = Math.max(0, curPage - 1); sel = null; markDirty(); renderThumbs(); renderStage(); renderPagePanel(); renderPool();
};
$('bkAddPage').onclick = () => { cur.data.pages.splice(curPage + 1, 0, newPage($('bkNewTpl').value)); curPage++; sel = null; markDirty(); renderThumbs(); renderStage(); renderPagePanel(); $('bkThumbs').children[curPage]?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
$('bkTitle').addEventListener('input', () => { cur.title = $('bkTitle').value.trim() || '이름 없는 수첩'; markDirty(); });
$('bkBack').onclick = () => { if (dirty) { clearTimeout(saveTimer); save(); } cur = null; sel = null; showShelf(); };
$('bkDelete').onclick = async () => {
  const b = $('bkDelete'); if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '한 번 더 누르면 삭제 (사진은 달력에 남아요)'; return; }
  b.disabled = true;
  try {
    await PA.api(`${PA.API}/files/${cur.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    books = books.filter((x) => x.id !== cur.id); saveCache(); clearTimeout(saveTimer); dirty = false; cur = null; showShelf();
    PA.note('수첩을 드라이브 휴지통으로 옮겼어요. 사진은 달력에 그대로 있어요.');
  } catch (e) { setSaved('삭제하지 못했어요'); } finally { b.disabled = false; }
};

/* ---------------- 수첩 사진함 ---------------- */
function usedCount(pid) { let n = 0; cur.data.pages.forEach((pg) => Object.values(pg.slots).forEach((s) => { if (s && s.pid === pid) n++; })); return n; }
function renderPool() {
  if (!cur) return;
  const box = $('bkPool'); box.innerHTML = ''; const pool = cur.data.pool;
  $('bkPoolCount').textContent = pool.length;
  if (!pool.length) { const e = document.createElement('p'); e.className = 'note'; e.textContent = '‘달력에서 사진 고르기’로 이 수첩에 쓸 사진을 담아요.'; box.appendChild(e); return; }
  pool.forEach((pid) => {
    const f = document.createElement('div'); f.className = 'pt';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pt-img';
    const ph = photoOf(pid);
    if (ph) { const im = document.createElement('img'); im.alt = ''; PA.getThumb(pid).then((u) => { im.src = u; }).catch(() => {}); b.appendChild(im); b.setAttribute('aria-label', `${PA.dayLabel(ph.date)} 사진 넣기`); }
    else { b.textContent = PA.photos.length ? '삭제된 사진' : '…'; b.classList.add('gone'); }
    const n = usedCount(pid); if (n) { const u = document.createElement('span'); u.className = 'pt-used'; u.textContent = n > 1 ? `${n}곳` : '사용'; f.appendChild(u); }
    b.onclick = () => assign(pid);
    const x = document.createElement('button'); x.type = 'button'; x.className = 'pt-x'; x.textContent = '×'; x.setAttribute('aria-label', '사진함에서 빼기');
    x.onclick = () => removeFromPool(pid);
    const d = document.createElement('span'); d.className = 'pt-d'; d.textContent = ph ? (ph.date === PA.UNDATED ? '날짜 모름' : ph.date.slice(5).replace('-', '.')) : '';
    f.append(b, x, d); box.appendChild(f);
  });
}
function assign(pid) {
  if (!photoOf(pid)) return;
  const pg = page(); const photoRegions = T[pg.tpl].regions.filter((r) => r.t === 'photo');
  let k = sel && photoRegions.some((r) => r.k === sel) ? sel : null;
  if (!k) { const empty = photoRegions.find((r) => !(pg.slots[r.k] && pg.slots[r.k].pid)); k = empty ? empty.k : null; }
  if (!k) { $('bkHint').textContent = '이 페이지에 빈 사진 칸이 없어요. 바꿀 사진 칸을 먼저 눌러주세요.'; return; }
  pg.slots[k] = { pid, zoom: 1, cx: 0.5, cy: 0.5 }; sel = k;
  $('bkHint').textContent = '사진을 끌어서 위치를 맞추고, 확대는 오른쪽에서 조절해요.';
  markDirty(); renderStage(); refreshThumb(curPage); renderPool();
}
function removeFromPool(pid) {
  const n = usedCount(pid);
  cur.data.pool = cur.data.pool.filter((x) => x !== pid);
  cur.data.pages.forEach((pg) => Object.keys(pg.slots).forEach((k) => { if (pg.slots[k] && pg.slots[k].pid === pid) delete pg.slots[k]; }));
  markDirty(); renderPool(); if (n) { renderStage(); renderThumbs(); }
  PA.note(n ? `사진함에서 뺐고, 페이지 ${n}곳에서도 비웠어요. 사진은 달력에 그대로 있어요.` : '사진함에서 뺐어요. 사진은 달력에 그대로 있어요.');
}
$('bkAutoFill').onclick = () => {
  const pg = page(); const used = new Set(); cur.data.pages.forEach((p) => Object.values(p.slots).forEach((s) => s && s.pid && used.add(s.pid)));
  const free = cur.data.pool.filter((pid) => !used.has(pid) && photoOf(pid)); let n = 0;
  T[pg.tpl].regions.filter((r) => r.t === 'photo').forEach((r) => { if (!(pg.slots[r.k] && pg.slots[r.k].pid) && free.length) { pg.slots[r.k] = { pid: free.shift(), zoom: 1, cx: 0.5, cy: 0.5 }; n++; } });
  if (!n) { $('bkHint').textContent = free.length ? '이 페이지에 빈 사진 칸이 없어요.' : '안 쓴 사진이 없어요. 달력에서 사진을 더 골라주세요.'; return; }
  markDirty(); renderStage(); refreshThumb(curPage); renderPool();
};

/* ---------------- 달력에서 사진 고르기 (중복 제외) ---------------- */
let pick = new Set(), pickMonth = null;
function openPicker() {
  pick = new Set(); const ms = [...new Set(PA.photos.map((p) => p.date === PA.UNDATED ? PA.UNDATED : p.date.slice(0, 7)))].sort().reverse();
  pickMonth = ms.includes(pickMonth) ? pickMonth : ms[0] || null;
  const mb = $('bpMonths'); mb.innerHTML = '';
  ms.forEach((m) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = m === PA.UNDATED ? '언제의 사진?' : m.replace('-', '.'); b.dataset.m = m; b.onclick = () => { pickMonth = m; renderPicker(); }; mb.appendChild(b); });
  $('bkPicker').hidden = false; renderPicker(); $('bpClose').focus();
}
function renderPicker() {
  $('bpMonths').querySelectorAll('.chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === pickMonth)));
  const list = $('bpList'); list.innerHTML = '';
  if (!pickMonth) { list.innerHTML = '<p class="note">달력에 사진이 아직 없어요.</p>'; updPick(); return; }
  const items = PA.photos.filter((p) => pickMonth === PA.UNDATED ? p.date === PA.UNDATED : p.date.startsWith(pickMonth)).sort((a, b) => (a.takenAt || a.date).localeCompare(b.takenAt || b.date));
  const g = {}; items.forEach((p) => { (g[p.date] = g[p.date] || []).push(p); });
  Object.keys(g).sort().forEach((d) => {
    const sec = document.createElement('section'); sec.className = 'bp-day';
    const h = document.createElement('div'); h.className = 'row bp-dh';
    const lb = document.createElement('b'); lb.textContent = PA.dayLabel(d);
    const all = document.createElement('button'); all.type = 'button'; all.className = 'btn small';
    const avail = g[d].filter((p) => !cur.data.pool.includes(p.id));
    all.textContent = avail.length && avail.every((p) => pick.has(p.id)) ? '이 날 선택 해제' : '이 날 전체 선택'; all.disabled = !avail.length;
    all.onclick = () => { const on = avail.every((p) => pick.has(p.id)); avail.forEach((p) => on ? pick.delete(p.id) : pick.add(p.id)); renderPicker(); };
    h.append(lb, all); sec.appendChild(h);
    const grid = document.createElement('div'); grid.className = 'bp-grid';
    g[d].forEach((p) => {
      const inPool = cur.data.pool.includes(p.id);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'bp-t' + (inPool ? ' inpool' : '') + (pick.has(p.id) ? ' on' : '');
      b.setAttribute('aria-pressed', String(pick.has(p.id))); b.disabled = inPool;
      const im = document.createElement('img'); im.alt = ''; PA.getThumb(p.id).then((u) => { im.src = u; }).catch(() => {}); b.appendChild(im);
      const m = document.createElement('span'); m.className = 'bp-m'; m.textContent = inPool ? '담김' : pick.has(p.id) ? '✓' : ''; b.appendChild(m);
      b.onclick = () => { if (pick.has(p.id)) pick.delete(p.id); else pick.add(p.id); b.classList.toggle('on'); b.setAttribute('aria-pressed', String(pick.has(p.id))); m.textContent = pick.has(p.id) ? '✓' : ''; updPick(); };
      grid.appendChild(b);
    });
    sec.appendChild(grid); list.appendChild(sec);
  });
  updPick();
}
function updPick() { $('bpCount').textContent = `${pick.size}장 선택`; $('bpAdd').disabled = !pick.size; }
$('bkPick').onclick = () => { if (!PA.photos.length) { $('bkHint').textContent = '달력에 사진이 아직 없어요. 달력 화면에서 사진을 먼저 추가해 주세요.'; return; } openPicker(); };
$('bpClose').onclick = () => { $('bkPicker').hidden = true; };
$('bkPicker').addEventListener('click', (e) => { if (e.target === $('bkPicker')) $('bkPicker').hidden = true; });
$('bpAdd').onclick = () => {
  const poolPhotos = cur.data.pool.map(photoOf).filter(Boolean); let added = 0, dup = 0;
  // 고른 순서가 아니라 찍은 시각 순서로 담는다
  const chosen = [...pick].map(photoOf).filter(Boolean).sort((a, b) => (a.takenAt || a.date).localeCompare(b.takenAt || b.date));
  chosen.forEach((p) => {
    const fp = { sha: p.sha, dh: p.dh, ot: p.ot, ar: p.w && p.h ? p.w / p.h : 0 };
    if (cur.data.pool.includes(p.id) || PA.findDup(fp, poolPhotos)) { dup++; return; }   // 같은 사진(다른 날에 중복으로 있는 것 포함)은 한 번만
    cur.data.pool.push(p.id); poolPhotos.push(p); added++;
  });
  $('bkPicker').hidden = true; markDirty(); renderPool();
  PA.note(`${added}장을 수첩 사진함에 담았어요.` + (dup ? ` 이미 담긴 사진과 같은 ${dup}장은 뺐어요.` : ''));
};

/* ---------------- 넘겨 보기 (플립북) ---------------- */
let vw = { spreads: [], i: 0, wide: true, busy: false };
function spreadsOf(n, wide) {
  if (!wide) return Array.from({ length: n }, (_, i) => [i]);
  const out = [[null, 0]]; for (let i = 1; i < n; i += 2) out.push([i, i + 1 < n ? i + 1 : null]);
  return out;
}
function vwScale() {
  const st = $('vwStage'); const aw = st.clientWidth - 24, ah = st.clientHeight - 24;
  return Math.min(aw / (vw.wide ? 2 * W : W), ah / H);
}
function pageEl(i, s) {
  const d = document.createElement('div'); d.className = 'vw-pg';
  d.style.width = W * s + 'px'; d.style.height = H * s + 'px';
  if (i == null) { d.classList.add('blank'); return d; }
  d.appendChild(scaled(cur.data.pages[i], 'view', s).wrap); return d;
}
function renderSpread() {
  const st = $('vwStage'); st.innerHTML = ''; const s = vwScale(); const sp = vw.spreads[vw.i];
  const book = document.createElement('div'); book.className = 'vw-book' + (vw.wide ? ' wide' : '');
  sp.forEach((i) => book.appendChild(pageEl(i, s))); st.appendChild(book);
  const n = cur.data.pages.length; const nums = sp.filter((x) => x != null).map((x) => x + 1);
  $('vwPage').textContent = `${nums.join('–')} / ${n}`;
  $('vwPrev').disabled = vw.i === 0; $('vwNext').disabled = vw.i === vw.spreads.length - 1;
}
function turn(d) {
  const j = vw.i + d; if (vw.busy || j < 0 || j >= vw.spreads.length) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { vw.i = j; renderSpread(); return; }
  const s = vwScale(); const from = vw.spreads[vw.i], to = vw.spreads[j]; const st = $('vwStage');
  const book = st.querySelector('.vw-book'); vw.busy = true;
  if (!vw.wide) {
    book.classList.add(d > 0 ? 'out-l' : 'out-r');
    setTimeout(() => { vw.i = j; renderSpread(); const nb = st.querySelector('.vw-book'); nb.classList.add(d > 0 ? 'in-r' : 'in-l'); requestAnimationFrame(() => requestAnimationFrame(() => nb.classList.remove('in-r', 'in-l'))); vw.busy = false; }, 220);
    return;
  }
  // 펼침면: 넘어가는 종이 한 장(앞=지금 쪽, 뒤=다음 쪽)을 가운데 접선 기준으로 돌린다
  const pages = book.children;
  const leaf = document.createElement('div'); leaf.className = 'vw-leaf ' + (d > 0 ? 'fwd' : 'back');
  leaf.style.width = W * s + 'px'; leaf.style.height = H * s + 'px';
  const front = pageEl(d > 0 ? from[1] : from[0], s); front.classList.add('face', 'front');
  const backF = pageEl(d > 0 ? to[0] : to[1], s); backF.classList.add('face', 'backf');
  leaf.append(front, backF);
  // 아래에 보일 다음 펼침면 쪽을 미리 바꿔 둔다
  const under = pageEl(d > 0 ? to[1] : to[0], s); book.replaceChild(under, pages[d > 0 ? 1 : 0]);
  book.appendChild(leaf);
  requestAnimationFrame(() => requestAnimationFrame(() => leaf.classList.add('go')));
  setTimeout(() => { vw.i = j; vw.busy = false; renderSpread(); }, 640);
}
function openViewer() {
  if (dirty) { clearTimeout(saveTimer); save(); }
  vw.wide = window.innerWidth >= 900; vw.spreads = spreadsOf(cur.data.pages.length, vw.wide);
  const cp = curPage; vw.i = Math.max(0, vw.spreads.findIndex((sp) => sp.includes(cp)));
  $('vwTitle').textContent = cur.title; $('bkViewer').hidden = false; document.body.classList.add('noscroll'); renderSpread(); $('vwClose').focus();
}
function closeViewer() { $('bkViewer').hidden = true; document.body.classList.remove('noscroll'); }
$('bkView').onclick = openViewer; $('vwClose').onclick = closeViewer;
$('vwPrev').onclick = () => turn(-1); $('vwNext').onclick = () => turn(1);
document.addEventListener('keydown', (e) => {
  if ($('bkViewer').hidden) { if (e.key === 'Escape' && !$('bkPicker').hidden) $('bkPicker').hidden = true; return; }
  if (e.key === 'Escape') closeViewer(); else if (e.key === 'ArrowRight') turn(1); else if (e.key === 'ArrowLeft') turn(-1);
});
(function () {
  let sx = null; const st = $('vwStage');
  st.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  st.addEventListener('pointerup', (e) => { if (sx == null) return; const dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) turn(dx < 0 ? 1 : -1); else { const r = st.getBoundingClientRect(); turn(e.clientX > r.left + r.width / 2 ? 1 : -1); } });
})();
window.addEventListener('resize', () => {
  if ($('bkViewer').hidden) return; const wide = window.innerWidth >= 900;
  if (wide !== vw.wide) { const p = vw.spreads[vw.i].find((x) => x != null) || 0; vw.wide = wide; vw.spreads = spreadsOf(cur.data.pages.length, wide); vw.i = Math.max(0, vw.spreads.findIndex((sp) => sp.includes(p))); }
  renderSpread();
});

/* ---------------- PDF 저장 (A5, 한 쪽 = 한 장) ---------------- */
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
$('bkPdf').onclick = async () => {
  const btn = $('bkPdf'); btn.disabled = true;
  try {
    if (!window.html2canvas) await loadScript('vendor/html2canvas.min.js');
    if (!window.jspdf) throw new Error('pdf');
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a5', orientation: 'portrait', compress: true });
    const host = document.createElement('div'); host.className = 'bk-export'; document.body.appendChild(host);
    const n = cur.data.pages.length;
    for (let i = 0; i < n; i++) {
      setSaved(`PDF 만드는 중 ${i + 1} / ${n}`);
      host.innerHTML = ''; const { el, ready } = buildPage(cur.data.pages[i], 'export'); host.appendChild(el); await ready;
      const c = await window.html2canvas(el, { scale: 3.5, backgroundColor: cur.data.pages[i].bg || '#ffffff', logging: false, useCORS: true, width: W, height: H, windowWidth: W, windowHeight: H });
      if (i) doc.addPage('a5', 'portrait');
      doc.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 148, 210, 'pg' + i, 'NONE');
    }
    host.remove();
    const name = `수첩_${cur.title.replace(/[\\/:*?"<>|]/g, '')}_A5.pdf`; PA.savePdf(doc, name);
    setSaved(`${name} 저장했어요`);
  } catch (e) {
    setSaved(e instanceof PA.AuthError ? '구글 연결이 끊겨 사진을 못 받았어요' : 'PDF를 만들지 못했어요');
    document.querySelectorAll('.bk-export').forEach((x) => x.remove());
  } finally { btn.disabled = false; }
};

/* ---------------- 달력과의 연결 ---------------- */
window.PB = {
  // 이 사진을 쓰는 수첩 제목들 (달력에서 삭제할 때 알려주기용)
  usedIn(pid) { return books.filter((b) => b.data && (b.data.pool.includes(pid) || b.data.pages.some((pg) => Object.values(pg.slots).some((s) => s && s.pid === pid)))).map((b) => b.title); },
  // 달력 사진 목록이 바뀌면(삭제·동기화) 수첩 화면을 다시 그린다. 날짜 이동은 ID가 같아 영향이 없다.
  onPhotos() { if (!document.body.classList.contains('mode-book')) return; if (cur && !$('editor').hidden) { renderPool(); if (!document.activeElement || !document.activeElement.classList.contains('bk-t')) { renderStage(); renderThumbs(); } } else if (!$('shelf').hidden) renderShelf(); }
};

if (location.hash === '#book') setTab(true);
})();
