import { MAX_STAGE_PEERS, type ClientMessage, type SignalPayload } from "../../shared/protocol";
import { debugError } from "../lib/debug";
import type { StageCompositor } from "./camera-overlay";
import { stageCandidate, type StageMediaState } from "./stage-guest";

/** The part of HostAudio the stage uses. */
export type StageAudio = {
  addGuest(id: string, track: MediaStreamTrack): void;
  removeGuest(id: string): void;
  guestMix(id: string): MediaStreamTrack | null;
};

export type StageMember = { peerId: string; live: boolean; camera: boolean; microphone: boolean };

type Member = {
  peerId: string;
  connection: RTCPeerConnection | null;
  connectionId: string;
  remoteVideo: MediaStreamTrack | null;
  returnVideo: MediaStreamTrack | null;
  playback: HTMLAudioElement | null;
  media: StageMediaState;
  live: boolean;
};

/**
 * The Host side of the stage. Accepted guests connect with a dedicated offer;
 * their camera becomes a compositor box, their voice joins the shared mix and
 * plays locally for the Host, and they receive the shared picture plus a mix
 * without their own voice.
 */
export class StageHost {
  requests: string[] = [];
  private members = new Map<string, Member>();
  private compositor: StageCompositor | null = null;
  private snapshot: StageMember[] = [];

  constructor(private readonly options: {
    send: (message: ClientMessage) => boolean;
    iceServers: () => RTCIceServer[];
    audio: () => StageAudio | null;
    labelFor: (peerId: string) => string;
    onChange: () => void;
  }) {}

  get full(): boolean { return this.members.size >= MAX_STAGE_PEERS; }

  membersSnapshot(): StageMember[] { return this.snapshot; }

  onRequest(peerId: string): void {
    if (this.members.has(peerId) || this.requests.includes(peerId)) return;
    // Only a composited Browser screen share can show guest boxes.
    if (!this.compositor?.live) {
      this.options.send({ type: "stage-decision", peerId, accept: false });
      return;
    }
    this.requests = [...this.requests, peerId];
    this.changed();
  }

  onLeft(peerId: string): void {
    this.requests = this.requests.filter((id) => id !== peerId);
    this.teardown(peerId);
    this.changed();
  }

  /** Accepting needs the mixer first; the caller creates it in the click. */
  decide(peerId: string, accept: boolean): void {
    if (!this.requests.includes(peerId)) return;
    this.requests = this.requests.filter((id) => id !== peerId);
    const admitted = accept && !this.full;
    this.options.send({ type: "stage-decision", peerId, accept: admitted });
    if (admitted) {
      this.members.set(peerId, {
        peerId, connection: null, connectionId: "", remoteVideo: null, returnVideo: null, playback: null,
        media: { camera: true, microphone: true }, live: false,
      });
    }
    this.changed();
  }

  remove(peerId: string): void {
    if (!this.members.has(peerId)) return;
    this.options.send({ type: "stage-remove", peerId });
    this.teardown(peerId);
    this.changed();
  }

  /** Follows the current share's compositor; boxes move to a replacement. */
  attachCompositor(compositor: StageCompositor | null): void {
    if (this.compositor === compositor) return;
    this.compositor = compositor;
    for (const member of this.members.values()) {
      this.placeBox(member);
      this.refreshReturnVideo(member);
    }
  }

  /** Drops requests and guests whose Viewer left the room. */
  retain(present: ReadonlySet<string>): void {
    const requests = this.requests.filter((id) => present.has(id));
    const gone = [...this.members.keys()].filter((id) => !present.has(id));
    if (requests.length === this.requests.length && gone.length === 0) return;
    this.requests = requests;
    for (const peerId of gone) this.teardown(peerId);
    this.changed();
  }

  /** The share ended: every guest leaves the stage. */
  reset(): void {
    this.requests = [];
    for (const peerId of [...this.members.keys()]) this.teardown(peerId);
    this.changed();
  }

  async onSignal(peerId: string, payload: SignalPayload): Promise<void> {
    const member = this.members.get(peerId);
    if (!member) return;
    try {
      if (payload.kind === "candidate") {
        if (member.connection && payload.connectionId === member.connectionId) {
          await member.connection.addIceCandidate(payload.candidate ?? undefined);
        }
        return;
      }
      if (payload.description.type !== "offer") return;
      if (member.connection) this.closeConnection(member);
      await this.answer(member, payload.connectionId, payload.description);
    } catch (error) {
      debugError("stage", "host-signal-failed", error, { peerId });
    }
  }

