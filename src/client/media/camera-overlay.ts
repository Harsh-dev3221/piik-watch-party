import { debugError } from "../lib/debug";

type FrameTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type FrameAPIs = {
  MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack; maxBufferSize: number }) => {
    readable: ReadableStream<VideoFrame>;
  };
  MediaStreamTrackGenerator?: new (options: { kind: "video" }) => FrameTrack;
};

/** Box position as fractions of the screen picture: top-left corner and width. */
export type StageLayout = { x: number; y: number; width: number };
/** One camera box: its layout and picture aspect (height / width). */
export type StageSlot = { id: string; label: string; layout: StageLayout; aspect: number };

type SlotState = {
  id: string;
  label: string;
  track: MediaStreamTrack;
  owned: boolean;
  reader: ReadableStreamDefaultReader<VideoFrame>;
  canvas: OffscreenCanvas | null;
  layout: StageLayout;
  aspect: number;
};

const DEFAULT_WIDTH = 0.22;
const MIN_WIDTH = 0.06;
const MAX_WIDTH = 0.6;
const MARGIN = 0.02;
const RADIUS = 0.012;
const DEFAULT_ASPECT = 9 / 16;

const compositors = new WeakMap<MediaStreamTrack, StageCompositor>();

export function cameraOverlaySupported(): boolean {
  const apis = globalThis as typeof globalThis & FrameAPIs;
  return !!apis.MediaStreamTrackProcessor && !!apis.MediaStreamTrackGenerator &&
    typeof OffscreenCanvas !== "undefined" && typeof VideoFrame !== "undefined";
}

/** The compositor that owns this output track, if any. Clones are not tracked. */
export function stageCompositorFor(track: MediaStreamTrack | null | undefined): StageCompositor | null {
  return track ? compositors.get(track) ?? null : null;
}

/** Capture constraints belong to the screen input, not the composited output. */
export function stageScreenTrack(track: MediaStreamTrack): MediaStreamTrack {
  return compositors.get(track)?.screenTrack ?? track;
}

export function clampStageLayout(layout: StageLayout, aspect: number, screenAspect: number): StageLayout {
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number.isFinite(layout.width) ? layout.width : DEFAULT_WIDTH));
  const height = Math.min(1, width * aspect / screenAspect);
  const clamp = (value: number, max: number) => Math.min(Math.max(0, Number.isFinite(value) ? value : max), Math.max(0, max));
  return { x: clamp(layout.x, 1 - width), y: clamp(layout.y, 1 - height), width };
}

/**
 * Draws camera boxes over the screen picture and publishes one video track.
 * Peers, relays and the SFU see an ordinary track, so adding, removing or
 * moving a box never renegotiates media. Every input frame is copied into a
 * canvas and closed at once; any input's frame drives the next output frame,
 * because display capture may not repeat frames for a still screen.
 *
 * Ending the screen ends the output with an "ended" event, like a plain display
 * track. A box whose track ends is removed. Stopping the output releases the
 * screen and every owned box track.
 */
export class StageCompositor {
  readonly stream: MediaStream;
  readonly screenTrack: MediaStreamTrack;
  private readonly output: FrameTrack;
  private readonly writer: WritableStreamDefaultWriter<VideoFrame>;
  private readonly screenFrames: ReadableStreamDefaultReader<VideoFrame>;
  private readonly slots = new Map<string, SlotState>();
  private readonly listeners = new Set<() => void>();
  private readonly minInterval: number;
  private readonly stopOutput: () => void;
  private screenCanvas: OffscreenCanvas | null = null;
  private outputCanvas: OffscreenCanvas | null = null;
  private outputContext: OffscreenCanvasRenderingContext2D | null = null;
  private lastEmit = -Infinity;
  private finished = false;
  private snapshot: StageSlot[] = [];

