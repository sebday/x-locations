(function () {
  "use strict";

  const REQ = "x-loc-req";
  const RES = "x-loc-res";
  const FALLBACK_IDS = ["zs_jFPFT78rBpXv9Z3U2YQ", "XRqGa7EeokUU5kppkh13EA"];
  const WEB_BEARER =
    "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
  const HEADER_KEEP = {
    authorization: true,
    "x-csrf-token": true,
    "x-twitter-auth-type": true,
    "x-twitter-active-user": true,
    "x-twitter-client-language": true,
  };

  const nativeFetch = window.fetch.bind(window);
  const captured = { headers: {}, queryId: "" };

  function cookie(name) {
    const parts = document.cookie.split("; ");
    for (let i = 0; i < parts.length; i++) {
      const row = parts[i];
      const eq = row.indexOf("=");
      if (eq === -1) continue;
      if (row.slice(0, eq) === name) return decodeURIComponent(row.slice(eq + 1));
    }
    return "";
  }

  function rememberHeader(key, value) {
    const k = String(key).toLowerCase();
    if (!HEADER_KEEP[k] || !value) return;
    captured.headers[k] = String(value);
  }

  function rememberHeaders(headers) {
    if (!headers) return;
    if (typeof headers.forEach === "function") {
      headers.forEach(function (value, key) {
        rememberHeader(key, value);
      });
      return;
    }
    const keys = Object.keys(headers);
    for (let i = 0; i < keys.length; i++) rememberHeader(keys[i], headers[keys[i]]);
  }

  function rememberUrl(url) {
    if (!url) return;
    const text = String(url);
    const match = text.match(/\/i\/api\/graphql\/([^/?#]+)\/AboutAccountQuery/);
    if (match) captured.queryId = match[1];
  }

  function captureFromInit(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    if (!url || String(url).indexOf("/i/api/graphql/") === -1) return;
    rememberUrl(url);
    if (input && typeof input !== "string" && input.headers) rememberHeaders(input.headers);
    if (init && init.headers) rememberHeaders(init.headers);
  }

  window.fetch = function (input, init) {
    try {
      captureFromInit(input, init);
    } catch (err) {}
    return nativeFetch(input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._xLocUrl = url;
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
    try {
      if (this._xLocUrl && String(this._xLocUrl).indexOf("/i/api/graphql/") !== -1) {
        rememberUrl(this._xLocUrl);
        rememberHeader(key, value);
      }
    } catch (err) {}
    return xhrSet.apply(this, arguments);
  };

  function requestHeaders() {
    const headers = {
      accept: "application/json",
      "x-twitter-active-user": "yes",
      "x-twitter-auth-type": "OAuth2Session",
    };
    const keys = Object.keys(captured.headers);
    for (let i = 0; i < keys.length; i++) headers[keys[i]] = captured.headers[keys[i]];
    if (!headers.authorization) headers.authorization = WEB_BEARER;
    if (!headers["x-csrf-token"]) {
      const ct0 = cookie("ct0");
      if (ct0) headers["x-csrf-token"] = ct0;
    }
    return headers;
  }

  function queryIds() {
    const ids = [];
    const seen = {};
    const raw = captured.queryId ? [captured.queryId].concat(FALLBACK_IDS) : FALLBACK_IDS;
    for (let i = 0; i < raw.length; i++) {
      const id = raw[i];
      if (!id || seen[id]) continue;
      seen[id] = true;
      ids.push(id);
    }
    return ids;
  }

  function extractPlace(json) {
    const user = json && json.data && json.data.user_result_by_screen_name;
    const about = user && user.result && user.result.about_profile;
    const place = about && about.account_based_in;
    if (typeof place !== "string") return null;
    const trimmed = place.trim();
    return trimmed || null;
  }

  async function fetchAbout(handle) {
    const ids = queryIds();
    let lastErr = "lookup failed";
    for (let i = 0; i < ids.length; i++) {
      const url =
        "/i/api/graphql/" +
        ids[i] +
        "/AboutAccountQuery?variables=" +
        encodeURIComponent(JSON.stringify({ screenName: handle }));
      const res = await nativeFetch(url, {
        method: "GET",
        headers: requestHeaders(),
        credentials: "include",
      });
      if (res.status === 404) {
        lastErr = "query id rejected";
        continue;
      }
      if (!res.ok) {
        lastErr = "http " + res.status;
        if (res.status === 401 || res.status === 403) break;
        continue;
      }
      const json = await res.json();
      if (json && Array.isArray(json.errors) && json.errors.length && !json.data) {
        lastErr = json.errors[0].message || "graphql error";
        continue;
      }
      return extractPlace(json);
    }
    throw new Error(lastErr);
  }

  window.addEventListener("message", function (event) {
    const data = event.data;
    if (!data || data.source !== REQ || event.source !== window) return;
    const id = data.id;
    const handle = data.handle;
    if (!id || !handle) return;
    fetchAbout(handle).then(
      function (place) {
        window.postMessage({ source: RES, id: id, place: place }, "*");
      },
      function (err) {
        window.postMessage({ source: RES, id: id, error: String(err && err.message ? err.message : err) }, "*");
      }
    );
  });
})();
