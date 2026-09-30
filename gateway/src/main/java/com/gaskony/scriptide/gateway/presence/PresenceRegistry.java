package com.gaskony.scriptide.gateway.presence;

import com.gaskony.scriptide.gateway.presence.Presence.Kind;
import com.gaskony.scriptide.gateway.presence.Presence.Peer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Everyone who has a script open right now, from anywhere.
 *
 * <h2>One map, two feeds</h2>
 *
 * <p>Browser clients report themselves over their own socket. Designer sessions
 * arrive from {@link DesignerPresenceListener}, which reads Ignition's own
 * concurrency events. Both land here as {@link Peer}s keyed on session id, so
 * "who has this file open" is one lookup rather than two half-answers the caller
 * has to merge.</p>
 *
 * <h2>Change is pushed, never polled</h2>
 *
 * <p>The whole point of the feature is that it is live: a name that appears
 * thirty seconds after somebody opened the file is a name you have already
 * clashed with. So every mutation bumps a version and notifies listeners, and
 * the sockets broadcast from there. The version exists so a client can tell a
 * genuine change from a redelivery — a Designer sends its full resource list on
 * every change, so identical updates are common and re-rendering the tree on
 * each one would be visible.</p>
 *
 * <h2>Stale entries are a certainty, not an edge case</h2>
 *
 * <p>A Designer that is killed rather than closed sends no destroy event, and
 * its session lingers in the platform until the session times out. So a peer is
 * also dropped when the platform stops listing its session — see
 * {@link #retainSessions}. Showing a name that left an hour ago trains people to
 * ignore the indicator, which is worse than showing nothing.</p>
 */
public final class PresenceRegistry {

    private static final Logger logger = LoggerFactory.getLogger(PresenceRegistry.class);

    /** Told when anything changes; the sockets use this to broadcast. */
    @FunctionalInterface
    public interface Listener {
        void presenceChanged(long version);
    }

    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    private final Set<Listener> listeners = ConcurrentHashMap.newKeySet();
    private final AtomicLong version = new AtomicLong();

    /** Every peer currently known, in no particular order. */
    public List<Peer> peers() {
        return List.copyOf(peers.values());
    }

    /** The current version, which changes whenever {@link #peers()} would. */
    public long version() {
        return version.get();
    }

    /**
     * Everyone EXCEPT the caller who has the given resource open.
     *
     * <p>Excluding yourself is not a nicety: your own tab is the one thing you
     * already know about, and an indicator that lights up for it would be on
     * permanently and mean nothing.</p>
     */
    public List<Peer> othersOn(String project, String path, String selfSessionId) {
        List<Peer> out = new ArrayList<>();
        for (Peer peer : peers.values()) {
            if (peer.sessionId().equals(selfSessionId)) {
                continue;
            }
            if (!project.equals(peer.project())) {
                continue;
            }
            if (peer.has(path)) {
                out.add(peer);
            }
        }
        return List.copyOf(out);
    }

    /** Record or replace one peer. */
    public void put(Peer peer) {
        if (peer == null || peer.sessionId() == null || peer.sessionId().isBlank()) {
            return;
        }
        Peer previous = peers.put(peer.sessionId(), peer);
        // An identical redelivery is not a change. A Designer re-sends its whole
        // resource list on every keystroke-free open and close, and bumping the
        // version for each would re-render every client's tree for nothing.
        if (!peer.equals(previous)) {
            changed();
        }
    }

    /**
     * Record a peer that is only known at SESSION level — in a project, with no
     * resources reported.
     *
     * <p>Never overwrites a peer that has resources. The two feeds race by
     * construction: the periodic sweep sees a Designer session as soon as it
     * connects, and its resource list arrives from the event bus a moment later,
     * so a plain {@code put} here would blank the useful half of the answer every
     * sweep and the file-level indicator would flicker.</p>
     */
    public void putSessionLevel(Peer peer) {
        if (peer == null || peer.sessionId() == null || peer.sessionId().isBlank()) {
            return;
        }
        Peer existing = peers.get(peer.sessionId());
        if (existing != null && !existing.resources().isEmpty()) {
            return;
        }
        put(peer);
    }

    /** Forget one peer — a socket closed, or a Designer session ended. */
    public void remove(String sessionId) {
        if (sessionId != null && peers.remove(sessionId) != null) {
            changed();
        }
    }

    /**
     * Drop every Designer peer whose session the platform no longer lists.
     *
     * <p>IDE peers are deliberately untouched: their liveness is their own
     * WebSocket, which the container closes for us, and a browser client has no
     * {@code ClientReqSession} to appear in the list being passed in.</p>
     */
    public void retainSessions(Set<String> liveSessionIds) {
        if (liveSessionIds == null) {
            return;
        }
        boolean removed = peers.entrySet().removeIf(entry ->
            entry.getValue().kind() == Kind.DESIGNER
                && !liveSessionIds.contains(entry.getKey()));
        if (removed) {
            changed();
        }
    }

    public void addListener(Listener listener) {
        if (listener != null) {
            listeners.add(listener);
        }
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    private void changed() {
        long now = version.incrementAndGet();
        for (Listener listener : listeners) {
            try {
                listener.presenceChanged(now);
            } catch (RuntimeException e) {
                // One client's broadcast failing must not stop the others being
                // told: a half-notified set is how two people end up with
                // different ideas of who is in a file.
                logger.debug("Presence listener failed: {}", e.toString());
            }
        }
    }

    /** Drop everything — module shutdown. */
    public void clear() {
        peers.clear();
        listeners.clear();
    }
}