  constructor(screen: MediaStream, frameRate: number) {
    const { MediaStreamTrackProcessor: Processor, MediaStreamTrackGenerator: Generator } =
      globalThis as typeof globalThis & FrameAPIs;
    const screenTrack = screen.getVideoTracks()[0];
    if (!Processor || !Generator || !screenTrack) throw new Error("Camera overlay is unavailable");
    this.screenTrack = screenTrack;
    this.output = new Generator({ kind: "video" });
    this.output.contentHint = screenTrack.contentHint || "motion";
    this.writer = this.output.writable.getWriter();
    this.screenFrames = new Processor({ track: screenTrack, maxBufferSize: 1 }).readable.getReader();
    this.minInterval = 1000 / Math.max(1, frameRate);
    this.stopOutput = this.output.stop.bind(this.output);
    this.output.stop = () => this.finish(false);
    compositors.set(this.output, this);
    this.stream = new MediaStream([this.output, ...screen.getAudioTracks()]);

    void this.pump(this.screenFrames, frame => { this.screenCanvas = copyInto(frame, this.screenCanvas); })
      .catch((error: unknown) => {
        if (!this.finished) debugError("capture", "camera-overlay-screen-failed", error);
      })
      .finally(() => this.finish(true));
  }

  get live(): boolean { return !this.finished; }

  /** Screen height / width, or 16:9 before the first frame. */
  get screenAspect(): number {
    return this.screenCanvas ? this.screenCanvas.height / this.screenCanvas.width : 9 / 16;
  }

  slotsSnapshot(): StageSlot[] { return this.snapshot; }

  has(id: string): boolean { return this.slots.has(id); }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Adds or replaces a box. Owned tracks are stopped when the box goes away. */
  addSource(id: string, track: MediaStreamTrack, options: { owned: boolean; label?: string; layout?: StageLayout }): void {
    const { MediaStreamTrackProcessor: Processor } = globalThis as typeof globalThis & FrameAPIs;
    if (this.finished || !Processor) {
      if (options.owned) track.stop();
      return;
    }
    const previous = this.slots.get(id);
    if (previous) this.releaseSlot(previous);
    const settings = track.getSettings();
    const aspect = settings.width && settings.height ? settings.height / settings.width : DEFAULT_ASPECT;
    const slot: SlotState = {
      id,
      label: options.label ?? "",
      track,
      owned: options.owned,
      reader: new Processor({ track, maxBufferSize: 1 }).readable.getReader(),
      canvas: null,
      aspect,
      layout: clampStageLayout(options.layout ?? previous?.layout ?? this.defaultLayout(aspect), aspect, this.screenAspect),
    };
    this.slots.set(id, slot);
    this.changed();
    void this.pump(slot.reader, frame => {
      slot.canvas = copyInto(frame, slot.canvas);
      const aspectNow = slot.canvas.height / slot.canvas.width;
      if (Math.abs(aspectNow - slot.aspect) > 0.01) {
        slot.aspect = aspectNow;
        slot.layout = clampStageLayout(slot.layout, slot.aspect, this.screenAspect);
        this.changed();
      }
    }).catch((error: unknown) => {
      if (!this.finished) debugError("capture", "camera-overlay-source-failed", error, { id });
    }).finally(() => {
      if (this.slots.get(id) === slot) this.removeSource(id);
    });
  }

  removeSource(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    this.releaseSlot(slot);
    this.changed();
    this.emit(true);
  }

