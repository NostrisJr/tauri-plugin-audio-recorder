import AVFoundation
import SwiftRs
import Tauri
import UIKit
import WebKit

class RecordingConfig: Decodable {
    let outputPath: String
    let format: String?
    let quality: String?
    let maxDuration: Int?
}

// On iOS, Tauri calls the Swift plugin directly without going through the Rust
// `#[command]` layer that would have unwrapped `config`. The guest-js helper
// sends `{ config: {...} }`, so we have to unwrap it explicitly on the Swift side.
class StartRecordingArgs: Decodable {
    let config: RecordingConfig
}

struct AmplitudeEvent: Encodable {
    let rms: Double
}

class AudioRecorderPlugin: Plugin {
    // AVAudioEngine replaces AVAudioRecorder so we can tap PCM buffers (for RMS amplitude).
    private var audioEngine: AVAudioEngine?
    private var audioOutputFile: AVAudioFile?
    private var recordingStartTime: Date?
    private var pausedDuration: TimeInterval = 0
    private var pauseStartTime: Date?
    private var isPaused: Bool = false
    private var isRecording: Bool = false
    private var isStopping: Bool = false  // Guard against concurrent stop calls
    private var currentFilePath: String?
    private var currentSampleRate: Int = 44100
    private var currentChannels: Int = 1
    private var maxDurationTimer: Timer?
    private var wasRecordingBeforeInterruption: Bool = false
    private var amplitudeTimer: DispatchSourceTimer?
    private var latestRms: Float = 0.0
    private var amplitudeChannel: Channel?
    
    override init() {
        super.init()
        NSLog("[AudioRecorder] ============================================")
        NSLog("[AudioRecorder] PLUGIN INIT")
        NSLog("[AudioRecorder]   iOS Version: \(UIDevice.current.systemVersion)")
        NSLog("[AudioRecorder]   Device: \(UIDevice.current.model)")
        setupInterruptionHandling()
        NSLog("[AudioRecorder] ============================================")
    }
    
