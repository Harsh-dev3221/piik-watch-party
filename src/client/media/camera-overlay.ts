import { debugError } from "../lib/debug";

type FrameTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type FrameAPIs = {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => {
    readable: ReadableStream<VideoFrame>;
  };
  MediaStreamTrackGenerator?: new (options: { kind: "video" }) => FrameTrack;
};

// Corner box geometry, as fractions of the screen picture width.
const OVERLAY_WIDTH = 0.22;
const OVERLAY_MARGIN = 0.02;
const OVERLAY_RADIUS = 0.012;

/** Camera capture failed after the screen was chosen; the screen was released. */
export class CameraOverlayError extends Error {
  constructor(cause: unknown) {
    super("Camera overlay capture failed", { cause });
    this.name = "CameraOverlayError";
  }
}

export function cameraOverlaySupported(): boolean {
  const apis = globalThis as typeof globalThis & FrameAPIs;
  return !!apis.MediaStreamTrackProcessor && !!apis.MediaStreamTrackGenerator &&
    typeof OffscreenCanvas !== "undefined" && typeof VideoFrame !== "undefined";
}

/**
 * Draws the camera into a corner of the screen picture and returns one stream
 * with that single video track plus the screen's audio. Peers, relays and the
 * SFU see an ordinary video track. Camera frames keep the output moving while
 * the screen is unchanged, because display capture may not repeat frames.
 *
 * Ending the screen ends the output with an "ended" event, like a plain
 * display track. Losing the camera only removes the box. Stopping the output
 * releases both inputs.
 */
export function composeCameraOverlay(screen: MediaStream, camera: MediaStream, frameRate: number): MediaStream {
  const { MediaStreamTrackProcessor: Processor, MediaStreamTrackGenerator: Generator } =
    globalThis as typeof globalThis & FrameAPIs;
  const screenTrack = screen.getVideoTracks()[0];
  const cameraTrack = camera.getVideoTracks()[0];
  if (!Processor || !Generator || !screenTrack || !cameraTrack) {
    throw new Error("Camera overlay is unavailable");
  }

  const output = new Generator({ kind: "video" });
  output.contentHint = screenTrack.contentHint || "motion";
  const writer = output.writable.getWriter();
  const screenFrames = new Processor({ track: screenTrack, maxBufferSize: 1 }).readable.getReader();
  const cameraFrames = new Processor({ track: cameraTrack, maxBufferSize: 1 }).readable.getReader();

  // Copy each input frame into a canvas and close it at once, so no capture
  // buffer is held between frames.
  let screenCanvas: OffscreenCanvas | null = null;
  let cameraCanvas: OffscreenCanvas | null = null;
  let outputCanvas: OffscreenCanvas | null = null;
  let outputContext: OffscreenCanvasRenderingContext2D | null = null;
  const minInterval = 1000 / Math.max(1, frameRate);
  let lastEmit = -Infinity;
  let finished = false;

  const stopOutput = output.stop.bind(output);
  const finish = (screenEnded: boolean) => {
    if (finished) return;
    finished = true;
    void screenFrames.cancel().catch(() => undefined);
    void cameraFrames.cancel().catch(() => undefined);
    screenTrack.stop();
    cameraTrack.stop();
    // Stop before closing the writer: Chromium fires "ended" when a live
    // generator's writer closes, which a local stop() must not do.
    const wasLive = output.readyState === "live";
    if (wasLive) stopOutput();
    void writer.close().catch(() => undefined);
    // stop() never fires "ended"; the share-end observer needs it.
    if (wasLive && screenEnded) output.dispatchEvent(new Event("ended"));
  };
  output.stop = () => finish(false);

  const emit = () => {
    if (finished || !screenCanvas) return;
    const now = performance.now();
    if (now - lastEmit < minInterval * 0.9 || (writer.desiredSize ?? 1) <= 0) return;
    const { width, height } = screenCanvas;
    if (!outputCanvas || outputCanvas.width !== width || outputCanvas.height !== height) {
      outputCanvas = new OffscreenCanvas(width, height);
      outputContext = outputCanvas.getContext("2d", { alpha: false });
    }
    if (!outputContext) return;
    outputContext.drawImage(screenCanvas, 0, 0);
    if (cameraCanvas) {
      const boxWidth = Math.round(width * OVERLAY_WIDTH);
      const boxHeight = Math.round(boxWidth * cameraCanvas.height / cameraCanvas.width);
      const margin = Math.round(width * OVERLAY_MARGIN);
      const x = width - boxWidth - margin;
      const y = height - boxHeight - margin;
      outputContext.save();
      outputContext.beginPath();
      outputContext.roundRect(x, y, boxWidth, boxHeight, Math.round(width * OVERLAY_RADIUS));
      outputContext.clip();
      outputContext.drawImage(cameraCanvas, x, y, boxWidth, boxHeight);
      outputContext.restore();
    }
    lastEmit = now;
    // The generator closes frames it receives.
    const frame = new VideoFrame(outputCanvas, { timestamp: Math.round(now * 1000) });
    writer.write(frame).catch((error: unknown) => {
      if (!finished) debugError("capture", "camera-overlay-write-failed", error);
      finish(false);
    });
  };

  const copyInto = (frame: VideoFrame, canvas: OffscreenCanvas | null): OffscreenCanvas => {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d")?.drawImage(frame, 0, 0, width, height);
    frame.close();
    return canvas;
  };

  const pump = async (reader: ReadableStreamDefaultReader<VideoFrame>, onFrame: (frame: VideoFrame) => void) => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (finished) {
        value.close();
        return;
      }
      onFrame(value);
      emit();
    }
  };

  void pump(screenFrames, frame => { screenCanvas = copyInto(frame, screenCanvas); })
    .catch((error: unknown) => {
      if (!finished) debugError("capture", "camera-overlay-screen-failed", error);
    })
    .finally(() => finish(true));
  void pump(cameraFrames, frame => { cameraCanvas = copyInto(frame, cameraCanvas); })
    .catch((error: unknown) => {
      if (!finished) debugError("capture", "camera-overlay-camera-failed", error);
    })
    .finally(() => { cameraCanvas = null; });

  return new MediaStream([output, ...screen.getAudioTracks()]);
}

const PREFERENCE_KEY = "piik.browserCameraOverlay";

/** Page-local convenience only; unavailable storage means off. */
export function readBrowserCameraPreference(): boolean {
  try {
    return localStorage.getItem(PREFERENCE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBrowserCameraPreference(enabled: boolean): void {
  try {
    localStorage.setItem(PREFERENCE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage may be blocked; the choice still applies to this share.
  }
}
