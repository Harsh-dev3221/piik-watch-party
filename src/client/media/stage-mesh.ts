import type { ClientMessage, SignalPayload } from "../../shared/protocol";
import { debugError } from "../lib/debug";
import { createOpaqueId } from "../lib/opaque-id";
import type { SignalCandidate } from "../webrtc/nat-prediction";

/** Camera and microphone state a publisher shares with its viewers. */
export type StageMediaState = { camera: boolean; microphone: boolean };

/** One watch-party camera tile. */
export type StageTile = {
  peerId: string;
  self: boolean;
  stream: MediaStream | null;
  media: StageMediaState;
  connected: boolean;
};

type Link = {
  direction: "out" | "in";
  peerId: string;
  connectionId: string;
  connection: RTCPeerConnection;
  stream: MediaStream | null;
  media: StageMediaState;
  connected: boolean;
  channels: RTCDataChannel[];
};

const RETRY_MS = 3000;
const CAMERA_MAX_BITRATE = 1_200_000;

function candidateForSignal(candidate: RTCIceCandidate | null): SignalCandidate | null {
  if (!candidate) return null;
  const json = candidate.toJSON();
  return {
    candidate: json.candidate ?? "",
    sdpMid: json.sdpMid ?? null,
    sdpMLineIndex: json.sdpMLineIndex ?? null,
    usernameFragment: json.usernameFragment ?? null,
  };
}

/**
 * Watch-party cameras. Everyone on the roster (the Host and accepted guests)
 * sends camera and microphone to every other participant over one send-only
 * connection per receiver; everyone receives every publisher. The shared
 * screen keeps its own route, untouched.
 */
export class StageMesh {
  private selfPeerId: string | null = null;
  private roster: string[] = [];
  private participants = new Set<string>();
  private local: MediaStream | null = null;
  private localMedia: StageMediaState = { camera: true, microphone: true };
  private links = new Map<string, Link>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private snapshot: StageTile[] = [];
  private disposed = false;

  constructor(private readonly options: {
    send: (message: ClientMessage) => boolean;
    iceServers: () => RTCIceServer[];
    onChange: () => void;
  }) {}

  get publishing(): boolean { return this.local !== null; }
  get media(): StageMediaState { return this.localMedia; }
  get publishers(): readonly string[] { return this.roster; }

  tiles(): StageTile[] { return this.snapshot; }

  setSelf(peerId: string | null): void {
    if (peerId === this.selfPeerId) return;
    this.closeLinks(() => true);
    this.selfPeerId = peerId;
    this.reconcile();
  }

  setRoster(publishers: readonly string[]): void {
    this.roster = [...publishers];
    this.reconcile();
  }

  setParticipants(peerIds: Iterable<string>): void {
    this.participants = new Set(peerIds);
    this.reconcile();
  }

  /** Starts camera and microphone. Throws the capture error to the caller. */
  async startLocal(): Promise<void> {
    if (this.local || this.disposed) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    stream.getVideoTracks().forEach((track) => { track.contentHint = "motion"; });
    this.local = stream;
    this.localMedia = { camera: true, microphone: true };
    this.reconcile();
  }

  stopLocal(): void {
    if (!this.local) return;
    this.closeLinks((link) => link.direction === "out");
    this.local.getTracks().forEach((track) => track.stop());
    this.local = null;
    this.reconcile();
  }

  setCamera(enabled: boolean): void {
    this.local?.getVideoTracks().forEach((track) => { track.enabled = enabled; });
    this.localMedia = { ...this.localMedia, camera: enabled };
    this.announce();
  }

  setMicrophone(enabled: boolean): void {
    this.local?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    this.localMedia = { ...this.localMedia, microphone: enabled };
    this.announce();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.closeLinks(() => true);
    this.local?.getTracks().forEach((track) => track.stop());
    this.local = null;
    this.changed();
  }

  async onSignal(fromPeerId: string, payload: SignalPayload): Promise<void> {
    try {
      if (payload.kind === "description" && payload.description.type === "offer") {
        if (!this.roster.includes(fromPeerId) || fromPeerId === this.selfPeerId) return;
        await this.acceptOffer(fromPeerId, payload.connectionId, payload.description);
        return;
      }
      const link = [...this.links.values()].find((item) =>
        item.peerId === fromPeerId && item.connectionId === payload.connectionId);
      if (!link) return;
      if (payload.kind === "description") {
        if (link.direction === "out") await link.connection.setRemoteDescription(payload.description);
      } else {
        await link.connection.addIceCandidate(payload.candidate ?? undefined);
      }
    } catch (error) {
      debugError("stage", "mesh-signal-failed", error, { kind: payload.kind });
    }
  }

  private reconcile() {
    if (this.disposed) return;
    const self = this.selfPeerId;
    const present = new Set([...this.participants].filter((peerId) => peerId !== self));
    // Receive from every present publisher; drop links that lost their reason.
    this.closeLinks((link) => link.direction === "in" &&
      (!this.roster.includes(link.peerId) || !present.has(link.peerId)));
    const sending = !!self && !!this.local && this.roster.includes(self);
    this.closeLinks((link) => link.direction === "out" && (!sending || !present.has(link.peerId)));
    if (sending) {
      for (const peerId of present) {
        if (!this.links.has(`out:${peerId}`)) void this.openOutLink(peerId);
      }
    }
    this.changed();
  }

