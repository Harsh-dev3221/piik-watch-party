package signal

import "github.com/TNTcraftHIM/Piik/internal/server/protocol"

// stageEntry is one Viewer's stage request. It is bound to the requesting
// session, so a reconnect or disconnect silently invalidates it.
type stageEntry struct {
	sessionID string
	accepted  bool
}

// currentStageEntry returns the entry while its Viewer session is still
// connected, pruning stale entries on the way.
func (s *Server) currentStageEntry(roomID, peerID string) (stageEntry, bool) {
	entry, ok := s.stages[roomID][peerID]
	if !ok {
		return entry, false
	}
	viewer, connected := s.store.GetConnectedViewer(roomID, peerID)
	if !connected || viewer.SessionID != entry.sessionID {
		delete(s.stages[roomID], peerID)
		return stageEntry{}, false
	}
	return entry, true
}

func (s *Server) acceptedStageCount(roomID string) int {
	count := 0
	for peerID := range s.stages[roomID] {
		if entry, ok := s.currentStageEntry(roomID, peerID); ok && entry.accepted {
			count++
		}
	}
	return count
}

// clearStage drops every stage entry of a room; share start, stop and room
// close own this. Pages reset their stage state from the same share events.
func (s *Server) clearStage(roomID string) {
	delete(s.stages, roomID)
}

func (s *Server) setStageEntry(roomID, peerID string, entry stageEntry) {
	if s.stages[roomID] == nil {
		s.stages[roomID] = map[string]stageEntry{}
	}
	s.stages[roomID][peerID] = entry
}

func (s *Server) sendToHost(roomID string, message protocol.ServerMessage) {
	if host, ok := s.store.GetConnectedHost(roomID); ok {
		s.sendToSession(host.SessionID, message)
	}
}

func (s *Server) sendStageState(roomID string, entry stageEntry, state string) {
	s.sendToSession(entry.sessionID, protocol.ServerStageStateMessage{Type: "stage-state", State: state})
}

func (s *Server) handleStageMessage(sess *session, authenticated *authenticatedSession, message protocol.ClientMessage) {
	roomID := authenticated.roomID
	isHost := authenticated.role == protocol.RoleHost
	switch m := message.(type) {
	case protocol.StageRequestMessage:
		if isHost {
			s.sendError(sess, "FORBIDDEN", "Only viewers may ask to go on stage")
			return
		}
		if s.activeHostShareGeneration(roomID) == "" {
			s.sendStageState(roomID, stageEntry{sessionID: sess.sessionID}, "declined")
			return
		}
		if _, ok := s.currentStageEntry(roomID, authenticated.peerID); ok {
			return
		}
		s.setStageEntry(roomID, authenticated.peerID, stageEntry{sessionID: sess.sessionID})
		s.sendToHost(roomID, protocol.ServerStageRequestMessage{Type: "stage-request", PeerID: authenticated.peerID})
	case protocol.StageLeaveMessage:
		if isHost {
			s.sendError(sess, "FORBIDDEN", "Only viewers may leave the stage")
			return
		}
		if _, ok := s.currentStageEntry(roomID, authenticated.peerID); !ok {
			return
		}
		delete(s.stages[roomID], authenticated.peerID)
		s.sendToHost(roomID, protocol.ServerStageLeftMessage{Type: "stage-left", PeerID: authenticated.peerID})
	case protocol.StageDecisionMessage:
		if !isHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may decide stage requests")
			return
		}
		entry, ok := s.currentStageEntry(roomID, m.PeerID)
		if !ok || entry.accepted {
			return
		}
		if m.Accept && s.acceptedStageCount(roomID) < protocol.MaxStagePeers {
			entry.accepted = true
			s.setStageEntry(roomID, m.PeerID, entry)
			s.sendStageState(roomID, entry, "accepted")
			return
		}
		delete(s.stages[roomID], m.PeerID)
		s.sendStageState(roomID, entry, "declined")
	case protocol.StageRemoveMessage:
		if !isHost {
			s.sendError(sess, "FORBIDDEN", "Only the host may remove stage viewers")
			return
		}
		entry, ok := s.currentStageEntry(roomID, m.PeerID)
		if !ok {
			return
		}
		delete(s.stages[roomID], m.PeerID)
		s.sendStageState(roomID, entry, "removed")
	case protocol.ClientStageSignalMessage:
		if isHost {
			entry, ok := s.currentStageEntry(roomID, m.TargetPeerID)
			if m.TargetPeerID == "" || !ok || !entry.accepted {
				return
			}
			s.sendToSession(entry.sessionID, protocol.ServerStageSignalMessage{
				Type: "stage-signal", FromPeerID: authenticated.peerID, Payload: m.Payload,
			})
			return
		}
		if m.TargetPeerID != "" {
			s.sendError(sess, "FORBIDDEN", "Stage signals from a viewer go to the host")
			return
		}
		if entry, ok := s.currentStageEntry(roomID, authenticated.peerID); !ok || !entry.accepted {
			return
		}
		s.sendToHost(roomID, protocol.ServerStageSignalMessage{
			Type: "stage-signal", FromPeerID: authenticated.peerID, Payload: m.Payload,
		})
	}
}
