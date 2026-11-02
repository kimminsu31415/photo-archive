// 사진 보관함 서비스 워커: 앱 화면 캐시 + 갤러리 '공유하기'로 받은 사진 보관
const VERSION = 'pa-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './vendor/jspdf.umd.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('photo-archive', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
      if (!d.objectStoreNames.contains('pending')) d.createObjectStore('pending', { autoIncrement: true });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function storeShared(request) {
  const form = await request.formData();
  const files = form.getAll('photos').filter((f) => f && typeof f === 'object' && f.size);
  if (files.length) {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('pending', 'readwrite');
      const st = tx.objectStore('pending');
      // File 객체는 IndexedDB에 그대로 저장할 수 있어요 (이름·수정일 유지)
      files.forEach((f) => st.add(f));
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }
  return Response.redirect('./?shared=' + files.length, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(storeShared(req).catch(() => Response.redirect('./?shared=error', 303)));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 화면 파일: 캐시를 먼저 보여주고 뒤에서 새 버전으로 갱신
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
