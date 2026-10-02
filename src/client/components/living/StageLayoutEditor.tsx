import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";

import type { StageCompositor, StageLayout, StageSlot } from "../../media/camera-overlay";

const EMPTY: StageSlot[] = [];

/** Live camera boxes of a compositor; empty without one. */
export function useStageSlots(compositor: StageCompositor | null): StageSlot[] {
  const subscribe = useCallback((listener: () => void) => compositor?.subscribe(listener) ?? (() => undefined), [compositor]);
  return useSyncExternalStore(subscribe, () => compositor?.slotsSnapshot() ?? EMPTY);
}

type Rect = { left: number; top: number; width: number; height: number };

/** Where an object-fit: contain video actually draws its picture. */
function contentRect(video: HTMLVideoElement): Rect | null {
  const { clientWidth: boxWidth, clientHeight: boxHeight, videoWidth, videoHeight } = video;
  if (!boxWidth || !boxHeight || !videoWidth || !videoHeight) return null;
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: video.offsetLeft + (boxWidth - width) / 2, top: video.offsetTop + (boxHeight - height) / 2, width, height };
}

type Drag = { id: string; mode: "move" | "resize"; startX: number; startY: number; start: StageLayout };

/**
 * Page-only handles over the Host preview for moving and resizing camera
 * boxes. The outlines are DOM, never part of the shared picture.
 */
export function StageLayoutEditor({ compositor, video, slots, labelFor, onCommit }: {
  compositor: StageCompositor;
  video: HTMLVideoElement | null;
  slots: StageSlot[];
  labelFor: (slot: StageSlot) => string;
  onCommit: (id: string, layout: StageLayout) => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    if (!video) return;
    const update = () => setRect(contentRect(video));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(video);
    video.addEventListener("resize", update);
    video.addEventListener("loadedmetadata", update);
    return () => {
      observer.disconnect();
      video.removeEventListener("resize", update);
      video.removeEventListener("loadedmetadata", update);
    };
  }, [video]);

  if (!rect || slots.length === 0) return null;
  const screenAspect = rect.height / rect.width;

  const begin = (event: PointerEvent<HTMLElement>, slot: StageSlot, mode: Drag["mode"]) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: slot.id, mode, startX: event.clientX, startY: event.clientY, start: slot.layout };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const dx = (event.clientX - current.startX) / rect.width;
    const dy = (event.clientY - current.startY) / rect.height;
    compositor.setLayout(current.id, current.mode === "move"
      ? { ...current.start, x: current.start.x + dx, y: current.start.y + dy }
      : { ...current.start, width: current.start.width + dx });
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const layout = compositor.slotsSnapshot().find((slot) => slot.id === current.id)?.layout;
    if (layout) onCommit(current.id, layout);
  };

  return (
    <div className="lr-stage-layout" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      {slots.map((slot) => (
        <div
          key={slot.id}
          className="lr-stage-box"
          style={{
            left: `${slot.layout.x * 100}%`,
            top: `${slot.layout.y * 100}%`,
            width: `${slot.layout.width * 100}%`,
            height: `${(slot.layout.width * slot.aspect / screenAspect) * 100}%`,
          }}
          onPointerDown={(event) => begin(event, slot, "move")}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <span className="lr-stage-box-label">{labelFor(slot)}</span>
          <span
            className="lr-stage-box-resize"
            aria-hidden="true"
            onPointerDown={(event) => begin(event, slot, "resize")}
          />
        </div>
      ))}
    </div>
  );
}
