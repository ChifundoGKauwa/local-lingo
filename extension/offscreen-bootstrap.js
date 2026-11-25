chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "offscreen_ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.action !== "init_stream") {
    return false;
  }

  import("./offscreen.js")
    .then(({ startCapture }) => startCapture(message))
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error("Failed to initialize offscreen capture:", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

chrome.runtime.sendMessage({ action: "offscreen_booted" }).catch((error) => {
  console.error("Could not announce offscreen bootstrap:", error);
});
