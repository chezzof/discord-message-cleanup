(function () {
  if (window.__discordCleanupBridgeReady) {
    return;
  }
  window.__discordCleanupBridgeReady = true;

  const REQUEST_EVENT = "discordCleanupBridgeRequest";
  const RESPONSE_EVENT = "discordCleanupBridgeResponse";
  const API_BASES = ["https://discord.com/api/v9", "https://discord.com/api/v10"];

  let cachedAuthExport = null;

  function isUsableToken(token) {
    return typeof token === "string" && token.length > 20 && !/\s/.test(token);
  }

  function getUsableTokenFromExport(exp) {
    if (
      !exp ||
      typeof exp.getToken !== "function" ||
      exp[Symbol.toStringTag] === "IntlMessagesProxy"
    ) {
      return null;
    }

    const token = exp.getToken();
    return isUsableToken(token) ? token : null;
  }

  function dispatchResponse(detail) {
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: detail,
      })
    );
  }

  function findAuthExport() {
    if (cachedAuthExport) {
      return cachedAuthExport;
    }

    if (!window.webpackChunkdiscord_app) {
      return null;
    }

    let found = null;
    window.webpackChunkdiscord_app.push([
      [Symbol()],
      {},
      function (req) {
        if (!req.c) {
          return;
        }
        for (const mod of Object.values(req.c)) {
          try {
            if (!mod.exports || mod.exports === window) {
              continue;
            }

            const candidates = [mod.exports];
            for (const key in mod.exports) {
              candidates.push(mod.exports[key]);
            }

            for (const exp of candidates) {
              if (getUsableTokenFromExport(exp)) {
                found = exp;
                return;
              }
            }
          } catch (_err) {
            // continue searching modules
          }
        }
      },
    ]);
    window.webpackChunkdiscord_app.pop();
    cachedAuthExport = found;
    return cachedAuthExport;
  }

  function readLocalStorageIframe() {
    window.dispatchEvent(new Event("beforeunload"));
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    const ls = iframe.contentWindow.localStorage;
    iframe.remove();
    return ls;
  }

  function getTokenFromWebpackDefault() {
    if (!window.webpackChunkdiscord_app) {
      return null;
    }
    window.webpackChunkdiscord_app.push([
      [""],
      {},
      function (req) {
        window.__discordCleanupWebpackModules = [];
        for (const key in req.c) {
          window.__discordCleanupWebpackModules.push(req.c[key]);
        }
      },
    ]);
    const modules = window.__discordCleanupWebpackModules || [];
    window.webpackChunkdiscord_app.pop();
    delete window.__discordCleanupWebpackModules;

    for (const mod of modules) {
      const token = getUsableTokenFromExport(mod?.exports?.default);
      if (token) {
        return token;
      }
    }

    return null;
  }

  function readTokenFromLocalStorage() {
    try {
      const ls = readLocalStorageIframe();
      const raw = ls.getItem("token");
      if (!raw) {
        return null;
      }
      try {
        const token = JSON.parse(raw);
        return isUsableToken(token) ? token : null;
      } catch (_err) {
        const token = raw.replace(/^"|"$/g, "");
        return isUsableToken(token) ? token : null;
      }
    } catch (_err) {
      return null;
    }
  }

  function getTokenFromAuthExport() {
    const auth = findAuthExport();
    return getUsableTokenFromExport(auth);
  }

  function getTokenWithSource() {
    const fromAuthExport = getTokenFromAuthExport();
    if (fromAuthExport) {
      return { token: fromAuthExport, source: "authExport" };
    }
    const fromWebpackDefault = getTokenFromWebpackDefault();
    if (fromWebpackDefault) {
      return { token: fromWebpackDefault, source: "webpackDefault" };
    }
    const fromStorage = readTokenFromLocalStorage();
    if (fromStorage) {
      return { token: fromStorage, source: "localStorage" };
    }
    return { token: null, source: "none" };
  }

  function getAuthorIdFromCache() {
    try {
      const ls = readLocalStorageIframe();
      const raw = ls.getItem("user_id_cache");
      if (!raw) {
        return null;
      }
      return JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  }

  function getCurrentUser() {
    const cachedId = getAuthorIdFromCache();
    if (cachedId) {
      return { id: String(cachedId), username: "" };
    }

    const auth = findAuthExport();
    if (auth && typeof auth.getCurrentUser === "function") {
      const user = auth.getCurrentUser();
      if (user && user.id) {
        return user;
      }
    }

    if (!window.webpackChunkdiscord_app) {
      return null;
    }

    let found = null;
    window.webpackChunkdiscord_app.push([
      [Symbol()],
      {},
      function (req) {
        if (!req.c) {
          return;
        }
        for (const mod of Object.values(req.c)) {
          try {
            if (!mod.exports || mod.exports === window) {
              continue;
            }

            const candidates = [mod.exports];
            for (const key in mod.exports) {
              candidates.push(mod.exports[key]);
            }

            for (const exp of candidates) {
              if (exp && typeof exp.getCurrentUser === "function") {
                const user = exp.getCurrentUser();
                if (user && user.id) {
                  found = user;
                  return;
                }
              }
            }
          } catch (_err) {
            // continue searching modules
          }
        }
      },
    ]);
    window.webpackChunkdiscord_app.pop();
    return found;
  }

  function buildHeaders(token) {
    const captured = window.__discordCleanupCapturedHeaders || {};
    const authorization = isUsableToken(token)
      ? token
      : isUsableToken(captured.authorization)
        ? captured.authorization
        : null;
    const headers = {};

    if (authorization) {
      headers.Authorization = authorization;
    }

    for (const [key, value] of Object.entries(captured)) {
      if (key.toLowerCase() === "authorization") {
        continue;
      }
      headers[key] = value;
    }

    return headers;
  }

  async function waitForCapturedHeaders(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (window.__discordCleanupCapturedHeaders && window.__discordCleanupCapturedHeaders.authorization) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !!(window.__discordCleanupCapturedHeaders && window.__discordCleanupCapturedHeaders.authorization);
  }

  async function performFetch(path, options) {
    let tokenInfo = getTokenWithSource();
    const hasUsableCapturedAuthorization = () =>
      isUsableToken(window.__discordCleanupCapturedHeaders && window.__discordCleanupCapturedHeaders.authorization);

    if (!tokenInfo.token && !hasUsableCapturedAuthorization()) {
      await waitForCapturedHeaders(1500);
      tokenInfo = getTokenWithSource();
    }
    const token = tokenInfo.token;
    if (!token && !hasUsableCapturedAuthorization()) {
      throw new Error("Could not read Discord session from this tab. Make sure you are logged in.");
    }

    const headerMode =
      !token && hasUsableCapturedAuthorization()
        ? "captured"
        : "built";

    const method = options.method || "GET";
    let lastError = null;

    for (const base of API_BASES) {
      const url = `${base}${path}`;
      let attempt = 0;

      while (attempt < 8) {
        attempt += 1;
        const response = await fetch(url, {
          method: method,
          credentials: "include",
          headers: buildHeaders(token),
          referrer: window.location.href,
          referrerPolicy: "no-referrer-when-downgrade",
          mode: "cors",
          body: options.body || null,
        });

        if (response.status === 429) {
          let retryAfter = 1;
          try {
            const body = await response.json();
            retryAfter = Number(body.retry_after) || 1;
          } catch (_err) {
            retryAfter = 1;
          }
          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 250));
          continue;
        }

        const text = await response.text();
        let body = null;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch (_err) {
            body = text;
          }
        }

        return {
          ok: response.ok,
          status: response.status,
          body: body,
          headerMode: headerMode,
          tokenSource: tokenInfo.source,
          errorCode: body && body.code ? body.code : null,
          errorMessage: body && body.message ? body.message : null,
        };
      }

      lastError = new Error(`Discord API error on ${base}`);
    }

    throw lastError || new Error("Discord API request failed.");
  }

  document.addEventListener(REQUEST_EVENT, async (event) => {
    const detail = event.detail || {};
    const requestId = detail.requestId;

    if (!requestId) {
      return;
    }

    try {
      if (detail.action === "getCurrentUser") {
        const user = getCurrentUser();
        if (!user || !user.id) {
          throw new Error("Could not read current user from this Discord tab. Refresh the page and try again.");
        }
        dispatchResponse({
          requestId: requestId,
          ok: true,
          user: {
            id: String(user.id),
            username: user.username || "",
          },
        });
        return;
      }

      if (detail.action === "apiFetch") {
        const result = await performFetch(detail.path, {
          method: detail.method || "GET",
          body: detail.body || null,
        });
        dispatchResponse({
          requestId: requestId,
          ok: true,
          status: result.status,
          body: result.body,
          headerMode: result.headerMode,
          errorCode: result.errorCode,
        });
        return;
      }

      throw new Error("Unknown bridge action.");
    } catch (err) {
      dispatchResponse({
        requestId: requestId,
        ok: false,
        error: err instanceof Error ? err.message : "Bridge request failed.",
      });
    }
  });
})();
