package signal

import (
	"sort"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

// stageEntry is one Viewer's stage request. It is bound to the requesting
// session, so a reconnect or disconnect silently invalidates it.
type stageEntry struct {
	sessionID string
	accepted  bool
	order     int64
}

// roomStage is the watch-party camera state of a room: who asked to go on
// camera, who was accepted, and whether the Host itself is on camera.
type roomStage struct {
	entries        map[string]stageEntry
	hostPublishing bool
	nextOrder      int64
}

func (s *Server) stageOf(roomID string) *roomStage {
	stage := s.stages[roomID]
	if stage == nil {
		stage = &roomStage{entries: map[string]stageEntry{}}
		s.stages[roomID] = stage
	}
	return stage
}

// currentStageEntry returns the entry while its Viewer session is still
// connected, pruning stale entries on the way.
func (s *Server) currentStageEntry(roomID, peerID string) (stageEntry, bool) {
	stage := s.stages[roomID]
	if stage == nil {
		return stageEntry{}, false
	}
	entry, ok := stage.entries[peerID]
	if !ok {
		return entry, false
	}
	viewer, connected := s.store.GetConnectedViewer(roomID, peerID)
	if !connected || viewer.SessionID != entry.sessionID {
		delete(stage.entries, peerID)
		return stageEntry{}, false
	}
	return entry, true
}

// stagePublishers lists everyone on camera: the Host first, then accepted
// Viewers in acceptance order.
func (s *Server) stagePublishers(roomID string) []string {
	publishers := []string{}
	stage := s.stages[roomID]
	if stage == nil {
		return publishers
	}
	if host, ok := s.store.GetConnectedHost(roomID); ok && stage.hostPublishing {
		publishers = append(publishers, host.PeerID)
	}
	type accepted struct {
		peerID string
		order  int64
	}
	guests := []accepted{}
	for peerID := range stage.entries {
		if entry, ok := s.currentStageEntry(roomID, peerID); ok && entry.accepted {
			guests = append(guests, accepted{peerID, entry.order})
		}
	}
	sort.Slice(guests, func(i, j int) bool { return guests[i].order < guests[j].order })
	for _, guest := range guests {
		publishers = append(publishers, guest.peerID)
	}
	return publishers
}

func (s *Server) acceptedStageCount(roomID string) int {
	count := len(s.stagePublishers(roomID))
	if stage := s.stages[roomID]; stage != nil && stage.hostPublishing {
		if _, ok := s.store.GetConnectedHost(roomID); ok {
			count--
		}
	}
	return count
}

func (s *Server) isStagePublisher(roomID, peerID string) bool {
	for _, publisher := range s.stagePublishers(roomID) {
		if publisher == peerID {
			return true
		}
	}
	return false
}

// broadcastStageRoster tells every connected participant who is on camera.
func (s *Server) broadcastStageRoster(roomID string) {
	message := protocol.ServerStageRosterMessage{Type: "stage-roster", Publishers: s.stagePublishers(roomID)}
	if host, ok := s.store.GetConnectedHost(roomID); ok {
		s.sendToSession(host.SessionID, message)
	}
	for _, viewer := range s.store.GetConnectedViewers(roomID) {
		s.sendToSession(viewer.SessionID, message)
	}
}

// clearStage drops a closed room's stage.
func (s *Server) clearStage(roomID string) {
	delete(s.stages, roomID)
}

func (s *Server) sendToHost(roomID string, message protocol.ServerMessage) {
	if host, ok := s.store.GetConnectedHost(roomID); ok {
		s.sendToSession(host.SessionID, message)
	}
}

func (s *Server) sendStageState(entry stageEntry, state string) {
	s.sendToSession(entry.sessionID, protocol.ServerStageStateMessage{Type: "stage-state", State: state})
}

func (s *Server) handleStageMessage(sess *session, authenticated *authenticatedSession, message protocol.ClientMessage) {
	roomID := authenticated.roomID
	isHost := authenticated.role == protocol.RoleHost
	switch m := message.(type) {
	case protocol.StageSyncMessage:
		s.send(sess, protocol.ServerStageRosterMessage{Type: "stage-roster", Publishers: s.stagePublishers(roomID)})
	case protocol.StagePublishMessage:
		if !isHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may publish without a stage request")
			return
		}
		stage := s.stageOf(roomID)
		if stage.hostPublishing == m.Enabled {
			return
		}
		stage.hostPublishing = m.Enabled
		s.broadcastStageRoster(roomID)
	case protocol.StageRequestMessage:
		if isHost {
			s.sendError(sess, "FORBIDDEN", "Only viewers may ask to go on camera")
			return
		}
		if _, ok := s.currentStageEntry(roomID, authenticated.peerID); ok {
			return
		}
		s.stageOf(roomID).entries[authenticated.peerID] = stageEntry{sessionID: sess.sessionID}
		s.sendToHost(roomID, protocol.ServerStageRequestMessage{Type: "stage-request", PeerID: authenticated.peerID})
	case protocol.StageLeaveMessage:
		if isHost {
			s.sendError(sess, "FORBIDDEN", "Only viewers may leave the stage")
			return
		}
		entry, ok := s.currentStageEntry(roomID, authenticated.peerID)
		if !ok {
			return
		}
		delete(s.stages[roomID].entries, authenticated.peerID)
		s.sendToHost(roomID, protocol.ServerStageLeftMessage{Type: "stage-left", PeerID: authenticated.peerID})
		if entry.accepted {
			s.broadcastStageRoster(roomID)
		}
	case protocol.StageDecisionMessage:
		if !isHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may decide stage requests")
			return
		}
		entry, ok := s.currentStageEntry(roomID, m.PeerID)
		if !ok || entry.accepted {
			return
		}
		stage := s.stages[roomID]
		if m.Accept && s.acceptedStageCount(roomID) < protocol.MaxStagePeers {
			stage.nextOrder++
			entry.accepted = true
			entry.order = stage.nextOrder
			stage.entries[m.PeerID] = entry
			s.sendStageState(entry, "accepted")
			s.broadcastStageRoster(roomID)
			return
		}
		delete(stage.entries, m.PeerID)
		s.sendStageState(entry, "declined")
	case protocol.StageRemoveMessage:
		if !isHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may remove stage viewers")
			return
		}
		entry, ok := s.currentStageEntry(roomID, m.PeerID)
		if !ok {
			return
		}
		delete(s.stages[roomID].entries, m.PeerID)
		s.sendStageState(entry, "removed")
		if entry.accepted {
			s.broadcastStageRoster(roomID)
		}
	case protocol.ClientStageSignalMessage:
		// Camera links run between two connected participants of the room,
		// and at least one end must be on camera.
		if m.TargetPeerID == "" || m.TargetPeerID == authenticated.peerID {
			s.sendError(sess, "FORBIDDEN", "Stage signals need another participant as target")
			return
		}
		target, ok := s.connectedPeer(roomID, m.TargetPeerID)
		if !ok {
			return
		}
		if !s.isStagePublisher(roomID, authenticated.peerID) && !s.isStagePublisher(roomID, m.TargetPeerID) {
			return
		}
		s.sendToSession(target.SessionID, protocol.ServerStageSignalMessage{
			Type: "stage-signal", FromPeerID: authenticated.peerID, Payload: m.Payload,
		})
	}
}
