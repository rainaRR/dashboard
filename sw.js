/* 서비스 워커 — 앱처럼 설치되게 하고, 인터넷이 없을 때도 마지막 화면을 보여줍니다. */
const VERSION = "v3";
const SHELL = "shell-" + VERSION;   // 화면 틀 (오래 보관)
const DATA  = "data-" + VERSION;    // 숫자 (항상 새로 받되, 실패하면 보관본 사용)

const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(SHELL)
      .then(c => c.addAll(SHELL_FILES))
      .catch(() => {})          // 파일 하나가 없어도 설치는 진행합니다
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부 주소(차트 라이브러리)는 건드리지 않습니다

  // 숫자 파일 — 항상 새것을 먼저 시도하고, 안 되면 보관본을 씁니다
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(DATA).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || Response.error()))
    );
    return;
  }

  // 화면 틀 — 보관본을 먼저 보여주고, 뒤에서 조용히 새것을 받아둡니다
  e.respondWith(
    caches.match(req).then(cached => {
      const fresh = fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
