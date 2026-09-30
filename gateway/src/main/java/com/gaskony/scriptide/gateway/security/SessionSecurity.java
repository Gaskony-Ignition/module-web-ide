package com.gaskony.scriptide.gateway.security;

import com.gaskony.scriptide.gateway.term.PolicySource;
import com.inductiveautomation.ignition.common.auth.web.WebAuthUser;
import com.inductiveautomation.ignition.gateway.dataroutes.AccessControlStrategy;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteAccess;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteMounterContext;
import com.inductiveautomation.ignition.gateway.web.session.WebUiSession;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;

/**
 * The module's single security primitive, used by BOTH the REST route strategies
 * and the WebSocket upgrade handshake.
 *
 * <p>There is deliberately only one of these. web-designer's own
 * {@code HandlerSupport.securityFor} Javadoc records what happens when a security
 * check gets duplicated: the two copies drift, and the copy that does not get the
 * fix is the one that silently keeps letting people through.</p>
 *
 * <h2>Why there is no actor fallback</h2>
 *
 * <p>web-designer's {@code AccessControl} grants any non-session caller that
 * presents a non-empty {@code RequestContext.getActor()}, and its own class
 * Javadoc flags this MUST-VALIDATE: <i>"confirm browser requests cannot spoof an
 * actor that would bypass the session check"</i>. That question was never
 * resolved.</p>
 *
 * <p>This module drops the fallback entirely, on both reads and writes. Two
 * reasons, and they are decisions rather than omissions:</p>
 * <ol>
 *   <li>What sits behind this gate is <b>arbitrary code execution in the Gateway
 *       JVM</b>. An unvalidated bypass has no business in front of that.</li>
 *   <li>There is no legitimate non-browser caller. Nothing but the SPA talks to
 *       this module — there is no RPC surface and no scripted client.</li>
 * </ol>
 *
 * <p>If a scripted caller is ever genuinely needed, add a Gateway API token check,
 * not an actor string.</p>
 */
public final class SessionSecurity {

    private static final Logger logger = LoggerFactory.getLogger(SessionSecurity.class);

    /**
     * The role name the fallback check matches, when the platform's own answer
     * is unavailable.
     *
     * <p>A DEFAULT, not a rule. The 05/09/2026 decision made
     * {@code WebUiSession.SESSION_WRITE} the primary gate and left this as the
     * union's other half — but the literal string stayed in the code, so a
     * gateway whose admin role is called anything else (an IdP that issues
     * {@code GatewayAdmin}, a site that renamed it) fell back to a check that
     * could only ever say no. It is now a policy key, resolved live, so an
     * estate can name its own role without a rebuild:</p>
     *
     * <pre>com.gaskony.scriptide.admin.role = GatewayAdmin</pre>
     *
     * <p>Widening the gate is a security decision, which is why it is a gateway
     * FILE and a system property rather than anything the module's own UI can
     * set. See {@code PolicySource}: file &gt; {@code -D} &gt; this default.</p>
     */
    public static final String ADMIN_ROLE_KEY = "com.gaskony.scriptide.admin.role";

    /** The role name assumed when nothing overrides it. */
    public static final String DEFAULT_ADMIN_ROLE = "Administrator";

    /** The role name in force right now. */
    public static String adminRole() {
        String configured = PolicySource.value(ADMIN_ROLE_KEY);
        return configured == null || configured.isBlank()
            ? DEFAULT_ADMIN_ROLE
            : configured.trim();
    }

    private SessionSecurity() { /* utility class */ }

    // ==================== Shared primitives ====================

    /**
     * Resolve the authenticated user behind a request, if there is one.
     *
     * <p>Never throws — a lookup failure is treated as "anonymous", which is the
     * restrictive answer.</p>
     */
    public static Optional<WebAuthUser> authenticatedUser(RequestContext requestContext) {
        try {
            Optional<? extends WebUiSession> sessionOpt = WebUiSession.find(requestContext);
            if (sessionOpt.isEmpty()) {
                return Optional.empty();
            }
            return sessionOpt.get().getUserContext().getWebAuthUser().map(u -> (WebAuthUser) u);
        } catch (Exception e) {
            logger.debug("Session lookup failed; treating caller as anonymous: {}", e.getMessage());
            return Optional.empty();
        }
    }

    /**
     * True when the given user holds the {@code Administrator} role.
     *
     * <p>The FALLBACK, not the rule — see {@link #canWriteGateway}. Used only
     * where the platform's own answer is unavailable because there is no
     * {@link RequestContext} to ask it about.</p>
     */
    public static boolean isAdministrator(WebAuthUser user) {
        String role = adminRole();
        return user.getRoles().stream().anyMatch(role::equalsIgnoreCase);
    }

