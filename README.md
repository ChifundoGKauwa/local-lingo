# Local Lingo Subtitles

Local Lingo is a Chrome extension that translates speech from a YouTube video into English subtitles. It captures the tab audio, runs the multilingual Whisper Tiny model in the browser, and displays timestamped cues over the video.

## Features

- Captures audio from the active YouTube tab and restores its normal playback route.
- Runs speech translation locally with Transformers.js and ONNX Runtime Web.
- Aligns timestamped subtitle cues to the video's playback position, including seeks and playback-rate changes.
- Keeps a bounded audio queue so slow inference does not create an ever-growing subtitle delay.

The first use may need an internet connection to download the Whisper model files from Hugging Face. The model is cached by the browser after download. Audio inference runs in the browser; the extension does not send captured audio to a transcription service.

## Install in Chrome

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Select **Load unpacked** and choose the repository's `extension/` directory.
4. Open a YouTube video, select the Local Lingo extension icon, and choose **Capture YouTube Audio**.
5. Allow the model to load. Translated subtitles will appear over the video as timestamped cues become available.

The extension currently targets YouTube pages in Chrome. Its manifest requests tab capture, an offscreen document, and scripting access for its capture and subtitle flows.

## How it works

1. The Manifest V3 service worker requests a tab-capture stream and starts an offscreen document.
2. An audio worklet converts captured audio to mono 16 kHz samples for Whisper while the original stream continues to the speakers.
3. Transformers.js runs `Xenova/whisper-tiny` with the translation task and returns timestamped text chunks.
4. The content script compares cue times with the YouTube video's current playback time and displays the active cue.

The Transformers.js runtime and ONNX WebAssembly files used by the extension are bundled under `extension/vendor/transformers/`.

## Development

### Regenerate the WebAssembly bindings

The Rust library is compiled to WebAssembly for use by the extension. Install Rust, add the WebAssembly target, and install `wasm-pack`, then run:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
wasm-pack build --target web --out-dir extension/pkg
```

This updates the generated bindings and WebAssembly binary in `extension/pkg/`.

### Run Rust tests

```sh
cargo test
```

The native test build includes `whisper-rs`; install the platform's `libclang` development library if Cargo reports that it cannot find `libclang`.

There is no JavaScript test script configured in `package.json` yet.

## Project layout

```text
extension/                 Chrome extension and runtime assets
  background.js            Capture startup and extension message routing
  content.js               YouTube subtitle overlay and playback clock
  offscreen.js             Audio capture, Whisper inference, and cue timing
  audio-capture-worklet.js  Audio conversion for Whisper
  pkg/                     Generated Rust-to-Wasm bindings
  vendor/transformers/     Bundled Transformers.js and ONNX runtime assets
src/                       Rust audio processing and transcript utilities
Cargo.toml                 Rust crate configuration
package.json               JavaScript dependency metadata
```

## Known limitations

- Subtitle timing depends on Whisper inference speed. If inference finishes after a cue's playback interval has passed, that cue may no longer be shown.
- The extension translates captured speech into English; it does not currently provide a target-language selector.
- Capture is started from the extension popup and is scoped to the active tab at that time.
