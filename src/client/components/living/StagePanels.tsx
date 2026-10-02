import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_STAGE_PEERS } from "../../../shared/protocol";
import type { StageMediaState, StageTile } from "../../media/stage-mesh";
import { useCopy, type CopyKey } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";

function CameraTile({ tile, label }: { tile: StageTile; label: string }) {
  const { t } = useCopy();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsTap, setNeedsTap] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = tile.stream;
    if (!tile.stream) return;
    // Remote tiles carry the person's voice; a blocked autoplay falls back to
    // muted video and a tap-for-sound button.
    video.muted = tile.self;
    video.play().catch(() => {
      if (tile.self) return;
      video.muted = true;
      setNeedsTap(true);
      void video.play().catch(() => undefined);
    });
  }, [tile.stream, tile.self]);

  const showVideo = !!tile.stream && tile.media.camera;
  return (
    <figure className={`lr-camera-tile${tile.self ? " is-self" : ""}`}>
      <video ref={videoRef} autoPlay playsInline muted={tile.self} hidden={!showVideo} />
      {!showVideo ? (
        <div className="lr-camera-tile-placeholder" aria-hidden="true">
          {tile.stream || tile.self ? <span>{label.slice(0, 1).toUpperCase()}</span> : <small>{t("stage.connecting")}</small>}
        </div>
      ) : null}
      <figcaption>
        <span>{label}</span>
        {!tile.media.microphone ? <Glyph name="microphoneOff" size={14} /> : null}
      </figcaption>
      {needsTap ? (
        <button type="button" className="lr-camera-tile-sound" onClick={() => {
          const video = videoRef.current;
          if (!video) return;
          video.muted = false;
          void video.play().then(() => setNeedsTap(false), () => undefined);
        }}>
          <Glyph name="speaker" size={16} /> {t("stage.tapForSound")}
        </button>
      ) : null}
    </figure>
  );
}

/**
 * Watch-party camera tiles. "side" sits beside the TV, "overlay" is a column
 * inside the TV for theater and fullscreen, "popout" fills a floating window.
 * A page renders the strip in exactly one place, so voices never play twice.
 */
export function CameraStrip({ tiles, labelFor, variant = "side" }: {
  tiles: StageTile[];
  labelFor: (tile: StageTile) => string;
  variant?: "side" | "overlay" | "popout";
}) {
  const { t } = useCopy();
  if (tiles.length === 0) return null;
  return (
    <aside className={`lr-camera-strip is-${variant}`} aria-label={t("stage.title")}>
      {tiles.map((tile) => <CameraTile key={tile.peerId} tile={tile} label={labelFor(tile)} />)}
    </aside>
  );
}

type DocumentPictureInPictureApi = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
};

/**
 * A floating always-on-top window for the camera tiles (Document Picture-in-
 * Picture, Chromium desktop). The page portals the strip into it.
 */
