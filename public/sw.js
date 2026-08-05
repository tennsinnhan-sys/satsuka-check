// 撮可チェック - Service Worker
// アプリの見た目(HTML/CSS/JS一式)をオフラインでも開けるようにキャッシュする。
// /api/ 以下(Notion照合・ページ取得)は常にネットワークを使う。
// オフライン時のグループ名リスト照合は、index.html 側で localStorage に
// 保存しておいたDBスナップショットを使ってクライアント内で完結させる。

const CACHE_NAME = "satsuka-check-shell-v1";
const SHELL_FILES = [
  "/",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API呼び出しはキャッシュせず、常にネットワークへそのまま流す
  if (url.pathname.startsWith("/api/")) {
    return;
  }

  // 同一オリジンのGETのみキャッシュ対象(アプリの見た目一式)
  if (req.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached);
      // キャッシュがあれば即返しつつ裏で更新(なければネットワーク待ち)
      return cached || network;
    })
  );
});
