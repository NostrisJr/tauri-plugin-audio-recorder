import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Note: input `format` is currently limited to "wav".
// On mobile, the native recorder still outputs M4A/AAC due to platform APIs.
export type AudioFormat = "wav";
export type AudioQuality = "low" | "medium" | "high";

export interface RecordingConfig {
  outputPath: string;
  format?: AudioFormat;
  quality?: AudioQuality;
  /** Maximum recording duration in seconds. 0 means no limit. */
  maxDuration?: number;
}

export type RecordingState = "idle" | "recording" | "paused";

export interface RecordingStatus {
  state: RecordingState;
  durationMs: number;
  outputPath: string | null;
}

export interface RecordingResult {
  filePath: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** File size in bytes */
  fileSize: number;
}

export interface PermissionResponse {
  /** Whether the permission is currently granted */
  granted: boolean;
  /** Whether the permission can be requested (not permanently denied) */
  canRequest: boolean;
}

export interface AudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface DevicesResponse {
  devices: AudioDevice[];
}

export async function startRecording(config: RecordingConfig): Promise<void> {
  await invoke("plugin:audio-recorder|start_recording", { config });
}

export async function stopRecording(): Promise<RecordingResult> {
  return await invoke("plugin:audio-recorder|stop_recording");
}

export async function pauseRecording(): Promise<void> {
  await invoke("plugin:audio-recorder|pause_recording");
}

export async function resumeRecording(): Promise<void> {
  await invoke("plugin:audio-recorder|resume_recording");
}

export async function getStatus(): Promise<RecordingStatus> {
  return await invoke("plugin:audio-recorder|get_status");
}

/**
 * Check if microphone permission is granted.
 * @returns Permission status with granted state and whether it can be requested
 */
export async function checkPermission(): Promise<PermissionResponse> {
  return await invoke("plugin:audio-recorder|check_permission");
}

/**
 * Request microphone permission from the user.
 * On Android, this will show a permission dialog and wait for the user's response.
 * @returns Permission status after the user responds
 */
export async function requestPermission(): Promise<PermissionResponse> {
  return await invoke("plugin:audio-recorder|request_permission");
}

/**
 * Get available audio input devices.
 * @returns List of available audio input devices
 */
export async function getDevices(): Promise<DevicesResponse> {
  return await invoke("plugin:audio-recorder|get_devices");
}

/** Payload emitted by the recorder for each amplitude tick (~10 Hz). */
export interface AmplitudePayload {
  /** Linear RMS amplitude in `[0, 1]`. */
  rms: number;
}

/**
 * Subscribe to live RMS amplitude updates while recording.
 *
 * On iOS, the plugin pushes payloads via a Tauri `Channel` (registered through
 * `register_amplitude_listener`). On desktop, the plugin emits a global event
 * (`audio-recorder://amplitude`) which is consumed via `listen()`. This helper
 * picks the right transport for the current platform and returns an unlisten
 * function for cleanup.
 *
 * @param handler  Called for every amplitude tick.
 * @returns        Function to call to stop receiving updates.
 */
export async function onAmplitude(
  handler: (payload: AmplitudePayload) => void,
): Promise<UnlistenFn> {
  try {
    const channel = new Channel<AmplitudePayload>(handler);
    await invoke("plugin:audio-recorder|register_amplitude_listener", {
      handler: channel,
    });
    // The plugin retains the channel until the next start/stop cycle, so the
    // unlisten is a no-op here — the channel goes out of scope with the caller.
    return () => {};
  } catch {
    return await listen<AmplitudePayload>(
      "audio-recorder://amplitude",
      (event) => handler(event.payload),
    );
  }
}
