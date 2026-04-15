# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **macOS / Desktop**: replaced quality-preset sample-rate negotiation with `device.default_input_config()` native format
  - The previous negotiation loop built a `StreamConfig` with the preset sample rate (e.g. 44100 Hz) even when the device's native rate differed, causing CoreAudio to silently deliver empty buffers with no error
  - `cpal_config` is now derived from `SupportedStreamConfig::config()`, which always matches the hardware's native rate and channel count
  - The `quality` preset field continues to work on iOS and Android but is ignored on desktop
- **macOS**: `checkPermission` and `requestPermission` now call AVFoundation instead of always returning granted
  - `checkPermission` maps `AVAuthorizationStatus`: `NotDetermined → {granted:false, canRequest:true}`, `Authorized → {granted:true, canRequest:false}`, `Denied/Restricted → {granted:false, canRequest:false}`
  - `requestPermission` blocks until the system dialog resolves (using `AVCaptureDevice.requestAccess(for:)` + `mpsc` channel), then returns the actual result
  - Fixes silent audio capture when macOS revokes microphone permission after an app rebuild

### Documentation

- Added macOS entitlement requirement (`com.apple.security.device.audio-input`) to README platform-specific setup

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
