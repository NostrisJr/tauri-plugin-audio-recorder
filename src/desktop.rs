use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use hound::{WavSpec, WavWriter};
use serde::de::DeserializeOwned;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use tauri::{plugin::PluginApi, AppHandle, Emitter, Runtime};

use crate::error::Error;
use crate::models::*;

/// Accumulateur RMS sur une fenêtre glissante de ~50ms.
/// Appelé depuis le callback audio (thread dédié, pas de contention).
struct AmplitudeAccumulator {
    sum_sq: f32,
    count: u32,
    /// Nombre de samples (tous canaux) correspondant à ~50ms
    target_count: u32,
}

impl AmplitudeAccumulator {
    fn new(sample_rate: u32, channels: u16) -> Self {
        let target_count = ((sample_rate as f32 * 0.05) as u32 * channels as u32).max(1);
        Self { sum_sq: 0.0, count: 0, target_count }
    }

    /// Ajoute un sample normalisé [-1.0, 1.0].
    /// Retourne le RMS clamped à [0.0, 1.0] quand la fenêtre est complète, None sinon.
    fn push(&mut self, sample: f32) -> Option<f32> {
        self.sum_sq += sample * sample;
        self.count += 1;
        if self.count >= self.target_count {
            let rms = (self.sum_sq / self.count as f32).sqrt().clamp(0.0, 1.0);
            self.sum_sq = 0.0;
            self.count = 0;
            Some(rms)
        } else {
            None
        }
    }
}

// Commands for the recording thread
enum RecorderCommand {
    Start(RecordingConfig, mpsc::Sender<Result<(), Error>>),
    Stop(mpsc::Sender<Result<RecordingResult, Error>>),
    Pause(mpsc::Sender<Result<(), Error>>),
    Resume(mpsc::Sender<Result<(), Error>>),
    Shutdown,
}

// Shared state that's Send + Sync
struct SharedState {
    is_recording: AtomicBool,
    is_paused: AtomicBool,
    duration_ms: AtomicU64,
    output_path: Mutex<Option<String>>,
    sample_rate: AtomicU64,
    channels: AtomicU64,
}

