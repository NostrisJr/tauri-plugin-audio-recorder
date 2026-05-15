# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **iOS**: real-time amplitude updates during active recording, matching the macOS behaviour
  - RMS is computed from PCM buffers delivered by the `AVAudioEngine` input tap and stored in `latestRms`
  - A `DispatchSourceTimer` (100 ms, utility queue) reads `latestRms` and forwards it to JS through a Tauri `Channel`
  - Timer is started on `startRecording`, stopped on `pauseRecording` and `stopRecording`/`cleanup`, restarted on `resumeRecording`
  - `latestRms` is reset to 0.0 on resume and cleanup so stale values are never re-emitted after silence
- **iOS**: new `register_amplitude_listener` command — frontends register a `Channel<{ rms: number }>` once and receive every tick directly (no global event bus, lower overhead, no listener leakage across windows)
- **guest-js**: new `onAmplitude(handler)` helper that picks the right transport per platform (Channel on iOS, `listen()` on desktop) and returns an unlisten function

### Fixed

- **iOS**: `start_recording` no longer rejects with a generic error when the JS helper is used
  - Root cause: the guest-js helper wraps the payload as `{ config: {...} }`, and Tauri's iOS plugin bridge routes JS calls directly to the Swift method **without going through the Rust `#[command]` layer** that would otherwise unwrap the `config` parameter. The Swift plugin was decoding the args directly into `RecordingConfig` and failing with `keyNotFound("outputPath")`.
  - Fix: introduce an explicit `StartRecordingArgs { config: RecordingConfig }` wrapper and parse that on the Swift side, then forward `args.config` to the rest of the flow.
  - The bug was silent on Android because `@InvokeArg` Kotlin classes have default field values — `parseArgs` did not throw, it just produced a `RecordingConfigArgs` filled with defaults (empty `outputPath`, `"wav"` format, …), which would have led to harder-to-diagnose runtime failures further down. **See the README "Implementing new commands" section** before adding any new mobile command that takes structured arguments.
- **iOS**: `parseArgs` failures inside `startRecording` are now caught explicitly and forwarded to JS as a readable error message instead of bubbling out of the `throws` declaration and reaching JS as a generic Tauri rejection.
- **iOS**: `cleanup()` now restores the audio session category to `.playback` after stopping the recording so the WebView can play audio (e.g. the recording you just made) without having to wait for the OS to recycle the session.
- **macOS / Desktop**: replaced quality-preset sample-rate negotiation with `device.default_input_config()` native format
  - The previous negotiation loop built a `StreamConfig` with the preset sample rate (e.g. 44100 Hz) even when the device's native rate differed, causing CoreAudio to silently deliver empty buffers with no error
  - `cpal_config` is now derived from `SupportedStreamConfig::config()`, which always matches the hardware's native rate and channel count
  - The `quality` preset field continues to work on iOS and Android but is ignored on desktop

### ⚠️ Notes for Android implementers

The same `{ config }` wrapping issue exists on Android today but is hidden by `@InvokeArg` defaults — it will surface as silent misbehaviour rather than an exception. Before publishing parity with the iOS amplitude `Channel` flow, the Kotlin side should:

1. Mirror the wrapper struct (`StartRecordingArgs(config: RecordingConfigArgs)`) and call `args.config` instead of relying on default-filled fields.
2. Expose an equivalent of `register_amplitude_listener` returning a `Channel` (Android plugins receive `Channel` arguments the same way as iOS — see `RegisterAmplitudeArgs` in `AudioRecorderPlugin.swift`).
3. Use the same snake_case command name (`register_amplitude_listener`) so the `onAmplitude()` JS helper works without per-platform branching.

---

## [0.2.0] - 2026-04-14

### Added

- Real-time amplitude event `audio-recorder://amplitude` emitted every ~50ms during recording
- Payload: `{ rms: number }` normalized between 0.0 (silence) and 1.0 (full scale)
- Event is suppressed while recording is paused on all platforms

### Desktop

- `AmplitudeAccumulator` struct accumulates PCM samples over a ~50ms window before computing RMS
- Supports all three cpal sample formats (F32, I16, U16) with proper normalization to f32
- Emits via `AppHandle::emit` (Tauri `Emitter` trait)

### iOS

- Replaced `AVAudioRecorder` with `AVAudioEngine` + `AVAudioInputNode.installTap`
- PCM buffers are written to an `AVAudioFile` (AAC output, Core Audio handles PCM→AAC conversion)
- RMS computed directly on `floatChannelData` of each buffer

### Android

- Added 50ms polling loop using `MediaRecorder.maxAmplitude` (0–32767), normalized to 0.0–1.0
- Polling stops automatically on pause, resume, and cleanup

---

## [0.1.0] - 2025-12

### Added

- Initial release of Audio Recorder plugin for Tauri 2.x
- Cross-platform support (Windows, macOS, Linux, iOS, Android)
- WAV recording with 16-bit PCM encoding
- Quality presets: low (16kHz mono), medium (44.1kHz mono), high (48kHz stereo)
- Pause and resume functionality
- Real-time duration tracking via `getStatus()`
- Audio device enumeration via `getDevices()`
- Permission checking and requesting APIs
- Max duration limit support
- TypeScript API with full type definitions

### Desktop Implementation

- Uses `cpal` crate for cross-platform audio input
- Uses `hound` crate for WAV file encoding
- Supports multiple sample formats (F32, I16, U16)
- Thread-safe recording state management

### iOS Implementation

- Uses AVAudioRecorder with Linear PCM format
- Proper audio session management
- Native permission handling via AVAudioSession

### Android Implementation

### Requirements

- Tauri: 2.9+
- Rust: 1.77+
- Android SDK: 24+ (Android 7.0+)
- iOS: 14.0+
- Uses MediaRecorder API
- Pause/Resume support on Android N+
- Runtime permission handling for RECORD_AUDIO
