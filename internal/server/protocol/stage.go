package protocol

import "errors"

// Stage messages let up to MaxStagePeers Viewers send their camera and
// microphone to the Host over a dedicated Host<->Viewer connection. The Host
// composites them into the one shared picture and mix; routes are unchanged.

// MaxStagePeers bounds accepted stage Viewers per room.
const MaxStagePeers = 2

// StageRequestMessage is { type: "stage-request" } from a Viewer.
type StageRequestMessage struct {
	Type string `json:"type"`
}

// StageLeaveMessage is { type: "stage-leave" } from a Viewer.
type StageLeaveMessage struct {
	Type string `json:"type"`
}

// StageDecisionMessage is { type: "stage-decision", peerId, accept } from the Host.
type StageDecisionMessage struct {
	Type   string `json:"type"`
	PeerID string `json:"peerId"`
	Accept bool   `json:"accept"`
}

// StageRemoveMessage is { type: "stage-remove", peerId } from the Host.
type StageRemoveMessage struct {
	Type   string `json:"type"`
	PeerID string `json:"peerId"`
}

// ClientStageSignalMessage is { type: "stage-signal", targetPeerId?, payload }.
// A Viewer omits targetPeerId (the Host is implied); the Host names the Viewer.
type ClientStageSignalMessage struct {
	Type         string        `json:"type"`
	TargetPeerID string        `json:"targetPeerId,omitempty"`
	Payload      SignalPayload `json:"payload"`
}

func (StageRequestMessage) isClientMessage()      {}
func (StageLeaveMessage) isClientMessage()        {}
func (StageDecisionMessage) isClientMessage()     {}
func (StageRemoveMessage) isClientMessage()       {}
func (ClientStageSignalMessage) isClientMessage() {}

// ServerStageRequestMessage tells the Host a Viewer asked to go on stage.
type ServerStageRequestMessage struct {
	Type   string `json:"type"`
	PeerID string `json:"peerId"`
}

// ServerStageLeftMessage tells the Host a stage Viewer left the stage.
type ServerStageLeftMessage struct {
	Type   string `json:"type"`
	PeerID string `json:"peerId"`
}

// ServerStageStateMessage tells a Viewer its stage state:
// "accepted", "declined" or "removed".
type ServerStageStateMessage struct {
	Type  string `json:"type"`
	State string `json:"state"`
}

// ServerStageSignalMessage forwards a stage connection signal.
type ServerStageSignalMessage struct {
	Type       string        `json:"type"`
	FromPeerID string        `json:"fromPeerId"`
	Payload    SignalPayload `json:"payload"`
}

func (ServerStageRequestMessage) isServerMessage() {}
func (ServerStageLeftMessage) isServerMessage()    {}
func (ServerStageStateMessage) isServerMessage()   {}
func (ServerStageSignalMessage) isServerMessage()  {}

func decodeStageDecision(data []byte) (ClientMessage, error) {
	var message StageDecisionMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "peerId", "accept"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.PeerID) {
		return nil, errors.New("peerId is not an opaque id")
	}
	return message, nil
}

func decodeStageRemove(data []byte) (ClientMessage, error) {
	var message StageRemoveMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "peerId"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.PeerID) {
		return nil, errors.New("peerId is not an opaque id")
	}
	return message, nil
}

func decodeClientStageSignal(data []byte) (ClientMessage, error) {
	var message ClientStageSignalMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "payload"); err != nil {
		return nil, err
	}
	if err := present.optional("targetPeerId"); err != nil {
		return nil, err
	}
	if present.has("targetPeerId") && !ValidOpaqueID(message.TargetPeerID) {
		return nil, errors.New("targetPeerId is not an opaque id")
	}
	return message, nil
}

func decodeServerStagePeer(data []byte, messageType string) (ServerMessage, error) {
	var message struct {
		Type   string `json:"type"`
		PeerID string `json:"peerId"`
	}
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "peerId"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.PeerID) {
		return nil, errors.New("peerId is not an opaque id")
	}
	if messageType == "stage-left" {
		return ServerStageLeftMessage{Type: messageType, PeerID: message.PeerID}, nil
	}
	return ServerStageRequestMessage{Type: messageType, PeerID: message.PeerID}, nil
}

func decodeServerStageState(data []byte) (ServerMessage, error) {
	var message ServerStageStateMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "state"); err != nil {
		return nil, err
	}
	switch message.State {
	case "accepted", "declined", "removed":
		return message, nil
	}
	return nil, errors.New("state is not a stage state")
}

func decodeServerStageSignal(data []byte) (ServerMessage, error) {
	var message ServerStageSignalMessage
	present, err := decodeObject(data, &message)
	if err != nil {
		return nil, err
	}
	if err := present.require("type", "fromPeerId", "payload"); err != nil {
		return nil, err
	}
	if !ValidOpaqueID(message.FromPeerID) {
		return nil, errors.New("fromPeerId is not an opaque id")
	}
	return message, nil
}