    /**
     * Whether this request may WRITE to the gateway, as the platform judges it.
     *
     * <p>Nigel, 04/09/2026: <em>"If write access is available to the gateway then
     * its authentication is accepted."</em> That is the rule, and this is the
     * platform's own answer to it — {@code WebUiSession.SESSION_WRITE} is the
     * same strategy the Gateway's own config pages are mounted behind.</p>
     *
     * <p>It replaces matching a role literally named {@code Administrator}, which
     * was an assumption this module had no way to check: an estate that renames
     * its admin role, or grants write through a security level rather than a
     * role, was silently locked out of every write and every execution while the
     * Gateway itself let the same user reconfigure the whole system. Matching a
     * name also gets it wrong the other way — a role called "Administrator" in
     * an IdP that grants nothing would have passed.</p>
     *
     * <p><b>A UNION, not a replacement, and that is a measured decision.</b> On
     * 8.3.8, {@code SESSION_WRITE} DENIED the gateway's own {@code admin} —
     * the deploy gate went straight to {@code canExecute=false} and "Running
     * scripts requires the Administrator role" for a user who can reconfigure
     * the whole system. Whatever that strategy gates, it is not "may this
     * caller write configuration", so using it alone would have shipped a
     * module nobody could save from.</p>
     *
     * <p>So either answer grants: the platform saying this session may write,
     * OR the {@code Administrator} role. That is the widening Nigel asked for —
     * an estate that grants write some other way gets in, and every estate that
     * worked before still does — without betting the whole module on one SDK
     * constant whose meaning is not what its name suggests.</p>
     */
    public static boolean canWriteGateway(RequestContext requestContext) {
        Optional<WebAuthUser> userOpt = authenticatedUser(requestContext);
        if (userOpt.isEmpty()) {
            return false;
        }
        if (isAdministrator(userOpt.get())) {
            return true;
        }
        try {
            return WebUiSession.SESSION_WRITE.canAccess(requestContext) == RouteAccess.GRANTED;
        } catch (Exception e) {
            // Never lets an SDK change lock anyone out silently.
            logger.warn("SESSION_WRITE check failed; the {} role is the only route left: {}",
                adminRole(), e.toString());
            return false;
        }
    }

    /**
     * Same-origin check for a WebSocket upgrade.
     *
     * <p>WebSockets get no CORS preflight, so the {@code Origin} header is the
     * only thing standing between a logged-in user's browser and a hostile page
     * opening an authenticated socket to this module. An ABSENT Origin is allowed
     * (non-browser clients such as the deploy gate's own check do not send one);
     * a PRESENT Origin whose host differs from {@code Host} is rejected.</p>
     */
    public static boolean isSameOrigin(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin == null || origin.isBlank()) {
            return true;
        }
        String host = request.getHeader("Host");
        if (host == null || host.isBlank()) {
            return false;
        }
        try {
            java.net.URI originUri = java.net.URI.create(origin);
            String originAuthority = originUri.getPort() < 0
                ? originUri.getHost()
                : originUri.getHost() + ":" + originUri.getPort();
            if (originAuthority == null) {
                return false;
            }
            return originAuthority.equalsIgnoreCase(host);
        } catch (IllegalArgumentException e) {
            logger.debug("Rejecting WebSocket upgrade with unparseable Origin: {}", origin);
            return false;
        }
    }

    // ==================== Route strategies ====================

    /**
     * Grants any authenticated Gateway user, of any role. Anonymous callers get
     * {@link RouteAccess#UNAUTHORIZED} (HTTP 401). No actor fallback.
     */
    public static AccessControlStrategy requireAuthenticated() {
        return new AccessControlStrategy() {
            @Override
            public RouteAccess canAccess(RequestContext requestContext) {
                return authenticatedUser(requestContext).isPresent()
                    ? RouteAccess.GRANTED
                    : RouteAccess.UNAUTHORIZED;
            }

            @Override
            public Optional<String> getWwwAuthenticateHeader(RequestContext requestContext) {
                return Optional.of("Bearer realm=\"Ignition Gateway\"");
            }

            @Override
            public void validate(RouteMounterContext routeMounterContext) {
                // nothing to validate at mount time
            }
        };
    }

    /**
     * Grants a caller who may WRITE to the gateway.
     *
     * <p>An authenticated caller who may not gets {@link RouteAccess#FORBIDDEN}
     * (403); an anonymous one gets 401. No actor fallback — see the class
     * Javadoc.</p>
     *
     * <p>Until 1.14.0 this matched a role literally named {@code Administrator}.
     * It asks the platform now — see {@link #canWriteGateway} for why the name
     * was both too strict and too loose.</p>
     */
    public static AccessControlStrategy requireGatewayWrite() {
        return new AccessControlStrategy() {
            @Override
            public RouteAccess canAccess(RequestContext requestContext) {
                if (authenticatedUser(requestContext).isEmpty()) {
                    return RouteAccess.UNAUTHORIZED;
                }
                if (canWriteGateway(requestContext)) {
                    return RouteAccess.GRANTED;
                }
                logger.debug("Access denied: authenticated caller has no gateway write access");
                return RouteAccess.FORBIDDEN;
            }

            @Override
            public Optional<String> getWwwAuthenticateHeader(RequestContext requestContext) {
                return Optional.of("Bearer realm=\"Ignition Gateway\"");
            }

            @Override
            public void validate(RouteMounterContext routeMounterContext) {
                // nothing to validate at mount time
            }
        };
    }


    /**
     * Explicit "no auth" strategy, named for intent. Used only by the session
     * probe, which must answer for anonymous callers rather than 401, and by the
     * SPA shell, which must load so the Gateway login can be presented.
     */
    public static AccessControlStrategy publicAccess() {
        return new AccessControlStrategy() {
            @Override
            public RouteAccess canAccess(RequestContext requestContext) {
                return RouteAccess.GRANTED;
            }

            @Override
            public Optional<String> getWwwAuthenticateHeader(RequestContext requestContext) {
                return Optional.empty();
            }

            @Override
            public void validate(RouteMounterContext routeMounterContext) {
                // nothing to validate at mount time
            }
        };
    }
}
