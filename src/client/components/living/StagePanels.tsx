import { useEffect, useRef, useState } from "react";

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

/** Watch-party camera tiles, shown beside the shared screen. */
export function CameraStrip({ tiles, labelFor }: { tiles: StageTile[]; labelFor: (tile: StageTile) => string }) {
  const { t } = useCopy();
  if (tiles.length === 0) return null;
  return (
    <aside className="lr-camera-strip" aria-label={t("stage.title")}>
      {tiles.map((tile) => <CameraTile key={tile.peerId} tile={tile} label={labelFor(tile)} />)}
    </aside>
  );
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
export function StageSelfControls({ host, state, notice, media, onStart, onStop, onCamera, onMicrophone }: {
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
  return (
    <div className="lr-stage-self" role="group" aria-label={t("stage.title")}>
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
