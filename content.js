(function () {
  "use strict";

  const REQ = "x-loc-req";
  const RES = "x-loc-res";
  const FLAG_ATTR = "data-x-loc-flag";
  const PENDING_ATTR = "data-x-loc-pending";
  const STYLE_ID = "x-loc-style";
  const STORAGE_KEY = "xLocCache";
  const TTL_MS = 24 * 60 * 60 * 1000;
  const FAIL_MS = 60 * 1000;
  const MAX_INFLIGHT = 2;
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
  const SKIP = {
    about: true,
    account: true,
    bookmarks: true,
    communities: true,
    compose: true,
    explore: true,
    following: true,
    followers: true,
    home: true,
    i: true,
    intents: true,
    jobs: true,
    lists: true,
    login: true,
    logout: true,
    messages: true,
    notifications: true,
    privacy: true,
    search: true,
    settings: true,
    share: true,
    signup: true,
    tos: true,
    verified: true,
  };

  const memory = Object.create(null);
  const waiting = Object.create(null);
  const queue = [];
  let inflight = 0;
  let scanScheduled = false;
  let storage = Object.create(null);

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent =
      "[" +
      FLAG_ATTR +
      "]{display:inline-flex;align-items:center;margin:0 .15em 0 .28em;font-size:1em;line-height:1;user-select:none;vertical-align:middle}";
    (document.head || document.documentElement).appendChild(el);
  }

  function handleFromHref(href) {
    if (!href) return "";
    let path = href;
    try {
      if (href.charAt(0) !== "/") path = new URL(href, location.origin).pathname;
    } catch (err) {
      return "";
    }
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return "";
    if (parts[0] === "i" || parts[0] === "intent" || parts[0] === "intents") return "";
    const raw = parts[0];
    if (SKIP[raw.toLowerCase()]) return "";
    if (parts[1] === "status" || parts[1] === "photo" || parts[1] === "media") {
      // /user/status/123 is still that user, but these links are tweet timestamps
      if (parts.length > 2) return "";
    }
    if (!HANDLE_RE.test(raw)) return "";
    return raw;
  }

  function handleFromRow(row) {
    const links = row.querySelectorAll('a[href]');
    for (let i = 0; i < links.length; i++) {
      const handle = handleFromHref(links[i].getAttribute("href"));
      if (handle) return handle;
    }
    return "";
  }

  function isHandleText(node) {
    return ((node && node.textContent) || "").trim().charAt(0) === "@";
  }

  function hasHandleLink(node) {
    if (!node || !node.querySelectorAll) return false;
    const links = node.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      if (isHandleText(links[i])) return true;
    }
    return false;
  }

  function nameLink(row) {
    const links = row.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      if (!handleFromHref(links[i].getAttribute("href"))) continue;
      if (isHandleText(links[i])) continue;
      return links[i];
    }
    return row.querySelector("a[href]");
  }

  function nameCluster(row, link) {
    let el = link;
    while (el.parentElement && el.parentElement !== row) {
      const parent = el.parentElement;
      if (hasHandleLink(parent) && !hasHandleLink(el)) break;
      el = parent;
    }
    return el;
  }

  function makeFlag(place) {
    const emoji = (globalThis.XLocFlags && XLocFlags.emojiForPlace(place)) || "🌍";
    const span = document.createElement("span");
    span.setAttribute(FLAG_ATTR, place);
    span.setAttribute("title", "Based in " + place);
    span.setAttribute("aria-label", "Based in " + place);
    span.textContent = emoji;
    return span;
  }

  function readStorage() {
    return new Promise(function (resolve) {
      if (!chrome.storage || !chrome.storage.local) {
        resolve();
        return;
      }
      chrome.storage.local.get(STORAGE_KEY, function (got) {
        const raw = got && got[STORAGE_KEY];
        storage = raw && typeof raw === "object" ? raw : Object.create(null);
        resolve();
      });
    });
  }

  function writeStorage() {
    if (!chrome.storage || !chrome.storage.local) return;
    const out = {};
    out[STORAGE_KEY] = storage;
    chrome.storage.local.set(out);
  }

  function cached(handle) {
    const key = handle.toLowerCase();
    const now = Date.now();
    const mem = memory[key];
    if (mem) {
      if (mem.failUntil && mem.failUntil > now) return { status: "wait" };
      if (mem.fetchedAt && now - mem.fetchedAt < TTL_MS) return { status: "ok", place: mem.place };
    }
    const disk = storage[key];
    if (disk && disk.fetchedAt && now - disk.fetchedAt < TTL_MS) {
      memory[key] = disk;
      return { status: "ok", place: disk.place };
    }
    return { status: "miss" };
  }

  function remember(handle, place) {
    const key = handle.toLowerCase();
    const row = { place: place, fetchedAt: Date.now() };
    memory[key] = row;
    storage[key] = row;
    writeStorage();
  }

  function rememberFail(handle) {
    const key = handle.toLowerCase();
    memory[key] = { failUntil: Date.now() + FAIL_MS };
  }

  function askPage(handle) {
    if (waiting[handle]) return waiting[handle];
    waiting[handle] = new Promise(function (resolve, reject) {
      const id = handle + ":" + Math.random().toString(36).slice(2);
      const timer = setTimeout(function () {
        window.removeEventListener("message", onMsg);
        delete waiting[handle];
        reject(new Error("timeout"));
      }, 15000);
      function onMsg(event) {
        const data = event.data;
        if (!data || data.source !== RES || data.id !== id || event.source !== window) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        delete waiting[handle];
        if (data.error) reject(new Error(data.error));
        else resolve(data.place == null ? null : data.place);
      }
      window.addEventListener("message", onMsg);
      window.postMessage({ source: REQ, id: id, handle: handle }, "*");
    });
    return waiting[handle];
  }

  function pump() {
    while (inflight < MAX_INFLIGHT && queue.length) {
      const job = queue.shift();
      inflight += 1;
      askPage(job.handle).then(
        function (place) {
          remember(job.handle, place);
          inflight -= 1;
          job.done(place);
          pump();
        },
        function () {
          rememberFail(job.handle);
          inflight -= 1;
          job.done(null);
          pump();
        }
      );
    }
  }

  function enqueue(handle) {
    return new Promise(function (resolve) {
      queue.push({ handle: handle, done: resolve });
      pump();
    });
  }

  function applyFlag(row, place) {
    row.removeAttribute(PENDING_ATTR);
    if (row.querySelector("[" + FLAG_ATTR + "]")) return;
    if (!place) return;
    const link = nameLink(row);
    if (!link) return;
    const cluster = nameCluster(row, link);
    if (!cluster || !cluster.parentNode) return;
    const flag = makeFlag(place);
    if (cluster === link) {
      let node = cluster;
      let sib = node.nextElementSibling;
      while (sib && !isHandleText(sib) && (sib.tagName === "svg" || (sib.querySelector && sib.querySelector("svg")))) {
        node = sib;
        sib = sib.nextElementSibling;
      }
      node.insertAdjacentElement("afterend", flag);
      return;
    }
    cluster.appendChild(flag);
  }

  function processRow(row) {
    if (row.querySelector("[" + FLAG_ATTR + "]")) return;
    if (row.getAttribute(PENDING_ATTR)) return;
    const handle = handleFromRow(row);
    if (!handle) return;
    const hit = cached(handle);
    if (hit.status === "ok") {
      applyFlag(row, hit.place);
      return;
    }
    if (hit.status === "wait") return;
    row.setAttribute(PENDING_ATTR, handle);
    enqueue(handle).then(function (place) {
      if (!row.isConnected) return;
      applyFlag(row, place);
    });
  }

  function scan() {
    injectStyle();
    const rows = document.querySelectorAll('[data-testid="User-Name"], [data-testid="UserName"]');
    for (let i = 0; i < rows.length; i++) processRow(rows[i]);
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(function () {
      scanScheduled = false;
      scan();
    });
  }

  function start() {
    scan();
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  readStorage().then(start);
})();
