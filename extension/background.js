let captureStartInProgress = false;

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return;
  } catch (error) {
    // The manifest content script may not have been injected into this tab yet.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

async function sendToOffscreen(message) {
  const attempts = 20;
  let lastPingError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: "offscreen_ping",
      });
    } catch (error) {
      lastPingError = error;
      // The offscreen document may exist before its module listener is ready.
    }

    if (response?.ok) {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) {
        throw new Error(result?.error || "Offscreen capture initialization failed.");
      }
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  let contextInfo = "context state unavailable";
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    contextInfo = `offscreen contexts found: ${contexts.length}`;
  } catch (error) {
    contextInfo = `offscreen document exists: ${await chrome.offscreen.hasDocument()}`;
  }

  throw new Error(
    `Offscreen audio processor did not become ready (${contextInfo}; ${lastPingError?.message || "no ping response"}).`,
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "content_ready") {
    console.log("Content script ready on tab:", sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "offscreen_booted") {
    console.log("Offscreen bootstrap loaded:", sender.url);
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "forward_to_tab") {
    if (sender.url !== chrome.runtime.getURL("offscreen.html")) {
      sendResponse({ ok: false, error: "Unauthorized message sender." });
      return false;
    }

    chrome.tabs
      .sendMessage(message.tabId, message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.action !== "start_youtube_capture") {
    return false;
  }

  if (captureStartInProgress) {
    sendResponse({ ok: false, error: "Capture startup is already in progress." });
    return false;
  }
  captureStartInProgress = true;

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        throw new Error("No active tab available for capture.");
      }

      const existing = await chrome.offscreen.hasDocument();
      if (existing) {
        await chrome.offscreen.closeDocument();
      }

      // Closing the previous offscreen document releases its tab-capture stream.
      const streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tab.id,
      });

      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification:
          "Capturing live tab audio stream to feed the local Whisper model.",
      });

      await ensureContentScript(tab.id);
      await sendToOffscreen({
        action: "init_stream",
        streamId,
        tabId: tab.id,
      });
      sendResponse({ ok: true });
    } catch (error) {
      console.error("Failed to start YouTube capture:", error);
      sendResponse({ ok: false, error: error.message });
    } finally {
      captureStartInProgress = false;
    }
  })();

  return true;
});
