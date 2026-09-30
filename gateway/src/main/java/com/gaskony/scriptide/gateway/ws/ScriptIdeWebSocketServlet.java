package com.gaskony.scriptide.gateway.ws;

import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.inductiveautomation.ignition.common.auth.web.WebAuthUser;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.web.session.WebUiSession;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.eclipse.jetty.ee10.websocket.server.JettyWebSocketServlet;
import org.eclipse.jetty.ee10.websocket.server.JettyWebSocketServletFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.Optional;

/**
 * Jetty-12 WebSocket servlet backing {@code /system/scriptide}.
 *
 * <p>Registered in the hook's {@code startup()} through
 * {@code WebResourceManager.addServlet(...)}, and removed in {@code shutdown()}.
 * It is not a {@code RouteGroup} route because {@code RouteGroup} has no
 * protocol-upgrade path. Mirrors Perspective's own
 * {@code PerspectiveWebSocketServlet}, and web-designer's working
 * {@code TagSubscriptionWebSocketServlet}.</p>
 *
 * <p>The container builds this with its no-arg constructor, so the Gateway
 * context comes from {@link ScriptIdeSocketRegistry}, not injection.</p>
 *
 * <p><b>The handshake is the security boundary.</b> Every upgrade is
 * authenticated against the Gateway session and checked same-origin, and the
 * resulting identity is baked into the socket. Nothing the client sends
 * afterwards can change who it is — which matters more here than in
 * web-designer, because from P2 this socket carries script execution.</p>
 */
public final class ScriptIdeWebSocketServlet extends JettyWebSocketServlet {

    private static final long serialVersionUID = 1L;

    private static final Logger logger = LoggerFactory.getLogger(ScriptIdeWebSocketServlet.class);

    /**
     * Max inbound text frame. Larger than web-designer's 256 KB because an LSP
     * {@code didChange} can carry a big paste, and a truncated frame would show up
     * as an inexplicably stale document rather than an error.
     */
    private static final int MAX_TEXT_MESSAGE_SIZE = 1024 * 1024;

    /**
     * Idle timeout. Deliberately long: an IDE sits open and untouched for long
     * stretches, unlike a tag subscription that is always streaming.
     */
    private static final Duration IDLE_TIMEOUT = Duration.ofMinutes(30);

    @Override
    protected void configure(JettyWebSocketServletFactory factory) {
        factory.setMaxTextMessageSize(MAX_TEXT_MESSAGE_SIZE);
        factory.setIdleTimeout(IDLE_TIMEOUT);
        factory.setCreator((upgradeRequest, upgradeResponse) -> {
            HttpServletRequest http = upgradeRequest.getHttpServletRequest();

            // WebSockets get no CORS preflight, so this is the CSRF defence for
            // the upgrade itself.
            if (!SessionSecurity.isSameOrigin(http)) {
                upgradeResponse.setStatusCode(HttpServletResponse.SC_FORBIDDEN);
                logger.debug("Rejected cross-origin Web IDE socket upgrade from '{}'",
                    http.getHeader("Origin"));
                return null;
            }

            RequestContext rc = new RequestContext(http, http.getRequestURI());
            Optional<? extends WebUiSession> session;
            try {
                session = WebUiSession.find(rc);
            } catch (Exception e) {
                logger.debug("Web IDE socket handshake: WebUiSession.find failed ({})", e.getMessage());
                session = Optional.empty();
            }
            if (session.isEmpty() || session.get().getUserContext().getWebAuthUser().isEmpty()) {
                upgradeResponse.setStatusCode(HttpServletResponse.SC_UNAUTHORIZED);
                logger.debug("Rejected anonymous Web IDE socket upgrade");
                return null;
            }

            WebAuthUser user = session.get().getUserContext().getWebAuthUser().get();
            // Identity and CSRF token are baked in at the handshake. Nothing the
            // client sends afterwards can change who this socket is — which matters
            // more here than in a read-only socket, because this one runs code.
            return new ScriptIdeSocket(
                user.getUserName(),
                // The execution channel is the highest-privilege surface here, so
                // it must not answer a DIFFERENT question from the write routes:
                // a caller who may write and could not execute would be able to
                // save a script and not run it. `rc` is already built above.
                SessionSecurity.canWriteGateway(rc),
                session.get().getCsrfToken(),
                http.getRemoteAddr());
        });
    }
}
