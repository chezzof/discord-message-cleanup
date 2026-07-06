(function () {
  if (window.__discordCleanupBridgeReady) {
    return;
  }
  window.__discordCleanupBridgeReady = true;

  const REQUEST_EVENT = "discordCleanupBridgeRequest";
  const RESPONSE_EVENT = "discordCleanupBridgeResponse";
  const API_BASE = "https://discord.com/api/v9";

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

  function getToken() {
    const fromAuthExport = getTokenFromAuthExport();
    if (fromAuthExport) {
      return fromAuthExport;
    }
    const fromWebpackDefault = getTokenFromWebpackDefault();
    if (fromWebpackDefault) {
      return fromWebpackDefault;
    }
    const fromStorage = readTokenFromLocalStorage();
    if (fromStorage) {
      return fromStorage;
    }
    return null;
  }

  function buildHeaders(token) {
    return {
      Authorization: token,
    };
  }

  async function performFetch(path, options) {
    const token = getToken();
    if (!token) {
      throw new Error("Could not read Discord session from this tab. Make sure you are logged in.");
    }

    const method = options.method || "GET";
    let attempt = 0;

    while (attempt < 8) {
      attempt += 1;
      const response = await fetch(`${API_BASE}${path}`, {
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
      };
    }

    throw new Error("Discord API request failed.");
  }

  document.addEventListener(REQUEST_EVENT, async (event) => {
    const detail = event.detail || {};
    const requestId = detail.requestId;

    if (!requestId) {
      return;
    }

    try {
      if (detail.action === "getCurrentUser") {
        const result = await performFetch("/users/@me", { method: "GET" });
        const user = result.body;
        if (!result.ok || !user || !user.id) {
          throw new Error("Could not read current user from this Discord tab. Refresh the page and try again.");
        }
        dispatchResponse({
          requestId: requestId,
          ok: true,
          user: {
            id: String(user.id),
            username: user.username || user.global_name || "",
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
