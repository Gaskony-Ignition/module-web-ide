package com.gaskony.scriptide.gateway.presence;

import com.gaskony.scriptide.gateway.presence.Presence.Kind;
import com.gaskony.scriptide.gateway.presence.Presence.Peer;
import com.inductiveautomation.ignition.gateway.clientcomm.ClientReqSession;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The supported half of Designer presence, and the thing that clears the dead.
 *
 * <h2>Two jobs, one pass over the session list</h2>
 *
 * <p><b>It removes what has gone.</b> A Designer that is killed rather than
 * closed — the process ends, the laptop sleeps, the VPN drops — sends no destroy
 * event, so its peer would otherwise sit in the registry claiming to hold a file
 * until somebody restarted the gateway. The platform's own session list is the
 * authority on who is still connected, so anything it no longer lists is
 * dropped.</p>
 *
 * <p><b>It reports what the event feed cannot.</b> A Designer that is open on a
 * project but has not opened a script yet has no resources to report, and is
 * invisible to the concurrency events. It is still worth knowing about: someone
 * is in this project, and is one double-click from the file you are in. Those
 * arrive as peers with an empty resource list, and never overwrite the richer
 * record — see {@link PresenceRegistry#putSessionLevel}.</p>
 *
 * <p>This is also the graceful floor under {@link DesignerPresenceListener}: it
 * uses only {@code GatewaySessionManager}, which is public SDK, so if the
 * internal event type ever changes shape the indicator becomes less specific
 * rather than disappearing.</p>
 *
 * <h2>Why a poll here, when everything else is pushed</h2>
 *
 * <p>There is no event for "this session went away without saying so" — that is
 * what makes it the hard case. Fifteen seconds is chosen against what the
 * indicator is for: it is the staleness of a name that has ALREADY left, not the
 * latency of one arriving, which stays instant on the event feed.</p>
 */
public final class PresenceSweep implements Runnable {

    private static final Logger logger = LoggerFactory.getLogger(PresenceSweep.class);

    /** How often the session list is re-read. See the class note. */
    public static final int PERIOD_SECONDS = 15;

    private final GatewayContext context;
    private final PresenceRegistry registry;

    public PresenceSweep(GatewayContext context, PresenceRegistry registry) {
        this.context = context;
        this.registry = registry;
    }

    @Override
    public void run() {
        try {
            sweep();
        } catch (RuntimeException e) {
            // A scheduled task that throws is cancelled by most executors, and a
            // presence list that silently stopped updating is worse than one that
            // missed a pass.
            logger.debug("Presence sweep failed: {}", e.toString());
        }
    }

    private void sweep() {
        var sessionManager = context.getGatewaySessionManager();
        if (sessionManager == null) {
            return;
        }
        // findSessions() is declared non-null by the SDK, so it is not checked.
        List<ClientReqSession> sessions = sessionManager.findSessions();
        Set<String> live = new HashSet<>();
        for (ClientReqSession session : sessions) {
            if (session == null || !session.isDesigner()) {
                continue;
            }
            String id = session.getPublicId();
            if (id == null || id.isBlank()) {
                continue;
            }
            live.add(id);
            registry.putSessionLevel(new Peer(
                id,
                attribute(session, ClientReqSession.SESSION_USERNAME),
                hostOf(session),
                Kind.DESIGNER,
                attribute(session, ClientReqSession.SESSION_PROJECT_NAME),
                List.of(),
                creationTime(session)));
        }
        registry.retainSessions(live);
    }

    /** A session attribute as a string, or blank — never null, never a throw. */
    private static String attribute(ClientReqSession session, String key) {
        try {
            Object value = session.getAttribute(key);
            return value instanceof String text ? text : "";
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** Hostname where the platform knows it, else the address. */
    private static String hostOf(ClientReqSession session) {
        String host = attribute(session, ClientReqSession.SESSION_REMOTE_HOST);
        return host.isBlank() ? attribute(session, ClientReqSession.SESSION_REMOTE_ADDR) : host;
    }

    /**
     * When the session started.
     *
     * <p>Guarded because {@code ClientReqSession} is an {@code HttpSession}, and
     * the servlet contract allows that call to throw on an invalidated one — which
     * is precisely the state a session being swept is most likely to be in.</p>
     */
    private static long creationTime(ClientReqSession session) {
        try {
            return session.getCreationTime();
        } catch (RuntimeException e) {
            return 0;
        }
    }
}
