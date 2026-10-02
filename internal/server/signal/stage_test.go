package signal

import (
	"bytes"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func stageCandidateSignal(connectionID string) map[string]any {
	return map[string]any{"kind": "candidate", "connectionId": connectionID, "candidate": nil}
}

func TestStageRequestAcceptSignalAndLimit(t *testing.T) {
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 5})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "stage-host", 1,
		"stage_share_generation_12345678", presenceOptions{displayName: "Host", viewerPresence: true, roomSession: true})
	host.ignore("route-update")
	host.ignore("viewer-presence")
	host.ignore("signal")

	viewers := make([]*testClient, 3)
	peerIDs := make([]string, 3)
	for index := range viewers {
		viewers[index] = openClient(t, h)
		auth := authenticate(t, viewers[index], h.room, protocol.RoleViewer, "stage-viewer-"+string(rune('a'+index)), 1, "",
			presenceOptions{displayName: "Viewer", viewerPresence: true})
		viewers[index].ignore("route-update")
		viewers[index].ignore("viewer-presence")
		viewers[index].ignore("signal")
		viewers[index].ignore("host-status")
		peerIDs[index] = auth.PeerID
	}

	// A Viewer that was never accepted cannot signal the Host.
	viewers[0].sendJSON(map[string]any{"type": "stage-signal", "payload": stageCandidateSignal("stage_connection_0001")})
	host.expectNone(80 * time.Millisecond)

	// Viewers cannot decide; the Host cannot request.
	viewers[0].sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[1], "accept": true})
	viewers[0].next("error")
	host.sendJSON(map[string]any{"type": "stage-request"})
	host.next("error")

	for index := range viewers {
		viewers[index].sendJSON(map[string]any{"type": "stage-request"})
		request := host.next("stage-request")
		if !bytes.Contains(request.raw, []byte(peerIDs[index])) {
			t.Fatalf("stage-request names the wrong peer: %s", request.raw)
		}
	}
	// A repeated request while pending is not forwarded again.
	viewers[0].sendJSON(map[string]any{"type": "stage-request"})
	host.expectNone(80 * time.Millisecond)

	for index := range viewers {
		host.sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[index], "accept": true})
	}
	expectEqual(t, viewers[0].next("stage-state").raw, `{"type":"stage-state","state":"accepted"}`)
	expectEqual(t, viewers[1].next("stage-state").raw, `{"type":"stage-state","state":"accepted"}`)
	// Only MaxStagePeers Viewers fit on stage.
	expectEqual(t, viewers[2].next("stage-state").raw, `{"type":"stage-state","state":"declined"}`)

	// Accepted Viewer -> Host, and Host -> that Viewer only.
	viewers[0].sendJSON(map[string]any{"type": "stage-signal", "payload": stageCandidateSignal("stage_connection_0001")})
	forwarded := host.next("stage-signal")
	if !bytes.Contains(forwarded.raw, []byte(`"fromPeerId":"`+peerIDs[0]+`"`)) {
		t.Fatalf("stage-signal lost its sender: %s", forwarded.raw)
	}
	host.sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[0], "payload": stageCandidateSignal("stage_connection_0001")})
	viewers[0].next("stage-signal")
	viewers[1].expectNone(80 * time.Millisecond)
	// The declined Viewer is not a valid target.
	host.sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[2], "payload": stageCandidateSignal("stage_connection_0003")})
	viewers[2].expectNone(80 * time.Millisecond)

	// Leaving frees the slot and tells the Host.
	viewers[1].sendJSON(map[string]any{"type": "stage-leave"})
	left := host.next("stage-left")
	if !bytes.Contains(left.raw, []byte(peerIDs[1])) {
		t.Fatalf("stage-left names the wrong peer: %s", left.raw)
	}
	viewers[2].sendJSON(map[string]any{"type": "stage-request"})
	host.next("stage-request")
	host.sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[2], "accept": true})
	expectEqual(t, viewers[2].next("stage-state").raw, `{"type":"stage-state","state":"accepted"}`)

	// Removal ends signaling for that Viewer.
	host.sendJSON(map[string]any{"type": "stage-remove", "peerId": peerIDs[0]})
	expectEqual(t, viewers[0].next("stage-state").raw, `{"type":"stage-state","state":"removed"}`)
	viewers[0].sendJSON(map[string]any{"type": "stage-signal", "payload": stageCandidateSignal("stage_connection_0001")})
	host.expectNone(80 * time.Millisecond)

	// Stopping the share clears the stage.
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": hostAuth.ShareGeneration})
	viewers[2].next("sharing-stopped")
	viewers[2].sendJSON(map[string]any{"type": "stage-signal", "payload": stageCandidateSignal("stage_connection_0003")})
	host.expectNone(80 * time.Millisecond)

	for _, viewer := range viewers {
		h.closeClient(viewer)
	}
	h.closeClient(host)
}

func TestStageRequestWithoutShareIsDeclined(t *testing.T) {
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 2})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "idle-stage-host", 1,
		"idle_share_generation_12345678", presenceOptions{displayName: "Host", viewerPresence: true, roomSession: true})
	host.ignore("route-update")
	host.ignore("viewer-presence")
	viewer := openClient(t, h)
	authenticate(t, viewer, h.room, protocol.RoleViewer, "idle-stage-viewer", 1, "",
		presenceOptions{displayName: "Viewer", viewerPresence: true})
	viewer.ignore("route-update")
	viewer.ignore("viewer-presence")
	viewer.ignore("signal")
	host.ignore("signal")
	host.sendJSON(map[string]any{"type": "stop-sharing", "shareGeneration": hostAuth.ShareGeneration})
	viewer.next("sharing-stopped")
	viewer.ignore("host-status")

	viewer.sendJSON(map[string]any{"type": "stage-request"})
	expectEqual(t, viewer.next("stage-state").raw, `{"type":"stage-state","state":"declined"}`)
	host.expectNone(80 * time.Millisecond)
	h.closeClient(viewer)
	h.closeClient(host)
}
