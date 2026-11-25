const toggle = document.getElementById("toggle");
const statusText = document.getElementById("status-text");
const statusIndicator = document.getElementById("status-indicator");
const stateLabel = document.getElementById("state-label");
const controlDescription = document.getElementById("control-description");
let isEnabled = false;

function renderState(enabled, message) {
  isEnabled = enabled;
  toggle.setAttribute("aria-checked", String(enabled));
  stateLabel.textContent = enabled ? "ON" : "OFF";
  stateLabel.dataset.state = enabled ? "on" : "off";
  statusIndicator.dataset.state = enabled ? "on" : "off";
  statusText.textContent = message || (enabled ? "Translation is running" : "Ready when you are");
  controlDescription.textContent = enabled
    ? "Capturing audio from the active tab"
    : "Turn on for the current video";
}

async function sendAction(action) {
  return chrome.runtime.sendMessage({ action });
}

async function loadState() {
  try {
    const response = await sendAction("get_capture_status");
    if (!response?.ok) throw new Error(response?.error || "Status unavailable");
    renderState(Boolean(response.active));
  } catch (error) {
    statusText.textContent = "Could not read capture status";
    statusIndicator.dataset.state = "error";
    toggle.disabled = true;
    console.error("Failed to read Local Lingo status:", error);
  } finally {
    if (statusIndicator.dataset.state !== "error") toggle.disabled = false;
  }
}

toggle.addEventListener("click", async () => {
  const shouldEnable = !isEnabled;
  toggle.disabled = true;
  statusText.textContent = shouldEnable ? "Starting translation…" : "Stopping translation…";

  try {
    const response = await sendAction(
      shouldEnable ? "start_youtube_capture" : "stop_youtube_capture",
    );
    if (!response?.ok) throw new Error(response?.error || "Could not change capture state");
    renderState(Boolean(response.active));
  } catch (error) {
    statusText.textContent = error.message || "Could not change capture state";
    statusIndicator.dataset.state = "error";
    console.error("Failed to toggle Local Lingo:", error);
  } finally {
    toggle.disabled = false;
  }
});

void loadState();