  private scheduleRetry() {
    if (this.retry || this.disposed) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.reconcile();
    }, RETRY_MS);
  }

  private newLink(direction: Link["direction"], peerId: string, connectionId: string): Link {
    const connection = new RTCPeerConnection({ iceServers: this.options.iceServers() });
    const link: Link = { direction, peerId, connectionId, connection, stream: null,
      media: { camera: true, microphone: true }, connected: false, channels: [] };
    const key = `${direction}:${peerId}`;
    this.links.get(key)?.connection.close();
    this.links.set(key, link);
    const owns = () => this.links.get(key) === link;
    connection.onicecandidate = (event) => {
      if (!owns()) return;
      this.options.send({ type: "stage-signal", targetPeerId: peerId,
        payload: { kind: "candidate", connectionId, candidate: candidateForSignal(event.candidate) } });
    };
    connection.onconnectionstatechange = () => {
      if (!owns()) return;
      const connected = connection.connectionState === "connected";
      if (connected !== link.connected) {
        link.connected = connected;
        this.changed();
      }
      if (connection.connectionState === "failed") {
        this.closeLinks((item) => item === link);
        // The publisher side re-offers; the receiver waits for that offer.
        if (direction === "out") this.scheduleRetry();
        this.changed();
      }
    };
    return link;
  }

  private async openOutLink(peerId: string) {
    const local = this.local;
    if (!local) return;
    const connectionId = createOpaqueId();
    const link = this.newLink("out", peerId, connectionId);
    const { connection } = link;
    for (const track of local.getTracks()) {
      // Faces at tile size: 720p within a bounded bitrate per receiver. Under
      // pressure the browser lowers resolution first and keeps motion smooth.
      connection.addTransceiver(track, {
        direction: "sendonly",
        streams: [local],
        ...(track.kind === "video" ? { sendEncodings: [{ maxBitrate: CAMERA_MAX_BITRATE, maxFramerate: 30 }] } : {}),
      });
    }
    for (const sender of connection.getSenders()) {
      if (sender.track?.kind !== "video") continue;
      const parameters = sender.getParameters();
      parameters.degradationPreference = "maintain-framerate";
      void sender.setParameters(parameters).catch(() => undefined);
    }
    const channel = connection.createDataChannel("stage");
    link.channels.push(channel);
    channel.onopen = () => channel.send(JSON.stringify(this.localMedia));
    try {
      await connection.setLocalDescription();
      const offer = connection.localDescription;
      if (this.links.get(`out:${peerId}`) !== link || !offer) return;
      this.options.send({ type: "stage-signal", targetPeerId: peerId,
        payload: { kind: "description", connectionId, description: { type: "offer", sdp: offer.sdp } } });
    } catch (error) {
      debugError("stage", "mesh-offer-failed", error);
      this.closeLinks((item) => item === link);
      this.scheduleRetry();
    }
  }

  private async acceptOffer(peerId: string, connectionId: string, offer: RTCSessionDescriptionInit) {
    const link = this.newLink("in", peerId, connectionId);
    const { connection } = link;
    connection.ontrack = (event) => {
      if (this.links.get(`in:${peerId}`) !== link) return;
      const stream = link.stream ?? event.streams[0] ?? new MediaStream();
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      link.stream = stream;
      this.changed();
    };
    connection.ondatachannel = (event) => {
      link.channels.push(event.channel);
      event.channel.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        try {
          const state = JSON.parse(message.data) as Partial<StageMediaState>;
          link.media = { camera: state.camera !== false, microphone: state.microphone !== false };
          this.changed();
        } catch {
          // Malformed state keeps the previous one.
        }
      };
    };
    this.changed();
    await connection.setRemoteDescription(offer);
    await connection.setLocalDescription();
    const answer = connection.localDescription;
    if (this.links.get(`in:${peerId}`) !== link || !answer) return;
    this.options.send({ type: "stage-signal", targetPeerId: peerId,
      payload: { kind: "description", connectionId, description: { type: "answer", sdp: answer.sdp } } });
  }

  private announce() {
    const state = JSON.stringify(this.localMedia);
    for (const link of this.links.values()) {
      if (link.direction !== "out") continue;
      for (const channel of link.channels) if (channel.readyState === "open") channel.send(state);
    }
    this.changed();
  }

  private closeLinks(predicate: (link: Link) => boolean) {
    for (const [key, link] of [...this.links]) {
      if (!predicate(link)) continue;
      this.links.delete(key);
      link.channels.forEach((channel) => channel.close());
      link.connection.close();
    }
  }

  private changed() {
    const self = this.selfPeerId;
    const tiles: StageTile[] = [];
    for (const peerId of this.roster) {
      if (peerId === self) {
        if (this.local) tiles.push({ peerId, self: true, stream: this.local, media: this.localMedia, connected: true });
        continue;
      }
      if (!this.participants.has(peerId)) continue;
      const link = this.links.get(`in:${peerId}`);
      tiles.push({ peerId, self: false, stream: link?.stream ?? null,
        media: link?.media ?? { camera: true, microphone: true }, connected: !!link?.connected });
    }
    // Own camera shows as soon as it starts, before the roster echoes it.
    if (self && this.local && !this.roster.includes(self)) {
      tiles.unshift({ peerId: self, self: true, stream: this.local, media: this.localMedia, connected: false });
    }
    this.snapshot = tiles;
    this.options.onChange();
  }
}