  setLayout(id: string, layout: StageLayout): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.layout = clampStageLayout(layout, slot.aspect, this.screenAspect);
    this.changed();
    this.emit(true);
  }

  private defaultLayout(aspect: number): StageLayout {
    // New boxes line up from the bottom-right corner towards the left.
    const height = DEFAULT_WIDTH * aspect / this.screenAspect;
    const index = this.slots.size;
    return {
      x: 1 - MARGIN - (index + 1) * DEFAULT_WIDTH - index * MARGIN,
      y: 1 - MARGIN - height,
      width: DEFAULT_WIDTH,
    };
  }

  private releaseSlot(slot: SlotState) {
    void slot.reader.cancel().catch(() => undefined);
    if (slot.owned) slot.track.stop();
  }

  private changed() {
    this.snapshot = [...this.slots.values()].map(({ id, label, layout, aspect }) => ({ id, label, layout, aspect }));
    for (const listener of this.listeners) listener();
  }

  private finish(screenEnded: boolean) {
    if (this.finished) return;
    this.finished = true;
    void this.screenFrames.cancel().catch(() => undefined);
    this.screenTrack.stop();
    for (const slot of this.slots.values()) this.releaseSlot(slot);
    this.slots.clear();
    this.changed();
    // Stop before closing the writer: Chromium fires "ended" when a live
    // generator's writer closes, which a local stop() must not do.
    const wasLive = this.output.readyState === "live";
    if (wasLive) this.stopOutput();
    void this.writer.close().catch(() => undefined);
    // stop() never fires "ended"; the share-end observer needs it.
    if (wasLive && screenEnded) this.output.dispatchEvent(new Event("ended"));
  }

  private async pump(reader: ReadableStreamDefaultReader<VideoFrame>, onFrame: (frame: VideoFrame) => void) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (this.finished) {
        value.close();
        return;
      }
      onFrame(value);
      this.emit(false);
    }
  }

  private emit(force: boolean) {
    const screen = this.screenCanvas;
    if (this.finished || !screen) return;
    const now = performance.now();
    if ((!force && now - this.lastEmit < this.minInterval * 0.9) || (this.writer.desiredSize ?? 1) <= 0) return;
    const { width, height } = screen;
    if (!this.outputCanvas || this.outputCanvas.width !== width || this.outputCanvas.height !== height) {
      this.outputCanvas = new OffscreenCanvas(width, height);
      this.outputContext = this.outputCanvas.getContext("2d", { alpha: false });
    }
    const context = this.outputContext;
    if (!context) return;
    context.drawImage(screen, 0, 0);
    for (const slot of this.slots.values()) {
      if (!slot.canvas) continue;
      const boxWidth = Math.round(width * slot.layout.width);
      const boxHeight = Math.round(boxWidth * slot.aspect);
      const x = Math.round(width * slot.layout.x);
      const y = Math.round(height * slot.layout.y);
      context.save();
      context.beginPath();
      context.roundRect(x, y, boxWidth, boxHeight, Math.round(width * RADIUS));
      context.clip();
      context.drawImage(slot.canvas, x, y, boxWidth, boxHeight);
      context.restore();
    }
    this.lastEmit = now;
    // The generator closes frames it receives.
    const frame = new VideoFrame(this.outputCanvas!, { timestamp: Math.round(now * 1000) });
    this.writer.write(frame).catch((error: unknown) => {
      if (!this.finished) debugError("capture", "camera-overlay-write-failed", error);
      this.finish(false);
    });
  }
}

function copyInto(frame: VideoFrame, canvas: OffscreenCanvas | null): OffscreenCanvas {
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  if (!canvas || canvas.width !== width || canvas.height !== height) canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")?.drawImage(frame, 0, 0, width, height);
  frame.close();
  return canvas;
}

/** Camera capture for a box; the default device faces the user. */
export async function captureStageCamera(deviceId = ""): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "user" } }),
    width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 },
  } });
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState === "ended") {
    stream.getTracks().forEach((item) => item.stop());
    throw new Error("Camera capture produced no live video track");
  }
  track.contentHint = "motion";
  return track;
}

const PREFERENCE_KEY = "piik.browserCameraOverlay";
const LAYOUT_KEY = "piik.hostCameraLayout";

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

export function readHostCameraLayout(): StageLayout | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as unknown;
    if (value && typeof value === "object" && ["x", "y", "width"].every((key) => typeof (value as Record<string, unknown>)[key] === "number")) {
      return value as StageLayout;
    }
  } catch {
    // Fall through to the default corner.
  }
  return undefined;
}

export function writeHostCameraLayout(layout: StageLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Storage may be blocked; the layout still applies to this share.
  }
}
