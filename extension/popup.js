document.getElementById("startBtn")?.addEventListener("click", async () => {
  try {
    chrome.runtime.sendMessage({ action: "ping" }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          "Background worker not ready yet:",
          chrome.runtime.lastError.message,
        );
        return;
      }

      chrome.runtime.sendMessage({ action: "start_youtube_capture" }, () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "Capture start failed:",
            chrome.runtime.lastError.message,
          );
        }
      });
    });
  } catch (error) {
    console.error("Failed to request capture start:", error);
  }
});
