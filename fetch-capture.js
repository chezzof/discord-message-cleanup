(function () {
  if (window.__discordCleanupFetchPatched) {
    return;
  }
  window.__discordCleanupFetchPatched = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.includes("/api/")) {
        const headers = new Headers(
          (init && init.headers) || (input instanceof Request ? input.headers : undefined)
        );
        if (headers.get("authorization")) {
          const captured = {};
          headers.forEach((value, key) => {
            captured[key] = value;
          });
          window.__discordCleanupCapturedHeaders = captured;
        }
      }
    } catch (_err) {
      // ignore capture errors
    }

    return originalFetch(input, init);
  };
})();
