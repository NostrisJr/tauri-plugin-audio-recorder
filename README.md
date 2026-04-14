# Tauri Plugin Audio Recorder

Cross-platform audio recording plugin for Tauri 2.x applications. Provides audio recording functionality for desktop (Windows, macOS, Linux) and mobile (iOS, Android).

This is a fork of https://github.com/brenogonzaga/tauri-plugin-audio-recorder, made to expose amplitude of incomming audio, to feed waveforms displays.

## Features

- **Cross-platform**: Works on Windows, macOS, Linux, iOS, and Android
- **Desktop WAV / Mobile M4A**: Desktop outputs WAV (16-bit PCM). Mobile outputs M4A/AAC due to native API constraints.
- **Quality presets**: Low (16kHz mono), Medium (44.1kHz mono), High (48kHz stereo)
- **Pause/Resume**: Full control over recording sessions
- **Duration tracking**: Real-time duration monitoring
- **Permission handling**: Built-in permission request APIs
- **Device enumeration**: List available audio input devices

## Installation

### Rust

Add the plugin to your `Cargo.toml`:

```toml
[dependencies]
tauri-plugin-audio-recorder = "0.1"
```

### TypeScript

Install the JavaScript guest bindings:

```bash
npm install tauri-plugin-audio-recorder-api
# or
yarn add tauri-plugin-audio-recorder-api
# or
pnpm add tauri-plugin-audio-recorder-api
```

## Setup

### Register Plugin

In your Tauri app setup:

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_audio_recorder::init())
        .run(tauri::generate_context!())
        .expect("error while running application");
}
```

### Permissions

Add permissions to your `capabilities/default.json`:

```json
{
  "permissions": ["audio-recorder:default"]
}
```

For granular permissions, you can specify individual commands:

```json
{
  "permissions": [
    "audio-recorder:allow-start-recording",
    "audio-recorder:allow-stop-recording",
    "audio-recorder:allow-pause-recording",
    "audio-recorder:allow-resume-recording",
    "audio-recorder:allow-get-status",
    "audio-recorder:allow-get-devices",
    "audio-recorder:allow-check-permission",
    "audio-recorder:allow-request-permission"
  ]
}
```

### Platform-Specific Setup

#### Android

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

#### iOS (Info.plist)

```xml
<key>NSMicrophoneUsageDescription</key>
<string>This app needs microphone access to record audio for exercises.</string>
```

## Usage

```typescript
import {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  getStatus,
  getDevices,
  checkPermission,
  requestPermission,
} from "tauri-plugin-audio-recorder-api";

// Check and request permission
const permission = await checkPermission();
if (!permission.granted) {
  const result = await requestPermission();
  if (!result.granted) {
    console.error("Microphone permission denied");
    return;
  }
}

// Start recording
await startRecording({
  outputPath: "/path/to/recording", // without extension
  quality: "medium", // "low" | "medium" | "high"
  maxDuration: 300, // max 5 minutes (0 = unlimited)
});

// Check status
const status = await getStatus();
console.log(`State: ${status.state}, Duration: ${status.durationMs}ms`);

// Pause/Resume
await pauseRecording();
await resumeRecording();

// Stop and get result
const result = await stopRecording();
console.log(`Recorded ${result.durationMs}ms to ${result.filePath}`);
console.log(`File size: ${result.fileSize} bytes`);
console.log(
  `Sample rate: ${result.sampleRate}Hz, Channels: ${result.channels}`
);
```

### Real-time Status Monitoring

```typescript
import { getStatus } from "tauri-plugin-audio-recorder-api";

// Poll for status updates during recording
const intervalId = setInterval(async () => {
  const status = await getStatus();
  if (status.state === "recording") {
    console.log(`Recording: ${Math.floor(status.durationMs / 1000)}s`);
    updateUI(status.durationMs);
  } else if (status.state === "idle") {
    clearInterval(intervalId);
  }
}, 100); // Update every 100ms

// Stop recording
await stopRecording();
clearInterval(intervalId);
```

### Device Selection

```typescript
import { getDevices, startRecording } from "tauri-plugin-audio-recorder-api";

// List available devices (Desktop only)
const { devices } = await getDevices();
console.log("Available microphones:");
devices.forEach(device => {
  console.log(`- ${device.name} ${device.isDefault ? "(default)" : ""}`);
});