impl Default for SharedState {
    fn default() -> Self {
        Self {
            is_recording: AtomicBool::new(false),
            is_paused: AtomicBool::new(false),
            duration_ms: AtomicU64::new(0),
            output_path: Mutex::new(None),
            sample_rate: AtomicU64::new(44100),
            channels: AtomicU64::new(1),
        }
    }
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AudioRecorder<R>> {
    let shared = Arc::new(SharedState::default());
    let (cmd_tx, cmd_rx) = mpsc::channel::<RecorderCommand>();

    // Spawn the recording thread (app_clone pour émettre les events d'amplitude)
    let shared_clone = Arc::clone(&shared);
    let app_clone = app.clone();
    let handle = thread::spawn(move || {
        recording_thread(cmd_rx, shared_clone, app_clone);
    });

    Ok(AudioRecorder {
        app: app.clone(),
        shared,
        cmd_tx,
        _thread_handle: Mutex::new(Some(handle)),
    })
}

// Recording thread - owns all non-Send cpal types
fn recording_thread<R: Runtime>(
    rx: mpsc::Receiver<RecorderCommand>,
    shared: Arc<SharedState>,
    app: AppHandle<R>,
) {
    let mut current_stream: Option<cpal::Stream> = None;
    let mut current_writer: Option<Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>> = None;
    let mut write_flag: Option<Arc<AtomicBool>> = None;

    loop {
        match rx.recv() {
            Ok(RecorderCommand::Start(config, reply)) => {
                let result = start_recording_internal(&config, &shared, &app);
                match result {
                    Ok((stream, writer, flag)) => {
                        current_stream = Some(stream);
                        current_writer = Some(writer);
                        write_flag = Some(flag);
                        let _ = reply.send(Ok(()));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Ok(RecorderCommand::Stop(reply)) => {
                let result =
                    stop_recording_internal(&shared, &mut current_stream, &mut current_writer);
                write_flag = None;
                let _ = reply.send(result);
            }
            Ok(RecorderCommand::Pause(reply)) => {
                if let Some(ref flag) = write_flag {
                    flag.store(false, Ordering::SeqCst);
                    shared.is_paused.store(true, Ordering::SeqCst);
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(Error::NotRecording));
                }
            }
            Ok(RecorderCommand::Resume(reply)) => {
                if let Some(ref flag) = write_flag {
                    flag.store(true, Ordering::SeqCst);
                    shared.is_paused.store(false, Ordering::SeqCst);
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err(Error::NotRecording));
                }
            }
            Ok(RecorderCommand::Shutdown) | Err(_) => {
                // Clean up and exit
                if let Some(stream) = current_stream.take() {
                    drop(stream);
                }
                if let Some(writer) = current_writer.take() {
                    if let Ok(mut guard) = writer.lock() {
                        if let Some(w) = guard.take() {
                            let _ = w.finalize();
                        }
                    }
                }
                break;
            }
        }
    }
}

fn start_recording_internal<R: Runtime>(
    config: &RecordingConfig,
    shared: &Arc<SharedState>,
    app: &AppHandle<R>,
) -> Result<
    (
        cpal::Stream,
        Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>,
        Arc<AtomicBool>,
    ),
    Error,
> {
    if shared.is_recording.load(Ordering::SeqCst) {
        return Err(Error::AlreadyRecording);
    }

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or(Error::DeviceNotFound)?;

    // Get the device's default/supported configuration
    let supported_config = device
        .default_input_config()
        .map_err(|e| Error::Recording(format!("Failed to get device config: {}", e)))?;

    // Try to use quality preset settings, fall back to device defaults
    let target_sample_rate = config.quality.sample_rate();
    let target_channels = config.quality.channels();

    // Check if device supports the target configuration
    let supported_configs = device.supported_input_configs();
    let (sample_rate, channels) = if let Ok(configs) = supported_configs {
        let mut best_match = None;
        for cfg in configs {
            let sr_min = cfg.min_sample_rate().0;
            let sr_max = cfg.max_sample_rate().0;
            let ch = cfg.channels();

            // Check if target sample rate is in range and channels match
            if target_sample_rate >= sr_min && target_sample_rate <= sr_max && ch == target_channels
            {
                best_match = Some((target_sample_rate, target_channels));
                break;
            }
            // Try just matching sample rate
            if best_match.is_none() && target_sample_rate >= sr_min && target_sample_rate <= sr_max
            {
                best_match = Some((target_sample_rate, ch));
            }
        }

        match best_match {
            Some((sr, ch)) => {
                log::info!(
                    "Using quality preset: {}Hz, {} channels (target was {}Hz, {} channels)",
                    sr,
                    ch,
                    target_sample_rate,
                    target_channels
                );
                (sr, ch)
            }
            None => {
                log::warn!(
                    "Quality preset not supported ({}Hz, {} ch), using device defaults",
                    target_sample_rate,
                    target_channels
                );
                (
                    supported_config.sample_rate().0,
                    supported_config.channels(),
                )
            }
        }
    } else {
        log::warn!("Could not enumerate supported configs, using device defaults");
        (
            supported_config.sample_rate().0,
            supported_config.channels(),
        )
    };

    log::info!(
        "Recording config: {}Hz, {} channels, format: {:?}",
        sample_rate,
        channels,
        supported_config.sample_format()
    );

    // Build stream config with our target settings
    let cpal_config = StreamConfig {
        channels,
        sample_rate: cpal::SampleRate(sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };

    // Create output file path
    // If output_path is empty or just a filename, use temp directory
    let file_path = if config.output_path.is_empty() {
        // Generate unique filename in temp directory
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let temp_dir = std::env::temp_dir();
        let filename = format!("recording-{}.wav", timestamp);
        temp_dir.join(filename).to_string_lossy().to_string()
    } else if !config.output_path.contains('/') && !config.output_path.contains('\\') {
        // Just a filename without path, use temp directory
        let temp_dir = std::env::temp_dir();
        let filename = format!("{}.wav", config.output_path);
        temp_dir.join(filename).to_string_lossy().to_string()
    } else {
        // Full path provided, use as-is
        format!("{}.wav", config.output_path)
    };

    let path = PathBuf::from(&file_path);

    // Ensure parent directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let spec = WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer = WavWriter::create(&path, spec)
        .map_err(|e| Error::Recording(format!("Failed to create WAV file: {}", e)))?;
    let writer = Arc::new(Mutex::new(Some(writer)));
    let writer_clone = Arc::clone(&writer);

    let write_enabled = Arc::new(AtomicBool::new(true));
    let write_enabled_clone = Arc::clone(&write_enabled);

    let shared_clone = Arc::clone(shared);
    let start_time = std::time::Instant::now();

    let err_fn = |err| log::error!("Audio stream error: {}", err);

    // Clones et accumulateurs RMS pour chaque variant de format (chaque arm du match
    // déplace ses propres captures, donc on prépare ici ceux du cas F32)
    let app_f32 = app.clone();
    let mut acc_f32 = AmplitudeAccumulator::new(sample_rate, channels);

    let stream = match supported_config.sample_format() {
        SampleFormat::F32 => device.build_input_stream(
            &cpal_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !write_enabled_clone.load(Ordering::Relaxed) {
                    return;
                }
                if let Ok(mut guard) = writer_clone.lock() {
                    if let Some(ref mut w) = *guard {
                        for &sample in data {
                            let sample_i16 = (sample * 32767.0) as i16;
                            let _ = w.write_sample(sample_i16);
                        }
                    }
                }
                // Calcul RMS et émission de l'event d'amplitude (~50ms)
                for &sample in data {
                    if let Some(rms) = acc_f32.push(sample) {
                        let _ = app_f32.emit(
                            "audio-recorder://amplitude",
                            AmplitudePayload { rms },
                        );
                    }
                }
                let elapsed = start_time.elapsed().as_millis() as u64;
                shared_clone.duration_ms.store(elapsed, Ordering::Relaxed);
            },
            err_fn,
            None,
        ),
        SampleFormat::I16 => {
            let write_enabled_clone = Arc::clone(&write_enabled);
            let writer_clone = Arc::clone(&writer);
            let shared_clone = Arc::clone(shared);
            let app_i16 = app.clone();
            let mut acc_i16 = AmplitudeAccumulator::new(sample_rate, channels);
            device.build_input_stream(
                &cpal_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !write_enabled_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut guard) = writer_clone.lock() {
                        if let Some(ref mut w) = *guard {
                            for &sample in data {
                                let _ = w.write_sample(sample);
                            }
                        }
                    }
                    // Normalisation i16 → f32 pour le calcul RMS
                    for &sample in data {
                        let sample_f32 = sample as f32 / 32768.0;
                        if let Some(rms) = acc_i16.push(sample_f32) {
                            let _ = app_i16.emit(
                                "audio-recorder://amplitude",
                                AmplitudePayload { rms },
                            );
                        }
                    }
                    let elapsed = start_time.elapsed().as_millis() as u64;
                    shared_clone.duration_ms.store(elapsed, Ordering::Relaxed);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let write_enabled_clone = Arc::clone(&write_enabled);
            let writer_clone = Arc::clone(&writer);
            let shared_clone = Arc::clone(shared);
            let app_u16 = app.clone();
            let mut acc_u16 = AmplitudeAccumulator::new(sample_rate, channels);
            device.build_input_stream(
                &cpal_config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    if !write_enabled_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut guard) = writer_clone.lock() {
                        if let Some(ref mut w) = *guard {
                            for &sample in data {
                                let sample_i16 = (sample as i32 - 32768) as i16;
                                let _ = w.write_sample(sample_i16);
                            }
                        }
                    }
                    // Normalisation u16 → f32 pour le calcul RMS
                    for &sample in data {
                        let sample_f32 = (sample as i32 - 32768) as f32 / 32768.0;
                        if let Some(rms) = acc_u16.push(sample_f32) {
                            let _ = app_u16.emit(
                                "audio-recorder://amplitude",
                                AmplitudePayload { rms },
                            );
                        }
                    }
                    let elapsed = start_time.elapsed().as_millis() as u64;
                    shared_clone.duration_ms.store(elapsed, Ordering::Relaxed);
                },
                err_fn,
                None,
            )
        }
        _ => return Err(Error::UnsupportedFormat),
    }
    .map_err(|e| Error::Recording(format!("Failed to build audio stream: {}", e)))?;

