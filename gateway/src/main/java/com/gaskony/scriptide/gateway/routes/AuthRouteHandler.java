package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.auth.web.WebAuthUser;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.web.session.WebUiSession;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;

/**
 * {@code GET /api/auth/session} — the SPA's "who am I, and what may I do?" probe.
 *
 * <p>Mounted OPEN ({@link SessionSecurity#publicAccess()}): it must answer for
 * anonymous callers with {@code 200 {authenticated:false}} rather than 401, so
 * the SPA can tell "not signed in" apart from "backend broken" and render a
 * sign-in notice instead of an error.</p>
 *
 * <p>The {@code canExecute} flag is a <b>UI convenience only</b>. It decides
 * whether the Run button is drawn; it decides nothing on the server, which
 * independently re-checks the Administrator role on the execution channel. Never
 * let a client-side flag become the gate.</p>
 */
public final class AuthRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(AuthRouteHandler.class);

    /**
     * Returns the caller's identity and capabilities. Never throws and never
     * returns 401 — an unreadable session is reported as anonymous.
     */
    public Object session(RequestContext req, HttpServletResponse resp) {
        Optional<? extends WebUiSession> sessionOpt;
        try {
            sessionOpt = WebUiSession.find(req);
        } catch (Exception e) {
            logger.debug("WebUiSession.find failed; treating caller as anonymous: {}", e.getMessage());
            sessionOpt = Optional.empty();
        }

        if (sessionOpt.isEmpty() || sessionOpt.get().getUserContext().getWebAuthUser().isEmpty()) {
            JsonObject anon = new JsonObject();
            anon.addProperty("authenticated", false);
            anon.addProperty("writable", false);
            anon.addProperty("canExecute", false);
            return anon;
        }

        WebUiSession session = sessionOpt.get();
        WebAuthUser user = session.getUserContext().getWebAuthUser().get();
        // What the client uses to enable Save and Run. It must be the SAME
        // question the routes are gated on, or the UI offers a button whose
        // request is about to 403 — so it asks the platform, not the role name.
        boolean admin = SessionSecurity.canWriteGateway(req);
        // Read live, same as the execution routes themselves — a gateway that
        // just disabled execution via policy.properties must be reflected on
        // the very next session probe, not just the next login.
        boolean executionEnabled = ExecPolicy.executionEnabled();

        JsonArray roles = new JsonArray();
        user.getRoles().forEach(roles::add);

        JsonArray zones = new JsonArray();
        session.getUserContext().getSecurityZones().forEach(zones::add);

        JsonObject body = new JsonObject();
        body.addProperty("authenticated", true);
        body.addProperty("username", user.getUserName());
        body.addProperty("userId", user.getId());
        body.add("roles", roles);
        body.add("securityZones", zones);
        body.addProperty("writable", admin);
        // Editing a script resource and running one are both Administrator-gated,
        // but execution can ALSO be switched off fleet-wide independent of role
        // (ExecPolicy) — canExecute folds both into the one flag the Run button
        // already used, and executionEnabled is reported separately so the UI
        // can tell a denied role apart from a disabled policy and say which.
        body.addProperty("canExecute", admin && executionEnabled);
        body.addProperty("executionEnabled", executionEnabled);
        // The SPA echoes this on every mutating request (X-CSRF-Token) and in the
        // first frame on the socket's exec channel.
        body.addProperty("csrfToken", session.getCsrfToken());
        return body;
    }
}
