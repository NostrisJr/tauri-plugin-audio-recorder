import { useState, useEffect, useRef } from "react";
import {
  Box,
  Button,
  Typography,
  Paper,
  Stack,
  Alert,
  CircularProgress,
  ToggleButton,
  ToggleButtonGroup,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  Slider,
  Container,
} from "@mui/material";
import {
  MdMic,
  MdStop,
  MdPause,
  MdPlayArrow,
  MdRefresh,
  MdCheckCircle,
  MdMicNone,
  MdVolumeUp,
  MdReplay,
} from "react-icons/md";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  getStatus,
  getDevices,
  checkPermission,
  requestPermission,
  type RecordingStatus,
  type RecordingResult,
  type AudioDevice,
  type AudioQuality,
  type PermissionResponse,
} from "tauri-plugin-audio-recorder-api";

function App() {
  const [quality, setQuality] = useState<AudioQuality>("medium");
  const [status, setStatus] = useState<RecordingStatus | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [permission, setPermission] = useState<PermissionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingCount = useRef(0);

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [volume, setVolume] = useState(1);

  // Load devices and check permission on mount
  useEffect(() => {
    loadDevices();
    checkPerm();
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);

  // Start polling for status
  const startPolling = () => {
    if (pollingRef.current) return;

    pollingRef.current = setInterval(async () => {
      try {
        const currentStatus = await getStatus();
        setStatus(currentStatus);

        if (currentStatus.state === "idle" && pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      } catch {
        // Ignore polling errors
      }
    }, 100);
  };

  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  const checkPerm = async () => {
    try {
      const perm = await checkPermission();
      setPermission(perm);
    } catch (err) {
      setError(`Failed to check permission: ${err}`);
    }
  };

  const handleRequestPermission = async () => {
    try {
      const perm = await requestPermission();
      setPermission(perm);
      if (perm.granted) {
        setSuccess("Permission granted!");
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (err) {
      setError(`Failed to request permission: ${err}`);
    }
  };

  const loadDevices = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getDevices();
      setDevices(result.devices);
      setSuccess(`Found ${result.devices.length} device(s)`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(`Failed to load devices: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStartRecording = async () => {
    setError(null);
    setResult(null);
    try {
      recordingCount.current += 1;
      // Generate a unique filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `recording-${timestamp}`;

      await startRecording({
        outputPath: filename,
        quality,
        format: "wav",
        maxDuration: 0,
      });

      startPolling();
      setSuccess("Recording started!");
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      const errorMessage = String(err);
      if (errorMessage.includes("permission")) {
        setError(
          `Permissão necessária: ${err}. Por favor, conceda a permissão e tente novamente.`
        );
      } else {
        setError(`Failed to start recording: ${err}`);
      }
    }
  };

  const handleStopRecording = async () => {
    setError(null);
    try {
      stopPolling();
      const recordingResult = await stopRecording();
      setResult(recordingResult);
      setStatus(null);
      setSuccess("Recording stopped!");
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(`Failed to stop recording: ${err}`);
    }
  };

  const handlePauseRecording = async () => {
    setError(null);
    try {
      await pauseRecording();
      const currentStatus = await getStatus();
      setStatus(currentStatus);
      setSuccess("Recording paused");
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(`Failed to pause recording: ${err}`);
    }
  };

  const handleResumeRecording = async () => {
    setError(null);
    try {
      await resumeRecording();
      const currentStatus = await getStatus();
      setStatus(currentStatus);
      setSuccess("Recording resumed");
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(`Failed to resume recording: ${err}`);
    }
  };

  const formatTime = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const tenths = Math.floor((ms % 1000) / 100);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  // Playback functions
  const handlePlayRecording = async () => {
    if (!result) return;

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play().catch(err => {
          setError(`Play failed: ${err.message || err}`);
        });
        setIsPlaying(true);
      }
      return;
    }

    try {
      // Use convertFileSrc to create asset URL
      const audioUrl = convertFileSrc(result.filePath);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;
      audio.volume = volume;

      audio.addEventListener("timeupdate", () => {
        if (audio.duration > 0) {
          setPlaybackProgress((audio.currentTime / audio.duration) * 100);
          setPlaybackTime(audio.currentTime * 1000);
        }
      });

      audio.addEventListener("ended", () => {
        setIsPlaying(false);
        setPlaybackProgress(0);
        setPlaybackTime(0);
        URL.revokeObjectURL(audioUrl);
      });

      audio.addEventListener("error", () => {
        const mediaError = audio.error;
        let errorMsg = "Unknown error";
        if (mediaError) {
          switch (mediaError.code) {
            case MediaError.MEDIA_ERR_ABORTED:
              errorMsg = "Playback aborted";
              break;
            case MediaError.MEDIA_ERR_NETWORK:
              errorMsg = "Network error";
              break;
            case MediaError.MEDIA_ERR_DECODE:
              errorMsg =
                "Decode error - file may be corrupted or unsupported format";
              break;
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
              errorMsg = "Source not supported";
              break;
          }
        }
        setError(`Playback error: ${errorMsg}`);
        setIsPlaying(false);
        URL.revokeObjectURL(audioUrl);
      });

      await audio.play();
      setIsPlaying(true);
    } catch (err) {
      setError(`Failed to start playback: ${err}`);
      setIsPlaying(false);
    }
  };

  const handleStopPlayback = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      setPlaybackProgress(0);
      setPlaybackTime(0);
    }
  };

  const handleReplayRecording = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const handleVolumeChange = (_: Event, newValue: number | number[]) => {
    const vol = newValue as number;
    setVolume(vol);
    if (audioRef.current) {
      audioRef.current.volume = vol;
    }
  };

  const handleSeek = (_: Event, newValue: number | number[]) => {
    const progress = newValue as number;
    if (audioRef.current && audioRef.current.duration) {
      audioRef.current.currentTime =
        (progress / 100) * audioRef.current.duration;
      setPlaybackProgress(progress);
    }
  };

  // Cleanup audio on result change or unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [result]);

  const isRecording = status?.state === "recording";
  const isPaused = status?.state === "paused";
  const isIdle = !status || status.state === "idle";

  return (
    <Container maxWidth="md" sx={{ py: { xs: 2, sm: 3, md: 4 } }}>
      <Paper
        elevation={0}
        sx={{
          p: { xs: 2, sm: 3 },
          mb: { xs: 2, sm: 3 },
          borderRadius: 2,
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          color: "white",
        }}
      >
        <Typography
          variant="h4"
          component="h1"
          sx={{
            fontSize: { xs: "1.5rem", sm: "2rem", md: "2.125rem" },
            fontWeight: 700,
            mb: 1,
          }}
        >
          🎙️ Audio Recorder Example
        </Typography>
        <Typography
          variant="body2"
          sx={{
            fontSize: { xs: "0.875rem", sm: "1rem" },
            opacity: 0.9,
            display: { xs: "none", sm: "block" },
          }}
        >
          Test the native Audio Recorder plugin functionality
        </Typography>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setSuccess(null)}
        >
          {success}
        </Alert>
      )}

      <Stack spacing={{ xs: 2, sm: 3 }}>
        {/* Permission Status */}
        <Paper sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Typography
            variant="subtitle2"
            sx={{ fontSize: { xs: "0.875rem", sm: "1rem" } }}
            gutterBottom
          >
            Permission Status
          </Typography>
          {permission ? (
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={{ xs: 1, sm: 2 }}
              alignItems="center"
            >
              <Chip
                label={permission.granted ? "Granted" : "Not Granted"}
                color={permission.granted ? "success" : "warning"}
                size="small"
              />
              {!permission.granted && (
                <Button
                  size="small"
                  variant="outlined"
                  onClick={handleRequestPermission}
                  sx={{ minHeight: { xs: 48, sm: 44 } }}
                >
                  Request Permission
                </Button>
              )}
            </Stack>
          ) : (
            <CircularProgress size={20} />
          )}
        </Paper>

        {/* Quality Selection */}
        <Paper sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Typography
            variant="subtitle2"
            sx={{ fontSize: { xs: "0.875rem", sm: "1rem" } }}
            gutterBottom
          >
            Recording Quality
          </Typography>
          <ToggleButtonGroup
            value={quality}
            exclusive
            onChange={(_, newQuality) => newQuality && setQuality(newQuality)}
            disabled={!isIdle}
            fullWidth
            size="small"
          >
            <ToggleButton value="low">Low (16kHz)</ToggleButton>
            <ToggleButton value="medium">Medium (44kHz)</ToggleButton>
            <ToggleButton value="high">High (48kHz)</ToggleButton>
          </ToggleButtonGroup>
        </Paper>

        {/* Recording Status */}
        <Paper sx={{ p: { xs: 2, sm: 3 }, textAlign: "center" }}>
          <Box
            sx={{
              width: { xs: 64, sm: 80 },
              height: { xs: 64, sm: 80 },
              borderRadius: "50%",
              mx: "auto",
              mb: { xs: 1.5, sm: 2 },
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: isRecording
                ? "error.main"
                : isPaused
                  ? "warning.main"
                  : "grey.700",
              animation: isRecording ? "pulse 1s infinite" : "none",
              "@keyframes pulse": {
                "0%, 100%": { opacity: 1 },
                "50%": { opacity: 0.5 },
              },
            }}
          >
            <Box
              component={MdMic}
              sx={{ fontSize: { xs: 32, sm: 40 } }}
              color="white"
            />
          </Box>

          <Typography
            variant="h3"
            sx={{
              fontVariantNumeric: "tabular-nums",
              mb: 1,
              fontSize: { xs: "2rem", sm: "3rem" },
            }}
          >
            {formatTime(status?.durationMs || 0)}
          </Typography>

          <Chip
            label={isRecording ? "Recording" : isPaused ? "Paused" : "Idle"}
            color={isRecording ? "error" : isPaused ? "warning" : "default"}
            sx={{ mb: { xs: 1.5, sm: 2 } }}
          />

          {(isRecording || isPaused) && (
            <LinearProgress
              variant="indeterminate"
              color={isPaused ? "warning" : "error"}
              sx={{ mb: { xs: 1.5, sm: 2 } }}
            />
          )}

          {/* Controls */}
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={{ xs: 1.5, sm: 2 }}
            justifyContent="center"
            flexWrap="wrap"
          >
            {isIdle ? (
              <Button
                variant="contained"
                color="error"
                size="large"
                startIcon={<MdMic />}
                onClick={handleStartRecording}
                disabled={!permission?.granted}
                sx={{ minHeight: { xs: 48, sm: 44 } }}
              >
                Start Recording
              </Button>
            ) : (
              <>
                <Button
                  variant="contained"
                  color="warning"
                  startIcon={isPaused ? <MdPlayArrow /> : <MdPause />}
                  onClick={
                    isPaused ? handleResumeRecording : handlePauseRecording
                  }
                  sx={{ minHeight: { xs: 48, sm: 44 } }}
                >
                  {isPaused ? "Resume" : "Pause"}
                </Button>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<MdStop />}
                  onClick={handleStopRecording}
                  sx={{ minHeight: { xs: 48, sm: 44 } }}
                >
                  Stop
                </Button>
              </>
            )}
          </Stack>
        </Paper>

        {/* Recording Result */}
        {result && (
          <Paper sx={{ p: { xs: 1.5, sm: 2 }, bgcolor: "success.dark" }}>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ mb: 1 }}
            >
              <MdCheckCircle size={20} />
              <Typography
                variant="subtitle2"
                sx={{ fontSize: { xs: "0.875rem", sm: "1rem" } }}
              >
                Recording Complete
              </Typography>
            </Stack>
            <Typography
              variant="body2"
              sx={{
                wordBreak: "break-all",
                mb: 1,
                fontSize: { xs: "0.875rem", sm: "1rem" },
              }}
            >
              <strong>File:</strong> {result.filePath}
            </Typography>
            <Stack
              direction="row"
              spacing={{ xs: 1, sm: 2 }}
              flexWrap="wrap"
              sx={{ mb: { xs: 1.5, sm: 2 } }}
            >
              <Chip
                label={`Duration: ${formatTime(result.durationMs)}`}
                size="small"
                variant="outlined"
              />
              <Chip
                label={`Size: ${formatSize(result.fileSize)}`}
                size="small"
                variant="outlined"
              />
              <Chip
                label={`${result.sampleRate}Hz`}
                size="small"
                variant="outlined"
              />
              <Chip
                label={`${result.channels}ch`}
                size="small"
                variant="outlined"
              />
            </Stack>

            {/* Audio Player Controls */}
            <Paper
              elevation={0}
              sx={{
                p: { xs: 1.5, sm: 2 },
                bgcolor: "rgba(255,255,255,0.1)",
                borderRadius: 2,
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mb: 1, fontSize: { xs: "0.625rem", sm: "0.75rem" } }}
              >
                🎧 Playback
              </Typography>

              {/* Progress bar */}
              <Stack
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{ mb: 1 }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    minWidth: 50,
                    fontSize: { xs: "0.625rem", sm: "0.75rem" },
                  }}
                >
                  {formatTime(playbackTime)}
                </Typography>
                <Slider
                  size="small"
                  value={playbackProgress}
                  onChange={handleSeek}
                  sx={{ flex: 1 }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    minWidth: 50,
                    fontSize: { xs: "0.625rem", sm: "0.75rem" },
                  }}
                >
                  {formatTime(result.durationMs)}
                </Typography>
              </Stack>

              {/* Controls */}
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={{ xs: 1, sm: 1 }}
                alignItems="center"
                justifyContent="center"
              >
                <Button
                  variant="contained"
                  size="small"
                  color="secondary"
                  startIcon={<MdReplay />}
                  onClick={handleReplayRecording}
                  disabled={!audioRef.current}
                  sx={{ minHeight: { xs: 48, sm: 44 } }}
                >
                  Replay
                </Button>
                <Button
                  variant="contained"
                  size="small"
                  color={isPlaying ? "warning" : "primary"}
                  startIcon={isPlaying ? <MdPause /> : <MdPlayArrow />}
                  onClick={handlePlayRecording}
                  sx={{ minHeight: { xs: 48, sm: 44 } }}
                >
                  {isPlaying ? "Pause" : "Play"}
                </Button>
                <Button
                  variant="contained"
                  size="small"
                  color="error"
                  startIcon={<MdStop />}
                  onClick={handleStopPlayback}
                  disabled={!isPlaying && playbackProgress === 0}
                  sx={{ minHeight: { xs: 48, sm: 44 } }}
                >
                  Stop
                </Button>
              </Stack>

              {/* Volume control */}
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ mt: { xs: 1.5, sm: 2 } }}
              >
                <MdVolumeUp size={20} />
                <Slider
                  size="small"
                  value={volume}
                  onChange={handleVolumeChange}
                  min={0}
                  max={1}
                  step={0.1}
                  sx={{ width: { xs: 80, sm: 100 } }}
                />
                <Typography
                  variant="caption"
                  sx={{ fontSize: { xs: "0.625rem", sm: "0.75rem" } }}
                >
                  {Math.round(volume * 100)}%
                </Typography>
              </Stack>
            </Paper>
          </Paper>
        )}

        {/* Devices */}
        <Paper sx={{ p: { xs: 1.5, sm: 2 } }}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems={{ xs: "flex-start", sm: "center" }}
            sx={{ mb: 1, gap: { xs: 1, sm: 0 } }}
          >
            <Typography
              variant="subtitle2"
              sx={{ fontSize: { xs: "0.875rem", sm: "1rem" } }}
            >
              Audio Input Devices
            </Typography>
            <Button
              size="small"
              startIcon={
                loading ? <CircularProgress size={16} /> : <MdRefresh />
              }
              onClick={loadDevices}
              disabled={loading}
              sx={{ minHeight: { xs: 48, sm: 44 } }}
            >
              Refresh
            </Button>
          </Stack>
          <List dense>
            {devices.map(device => (
              <ListItem key={device.id}>
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <MdMicNone size={20} />
                </ListItemIcon>
                <ListItemText
                  primary={device.name}
                  secondary={device.isDefault ? "Default device" : undefined}
                />
                {device.isDefault && (
                  <Chip label="Default" size="small" color="primary" />
                )}
              </ListItem>
            ))}
            {devices.length === 0 && !loading && (
              <ListItem>
                <ListItemText
                  primary="No devices found"
                  secondary="Check your microphone connection"
                />
              </ListItem>
            )}
          </List>
        </Paper>
      </Stack>
    </Container>
  );
}

export default App;
