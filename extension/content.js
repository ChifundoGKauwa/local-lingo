function createSubtitleOverlay() {
  let overlay = document.getElementById("local-lingo-subtitles");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "local-lingo-subtitles";

    Object.assign(overlay.style, {
      position: "absolute",
      bottom: "60px",
      left: "50%",
      transform: "translateX(-50%)",
      backgroundColor: "rgba(0, 0, 0, 0.75)",
      color: "#ffffff",
      padding: "8px 16px",
      fontSize: "20px",
      fontFamily: "Arial, sans-serif",
      borderRadius: "4px",
      zIndex: "9999",
      pointerEvents: "none",
      textAlign: "center",
      maxWidth: "80%",
      lineHeight: "1.4",
    });

    const moviePlayer = document.querySelector(".html5-video-player");
    if (moviePlayer) {
      moviePlayer.appendChild(overlay);
    } else {
      document.body.appendChild(overlay);
    }
  }

  return overlay;
}

let timedCues = [];
let lastRenderedCue = "";

function getYouTubeVideo() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function updateTimedSubtitle() {
  const video = getYouTubeVideo();
  if (!video) return;

  const now = video.currentTime;
  const cue = timedCues.find((item) =>
    item.startTime !== null && item.endTime !== null &&
    now >= item.startTime && now <= item.endTime + 0.35
  );
  const overlay = document.getElementById("local-lingo-subtitles");
  if (!overlay) return;
  const text = cue?.text ?? "";
  if (text !== lastRenderedCue) {
    overlay.textContent = text;
    lastRenderedCue = text;
  }

  // Keep only recent playback history. This also leaves enough cues available
  // for short backward seeks without letting the list grow for the whole video.
  timedCues = timedCues.filter((item) => item.endTime === null || item.endTime >= now - 30);
}

setInterval(() => {
  const video = getYouTubeVideo();
  if (!video) return;
  chrome.runtime.sendMessage({
    action: "video_clock",
    currentTime: video.currentTime,
    playbackRate: video.playbackRate || 1,
    paused: video.paused,
  }).catch(() => {});
  updateTimedSubtitle();
}, 100);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "ping") {
    sendResponse({ ok: true });
    return false;
  }

  if (message.action === "render_subtitle") {
    if (Array.isArray(message.cues)) {
      const overlay = createSubtitleOverlay();
      if (window.subtitleTimeout) clearTimeout(window.subtitleTimeout);
      const cues = message.cues.filter((cue) => cue.text);
      const video = getYouTubeVideo();
      const now = video?.currentTime;
      const newestCue = cues.at(-1);
      const cueTimesAlreadyPassed = Number.isFinite(now) && newestCue &&
        (!Number.isFinite(newestCue.endTime) || newestCue.endTime < now - 0.35);

      if (cueTimesAlreadyPassed) {
        const originalDuration = Number.isFinite(newestCue.startTime) &&
          Number.isFinite(newestCue.endTime)
          ? newestCue.endTime - newestCue.startTime
          : 2;
        timedCues.push({
          text: newestCue.text,
          startTime: now,
          endTime: now + Math.min(3, Math.max(1.2, originalDuration)),
        });
      } else {
        timedCues.push(...cues);
      }
      timedCues.sort((left, right) => (left.startTime ?? 0) - (right.startTime ?? 0));
      overlay.textContent = "";
      lastRenderedCue = "";
      updateTimedSubtitle();
      sendResponse({ ok: true });
      return true;
    }

    const overlay = createSubtitleOverlay();
    overlay.textContent = message.text;

    if (window.subtitleTimeout) {
      clearTimeout(window.subtitleTimeout);
    }

    window.subtitleTimeout = setTimeout(() => {
      overlay.textContent = "";
    }, 4000);

    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "transcription_status") {
    timedCues = [];
    lastRenderedCue = "";
    const overlay = createSubtitleOverlay();
    overlay.textContent = message.text || "Loading...";

    if (window.subtitleTimeout) {
      clearTimeout(window.subtitleTimeout);
    }

    window.subtitleTimeout = setTimeout(() => {
      overlay.textContent = "";
    }, 3000);

    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "clear_subtitles") {
    timedCues = [];
    lastRenderedCue = "";
    if (window.subtitleTimeout) clearTimeout(window.subtitleTimeout);
    const overlay = document.getElementById("local-lingo-subtitles");
    if (overlay) overlay.textContent = "";
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "init_stream") {
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.runtime.sendMessage({ action: "content_ready" }).catch(() => {
  // Ignore startup race while the service worker is still initializing.
});
