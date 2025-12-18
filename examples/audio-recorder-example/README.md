# Audio Recorder Plugin Example

Complete demonstration of the `tauri-plugin-audio-recorder` functionality using React + TypeScript + Material UI.

## Features Demonstrated

- ✅ Permission checking and requesting flow
- ✅ Audio recording with real-time duration display
- ✅ Pause and resume functionality
- ✅ Quality preset selection (Low, Medium, High)
- ✅ Max duration limiting
- ✅ Status monitoring (idle/recording/paused)
- ✅ Device enumeration (desktop only)
- ✅ Recording result display (duration, file size, sample rate, channels)
- ✅ Error handling with user feedback
- ✅ Platform-specific format handling (WAV vs M4A)
- ✅ Responsive design (mobile-friendly)

## Running the Example

### Desktop

```bash
npm install
npm run tauri dev
```

### Mobile

```bash
npm install
npm run tauri android dev
# or
npm run tauri ios dev
```

## Project Structure

```
audio-recorder-example/
├── src/
│   ├── App.tsx          # Main demo component
│   └── main.tsx         # React entry point
├── src-tauri/
│   ├── src/
│   │   └── main.rs      # Tauri setup with Audio Recorder plugin
│   ├── Cargo.toml       # Rust dependencies
│   └── capabilities/
│       └── default.json # Permissions configuration
└── package.json         # NPM dependencies
```

## Code Highlights

### Permission Flow

The example demonstrates proper permission handling:

```typescript
// Check permission status
const perm = await checkPermission();

if (!perm.granted) {
  if (perm.canRequest) {
    // Request permission
    const result = await requestPermission();
    if (!result.granted) {
      showError("Microphone permission is required");
      return;
    }
  } else {
    showError("Permission denied. Enable in system settings.");
    return;
  }
}

// Permission granted, start recording
await startRecording(config);
```

### Real-time Duration Display

Update UI every 100ms while recording:

```typescript
const [duration, setDuration] = useState(0);

useEffect(() => {
  let interval: NodeJS.Timeout;

  if (isRecording) {
    interval = setInterval(async () => {
      const status = await getStatus();
      setDuration(status.durationMs);

      // Auto-stop detection when max duration reached
      if (status.state === "idle" && duration > 0) {
        handleRecordingStopped();
      }
    }, 100);
  }

  return () => clearInterval(interval);
}, [isRecording]);

// Format duration display
const formatDuration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
};
```

### State Management

Track recording state with clear transitions:

```typescript
type RecordingState = "idle" | "recording" | "paused";

const [state, setState] = useState<RecordingState>("idle");

const handleStartRecording = async () => {
  try {
    await startRecording({
      outputPath: recordingPath,
      quality: selectedQuality,
      maxDuration: maxDuration || 0,
    });
    setState("recording");
  } catch (error) {
    handleError(error);
  }
};

const handlePause = async () => {
  await pauseRecording();
  setState("paused");
};

const handleResume = async () => {
  await resumeRecording();
  setState("recording");
};

const handleStop = async () => {
  const result = await stopRecording();
  setState("idle");
  displayResult(result);
};
```

### Error Handling Pattern

Structured error handling with user-friendly messages:

```typescript
const handleError = (error: unknown) => {
  const errorMsg = String(error);

  if (errorMsg.includes("permission denied")) {
    showError("Microphone permission denied");
  } else if (errorMsg.includes("already recording")) {
    showError("Recording already in progress");
  } else if (errorMsg.includes("not supported")) {
    showError("Feature not supported on this platform");
  } else if (errorMsg.includes("device not found")) {
    showError("No audio input device found");
  } else {
    showError(`Recording error: ${errorMsg}`);
  }
};
```

### Platform-Specific Handling

Detect and handle format differences:

```typescript
const result = await stopRecording();

// Detect platform based on file extension
const extension = result.filePath.split(".").pop();
const isDesktop = extension === "wav";
const isMobile = extension === "m4a";

setResultInfo({
  path: result.filePath,
  duration: result.durationMs,
  size: result.fileSize,
  sampleRate: result.sampleRate,
  channels: result.channels,
  format: extension,
  platform: isDesktop ? "Desktop (WAV/PCM)" : "Mobile (M4A/AAC)",
});
```

## Technologies Used

- **Tauri 2.x** - Desktop/Mobile application framework
- **React 18** - UI library
- **TypeScript** - Type safety
- **Material UI 6** - Component library
- **Vite** - Build tool

## Platform-Specific Features

### Desktop

- **Output:** WAV (16-bit PCM)
- **Device Selection:** Full enumeration support
- **Pause/Resume:** Full support
- **Quality Presets:** All supported

### iOS

- **Output:** M4A (AAC) - more efficient for mobile
- **Device Selection:** Uses system default
- **Pause/Resume:** Full support
- **Quality Presets:** All supported
- **Permission:** First-time dialog

### Android

- **Output:** M4A (AAC)
- **Device Selection:** Uses system default
- **Pause/Resume:** Requires Android N+ (API 24+)
- **Quality Presets:** All supported
- **Permission:** Runtime permission dialog

## Features by Quality Preset

### Low (16kHz Mono)

- Best for: Voice notes, speech recognition
- File size: ~2 MB per minute
- Use case: Podcasts, voice memos

### Medium (44.1kHz Mono)

- Best for: General purpose recording
- File size: ~5 MB per minute
- Use case: Interviews, meetings

### High (48kHz Stereo)

- Best for: Music, high-quality audio
- File size: ~17 MB per minute (WAV), ~1-2 MB (M4A)
- Use case: Music recording, soundscapes

## Learn More

- [tauri-plugin-audio-recorder Documentation](../../README.md)
- [Tauri Documentation](https://tauri.app/)
- [Material UI Documentation](https://mui.com/)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [AVAudioRecorder (iOS)](https://developer.apple.com/documentation/avfoundation/avaudiorecorder)
- [MediaRecorder (Android)](https://developer.android.com/reference/android/media/MediaRecorder)

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri Extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Troubleshooting

### Permission denied

**Solution:** Check platform-specific requirements:

**iOS:** Add to Info.plist:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>We need microphone access to record audio</string>
```

**Android:** Add to AndroidManifest.xml:

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

### Pause not working on Android

**Issue:** Pause/Resume requires Android N+ (API 24+)

**Solution:** Check Android version or disable pause button:

```typescript
const canPause = Platform.OS === "android" ? Platform.Version >= 24 : true;
```

### No audio devices (Desktop)

**Checklist:**

- Microphone connected and enabled
- Not used exclusively by another app
- Audio drivers updated
- System audio settings correct

**Debug:**

```typescript
const { devices } = await getDevices();
console.log(`Found ${devices.length} audio devices`);
devices.forEach(d => console.log(`- ${d.name}`));
```

### Recording file is empty

**Common causes:**

- Recording stopped immediately
- Microphone not working
- Insufficient permissions
- Disk space full

**Solution:** Add validation:

```typescript
const result = await stopRecording();
if (result.durationMs < 100 || result.fileSize < 1000) {
  showWarning("Recording may be invalid");
}
```
