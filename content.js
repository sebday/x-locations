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
      "]{display:inline-flex;align-items:center;flex-shrink:0;margin:0 .15em 0 .28em;font-size:1em;line-height:1;user-select:none;vertical-align:middle}";
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

  function profileHandleFromUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return "";
    const raw = parts[0];
    if (SKIP[raw.toLowerCase()]) return "";
    if (!HANDLE_RE.test(raw)) return "";
    return raw;
  }

  function handleFromAt(row) {
    const who = handleNode(row);
    if (!who) return "";
    const text = (who.textContent || "").trim().replace(/^@/, "");
    if (!HANDLE_RE.test(text)) return "";
    return text;
  }

  function handleFromRow(row) {
    const links = row.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      const handle = handleFromHref(links[i].getAttribute("href"));
      if (handle) return handle;
    }
    const at = handleFromAt(row);
    if (at) return at;
    if (row.getAttribute("data-testid") === "UserName") return profileHandleFromUrl();
    return "";
  }

  function isProfileHeader(row) {
    return row.getAttribute("data-testid") === "UserName";
  }

  function isHandleText(node) {
    return ((node && node.textContent) || "").trim().charAt(0) === "@";
  }

  function handleLink(row) {
    const links = row.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      if (!handleFromHref(links[i].getAttribute("href"))) continue;
      if (isHandleText(links[i])) return links[i];
    }
    return null;
  }

  function handleNode(row) {
    const link = handleLink(row);
    if (link) return link;
    const nodes = row.querySelectorAll("span, a");
    for (let i = 0; i < nodes.length; i++) {
      if (isHandleText(nodes[i]) && !nodes[i].querySelector("span, a")) return nodes[i];
    }
    for (let i = 0; i < nodes.length; i++) {
      if (isHandleText(nodes[i])) return nodes[i];
    }
    return null;
  }

  function profileNameLine(row) {
    const at = handleNode(row);
    const nodes = row.querySelectorAll("span");
    let name = null;
    for (let i = 0; i < nodes.length; i++) {
      const text = (nodes[i].textContent || "").trim();
      if (!text || text.charAt(0) === "@") continue;
      if (nodes[i].querySelector("span")) continue;
      name = nodes[i];
      break;
    }
    if (!name) return row.firstElementChild || row;
    let cluster = name;
    while (cluster.parentElement && cluster.parentElement !== row) {
      const parent = cluster.parentElement;
      if (at && parent.contains(at) && !cluster.contains(at)) break;
      cluster = parent;
    }
    return cluster;
  }

  function timeNode(row) {
    const time = row.querySelector("time");
    if (time) return time.closest("a") || time;
    const links = row.querySelectorAll("a[href]");
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute("href") || "";
      if (href.indexOf("/status/") !== -1) return links[i];
    }
    return null;
  }

  function makeFlag(place, handle) {
    const emoji = (globalThis.XLocFlags && XLocFlags.emojiForPlace(place)) || "🌍";
    const span = document.createElement("span");
    span.setAttribute(FLAG_ATTR, place);
    span.setAttribute("data-x-loc-handle", handle.toLowerCase());
    span.setAttribute("title", "Based in " + place);
    span.setAttribute("aria-label", "Based in " + place);
    span.textContent = emoji;
    return span;
  }

  function findFlag(row, handle) {
    const key = handle.toLowerCase();
    const flags = row.querySelectorAll("[" + FLAG_ATTR + "]");
    for (let i = 0; i < flags.length; i++) {
      if ((flags[i].getAttribute("data-x-loc-handle") || "") === key) return flags[i];
    }
    return flags[0] || null;
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

  function rowChild(row, el) {
    let node = el;
    while (node.parentElement && node.parentElement !== row) node = node.parentElement;
    return node.parentElement === row ? node : null;
  }

  function applyFlag(row, place, handle) {
    row.removeAttribute(PENDING_ATTR);
    if (findFlag(row, handle)) return;
    if (!place) return;
    const flag = makeFlag(place, handle);
    if (isProfileHeader(row)) {
      const line = profileNameLine(row);
      if (line) {
        line.appendChild(flag);
        return;
      }
    }
    const after = timeNode(row) || handleNode(row);
    if (after) {
      const cluster = rowChild(row, after);
      if (cluster) {
        cluster.insertAdjacentElement("afterend", flag);
        return;
      }
      after.insertAdjacentElement("afterend", flag);
      return;
    }
    row.appendChild(flag);
  }

  function processRow(row) {
    if (row.getAttribute(PENDING_ATTR)) return;
    const handle = handleFromRow(row);
    if (!handle) return;
    if (findFlag(row, handle)) return;
    const hit = cached(handle);
    if (hit.status === "ok") {
      applyFlag(row, hit.place, handle);
      return;
    }
    if (hit.status === "wait") return;
    row.setAttribute(PENDING_ATTR, handle);
    enqueue(handle).then(function (place) {
      if (!row.isConnected) return;
      applyFlag(row, place, handle);
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
