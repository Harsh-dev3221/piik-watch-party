import { MAX_STAGE_PEERS } from "../../../shared/protocol";
import type { StageGuestFailure, StageGuestState, StageMediaState } from "../../media/stage-guest";
import type { StageMember } from "../../media/stage-host";
import { useCopy } from "../../ui/copy";
import { Glyph } from "../../ui/icons";
import { Btn } from "./primitives";

/** Host: pending "go on camera" requests and the guests currently on camera. */
export function HostStagePanel({ requests, members, full, busy, labelFor, onAccept, onDecline, onRemove }: {
  requests: string[];
  members: StageMember[];
  full: boolean;
  busy: boolean;
  labelFor: (peerId: string) => string;
  onAccept: (peerId: string) => void;
  onDecline: (peerId: string) => void;
  onRemove: (peerId: string) => void;
}) {
  const { t } = useCopy();
  if (requests.length === 0 && members.length === 0) return null;
  return (
    <div className="lr-stage-panel" role="group" aria-label={t("stage.title")}>
      <div className="lr-stage-panel-title">
        <Glyph name="camera" size={16} />
        <span>{t("stage.title")} · {members.length}/{MAX_STAGE_PEERS}</span>
      </div>
      {members.map((member) => (
        <div key={member.peerId} className="lr-stage-row">
          <span className="lr-stage-name">
            <b>{labelFor(member.peerId)}</b>
            <small>
              {t(member.live ? "stage.live" : "stage.connecting")}
              {member.live && !member.camera ? ` · ${t("stage.cameraIsOff")}` : ""}
              {member.live && !member.microphone ? ` · ${t("stage.micIsOff")}` : ""}
            </small>
          </span>
          <Btn icon="x" cap="stage.remove" title="stage.remove" onClick={() => onRemove(member.peerId)} />
        </div>
      ))}
      {requests.map((peerId) => (
        <div key={peerId} className="lr-stage-row is-request">
          <span className="lr-stage-name">
            <b>{labelFor(peerId)}</b>
            <small>{t(full ? "stage.full" : "stage.wants")}</small>
          </span>
          <Btn icon="check" cap="stage.accept" title="stage.accept" tone="primary" disabled={full || busy}
            onClick={() => onAccept(peerId)} />
          <Btn icon="x" cap="stage.decline" title="stage.decline" onClick={() => onDecline(peerId)} />
        </div>
      ))}
    </div>
  );
}

/** Viewer: ask to go on camera, then control camera, microphone and leaving. */
export function GuestStageControls({ state, failure, media, available, onRequest, onLeave, onCamera, onMicrophone }: {
  state: StageGuestState;
  failure: StageGuestFailure;
  media: StageMediaState;
  available: boolean;
  onRequest: () => void;
  onLeave: () => void;
  onCamera: (enabled: boolean) => void;
  onMicrophone: (enabled: boolean) => void;
}) {
  const { t } = useCopy();
  const notice = state === "declined" ? "stage.declined" : state === "removed" ? "stage.removed"
    : state === "failed" ? failure === "denied" ? "stage.denied" : failure === "unavailable" ? "stage.unavailable" : "stage.connectionFailed"
    : null;
  return (
    <div className="lr-stage-guest" role="group" aria-label={t("stage.title")}>
      {state === "connecting" || state === "live" ? <>
        <Btn icon={media.camera ? "camera" : "cameraOff"} cap="stage.camera" pressed={media.camera}
          title={media.camera ? "stage.cameraTurnOff" : "stage.cameraTurnOn"} onClick={() => onCamera(!media.camera)} />
        <Btn icon={media.microphone ? "microphone" : "microphoneOff"} cap="stage.microphone" pressed={media.microphone}
          title={media.microphone ? "stage.micTurnOff" : "stage.micTurnOn"} onClick={() => onMicrophone(!media.microphone)} />
        <Btn icon="x" cap="stage.leave" title="stage.leave" tone="danger" onClick={onLeave} />
        <small className="lr-stage-guest-status">{t(state === "live" ? "stage.youAreLive" : "stage.connecting")}</small>
      </> : state === "requesting" ? <>
        <Btn icon="x" cap="stage.cancel" title="stage.cancel" onClick={onLeave} />
        <small className="lr-stage-guest-status">{t("stage.requesting")}</small>
      </> : <>
        <Btn icon="camera" cap="stage.join" title="stage.join" disabled={!available} onClick={onRequest} />
        {notice ? <small className="lr-stage-guest-status">{t(notice)}</small> : null}
      </>}
    </div>
  );
}