// Note: Currently uses system default device
// Device selection will be added in future versions
```

## API Reference

### Recording Functions

#### `startRecording(config: RecordingConfig): Promise<void>`

Start audio recording.

**Config:**

- `outputPath`: File path without extension (required)
- `format`: Audio format (currently only "wav", mobile outputs M4A)
- `quality`: "low" (16kHz mono) | "medium" (44.1kHz mono) | "high" (48kHz stereo)
- `maxDuration`: Max recording duration in seconds (0 = unlimited)

**Throws:** Error if already recording or permission denied

#### `stopRecording(): Promise<RecordingResult>`

Stop recording and get result.

**Returns:**

- `filePath`: Full path to recorded file (with .wav or .m4a extension)
- `durationMs`: Recording duration in milliseconds
- `fileSize`: File size in bytes
- `sampleRate`: Sample rate used (Hz)
- `channels`: Number of channels (1 = mono, 2 = stereo)

**Throws:** Error if not recording

#### `pauseRecording(): Promise<void>`

Pause current recording.

**Note:** Requires Android N+ (API 24+) on Android.

#### `resumeRecording(): Promise<void>`

Resume paused recording.

#### `getStatus(): Promise<RecordingStatus>`

Get current recording status.

**Returns:**

- `state`: "idle" | "recording" | "paused"
- `durationMs`: Current duration in milliseconds
- `outputPath`: Output file path (without extension) or null if idle

### Utility Functions

#### `getDevices(): Promise<DevicesResponse>`

List available audio input devices (Desktop only).

**Returns:**

- `devices`: Array of audio devices with id, name, and isDefault

**Note:** Returns empty array on mobile (uses system default device).

#### `checkPermission(): Promise<PermissionResponse>`

Check microphone permission status.

**Returns:**

- `granted`: Whether permission is granted
- `canRequest`: Whether permission can be requested (not permanently denied)

#### `requestPermission(): Promise<PermissionResponse>`

Request microphone permission from user.

**Returns:** Same as `checkPermission()`

**Behavior:**

- Desktop: Returns granted immediately (no permission system)
- Android: Shows permission dialog
- iOS: Shows permission dialog on first request

### Types

#### RecordingConfig

```typescript
interface RecordingConfig {
  outputPath: string; // File path without extension
  format?: "wav"; // Input format option (currently only "wav"; output container varies by platform)
  quality?: "low" | "medium" | "high"; // Quality preset
  maxDuration?: number; // Max duration in seconds (0 = unlimited)
}
```

#### RecordingResult

```typescript
interface RecordingResult {
  filePath: string; // Full path to recorded file
  durationMs: number; // Duration in milliseconds
  fileSize: number; // File size in bytes
  sampleRate: number; // Sample rate used
  channels: number; // Number of channels
}
```

#### RecordingStatus

```typescript
interface RecordingStatus {
  state: "idle" | "recording" | "paused";
  durationMs: number;
  outputPath: string | null;
}
```

## Feature Support Matrix

| Feature            | Windows | macOS | Linux | iOS | Android |
| ------------------ | ------- | ----- | ----- | --- | ------- |
| Recording          | ✅      | ✅    | ✅    | ✅  | ✅      |
| Pause/Resume       | ✅      | ✅    | ✅    | ✅  | ✅\*    |
| Status Monitoring  | ✅      | ✅    | ✅    | ✅  | ✅      |
| Device Enumeration | ✅      | ✅    | ✅    | ❌  | ❌      |
| WAV Output         | ✅      | ✅    | ✅    | ⚠️  | ❌      |
| M4A Output         | ❌      | ❌    | ❌    | ✅  | ✅      |
| Max Duration       | ✅      | ✅    | ✅    | ✅  | ✅      |
| Quality Presets    | ✅      | ✅    | ✅    | ✅  | ✅      |

**Legend:**

- ✅ Full support
- ⚠️ iOS can output WAV but defaults to M4A for efficiency
- ❌ Not supported
- \* Pause/Resume requires Android N+ (API 24+)

## Quality Presets

| Preset   | Sample Rate | Channels | Use Case           |
| -------- | ----------- | -------- | ------------------ |
| `low`    | 16 kHz      | Mono     | Voice/Speech       |
| `medium` | 44.1 kHz    | Mono     | General purpose    |
| `high`   | 48 kHz      | Stereo   | Music/High quality |

## Platform-specific Output Formats

> ⚠️ **Important**: Output format varies by platform due to native API constraints.

| Platform | Output Format | Extension | Codec | Notes                                     |
| -------- | ------------- | --------- | ----- | ----------------------------------------- |
| Desktop  | WAV           | `.wav`    | PCM   | True uncompressed WAV                     |
| Android  | M4A           | `.m4a`    | AAC   | MediaRecorder uses AAC encoder            |
| iOS      | M4A           | `.m4a`    | AAC   | AVAudioRecorder with kAudioFormatMPEG4AAC |

### Handling Format Differences

When processing recordings across platforms, check the file extension or use a media library to detect the format:

```typescript
import { stopRecording } from "tauri-plugin-audio-recorder-api";

const result = await stopRecording();
const extension = result.filePath.split(".").pop();

if (extension === "wav") {
  // Desktop: PCM WAV - can be processed directly
} else if (extension === "m4a") {
  // Mobile: AAC in M4A container - may need transcoding for some operations
}
```

### Why Different Formats?

- **Desktop**: Uses `cpal` + `hound` which natively produce WAV
- **Android**: MediaRecorder API is optimized for AAC/M4A output; WAV requires lower-level AudioRecord API
- **iOS**: AVAudioRecorder can produce WAV but AAC/M4A is more efficient for mobile storage

### Converting to Unified Format

If you need consistent format across platforms, use the `media-editor` plugin to convert:

```typescript
import { stopRecording } from "tauri-plugin-audio-recorder-api";
import { convert } from "tauri-plugin-media-editor-api";

