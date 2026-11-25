let whisperPipeline = null;
let pipelinePromise = null;
let inferenceInFlight = false;
let sessionModelManager = null;
let sessionTabId = null;
let previousWindowTranscript = "";
let activeCapture = null;

const SAMPLE_RATE = 16_000;
// Keep the translation window and backlog short so captions stay close to the
// audio being played. Whisper inference is serial, so an unbounded audio queue
// turns any slow inference into steadily increasing subtitle delay.
const WINDOW_SAMPLES = SAMPLE_RATE * 5;
const OVERLAP_SAMPLES = SAMPLE_RATE;
const MAX_QUEUED_SAMPLES = SAMPLE_RATE * 5;
let audioChunks = [];
let queuedSamples = 0;
let overlapTail = new Float32Array(0);
let audioWasDropped = false;
let latestVideoClock = null;
let overlapTailTime = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const sourceTabId = message.tabId ?? sender.tab?.id;
  if (message.action === "stop_capture") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.action === "video_clock" && sourceTabId === sessionTabId) {
    latestVideoClock = {
      currentTime: message.currentTime,
      playbackRate: message.playbackRate || 1,
      paused: message.paused,
      receivedAt: Date.now(),
    };
  }
});

function videoTimeNow() {
  if (!latestVideoClock || latestVideoClock.paused) {
    return latestVideoClock?.currentTime ?? null;
  }
  const elapsed = (Date.now() - latestVideoClock.receivedAt) / 1000;
  return latestVideoClock.currentTime + elapsed * latestVideoClock.playbackRate;
}

function enqueueAudio(samples) {
  if (!samples.length) return;
  const endTime = videoTimeNow();
  const duration = latestVideoClock?.paused
    ? 0
    : samples.length / SAMPLE_RATE * (latestVideoClock?.playbackRate || 1);
  audioChunks.push({
    samples,
    startTime: endTime === null ? null : endTime - duration,
    endTime,
  });
  queuedSamples += samples.length;

  while (queuedSamples > MAX_QUEUED_SAMPLES && audioChunks.length) {
    const excess = queuedSamples - MAX_QUEUED_SAMPLES;
    const first = audioChunks[0];
    if (first.samples.length <= excess) {
      audioChunks.shift();
      queuedSamples -= first.samples.length;
    } else {
      const fraction = excess / first.samples.length;
      audioChunks[0] = {
        ...first,
        samples: first.samples.subarray(excess),
        startTime: first.startTime === null
          ? null
          : first.startTime + (first.endTime - first.startTime) * fraction,
      };
      queuedSamples -= excess;
    }
    audioWasDropped = true;
  }

  // The saved overlap belongs to audio before the discarded samples. Do not
  // prepend it to a newer window after trimming the backlog.
  if (audioWasDropped) {
    overlapTail = new Float32Array(0);
    overlapTailTime = null;
  }
}

function takeAudio(samplesToTake) {
  const output = new Float32Array(samplesToTake);
  let written = 0;
  let startTime = null;
  let endTime = null;

  while (written < samplesToTake) {
    const first = audioChunks[0];
    const count = Math.min(first.samples.length, samplesToTake - written);
    if (startTime === null) startTime = first.startTime;
    output.set(first.samples.subarray(0, count), written);
    written += count;
    queuedSamples -= count;

    if (count === first.samples.length) {
      endTime = first.endTime;
      audioChunks.shift();
    } else {
      const fraction = count / first.samples.length;
      endTime = first.startTime === null
        ? null
        : first.startTime + (first.endTime - first.startTime) * fraction;
      audioChunks[0] = {
        ...first,
        samples: first.samples.subarray(count),
        startTime: endTime,
      };
    }
  }

  return { samples: output, startTime, endTime };
}

