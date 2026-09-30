package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ModuleConstants;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceType;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.web.session.WebUiSession;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Optional;

/**
 * Shared helpers for the JSON route handlers.
 *
 * <p>Everything here is shared rather than duplicated ON PURPOSE. CSRF and the
 * signature precedence are security primitives: two copies drift, and the copy
 * that does not get the fix is the one that silently keeps letting people
 * through.</p>
 */
final class HandlerSupport {

    private static final Logger logger = LoggerFactory.getLogger(HandlerSupport.class);

    /** Shared, thread-safe Gson instance. */
    static final Gson GSON = new Gson();

    /**
     * For writing a JSON DATA FILE back to a resource.
     *
     * Pretty-printed because the platform writes these files that way. A compact
     * rewrite of a Web Dev config.json is semantically identical and shows every
     * endpoint as fully rewritten in the next diff, which is exactly the
     * diff-noise the byte-fidelity rule exists to prevent for script bodies.
     */
    static final Gson PRETTY_GSON = new com.google.gson.GsonBuilder()
        .setPrettyPrinting()
        .disableHtmlEscaping()
        .create();

    /** HTTP 428 Precondition Required — not a constant in the servlet API. */
    static final int SC_PRECONDITION_REQUIRED = 428;

    /**
     * How long to wait for a resource push. The platform does the write; 30 s is
     * generous for a script body and still bounded, so a wedged push surfaces as a
     * 502 rather than hanging the request thread indefinitely.
     */
    static final long PUSH_TIMEOUT_SECONDS = 30;

    private HandlerSupport() { /* utility class */ }

    /** Set the status and return a uniform {@code {"error": "..."}} body. */
    static JsonObject error(HttpServletResponse response, int status, String message) {
        response.setStatus(status);
        JsonObject body = new JsonObject();
        body.addProperty("error", message);
        return body;
    }

    /**
     * Enforce CSRF for browser callers. Returns a non-null error body to reject,
     * or {@code null} to allow.
     *
     * <p>Only enforced when a {@link WebUiSession} is present: a caller without one
     * is not a browser and therefore not CSRF-exposed, and the route's
     * Administrator strategy has already vetted it. Within that branch it is
     * deny-by-default — a missing token rejects.</p>
     */
    static Object enforceCsrf(RequestContext req, HttpServletResponse resp) {
        Optional<? extends WebUiSession> sessionOpt;
        try {
            sessionOpt = WebUiSession.find(req);
        } catch (Exception e) {
            logger.debug("CSRF check: session lookup failed, treating as non-browser ({})",
                e.getMessage());
            return null;
        }
        if (sessionOpt.isEmpty()) {
            return null;
        }
        String expected = sessionOpt.get().getCsrfToken();
        String presented = req.getRequest().getHeader(WebUiSession.CSRF_TOKEN_HEADER);
        if (expected == null || presented == null || !expected.equals(presented)) {
            logger.debug("CSRF token missing or mismatched on a mutating request");
            return error(resp, HttpServletResponse.SC_FORBIDDEN, "CSRF token missing or invalid");
        }
        return null;
    }

    /**
     * The client's expected resource signature: the {@code If-Match} header wins,
     * else the request body's {@code baseSignature}.
     *
     * <p>The header is unquoted on the way in — see {@link #unquoteEtag}. The body
     * value is not: JSON has no entity-tag syntax, so a quote there is part of the
     * signature rather than framing around it.</p>
     */
    static String expectedSignature(RequestContext req, String bodySignature) {
        String ifMatch = req.getRequest().getHeader("If-Match");
        if (ifMatch != null && !ifMatch.isBlank()) {
            return unquoteEtag(ifMatch);
        }
        return bodySignature;
    }

    /**
     * An entity tag reduced to the signature inside it.
     *
     * <p>RFC 9110 §8.8.3 says an {@code ETag} is a quoted string, optionally with a
     * {@code W/} weak prefix, and this module emitted the bare signature until
     * 1.6.0. Both forms now reach the comparison as the same string, which is what
     * makes the change safe to deploy under a client that has not been reloaded: an
     * old page holds a bare signature and sends it bare, a new one holds a quoted
     * value its own reader has already stripped, and a proxy is free to add the
     * quoting to either. Comparing raw strings would turn any of those into a
     * permanent 409 that looks exactly like somebody else editing the file.</p>
     */
    static String unquoteEtag(String raw) {
        if (raw == null) {
            return null;
        }
        String value = raw.trim();
        if (value.startsWith("W/")) {
            value = value.substring(2).trim();
        }
        if (value.length() >= 2 && value.charAt(0) == '"' && value.charAt(value.length() - 1) == '"') {
            value = value.substring(1, value.length() - 1);
        }
        return value;
    }

    /** A resource signature as the {@code ETag} header value — quoted, per RFC 9110. */
    static String quoteEtag(String signature) {
        return "\"" + signature + "\"";
    }

    /**
     * The opaque actor for a {@code PushOperation} — used for audit and for
     * change-echo suppression. Prefers the authenticated username.
     */
    static String actorFor(RequestContext req) {
        String prefix = ModuleConstants.MOUNT_PATH_ALIAS + ":";
        try {
            Optional<? extends WebUiSession> sessionOpt = WebUiSession.find(req);
            if (sessionOpt.isPresent()) {
                String username = sessionOpt.get().getUserContext().getWebAuthUser()
                    .map(u -> u.getUserName()).orElse(null);
                if (username != null && !username.isBlank()) {
                    return prefix + username;
                }
            }
        } catch (Exception e) {
            logger.debug("actorFor: could not resolve session ({})", e.getMessage());
        }
        String actor = req.getActor();
        return (actor != null && !actor.isBlank())
            ? prefix + actor
            : ModuleConstants.MOUNT_PATH_ALIAS;
    }

    /** Encode a {@link ResourcePath} as {@code <moduleId>/<typeId>/<folder/name>}. */
    static String encodePath(ResourcePath rp) {
        ResourceType rt = rp.getResourceType();
        String tail = rp.getPath().toString();
        return rt.moduleId() + "/" + rt.typeId() + (tail.isEmpty() ? "" : "/" + tail);
    }

    /**
     * Decode {@code <moduleId>/<typeId>[/<name>]} into a {@link ResourcePath}.
     *
     * <p>A two-segment value addresses the type's SINGLETON resource (empty name)
     * — which is exactly how startup, shutdown and update are stored on disk, so
     * this branch is load-bearing rather than defensive.</p>
     *
     * @throws IllegalArgumentException when blank, malformed, or containing a
     *         path-traversal segment.
     */
    static ResourcePath decodePath(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("Missing resource path");
        }
        List<String> parts = List.of(raw.split("/", 3));
        if (parts.size() < 2 || parts.get(0).isBlank() || parts.get(1).isBlank()) {
            throw new IllegalArgumentException(
                "Malformed resource path (expected <moduleId>/<typeId>[/<name>]): " + raw);
        }
        if (parts.size() == 2 || parts.get(2).isBlank()) {
            return new ResourcePath(new ResourceType(parts.get(0), parts.get(1)), "");
        }
        String name = parts.get(2);
        for (String segment : name.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..")) {
                throw new IllegalArgumentException(
                    "Illegal path-traversal segment in resource path: " + raw);
            }
        }
        return new ResourcePath(new ResourceType(parts.get(0), parts.get(1)), name);
    }
}
