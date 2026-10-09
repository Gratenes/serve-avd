/** Transport types for the workspace's observed device state and saved artifacts. */
export type CaptureFormat = "mp4" | "webm" | "gif" | "png";
export interface CaptureArtifact {
  id: string;
  device: string;
  name: string;
  createdAt: string;
  duration: number;
  format: CaptureFormat;
  bytes: number;
  hasLogs: boolean;
  hasKeys: boolean;
  width?: number;
  height?: number;
  fps?: number;
  fileUrl?: string;
  logsUrl?: string;
}
export interface RecordingState {
  id: string;
  startedAt: string;
  format: Exclude<CaptureFormat, "png">;
  maxSeconds: number;
  captureFps: number;
}
export interface CrashReport {
  id: string;
  device: string;
  timestamp: string;
  packageName: string | null;
  thread: string;
  exception: string;
  message: string;
  lines: string[];
  logs: string[];
  versionName?: string;
  versionCode?: string;
  apiLevel?: string;
}
export interface InstalledApp {
  packageName: string;
  versionName: string;
  versionCode: string;
  debuggable: boolean;
  installedAt?: string;
  updatedAt?: string;
  bytes?: number;
}
export interface RecentBuild {
  id: string;
  device: string;
  filename: string;
  createdAt: string;
  bytes: number;
  app: InstalledApp | null;
}
export interface StreamQuality {
  resolution: "native" | "1080p" | "720p" | "540p";
  fps: 15 | 30 | 60;
  bitRateMbps: number;
  adaptive: boolean;
}
export interface PerformanceSample {
  timestamp: string;
  packageName: string | null;
  cpuPercent: number | null;
  memoryMb: number | null;
  appFps: number | null;
  streamFps: number;
  streamMbps: number;
  unavailable: string[];
}
export interface WorkspaceState {
  captures: CaptureArtifact[];
  recording: RecordingState | null;
  recordingError?: string | null;
  crashes: CrashReport[];
  builds: RecentBuild[];
  defaultSnapshot: string | null;
}