function nextAudioWindow() {
  const hasOverlap = overlapTail.length > 0;
  const newSamplesNeeded = hasOverlap
    ? WINDOW_SAMPLES - OVERLAP_SAMPLES
    : WINDOW_SAMPLES;

  if (queuedSamples < newSamplesNeeded) return null;

  const freshAudio = takeAudio(newSamplesNeeded);
  const window = new Float32Array(overlapTail.length + freshAudio.samples.length);
  window.set(overlapTail);
  window.set(freshAudio.samples, overlapTail.length);
  const startTime = overlapTailTime?.startTime ?? freshAudio.startTime;
  const endTime = freshAudio.endTime;
  overlapTail = window.slice(-OVERLAP_SAMPLES);
  const overlapDuration = OVERLAP_SAMPLES / window.length *
    ((endTime ?? 0) - (startTime ?? 0));
  overlapTailTime = startTime === null || endTime === null
    ? null
    : { startTime: endTime - overlapDuration, endTime };
  return { samples: window, startTime, endTime };
}

async function processNextAudioWindow() {
  if (inferenceInFlight || !sessionModelManager || !sessionTabId) return;
  const audioWindow = nextAudioWindow();
  if (!audioWindow) return;

  if (audioWasDropped) {
    previousWindowTranscript = "";
    audioWasDropped = false;
  }

  inferenceInFlight = true;
  try {
    const pipelineInstance = await getWhisperPipeline(sessionTabId);
    const result = await pipelineInstance(audioWindow.samples, {
      task: "translate",
      return_timestamps: true,
    });

    const windowBecameStale = audioWasDropped;
    if (windowBecameStale) {
      previousWindowTranscript = "";
      audioWasDropped = false;
    }

    const transcript = result?.text?.trim() ?? "";
    const freshTranscript = removeWindowOverlap(previousWindowTranscript, transcript);
    const overlapWords = transcript.split(/\s+/).filter(Boolean).length -
      freshTranscript.split(/\s+/).filter(Boolean).length;
    previousWindowTranscript = transcript;
    if (!freshTranscript) {
      console.debug("Whisper returned no new text for the current audio window.");
      return;
    }

    const chunks = Array.isArray(result?.chunks) && result.chunks.length
      ? result.chunks
      : [{ text: freshTranscript, timestamp: [0, audioWindow.samples.length / SAMPLE_RATE] }];
    const videoSecondsPerAudioSecond =
      audioWindow.startTime === null || audioWindow.endTime === null
        ? 1
        : (audioWindow.endTime - audioWindow.startTime) /
          (audioWindow.samples.length / SAMPLE_RATE);
    let wordsToSkip = Math.max(0, overlapWords);
    const cues = [];
    for (const chunk of chunks) {
      let text = chunk.text?.trim() ?? "";
      if (!text) continue;
      if (wordsToSkip) {
        const words = text.split(/\s+/);
        const skipped = Math.min(wordsToSkip, words.length);
        wordsToSkip -= skipped;
        text = words.slice(skipped).join(" ");
      }
      const deduped = sessionModelManager.process_transcript_chunk(text);
      if (!deduped.trim()) continue;
      const [start, end] = chunk.timestamp ?? [0, audioWindow.samples.length / SAMPLE_RATE];
      cues.push({
        text: deduped.trim(),
        startTime: audioWindow.startTime === null
          ? null
          : audioWindow.startTime + (start ?? 0) * videoSecondsPerAudioSecond,
        endTime: audioWindow.startTime === null
          ? null
          : audioWindow.startTime + (end ?? audioWindow.samples.length / SAMPLE_RATE) * videoSecondsPerAudioSecond,
      });
    }
    if (!cues.length) {
      const fallbackText = sessionModelManager.process_transcript_chunk(freshTranscript);
      if (fallbackText.trim()) {
        cues.push({
          text: fallbackText.trim(),
          startTime: audioWindow.startTime,
          endTime: audioWindow.endTime,
        });
      }
    }
    if (!cues.length) return;

    console.info("Translation ready to render", {
      characters: freshTranscript.length,
      timedChunks: cues.length,
      windowBecameStale,
    });
    const delivery = await chrome.runtime.sendMessage({
      action: "forward_to_tab",
      tabId: sessionTabId,
      payload: {
        action: "render_subtitle",
        cues,
        windowBecameStale,
        text: cues.map((cue) => cue.text).join(" "),
      },
    });
    if (!delivery?.ok) {
      console.error("Subtitle delivery to the YouTube tab failed:", delivery?.error);
    }
  } catch (error) {
    console.error("Whisper inference failed:", error);
    await notifyStatus(
      sessionTabId,
      `Transcription failed: ${error.message}. Retrying...`,
    );
  } finally {
    inferenceInFlight = false;
  }
}