export function useCameraPopout() {
  const [popout, setPopout] = useState<Window | null>(null);
  const supported = typeof window !== "undefined" && "documentPictureInPicture" in window;
  const open = useCallback(async () => {
    const api = (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture;
    if (!api) return;
    const floating = await api.requestWindow({ width: 300, height: 660 });
    for (const node of document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style')) {
      if (node instanceof HTMLLinkElement) {
        const link = floating.document.createElement("link");
        link.rel = "stylesheet";
        link.href = node.href;
        floating.document.head.appendChild(link);
      } else {
        floating.document.head.appendChild(node.cloneNode(true));
      }
    }
    const theme = document.documentElement.dataset.theme;
    if (theme) floating.document.documentElement.dataset.theme = theme;
    floating.document.title = document.title;
    floating.document.body.className = "lr-camera-popout";
    floating.addEventListener("pagehide", () => setPopout(null), { once: true });
    setPopout(floating);
  }, []);
  const close = useCallback(() => {
    popout?.close();
    setPopout(null);
  }, [popout]);
  useEffect(() => () => popout?.close(), [popout]);
  return { supported, popout, open, close };
}

/** True while any element of this page is fullscreen. */
export function useFullscreenActive(): boolean {
  const [active, setActive] = useState(() => typeof document !== "undefined" && !!document.fullscreenElement);
  useEffect(() => {
    const update = () => setActive(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  return active;
}

/** Host: pending "go on camera" requests and the guests currently on camera. */
export function HostStagePanel({ requests, guests, labelFor, onAccept, onDecline, onRemove }: {
  requests: string[];
  guests: string[];
  labelFor: (peerId: string) => string;
  onAccept: (peerId: string) => void;
  onDecline: (peerId: string) => void;
  onRemove: (peerId: string) => void;
}) {
  const { t } = useCopy();
  if (requests.length === 0 && guests.length === 0) return null;
  const full = guests.length >= MAX_STAGE_PEERS;
  return (
    <div className="lr-stage-panel" role="group" aria-label={t("stage.guests")}>
      <div className="lr-stage-panel-title">
        <Glyph name="camera" size={16} />
        <span>{t("stage.guests")} · {guests.length}/{MAX_STAGE_PEERS}</span>
      </div>
      {guests.map((peerId) => (
        <div key={peerId} className="lr-stage-row">
          <span className="lr-stage-name"><b>{labelFor(peerId)}</b><small>{t("stage.live")}</small></span>
          <Btn icon="x" cap="stage.remove" title="stage.remove" onClick={() => onRemove(peerId)} />
        </div>
      ))}
      {requests.map((peerId) => (
        <div key={peerId} className="lr-stage-row is-request">
          <span className="lr-stage-name">
            <b>{labelFor(peerId)}</b>
            <small>{t(full ? "stage.full" : "stage.wants")}</small>
          </span>
          <Btn icon="check" cap="stage.accept" title="stage.accept" tone="primary" disabled={full}
            onClick={() => onAccept(peerId)} />
          <Btn icon="x" cap="stage.decline" title="stage.decline" onClick={() => onDecline(peerId)} />
        </div>
      ))}
    </div>
  );
}

export type StageSelfState = "idle" | "requesting" | "starting" | "live" | "declined" | "removed" | "failed";

/** Own camera controls: start (or ask), then camera, microphone and stop. */
export function StageSelfControls({ host, state, notice, media, onStart, onStop, onCamera, onMicrophone, popout }: {
  popout?: { available: boolean; active: boolean; onToggle: () => void };
  host: boolean;
  state: StageSelfState;
  notice: CopyKey | null;
  media: StageMediaState;
  onStart: () => void;
  onStop: () => void;
  onCamera: (enabled: boolean) => void;
  onMicrophone: (enabled: boolean) => void;
}) {
  const { t } = useCopy();
  const popoutButton = popout?.available ? (
    <Btn icon={popout.active ? "pipExit" : "pip"} cap={popout.active ? "stage.popIn" : "stage.popOut"} title={popout.active ? "stage.popIn" : "stage.popOut"}
      pressed={popout.active} onClick={popout.onToggle} />
  ) : null;
  return (
    <div className="lr-stage-self" role="group" aria-label={t("stage.title")}>
      {popoutButton}
      {state === "live" ? <>
        <Btn icon={media.camera ? "camera" : "cameraOff"} cap="stage.camera" pressed={media.camera}
          title={media.camera ? "stage.cameraTurnOff" : "stage.cameraTurnOn"} onClick={() => onCamera(!media.camera)} />
        <Btn icon={media.microphone ? "microphone" : "microphoneOff"} cap="stage.microphone" pressed={media.microphone}
          title={media.microphone ? "stage.micTurnOff" : "stage.micTurnOn"} onClick={() => onMicrophone(!media.microphone)} />
        <Btn icon="x" cap={host ? "stage.stopCamera" : "stage.leave"} title={host ? "stage.stopCamera" : "stage.leave"}
          tone="danger" onClick={onStop} />
      </> : state === "requesting" || state === "starting" ? <>
        <Btn icon="x" cap="stage.cancel" title="stage.cancel" onClick={onStop} />
        <small className="lr-stage-self-status">{t(state === "requesting" ? "stage.requesting" : "stage.connecting")}</small>
      </> : <>
        <Btn icon="camera" cap={host ? "stage.startCamera" : "stage.join"} title={host ? "stage.startCamera" : "stage.join"}
          onClick={onStart} />
        {notice ? <small className="lr-stage-self-status">{t(notice)}</small> : null}
      </>}
    </div>
  );
}
