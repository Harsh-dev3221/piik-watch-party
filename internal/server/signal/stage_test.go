package signal

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/TNTcraftHIM/Piik/internal/server/protocol"
)

func stageCandidateSignal(connectionID string) map[string]any {
	return map[string]any{"kind": "candidate", "connectionId": connectionID, "candidate": nil}
}

func expectRoster(t *testing.T, client *testClient, publishers ...string) {
	t.Helper()
	raw := client.next("stage-roster").raw
	var message struct {
		Publishers []string `json:"publishers"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatalf("bad stage-roster %s: %v", raw, err)
	}
	if len(message.Publishers) != len(publishers) {
		t.Fatalf("roster %v, want %v", message.Publishers, publishers)
	}
	for index := range publishers {
		if message.Publishers[index] != publishers[index] {
			t.Fatalf("roster %v, want %v", message.Publishers, publishers)
		}
	}
}

func TestStageWatchPartyRosterAndSignals(t *testing.T) {
	h := startHarness(t, harnessOptions{maxViewersPerRoom: 5})
	host := openClient(t, h)
	hostAuth := authenticate(t, host, h.room, protocol.RoleHost, "stage-host", 1,
		"stage_share_generation_12345678", presenceOptions{displayName: "Host", viewerPresence: true, roomSession: true})
	for _, typ := range []string{"route-update", "viewer-presence", "signal"} {
		host.ignore(typ)
	}

	viewers := make([]*testClient, 3)
	peerIDs := make([]string, 3)
	for index := range viewers {
		viewers[index] = openClient(t, h)
		auth := authenticate(t, viewers[index], h.room, protocol.RoleViewer, "stage-viewer-"+string(rune('a'+index)), 1, "",
			presenceOptions{displayName: "Viewer", viewerPresence: true})
		for _, typ := range []string{"route-update", "viewer-presence", "signal", "host-status"} {
			viewers[index].ignore(typ)
		}
		peerIDs[index] = auth.PeerID
	}
	everyone := append([]*testClient{host}, viewers...)

	// Nobody is on camera: no camera links at all.
	viewers[0].sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[1], "payload": stageCandidateSignal("stage_connection_0001")})
	viewers[1].expectNone(80 * time.Millisecond)
	viewers[0].sendJSON(map[string]any{"type": "stage-sync"})
	expectRoster(t, viewers[0])

	// Only the Host decides and publishes without asking; the Host never asks.
	viewers[0].sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[1], "accept": true})
	viewers[0].next("error")
	viewers[0].sendJSON(map[string]any{"type": "stage-publish", "enabled": true})
	viewers[0].next("error")
	host.sendJSON(map[string]any{"type": "stage-request"})
	host.next("error")

	// The Host turns its camera on: everyone learns the roster.
	host.sendJSON(map[string]any{"type": "stage-publish", "enabled": true})
	for _, client := range everyone {
		expectRoster(t, client, hostAuth.PeerID)
	}
	// A Viewer may now link to the Host's camera and back.
	viewers[2].sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": hostAuth.PeerID, "payload": stageCandidateSignal("stage_connection_0003")})
	forwarded := host.next("stage-signal")
	if !bytes.Contains(forwarded.raw, []byte(`"fromPeerId":"`+peerIDs[2]+`"`)) {
		t.Fatalf("stage-signal lost its sender: %s", forwarded.raw)
	}
	host.sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[2], "payload": stageCandidateSignal("stage_connection_0003")})
	viewers[2].next("stage-signal")

	for index := range viewers {
		viewers[index].sendJSON(map[string]any{"type": "stage-request"})
		request := host.next("stage-request")
		if !bytes.Contains(request.raw, []byte(peerIDs[index])) {
			t.Fatalf("stage-request names the wrong peer: %s", request.raw)
		}
	}
	viewers[0].sendJSON(map[string]any{"type": "stage-request"})
	host.expectNone(80 * time.Millisecond)

	host.sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[0], "accept": true})
	expectEqual(t, viewers[0].next("stage-state").raw, `{"type":"stage-state","state":"accepted"}`)
	for _, client := range everyone {
		expectRoster(t, client, hostAuth.PeerID, peerIDs[0])
	}
	host.sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[1], "accept": true})
	expectEqual(t, viewers[1].next("stage-state").raw, `{"type":"stage-state","state":"accepted"}`)
	for _, client := range everyone {
		expectRoster(t, client, hostAuth.PeerID, peerIDs[0], peerIDs[1])
	}
	// The Host's own camera does not use a guest slot; two guests fill it.
	host.sendJSON(map[string]any{"type": "stage-decision", "peerId": peerIDs[2], "accept": true})
	expectEqual(t, viewers[2].next("stage-state").raw, `{"type":"stage-state","state":"declined"}`)

	// A guest links to a plain Viewer, who answers back.
	viewers[0].sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[2], "payload": stageCandidateSignal("stage_connection_0013")})
	viewers[2].next("stage-signal")
	viewers[2].sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[0], "payload": stageCandidateSignal("stage_connection_0013")})
	viewers[0].next("stage-signal")
	// A signal needs a target other than the sender.
	viewers[2].sendJSON(map[string]any{"type": "stage-signal", "payload": stageCandidateSignal("stage_connection_0013")})
	viewers[2].next("error")

	// Leaving and removal update everyone's roster.
	viewers[1].sendJSON(map[string]any{"type": "stage-leave"})
	host.next("stage-left")
	for _, client := range everyone {
		expectRoster(t, client, hostAuth.PeerID, peerIDs[0])
	}
	host.sendJSON(map[string]any{"type": "stage-remove", "peerId": peerIDs[0]})
	expectEqual(t, viewers[0].next("stage-state").raw, `{"type":"stage-state","state":"removed"}`)
	for _, client := range everyone {
		expectRoster(t, client, hostAuth.PeerID)
	}
	host.sendJSON(map[string]any{"type": "stage-publish", "enabled": false})
	for _, client := range everyone {
		expectRoster(t, client)
	}
	// With nobody on camera again, Viewers cannot link to each other.
	viewers[0].sendJSON(map[string]any{"type": "stage-signal", "targetPeerId": peerIDs[2], "payload": stageCandidateSignal("stage_connection_0013")})
	viewers[2].expectNone(80 * time.Millisecond)

	for _, viewer := range viewers {
		h.closeClient(viewer)
	}
	h.closeClient(host)
}