function removeWindowOverlap(previous, current) {
  const previousWords = previous.split(/\s+/).filter(Boolean);
  const currentWords = current.split(/\s+/).filter(Boolean);
  const limit = Math.min(20, previousWords.length, currentWords.length);
  const normalize = (word) =>
    word.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

  for (let overlap = limit; overlap > 0; overlap -= 1) {
    const previousTail = previousWords.slice(-overlap).map(normalize);
    const currentHead = currentWords.slice(0, overlap).map(normalize);
    if (
      previousTail.every((word, index) => word && word === currentHead[index])
    ) {
      return currentWords.slice(overlap).join(" ");
    }
  }

  return current;
}

async function notifyStatus(tabId, text) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      action: "forward_to_tab",
      tabId,
      payload: {
        action: "transcription_status",
        text,
      },
    });
  } catch (error) {
    console.debug("Status message not delivered:", error);
  }
}

async function getWhisperPipeline(tabId) {
  if (whisperPipeline) {
    return whisperPipeline;
  }

  if (!pipelinePromise) {
    notifyStatus(tabId, "Loading local multilingual Whisper model...");

    pipelinePromise = (async () => {
      const { env, pipeline } =
        await import("./vendor/transformers/dist/transformers.js");
      env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL(
        "vendor/transformers/dist/",
      );
      return await pipeline(
        "automatic-speech-recognition",
        "Xenova/whisper-tiny",
        {
          quantized: true,
        },
      );
    })().catch((error) => {
      pipelinePromise = null;
      throw error;
    });
  }

  try {
    whisperPipeline = await pipelinePromise;
    return whisperPipeline;
  } catch (error) {
    await notifyStatus(tabId, "Whisper model failed to load.");
    throw error;
  }
}

export async function startCapture(message) {
  let mediaStream;
  let audioCtx;

  try {
    const wasm = await import("./pkg/local_lingo.js");
    await wasm.default();

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: message.streamId,
        },
      },
      video: false,
    });

    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(mediaStream);
    const modelManager = new wasm.ExtensionModelManager();
    await audioCtx.audioWorklet.addModule(
      chrome.runtime.getURL("audio-capture-worklet.js"),
    );
    const captureNode = new AudioWorkletNode(audioCtx, "tab-audio-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCountMode: "max",
      processorOptions: { targetRate: SAMPLE_RATE },
    });

    // tabCapture removes the original output route. Restore playback directly;
    // keep transcription on a separate, silent AudioWorklet analysis branch.
    source.connect(audioCtx.destination);
    source.connect(captureNode);
    captureNode.connect(audioCtx.destination);
    sessionModelManager = modelManager;
    sessionTabId = message.tabId;
    previousWindowTranscript = "";
    captureNode.port.onmessage = ({ data }) => {
      enqueueAudio(data);
      void processNextAudioWindow();
    };
    await audioCtx.resume();
    activeCapture = { mediaStream, audioCtx, source, captureNode };
  } catch (error) {
    mediaStream?.getTracks().forEach((track) => track.stop());
    if (audioCtx && audioCtx.state !== "closed") {
      await audioCtx.close().catch(() => {});
    }
    console.error("Failed to initialize offscreen capture:", error);
    if (message.tabId) {
      await notifyStatus(message.tabId, "Audio capture failed to start.");
    }
    throw error;
  }
}

async function stopCapture() {
  const capture = activeCapture;
  const tabId = sessionTabId;
  activeCapture = null;
  sessionTabId = null;
  sessionModelManager = null;
  audioChunks = [];
  queuedSamples = 0;
  overlapTail = new Float32Array(0);
  overlapTailTime = null;
  audioWasDropped = false;
  previousWindowTranscript = "";

  if (capture) {
    capture.captureNode.port.onmessage = null;
    capture.captureNode.disconnect();
    capture.source.disconnect();
    capture.mediaStream.getTracks().forEach((track) => track.stop());
    if (capture.audioCtx.state !== "closed") {
      await capture.audioCtx.close().catch(() => {});
    }
  }

  if (tabId) {
    await chrome.runtime.sendMessage({
      action: "forward_to_tab",
      tabId,
      payload: { action: "clear_subtitles" },
    }).catch(() => {});
  }
}