    stream
        .play()
        .map_err(|e| Error::Recording(format!("Failed to start audio stream: {}", e)))?;

    // Update shared state
    shared.is_recording.store(true, Ordering::SeqCst);
    shared.is_paused.store(false, Ordering::SeqCst);
    shared.duration_ms.store(0, Ordering::SeqCst);
    shared
        .sample_rate
        .store(sample_rate as u64, Ordering::SeqCst);
    shared.channels.store(channels as u64, Ordering::SeqCst);
    *shared.output_path.lock().unwrap() = Some(file_path);

    log::info!(
        "Recording started: {}Hz, {} channels",
        sample_rate,
        channels
    );

    Ok((stream, writer, write_enabled))
}

fn stop_recording_internal(
    shared: &Arc<SharedState>,
    stream: &mut Option<cpal::Stream>,
    writer: &mut Option<Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>>,
) -> Result<RecordingResult, Error> {
    if !shared.is_recording.load(Ordering::SeqCst) {
        return Err(Error::NotRecording);
    }

    // Stop the stream
    if let Some(s) = stream.take() {
        drop(s);
    }

    // Finalize the WAV file
    if let Some(w) = writer.take() {
        if let Ok(mut guard) = w.lock() {
            if let Some(wav_writer) = guard.take() {
                wav_writer
                    .finalize()
                    .map_err(|e| Error::Recording(format!("Failed to finalize WAV: {}", e)))?;
            }
        }
    }

    let duration_ms = shared.duration_ms.load(Ordering::SeqCst);
    let sample_rate = shared.sample_rate.load(Ordering::SeqCst) as u32;
    let channels = shared.channels.load(Ordering::SeqCst) as u16;
    let output_path = shared
        .output_path
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();

    // Get file size
    let file_size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Reset state
    shared.is_recording.store(false, Ordering::SeqCst);
    shared.is_paused.store(false, Ordering::SeqCst);
    shared.duration_ms.store(0, Ordering::SeqCst);

    log::info!("Recording stopped: {} ({}ms)", output_path, duration_ms);

    Ok(RecordingResult {
        file_path: output_path,
        duration_ms,
        file_size,
        sample_rate,
        channels,
    })
}