    /// Sets up observers for audio session interruptions (phone calls, Siri, etc.)
    private func setupInterruptionHandling() {
        NSLog("[AudioRecorder] Setting up interruption handling...")
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioSessionInterruption),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
        NSLog("[AudioRecorder]   Observers registered")
    }
    
    /// Handles audio interruptions such as phone calls, Siri activation, etc.
    @objc private func handleAudioSessionInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }
        
        switch type {
        case .began:
            // Suspend recording: the AVAudioEngine tap will stop writing while isPaused is true.
            if isRecording && !isPaused {
                wasRecordingBeforeInterruption = true
                isPaused = true
                pauseStartTime = Date()
                NSLog("[AudioRecorder] Enregistrement suspendu (interruption système)")
            }

        case .ended:
            guard let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt else { return }
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)

            if options.contains(.shouldResume) && wasRecordingBeforeInterruption {
                do {
                    try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
                    if let pauseStart = pauseStartTime {
                        pausedDuration += Date().timeIntervalSince(pauseStart)
                    }
                    isPaused = false
                    pauseStartTime = nil
                    NSLog("[AudioRecorder] Enregistrement repris après interruption")
                } catch {
                    NSLog("[AudioRecorder] Échec de la reprise après interruption: \(error.localizedDescription)")
                }
            }
            wasRecordingBeforeInterruption = false
            
        @unknown default:
            break
        }
    }
    
    /// Handles audio route changes (headphones plugged/unplugged, Bluetooth, etc.)
    @objc private func handleAudioRouteChange(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }
        
        switch reason {
        case .oldDeviceUnavailable:
            // Previous audio device (e.g., headphones) was disconnected
            NSLog("[AudioRecorder] Audio route changed: old device unavailable")
        case .newDeviceAvailable:
            NSLog("[AudioRecorder] Audio route changed: new device available")
        default:
            break
        }
    }
    
    deinit {
        NotificationCenter.default.removeObserver(self)
    }
    
    struct RegisterAmplitudeArgs: Decodable {
        let handler: Channel
    }

    @objc public func registerAmplitudeListener(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] registerAmplitudeListener() CALLED")
        let args = try invoke.parseArgs(RegisterAmplitudeArgs.self)
        amplitudeChannel = args.handler
        NSLog("[AudioRecorder] registerAmplitudeListener() OK — channel id=\(args.handler.id)")
        invoke.resolve()
    }

    @objc public func startRecording(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] ============================================")
        NSLog("[AudioRecorder] startRecording() CALLED")

        // NOTE: the guest-js helper sends `{ config: {...} }` and Tauri iOS routes JS
        // directly to Swift without unwrapping through the Rust `#[command]` layer —
        // we therefore parse an explicit wrapper struct.
        let config: RecordingConfig
        do {
            config = try invoke.parseArgs(StartRecordingArgs.self).config
        } catch {
            NSLog("[AudioRecorder]   ERROR parseArgs: \(error)")
            invoke.reject("Failed to parse RecordingConfig: \(error.localizedDescription)")
            return
        }
        NSLog("[AudioRecorder]   outputPath: \(config.outputPath)")
        NSLog("[AudioRecorder]   format: \(config.format ?? "default")")
        NSLog("[AudioRecorder]   quality: \(config.quality ?? "medium")")
        NSLog("[AudioRecorder]   maxDuration: \(config.maxDuration ?? 0)")
        
        if isRecording {
            NSLog("[AudioRecorder]   ERROR: Already recording")
            invoke.reject("Already recording")
            return
        }
        
        let permission = AVAudioSession.sharedInstance().recordPermission
        NSLog("[AudioRecorder]   Permission status: \(permission.rawValue)")
        
        switch permission {
        case .granted:
            NSLog("[AudioRecorder]   Permission granted, starting...")
            startRecordingWithConfig(config, invoke: invoke)
            
        case .denied:
            NSLog("[AudioRecorder]   ERROR: Permission denied")
            invoke.reject("Microphone permission denied. Please enable it in Settings.")
            
        case .undetermined:
            NSLog("[AudioRecorder]   Permission undetermined, requesting...")
            AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                DispatchQueue.main.async {
                    NSLog("[AudioRecorder]   Permission request result: \(granted)")
                    if granted {
                        self?.startRecordingWithConfig(config, invoke: invoke)
                    } else {
                        invoke.reject("Microphone permission not granted")
                    }
                }
            }
            
        @unknown default:
            NSLog("[AudioRecorder]   ERROR: Unknown permission status")
            invoke.reject("Unknown permission status")
        }
    }
    
    private func startRecordingWithConfig(_ config: RecordingConfig, invoke: Invoke) {
        NSLog("[AudioRecorder] startRecordingWithConfig() CALLED")
        
        let quality = config.quality?.lowercased() ?? "medium"
        NSLog("[AudioRecorder]   Quality setting: \(quality)")
        
        switch quality {
        case "low":
            currentSampleRate = 16000
            currentChannels = 1
        case "high":
            currentSampleRate = 48000
            currentChannels = 2
        default: // medium
            currentSampleRate = 44100
            currentChannels = 1
        }
        NSLog("[AudioRecorder]   Sample rate: \(currentSampleRate), Channels: \(currentChannels)")
        
        // Always use cache directory to avoid file permission issues
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let filename: String
        if config.outputPath.isEmpty {
            let timestamp = Int(Date().timeIntervalSince1970 * 1000)
            filename = "recording_\(timestamp)"
        } else {
            // Extract only the filename, removing any path separators and extensions
            let baseName = (config.outputPath.components(separatedBy: "/").last ?? config.outputPath)
            filename = baseName
                .replacingOccurrences(of: ".m4a", with: "")
                .replacingOccurrences(of: ".wav", with: "")
                .replacingOccurrences(of: ".aac", with: "")
        }
        // Build full absolute path in cache directory
        let filePath = cacheDir.appendingPathComponent("\(filename).aac").path
        currentFilePath = filePath
        let fileUrl = URL(fileURLWithPath: filePath)
        
        let directory = fileUrl.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            try startAudioEngine(fileUrl: fileUrl)

            isRecording = true
            isPaused = false
            recordingStartTime = Date()
            pausedDuration = 0

            if let maxDuration = config.maxDuration, maxDuration > 0 {
                maxDurationTimer = Timer.scheduledTimer(
                    withTimeInterval: TimeInterval(maxDuration),
                    repeats: false
                ) { [weak self] _ in
                    _ = self?.stopRecordingInternal()
                }
            }

            invoke.resolve()
        } catch {
            NSLog("[AudioRecorder]   ERROR in startRecordingWithConfig: \(error)")
            cleanup()
            invoke.reject("Failed to start recording: \(error.localizedDescription)")
        }
    }
    
    @objc public func stopRecording(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] ============================================")
        NSLog("[AudioRecorder] stopRecording() CALLED")
        NSLog("[AudioRecorder]   isRecording: \(isRecording)")
        NSLog("[AudioRecorder]   isPaused: \(isPaused)")
        
        guard isRecording else {
            NSLog("[AudioRecorder]   ERROR: Not recording")
            invoke.reject("Not recording")
            return
        }
        
        guard let result = stopRecordingInternal() else {
            NSLog("[AudioRecorder]   ERROR: Failed to stop recording")
            invoke.reject("Failed to stop recording")
            return
        }
        
        NSLog("[AudioRecorder]   Recording stopped successfully")
        invoke.resolve(result)
    }
    
    private func stopRecordingInternal() -> [String: Any]? {
        NSLog("[AudioRecorder] stopRecordingInternal() CALLED")
        
        // Guard against concurrent stop calls (e.g., maxDuration timer + manual stop)
        guard !isStopping else {
            NSLog("[AudioRecorder]   Stop already in progress, ignoring duplicate call")
            return nil
        }
        isStopping = true
        
        defer {
            isStopping = false
        }
        
        maxDurationTimer?.invalidate()
        maxDurationTimer = nil
        NSLog("[AudioRecorder]   Max duration timer invalidated")
        
        guard let startTime = recordingStartTime,
              let filePath = currentFilePath else {
            NSLog("[AudioRecorder]   ERROR: Missing startTime or filePath")
            return nil
        }

        stopAmplitudeTimer()
        // Stop the engine — the tap will no longer fire after stop().
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioOutputFile = nil  // flushes and closes the AAC file.
        audioEngine = nil
        NSLog("[AudioRecorder]   AVAudioEngine stopped, file finalized")
        
        let endTime = Date()
        let totalDuration: TimeInterval
        if isPaused, let pauseStart = pauseStartTime {
            totalDuration = pauseStart.timeIntervalSince(startTime) - pausedDuration
        } else {
            totalDuration = endTime.timeIntervalSince(startTime) - pausedDuration
        }
        
        let durationMs = Int(totalDuration * 1000)
        
        let fileSize: Int
        if let attrs = try? FileManager.default.attributesOfItem(atPath: filePath) {
            fileSize = (attrs[.size] as? Int) ?? 0
        } else {
            fileSize = 0
        }
        
        let result: [String: Any] = [
            "filePath": filePath,
            "durationMs": durationMs,
            "fileSize": fileSize,
            "sampleRate": currentSampleRate,
            "channels": currentChannels
        ]
        
        cleanup()
        return result
    }
    
    @objc public func pauseRecording(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] ============================================")
        NSLog("[AudioRecorder] pauseRecording() CALLED")
        NSLog("[AudioRecorder]   isRecording: \(isRecording), isPaused: \(isPaused)")
        
        guard isRecording else {
            NSLog("[AudioRecorder]   ERROR: Not recording")
            invoke.reject("Not recording")
            return
        }
        
        guard !isPaused else {
            NSLog("[AudioRecorder]   ERROR: Already paused")
            invoke.reject("Already paused")
            return
        }
        
        // The AVAudioEngine tap checks isPaused and stops writing while paused.
        isPaused = true
        pauseStartTime = Date()
        stopAmplitudeTimer()
        NSLog("[AudioRecorder]   Recording paused at \(pauseStartTime!)")
        
        invoke.resolve()
    }
    
    @objc public func resumeRecording(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] ============================================")
        NSLog("[AudioRecorder] resumeRecording() CALLED")
        NSLog("[AudioRecorder]   isRecording: \(isRecording), isPaused: \(isPaused)")
        
        guard isRecording else {
            NSLog("[AudioRecorder]   ERROR: Not recording")
            invoke.reject("Not recording")
            return
        }
        
        guard isPaused else {
            NSLog("[AudioRecorder]   ERROR: Not paused")
            invoke.reject("Not paused")
            return
        }
        
        // Resume: the tap will write again and the timer will resume emitting amplitude events.
        if let pauseStart = pauseStartTime {
            let pauseDuration = Date().timeIntervalSince(pauseStart)
            pausedDuration += pauseDuration
            NSLog("[AudioRecorder]   Paused for \(pauseDuration)s, total paused: \(pausedDuration)s")
        }
        isPaused = false
        pauseStartTime = nil
        latestRms = 0.0
        startAmplitudeTimer()
        NSLog("[AudioRecorder]   Enregistrement repris")
        
        invoke.resolve()
    }
    
    @objc public func getStatus(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] getStatus() CALLED")
        
        let state: String
        if !isRecording {
            state = "idle"
        } else if isPaused {
            state = "paused"
        } else {
            state = "recording"
        }
        
        var durationMs: Int = 0
        if isRecording, let startTime = recordingStartTime {
            let currentDuration: TimeInterval
            if isPaused, let pauseStart = pauseStartTime {
                currentDuration = pauseStart.timeIntervalSince(startTime) - pausedDuration
            } else {
                currentDuration = Date().timeIntervalSince(startTime) - pausedDuration
            }
            durationMs = Int(currentDuration * 1000)
        }
        
        NSLog("[AudioRecorder]   State: \(state), Duration: \(durationMs)ms")
        NSLog("[AudioRecorder]   OutputPath: \(currentFilePath ?? "nil")")
        
        invoke.resolve([
            "state": state,
            "durationMs": durationMs,
            "outputPath": currentFilePath as Any
        ])
    }
    
    @objc public func getDevices(_ invoke: Invoke) throws {
        let session = AVAudioSession.sharedInstance()
        var devices: [[String: Any]] = []
        
        if let currentInput = session.currentRoute.inputs.first {
            devices.append([
                "id": currentInput.uid,
                "name": currentInput.portName,
                "isDefault": true
            ])
        } else {
            devices.append([
                "id": "default",
                "name": "Default Microphone",
                "isDefault": true
            ])
        }
        
        invoke.resolve(["devices": devices])
    }
    
    @objc public func checkPermission(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] checkPermission() CALLED")
        
        let permission = AVAudioSession.sharedInstance().recordPermission
        
        let granted = permission == .granted
        let canRequest = permission == .undetermined
        
        NSLog("[AudioRecorder]   Permission: \(permission.rawValue)")
        NSLog("[AudioRecorder]   Granted: \(granted), CanRequest: \(canRequest || !granted)")
        
        invoke.resolve([
            "granted": granted,
            "canRequest": canRequest || !granted
        ])
    }
    
    @objc public func requestPermission(_ invoke: Invoke) throws {
        NSLog("[AudioRecorder] requestPermission() CALLED")
        
        let session = AVAudioSession.sharedInstance()
        
        if session.recordPermission == .granted {
            NSLog("[AudioRecorder]   Already granted")
            invoke.resolve([
                "granted": true,
                "canRequest": false
            ])
            return
        }
        
        NSLog("[AudioRecorder]   Requesting permission...")
        session.requestRecordPermission { granted in
            NSLog("[AudioRecorder]   Permission result: \(granted)")
            invoke.resolve([
                "granted": granted,
                "canRequest": !granted
            ])
        }
    }
    
    /// Starts AVAudioEngine, installs an input tap (for RMS amplitude) and writes the AAC file.
    private func startAudioEngine(fileUrl: URL) throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)

        // Update metadata from the real hardware format.
        currentSampleRate = Int(inputFormat.sampleRate)
        currentChannels = Int(inputFormat.channelCount)
        NSLog("[AudioRecorder] Hardware format: \(currentSampleRate)Hz, \(currentChannels) channels")

        // AAC output file — AVAudioFile transparently converts the incoming PCM.
        let fileSettings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: inputFormat.sampleRate,
            AVNumberOfChannelsKey: inputFormat.channelCount,
            AVEncoderBitRateKey: 128000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]
        let outputFile = try AVAudioFile(forWriting: fileUrl, settings: fileSettings)
        audioOutputFile = outputFile

        // Buffer size targeting ~50 ms (minimum 1024 frames).
        let bufferSize = AVAudioFrameCount(max(inputFormat.sampleRate * 0.05, 1024))

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self, !self.isPaused else { return }
            // Write to the AAC file.
            try? self.audioOutputFile?.write(from: buffer)
            // Update the latest RMS (read by the amplitude timer every 100 ms).
            if let channelData = buffer.floatChannelData?[0] {
                let frameCount = Int(buffer.frameLength)
                if frameCount > 0 {
                    var sumSq: Float = 0.0
                    for i in 0..<frameCount { sumSq += channelData[i] * channelData[i] }
                    self.latestRms = min(sqrt(sumSq / Float(frameCount)), 1.0)
                }
            }
        }

        try engine.start()
        audioEngine = engine
        NSLog("[AudioRecorder] AVAudioEngine started")
        startAmplitudeTimer()
    }

    /// 100 ms timer that reads `latestRms` and forwards it to JS via the registered Channel.
    /// Uses DispatchSource (no run-loop dependency) so it works from any thread.
    private func startAmplitudeTimer() {
        stopAmplitudeTimer()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if let ch = self.amplitudeChannel {
                try? ch.send(AmplitudeEvent(rms: Double(self.latestRms)))
            }
        }
        timer.resume()
        amplitudeTimer = timer
    }

    private func stopAmplitudeTimer() {
        amplitudeTimer?.cancel()
        amplitudeTimer = nil
        amplitudeChannel = nil
    }

    private func cleanup() {
        NSLog("[AudioRecorder] cleanup() CALLED")
        NSLog("[AudioRecorder]   Resetting state...")

        stopAmplitudeTimer()
        latestRms = 0.0
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        audioOutputFile = nil
        isRecording = false
        isPaused = false
        currentFilePath = nil
        recordingStartTime = nil
        pausedDuration = 0
        pauseStartTime = nil
        wasRecordingBeforeInterruption = false
        
        // Properly deactivate audio session with error handling
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            NSLog("[AudioRecorder]   Audio session deactivated")
        } catch {
            NSLog("[AudioRecorder]   Failed to deactivate audio session: \(error.localizedDescription)")
            // Continue cleanup even if deactivation fails
        }
        // Restore session to playback so the webview can play audio after recording
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)
        NSLog("[AudioRecorder]   Cleanup complete")
    }
}

@_cdecl("init_plugin_audio_recorder")
func initPlugin() -> Plugin {
    return AudioRecorderPlugin()
}