const result = await stopRecording();

// Convert mobile M4A to WAV if needed
if (result.filePath.endsWith(".m4a")) {
  const converted = await convert({
    inputPath: result.filePath,
    outputPath: result.filePath.replace(".m4a", ""),
    format: "wav",
    audioQuality: "lossless",
  });
  console.log(`Converted to WAV: ${converted.outputPath}`);
}
```

## Troubleshooting

### "Permission denied" errors

**Always request permission before recording:**

```typescript
const perm = await requestPermission();
if (!perm.granted) {
  if (perm.canRequest) {
    console.error("User denied permission");
  } else {
    console.error("Permission permanently denied. Enable in system settings.");
  }
  return;
}
```

**iOS:** Ensure `NSMicrophoneUsageDescription` is in Info.plist

**Android:** Ensure `RECORD_AUDIO` permission is in AndroidManifest.xml

### "Already recording" errors

**Solution:** Stop current recording before starting new one:

```typescript
const status = await getStatus();
if (status.state !== "idle") {
  await stopRecording();
}
await startRecording(config);
```

### Pause/Resume not working on Android

**Issue:** Pause/Resume requires Android N+ (API 24+, Android 7.0+)

**Solution:** Check Android version or handle gracefully:

```typescript
try {
  await pauseRecording();
} catch (error) {
  if (String(error).includes("not supported")) {
    console.warn("Pause not supported on this Android version");
    // Fallback: stop and restart recording
  }
}
```

### No audio devices found (Desktop)

**Checklist:**

- ✅ Microphone is connected
- ✅ Microphone is enabled in system settings
- ✅ Microphone is not exclusively used by another app
- ✅ Audio drivers are up to date

**Debug:**

```typescript
const { devices } = await getDevices();
if (devices.length === 0) {
  console.error("No audio input devices found");
  console.log("Check system audio settings");
}
```

### Recording file is empty or corrupted

**Common causes:**

- Recording stopped immediately after start
- Insufficient disk space
- File path not writable
- Microphone not working

**Solution:** Add minimum duration check:

```typescript
const result = await stopRecording();
if (result.durationMs < 100) {
  console.warn("Recording too short, may be corrupted");
}
if (result.fileSize < 1000) {
  console.warn("File size too small, recording may have failed");
}
```

### Max duration not triggering

**Note:** `maxDuration` is a hard limit. Recording stops automatically when reached, but you won't receive a callback.

**Recommended pattern:**

```typescript
await startRecording({
  outputPath: "/path/to/recording",
  maxDuration: 60, // 60 seconds
});

// Poll status to detect when stopped
const checkInterval = setInterval(async () => {
  const status = await getStatus();
  if (status.state === "idle") {
    clearInterval(checkInterval);
    const result = await stopRecording();
    console.log("Recording completed:", result);
  }
}, 1000);
```

### Format conversion between platforms

**Problem:** Desktop produces WAV, mobile produces M4A.

**Solution:** Use Media Toolkit plugin for conversion:

```typescript
import { stopRecording } from "tauri-plugin-audio-recorder-api";
import { convert } from "tauri-plugin-media-toolkit-api";

const result = await stopRecording();

if (result.filePath.endsWith(".m4a")) {
  // Convert mobile M4A to WAV
  const converted = await convert({
    inputPath: result.filePath,
    outputPath: result.filePath.replace(".m4a", ""),
    format: "wav",
    audioQuality: "lossless",
  });
  console.log("Converted to WAV:", converted.outputPath);
}
```

### Output path doesn't include extension

**This is by design.** The plugin automatically appends the correct extension:

```typescript
// Input: outputPath = "/path/to/recording"
// Desktop output: "/path/to/recording.wav"
// Mobile output: "/path/to/recording.m4a"

// ❌ Don't include extension:
outputPath: "/path/to/recording.wav"; // Wrong

// ✅ Correct:
outputPath: "/path/to/recording"; // Correct
```

## Platform Notes

### Desktop

- Uses `cpal` for cross-platform audio input
- Uses `hound` for WAV encoding
- Full device enumeration support

### Android

- Uses MediaRecorder API
- Requires `RECORD_AUDIO` permission
- Pause/Resume requires Android N (API 24+)

### iOS

- Uses AVAudioRecorder
- Requires `NSMicrophoneUsageDescription` in Info.plist
- True WAV output with Linear PCM

## Examples

See the [examples/audio-recorder-example](./examples/audio-recorder-example) directory for a complete working demo with React + Material UI, featuring:

- Permission handling flow
- Recording with pause/resume
- Real-time duration display
- Quality preset selection
- Device enumeration (desktop)
- Status monitoring
- Error handling

## License

MIT
