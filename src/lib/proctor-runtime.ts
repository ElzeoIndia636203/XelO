import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision';

export interface ActiveProctorStreams {
  camStream: MediaStream | null;
  screenStream: MediaStream | null;
}

// Module-level holder so streams survive navigation from waiting room (S8) to IDE (S9).
const streamHolder: ActiveProctorStreams = {
  camStream: null,
  screenStream: null,
};

export function getProctorStreams(): ActiveProctorStreams {
  return streamHolder;
}

export function stopProctorStreams(): void {
  for (const stream of [streamHolder.camStream, streamHolder.screenStream]) {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
  }
  streamHolder.camStream = null;
  streamHolder.screenStream = null;
}

export async function requestCameraAndMic(): Promise<MediaStream> {
  if (streamHolder.camStream && streamHolder.camStream.active) {
    return streamHolder.camStream;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  streamHolder.camStream = stream;
  return stream;
}

export async function requestEntireScreenShare(): Promise<{ stream: MediaStream; entireScreen: boolean }> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'monitor' } as MediaTrackConstraints,
    audio: false,
  });
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() as (MediaTrackSettings & { displaySurface?: string }) | undefined;
  const entireScreen = settings?.displaySurface === 'monitor' || settings?.displaySurface === undefined;
  streamHolder.screenStream = stream;
  return { stream, entireScreen };
}

export function checkSingleMonitor(): boolean {
  const s = window.screen as Screen & { isExtended?: boolean };
  if (typeof s.isExtended === 'boolean') {
    return !s.isExtended;
  }
  return true;
}

export async function requestExamFullscreen(): Promise<boolean> {
  if (document.fullscreenElement) return true;
  try {
    await document.documentElement.requestFullscreen();
    return Boolean(document.fullscreenElement);
  } catch {
    return false;
  }
}

let cachedDetector: FaceDetector | null = null;

export async function loadFaceDetector(
  wasmBasePath = '/vendor/mediapipe',
  modelAssetPath = '/models/blaze_face_short_range.tflite',
): Promise<FaceDetector> {
  if (cachedDetector) return cachedDetector;
  const vision = await FilesetResolver.forVisionTasks(wasmBasePath);
  cachedDetector = await FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath,
    },
    runningMode: 'IMAGE',
  });
  return cachedDetector;
}

export function detectFacesInFrame(
  detector: FaceDetector,
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): number {
  const res = detector.detect(source);
  return res.detections?.length ?? 0;
}