/// Access to the audio-recorder APIs.
pub struct AudioRecorder<R: Runtime> {
    #[allow(dead_code)]
    app: AppHandle<R>,
    shared: Arc<SharedState>,
    cmd_tx: mpsc::Sender<RecorderCommand>,
    _thread_handle: Mutex<Option<JoinHandle<()>>>,
}

impl<R: Runtime> AudioRecorder<R> {
    /// Start recording audio
    pub fn start_recording(&self, config: RecordingConfig) -> crate::Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.cmd_tx
            .send(RecorderCommand::Start(config, reply_tx))
            .map_err(|_| Error::Recording("Recording thread not available".to_string()))?;

        reply_rx
            .recv()
            .map_err(|_| Error::Recording("No response from recording thread".to_string()))?
    }

    /// Stop recording and return the result
    pub fn stop_recording(&self) -> crate::Result<RecordingResult> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.cmd_tx
            .send(RecorderCommand::Stop(reply_tx))
            .map_err(|_| Error::Recording("Recording thread not available".to_string()))?;

        reply_rx
            .recv()
            .map_err(|_| Error::Recording("No response from recording thread".to_string()))?
    }

    /// Pause recording
    pub fn pause_recording(&self) -> crate::Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.cmd_tx
            .send(RecorderCommand::Pause(reply_tx))
            .map_err(|_| Error::Recording("Recording thread not available".to_string()))?;

        reply_rx
            .recv()
            .map_err(|_| Error::Recording("No response from recording thread".to_string()))?
    }

    /// Resume recording
    pub fn resume_recording(&self) -> crate::Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.cmd_tx
            .send(RecorderCommand::Resume(reply_tx))
            .map_err(|_| Error::Recording("Recording thread not available".to_string()))?;

        reply_rx
            .recv()
            .map_err(|_| Error::Recording("No response from recording thread".to_string()))?
    }

    /// Get current recording status
    pub fn get_status(&self) -> crate::Result<RecordingStatus> {
        let is_recording = self.shared.is_recording.load(Ordering::SeqCst);
        let is_paused = self.shared.is_paused.load(Ordering::SeqCst);
        let duration_ms = self.shared.duration_ms.load(Ordering::SeqCst);
        let output_path = self.shared.output_path.lock().unwrap().clone();

        let state = if !is_recording {
            RecordingState::Idle
        } else if is_paused {
            RecordingState::Paused
        } else {
            RecordingState::Recording
        };

        Ok(RecordingStatus {
            state,
            duration_ms,
            output_path,
        })
    }

    /// List available audio input devices
    pub fn get_devices(&self) -> crate::Result<AudioDevicesResponse> {
        let host = cpal::default_host();
        let default_device = host.default_input_device();
        let default_name = default_device.as_ref().and_then(|d| d.name().ok());

        let devices = host
            .input_devices()
            .map_err(|e| Error::Recording(format!("Failed to enumerate devices: {}", e)))?;

        let mut result = Vec::new();
        for device in devices {
            if let Ok(name) = device.name() {
                let is_default = default_name.as_ref().map(|n| n == &name).unwrap_or(false);
                result.push(AudioDevice {
                    id: name.clone(),
                    name,
                    is_default,
                });
            }
        }

        Ok(AudioDevicesResponse { devices: result })
    }

    /// Check microphone permission (always granted on desktop)
    pub fn check_permission(&self) -> crate::Result<PermissionStatus> {
        // On desktop, microphone access is typically granted at the OS level
        Ok(PermissionStatus {
            granted: true,
            can_request: false,
        })
    }

    /// Request microphone permission (no-op on desktop)
    pub fn request_permission(&self) -> crate::Result<PermissionStatus> {
        // On desktop, this is handled by the OS
        Ok(PermissionStatus {
            granted: true,
            can_request: false,
        })
    }
}

impl<R: Runtime> Drop for AudioRecorder<R> {
    fn drop(&mut self) {
        // Send shutdown command
        let _ = self.cmd_tx.send(RecorderCommand::Shutdown);
        // Wait for thread to finish
        if let Ok(mut guard) = self._thread_handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}
