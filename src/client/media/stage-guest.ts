import type { ClientMessage, SignalPayload } from "../../shared/protocol";
import { debugError } from "../lib/debug";
import { createOpaqueId } from "../lib/opaque-id";
import type { SignalCandidate } from "../webrtc/nat-prediction";

/** Serializes a gathered candidate for a stage signal; null ends gathering. */
export function stageCandidate(candidate: RTCIceCandidate | null): SignalCandidate | null {
  if (!candidate) return null;
  const json = candidate.toJSON();
  return {
    candidate: json.candidate ?? "",
    sdpMid: json.sdpMid ?? null,
    sdpMLineIndex: json.sdpMLineIndex ?? null,
    usernameFragment: json.usernameFragment ?? null,
  };
}

export type StageGuestState = "idle" | "requesting" | "connecting" | "live" | "declined" | "removed" | "failed";
export type StageGuestFailure = "denied" | "unavailable" | "connection" | null;

/** Camera and microphone state the guest shares with the Host. */
export type StageMediaState = { camera: boolean; microphone: boolean };

/**
 * A Viewer on stage: sends camera and microphone to the Host over a dedicated
 * connection and plays the Host's return mix, which leaves out this guest's
 * own voice. The shared picture still arrives on the ordinary route; its audio
 * is muted by the page while the return mix plays.
 */
export class StageGuest {
  state: StageGuestState = "idle";
  failure: StageGuestFailure = null;
  media: StageMediaState = { camera: true, microphone: true };
  private connection: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private local: MediaStream | null = null;
  private returnAudio: HTMLAudioElement | null = null;
  private connectionId = "";
  private disposed = false;

  constructor(private readonly options: {
    send: (message: ClientMessage) => boolean;
    iceServers: () => RTCIceServer[];
    onChange: () => void;
  }) {}

  get active(): boolean {
    return this.state === "requesting" || this.state === "connecting" || this.state === "live";
  }

  /** True while the return mix should replace the shared stream's audio. */
  get returnAudioActive(): boolean {
    return this.state === "connecting" || this.state === "live";
  }

  request(): void {
    if (this.disposed || this.active) return;
    this.failure = null;
    if (this.options.send({ type: "stage-request" })) this.set("requesting");
  }

  leave(): void {
    if (this.state === "idle") return;
    this.options.send({ type: "stage-leave" });
    this.teardown("idle");
  }

  setCamera(enabled: boolean): void {
    const track = this.local?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = enabled;
    this.media = { ...this.media, camera: enabled };
    this.announce();
    this.options.onChange();
  }

  setMicrophone(enabled: boolean): void {
    const track = this.local?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = enabled;
    this.media = { ...this.media, microphone: enabled };
    this.announce();
    this.options.onChange();
  }

  /** The shared stream ended: the stage ends with it. */
  reset(): void {
    if (this.state !== "idle") this.teardown("idle");
  }

  dispose(): void {
    this.teardown("idle");
    this.disposed = true;
  }

  async onState(state: "accepted" | "declined" | "removed"): Promise<void> {
    if (state !== "accepted") {
      this.teardown(state);
      return;
    }
    if (this.state !== "requesting") return;
    this.set("connecting");
    let local: MediaStream;
    try {
      local = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      debugError("stage", "guest-capture-failed", error);
      this.options.send({ type: "stage-leave" });
      this.failure = error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "unavailable";
      this.teardown("failed");
      return;
    }
    // The guest may have left, or the share ended, while the camera started.
    if (!this.is("connecting")) {
      local.getTracks().forEach((track) => track.stop());
      return;
    }
    this.local = local;
    this.media = { camera: true, microphone: true };
    const connection = this.connection = new RTCPeerConnection({ iceServers: this.options.iceServers() });
    const connectionId = this.connectionId = createOpaqueId();
    for (const track of local.getTracks()) connection.addTransceiver(track, { direction: "sendrecv", streams: [local] });
    this.channel = connection.createDataChannel("stage");
    this.channel.onopen = () => this.announce();
    connection.onicecandidate = (event) => {
      if (this.connection !== connection) return;
      this.signal({ kind: "candidate", connectionId, candidate: stageCandidate(event.candidate) });
    };
    connection.ontrack = (event) => {
      if (this.connection !== connection || event.track.kind !== "audio") return;
      this.playReturnAudio(new MediaStream([event.track]));
    };
    connection.onconnectionstatechange = () => {
      if (this.connection !== connection) return;
      if (connection.connectionState === "connected") this.set("live");
      if (connection.connectionState === "failed") {
        this.options.send({ type: "stage-leave" });
        this.failure = "connection";
        this.teardown("failed");
      }
    };
    try {
      await connection.setLocalDescription();
      const description = connection.localDescription;
      if (this.connection !== connection || !description) return;
      this.signal({ kind: "description", connectionId, description: { type: description.type as "offer", sdp: description.sdp } });
    } catch (error) {
      debugError("stage", "guest-offer-failed", error);
      this.options.send({ type: "stage-leave" });
      this.failure = "connection";
      this.teardown("failed");
    }
  }

  async onSignal(payload: SignalPayload): Promise<void> {
    const connection = this.connection;
    if (!connection || payload.connectionId !== this.connectionId) return;
    try {
      if (payload.kind === "description") {
        if (payload.description.type === "answer") await connection.setRemoteDescription(payload.description);
      } else {
        await connection.addIceCandidate(payload.candidate ?? undefined);
      }
    } catch (error) {
      debugError("stage", "guest-signal-failed", error);
    }
  }

  private signal(payload: SignalPayload) {
    this.options.send({ type: "stage-signal", payload });
  }

  private announce() {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(this.media));
  }

  private playReturnAudio(stream: MediaStream) {
    if (!this.returnAudio) {
      this.returnAudio = new Audio();
      this.returnAudio.autoplay = true;
    }
    this.returnAudio.srcObject = stream;
    void this.returnAudio.play().catch((error: unknown) => debugError("stage", "guest-return-audio-blocked", error));
  }

  private teardown(state: StageGuestState) {
    this.channel?.close();
    this.channel = null;
    this.connection?.close();
    this.connection = null;
    this.connectionId = "";
    this.local?.getTracks().forEach((track) => track.stop());
    this.local = null;
    if (this.returnAudio) {
      this.returnAudio.pause();
      this.returnAudio.srcObject = null;
      this.returnAudio = null;
    }
    this.set(state);
  }

  private is(state: StageGuestState): boolean {
    return this.state === state;
  }

  private set(state: StageGuestState) {
    this.state = state;
    this.options.onChange();
  }
}
