package com.gaskony.scriptide.gateway.presence;

import java.util.List;

/**
 * Who else has this file open, and where from.
 *
 * <h2>Why a shared vocabulary</h2>
 *
 * <p>Two very different mechanisms answer the same question — this module's own
 * WebSocket clients, and Ignition's Designer concurrency events — and the person
 * reading the answer does not care which one it came from. They care that
 * somebody else is in the file. So both are normalised into {@link Peer} the
 * moment they arrive, and the difference survives only as {@link Peer#kind()},
 * which the UI shows as a label rather than treating as two features.</p>
 *
 * <h2>What a peer is NOT</h2>
 *
 * <p>It is not a lock. Nothing here refuses a save, and nothing here should ever
 * start to: this module's write path already has optimistic concurrency through
 * {@code If-Match}, which is the mechanism that actually prevents a lost update.
 * Presence exists so two people find out about each other BEFORE the conflict,
 * not so the second one is stopped after it.</p>
 *
 * <p>It is also not proof that somebody is typing. The Designer reports the
 * resources a session has OPEN, which is what its own concurrency banner means
 * too, and a tab left open over lunch counts. Saying "has it open" rather than
 * "is editing" is therefore the accurate wording and is used throughout.</p>
 */
public final class Presence {

    private Presence() { /* vocabulary only */ }

    /** Where a peer is working. */
    public enum Kind {
        /** Another browser connected to this module. */
        IDE,
        /** An Ignition Designer, reported by the platform's own concurrency events. */
        DESIGNER
    }

    /**
     * One other person, in one place, with one set of resources open.
     *
     * @param sessionId opaque and stable for the life of that session; the key
     *                  everything is deduplicated on. Never shown to anyone.
     * @param username  who they are. Blank when the platform did not say — shown
     *                  as "someone", because an empty name in a warning reads as
     *                  a bug in the warning.
     * @param host      the machine they are on, for the case this feature exists
     *                  to serve: the same person, logged in twice, in two places.
     * @param kind      IDE or Designer
     * @param project   the project the session is in
     * @param resources resource paths currently open, in the module/type/name
     *                  form this module uses everywhere else
     * @param since     when the session started, epoch millis, or 0 if unknown
     */
    public record Peer(String sessionId, String username, String host, Kind kind,
                       String project, List<String> resources, long since) {

        public Peer {
            resources = resources == null ? List.of() : List.copyOf(resources);
            username = username == null ? "" : username;
            host = host == null ? "" : host;
            project = project == null ? "" : project;
        }

        /** True when this peer has the given resource path open. */
        public boolean has(String path) {
            return path != null && resources.contains(path);
        }
    }
}