  private async answer(member: Member, connectionId: string, offer: RTCSessionDescriptionInit) {
    const connection = new RTCPeerConnection({ iceServers: this.options.iceServers() });
    member.connection = connection;
    member.connectionId = connectionId;
    const owns = () => this.members.get(member.peerId) === member && member.connection === connection;
    connection.onicecandidate = (event) => {
      if (!owns()) return;
      this.options.send({ type: "stage-signal", targetPeerId: member.peerId,
        payload: { kind: "candidate", connectionId, candidate: stageCandidate(event.candidate) } });
    };
    connection.ontrack = (event) => {
      if (!owns()) return;
      if (event.track.kind === "video") {
        member.remoteVideo = event.track;
        this.placeBox(member);
      } else {
        this.options.audio()?.addGuest(member.peerId, event.track);
        member.playback?.pause();
        member.playback = new Audio();
        member.playback.autoplay = true;
        member.playback.srcObject = new MediaStream([event.track]);
        void member.playback.play().catch((error: unknown) => debugError("stage", "host-guest-audio-blocked", error));
      }
    };
    connection.ondatachannel = (event) => {
      event.channel.onmessage = (message) => {
        if (!owns() || typeof message.data !== "string") return;
        try {
          const state = JSON.parse(message.data) as Partial<StageMediaState>;
          member.media = { camera: state.camera !== false, microphone: state.microphone !== false };
          this.placeBox(member);
          this.changed();
        } catch {
          // Ignore malformed state; the box keeps its last state.
        }
      };
    };
    connection.onconnectionstatechange = () => {
      if (!owns()) return;
      const live = connection.connectionState === "connected";
      if (live !== member.live) {
        member.live = live;
        this.changed();
      }
      if (connection.connectionState === "failed") this.remove(member.peerId);
    };
    await connection.setRemoteDescription(offer);
    // Answer on the guest's own transceivers: the shared picture and this
    // guest's return mix go back on the same m-lines.
    for (const transceiver of connection.getTransceivers()) {
      transceiver.direction = "sendrecv";
      const kind = transceiver.receiver.track.kind;
      if (kind === "video") {
        member.returnVideo?.stop();
        member.returnVideo = this.returnVideoTrack();
        await transceiver.sender.replaceTrack(member.returnVideo);
      } else {
        await transceiver.sender.replaceTrack(this.options.audio()?.guestMix(member.peerId) ?? null);
      }
    }
    await connection.setLocalDescription();
    const answer = connection.localDescription;
    if (!owns() || !answer) return;
    this.options.send({ type: "stage-signal", targetPeerId: member.peerId,
      payload: { kind: "description", connectionId, description: { type: "answer", sdp: answer.sdp } } });
  }

  private returnVideoTrack(): MediaStreamTrack | null {
    return this.compositor?.live ? this.compositor.stream.getVideoTracks()[0]?.clone() ?? null : null;
  }

  private refreshReturnVideo(member: Member) {
    const transceiver = member.connection?.getTransceivers().find((item) => item.receiver.track.kind === "video");
    if (!transceiver) return;
    member.returnVideo?.stop();
    member.returnVideo = this.returnVideoTrack();
    void transceiver.sender.replaceTrack(member.returnVideo).catch((error: unknown) =>
      debugError("stage", "host-return-video-failed", error));
  }

  private placeBox(member: Member) {
    const compositor = this.compositor;
    if (!compositor) return;
    const track = member.remoteVideo;
    if (track && track.readyState === "live" && member.media.camera) {
      if (!compositor.has(member.peerId)) {
        compositor.addSource(member.peerId, track, { owned: false, label: this.options.labelFor(member.peerId) });
      }
    } else {
      compositor.removeSource(member.peerId);
    }
  }

  private closeConnection(member: Member) {
    member.connection?.close();
    member.connection = null;
    member.connectionId = "";
    member.returnVideo?.stop();
    member.returnVideo = null;
    member.remoteVideo = null;
    member.live = false;
    if (member.playback) {
      member.playback.pause();
      member.playback.srcObject = null;
      member.playback = null;
    }
    this.compositor?.removeSource(member.peerId);
    this.options.audio()?.removeGuest(member.peerId);
  }

  private teardown(peerId: string) {
    const member = this.members.get(peerId);
    if (!member) return;
    this.members.delete(peerId);
    this.closeConnection(member);
  }

  private changed() {
    this.snapshot = [...this.members.values()].map(({ peerId, live, media }) =>
      ({ peerId, live, camera: media.camera, microphone: media.microphone }));
    this.options.onChange();
  }
}
