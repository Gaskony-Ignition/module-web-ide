package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ModuleConstants;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Locale;
import java.util.Map;

/**
 * Catch-all static-asset handler for the Web IDE SPA.
 *
 * <p>Unlike every other module in the suite — which each serve exactly one
 * hand-named UMD bundle (see {@code PageHandler} in
 * ignition-module-camera-driver) — the Web IDE ships a genuine
 * multi-file Vite bundle (JS chunks, CSS, fonts, source maps) with
 * client-side routing. This handler maps the request path to a classpath
 * resource under {@code /mounted/} (the same folder
 * {@link com.gaskony.scriptide.gateway.ScriptIdeModuleHook#getMountedResourceFolder()}
 * declares), sets the content type from the file extension, and falls back to
 * {@code index.html} for any path that doesn't match a real built asset so
 * client-side routes resolve correctly.</p>
 *
 * <p><b>Path-traversal hardening.</b> The raw request path is untrusted input.
 * Before it is ever concatenated onto {@link #RESOURCE_ROOT} it is: rejected
 * outright if it contains a backslash or a null byte; percent-decoded exactly
 * once (rejecting malformed escapes and any leftover {@code %} afterwards,
 * which indicates double-encoding — a classic traversal bypass); rejected if
 * any {@code /}-delimited segment is {@code .} or {@code ..}; and had
 * duplicate slashes collapsed. As a final defence-in-depth check, the
 * resolved classpath resource path is canonicalised (its {@code .}/{@code ..}
 * segments resolved) and confirmed to still fall strictly under
 * {@link #RESOURCE_ROOT} before any classpath lookup happens. Any path that
 * fails these checks is rejected with {@code 400 Bad Request} — it is never
 * silently handed to the {@code index.html} fallback, which is reserved for
 * legitimate, clean, unknown client-side routes.</p>
 *
 * <p><b>Mount order is load-bearing.</b> The {@code "/*"} splat this handler is
 * mounted with matches every path, and {@code RouteGroupImpl.findMatchingRoute}
 * takes the FIRST match in insertion order — so this route must be registered
 * after every {@code /api/...} route or it shadows all of them. Proven in
 * production by ignition-module-web-designer 0.106.0, from which this class is
 * a near-verbatim copy; {@code RouteMountOrderTest} asserts the ordering here.</p>
 */
public class SpaAssetRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(SpaAssetRouteHandler.class);

    private static final String RESOURCE_ROOT = "/" + ModuleConstants.MOUNTED_RESOURCE_FOLDER;
    private static final String INDEX_RESOURCE = RESOURCE_ROOT + "/index.html";

    private static final Map<String, String> CONTENT_TYPES = Map.ofEntries(
        Map.entry("html", "text/html; charset=UTF-8"),
        Map.entry("js", "application/javascript; charset=UTF-8"),
        Map.entry("mjs", "application/javascript; charset=UTF-8"),
        Map.entry("css", "text/css; charset=UTF-8"),
        Map.entry("svg", "image/svg+xml"),
        Map.entry("woff2", "font/woff2"),
        Map.entry("woff", "font/woff"),
        Map.entry("ttf", "font/ttf"),
        Map.entry("eot", "application/vnd.ms-fontobject"),
        Map.entry("ico", "image/x-icon"),
        Map.entry("png", "image/png"),
        Map.entry("jpg", "image/jpeg"),
        Map.entry("jpeg", "image/jpeg"),
        Map.entry("gif", "image/gif"),
        Map.entry("webp", "image/webp"),
        Map.entry("json", "application/json; charset=UTF-8"),
        Map.entry("map", "application/json; charset=UTF-8"),
        Map.entry("txt", "text/plain; charset=UTF-8"),
        Map.entry("wasm", "application/wasm")
    );

    /**
     * Serves a single SPA asset, or falls back to {@code index.html} for
     * client-side routes. Always returns {@code null} — the response body is
     * written directly, matching the rest of the suite's route handler
     * convention (see {@code CameraRoutes} / {@code PageHandler}).
     */
    public Object handle(RequestContext requestContext, HttpServletResponse response) throws IOException {
        String rawPath = requestContext.getPath();
        String sanitisedPath = sanitise(rawPath);
        if (sanitisedPath == null) {
            logger.warn("Rejected suspicious Web IDE SPA asset request path: {}", rawPath);
            response.sendError(HttpServletResponse.SC_BAD_REQUEST, "Invalid asset path");
            return null;
        }

        String requestPath = normalise(sanitisedPath);

        // Defence in depth against route shadowing: this catch-all is registered
        // LAST (after every /api/... route) so the router only reaches it for
        // paths no API route matched. An unmatched /api/... path is a missing
        // endpoint, not a client-side SPA route — return 404 rather than leak the
        // index.html shell (which would break API clients expecting JSON).
        if (requestPath.equals("/api") || requestPath.startsWith("/api/")) {
            logger.debug("No API route matched {}; returning 404 instead of SPA shell", rawPath);
            response.sendError(HttpServletResponse.SC_NOT_FOUND, "Unknown API endpoint");
            return null;
        }

        String resourcePath = RESOURCE_ROOT + requestPath;

        // Defence in depth: even though sanitise() already rejects "." / ".."
        // segments, confirm the fully-resolved resource path still falls
        // strictly under RESOURCE_ROOT before it ever reaches a classpath
        // lookup.
        if (!isWithinResourceRoot(resourcePath)) {
            logger.warn("Rejected Web IDE SPA asset request resolving outside {}: {}", RESOURCE_ROOT, rawPath);
            response.sendError(HttpServletResponse.SC_BAD_REQUEST, "Invalid asset path");
            return null;
        }

        byte[] body = readResource(resourcePath);
        String servedPath = resourcePath;
        boolean servingIndexFallback = false;
        if (body == null) {
            // No built asset at this path — treat as a client-side route and
            // fall back to index.html so the SPA's own router can take over.
            body = readResource(INDEX_RESOURCE);
            servedPath = INDEX_RESOURCE;
            servingIndexFallback = true;
        }

        if (body == null) {
            logger.warn("Web IDE SPA index.html not found on classpath at {}", INDEX_RESOURCE);
            response.sendError(HttpServletResponse.SC_NOT_FOUND, "Web IDE assets not found");
            return null;
        }

        response.setContentType(contentTypeFor(servedPath));
        response.setContentLength(body.length);
        applyCacheControl(response, requestPath, servingIndexFallback);
        response.getOutputStream().write(body);
        return null;
    }

    /**
     * Decodes and validates a raw request path, returning the safe decoded
     * path, or {@code null} if the path is a path-traversal attempt (or
     * otherwise malformed) and must be rejected outright with 400 rather than
     * silently falling back to {@code index.html}.
     */
    private static String sanitise(String rawPath) {
        if (rawPath == null) {
            return "";
        }
        if (rawPath.indexOf('\\') >= 0 || rawPath.indexOf('\0') >= 0) {
            return null;
        }

        String decoded;
        try {
            // Percent-decode exactly once. '+' is protected first because
            // this is a URL path, not a query string / form-encoded value,
            // and URLDecoder would otherwise turn a literal '+' into a space.
            decoded = URLDecoder.decode(rawPath.replace("+", "%2B"), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            // Malformed percent-encoding (e.g. a lone "%").
            return null;
        }

        if (decoded.indexOf('\\') >= 0 || decoded.indexOf('\0') >= 0) {
            return null;
        }
        // Any '%' surviving a single decode pass means the path was
        // double-encoded (e.g. "%252e%252e" -> "%2e%2e") — a classic
        // traversal bypass technique — so reject it rather than decode again.
        if (decoded.indexOf('%') >= 0) {
            return null;
        }

        String collapsed = decoded.replaceAll("/{2,}", "/");
        for (String segment : collapsed.split("/", -1)) {
            if (segment.equals("..") || segment.equals(".")) {
                return null;
            }
        }
        return collapsed;
    }

    private static String normalise(String requestPath) {
        if (requestPath == null || requestPath.isBlank() || "/".equals(requestPath)) {
            return "/index.html";
        }
        return requestPath;
    }

    /**
     * Resolves {@code .}/{@code ..} segments in a {@code /}-delimited
     * absolute path and confirms the canonical result still falls strictly
     * under {@link #RESOURCE_ROOT}. Implemented manually (not via
     * {@code java.nio.file.Path}) because classpath resource lookups always
     * use {@code /}, independent of the host OS's path separator.
     */
    private static boolean isWithinResourceRoot(String resourcePath) {
        String canonical = canonicalise(resourcePath);
        return canonical.equals(RESOURCE_ROOT) || canonical.startsWith(RESOURCE_ROOT + "/");
    }

    private static String canonicalise(String path) {
        Deque<String> segments = new ArrayDeque<>();
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".")) {
                continue;
            }
            if (segment.equals("..")) {
                segments.pollLast();
                continue;
            }
            segments.addLast(segment);
        }
        if (segments.isEmpty()) {
            return "/";
        }
        StringBuilder builder = new StringBuilder();
        for (String segment : segments) {
            builder.append('/').append(segment);
        }
        return builder.toString();
    }

    private static byte[] readResource(String resourcePath) throws IOException {
        try (InputStream stream = SpaAssetRouteHandler.class.getResourceAsStream(resourcePath)) {
            if (stream == null) {
                return null;
            }
            return stream.readAllBytes();
        }
    }

    private static String contentTypeFor(String path) {
        int dot = path.lastIndexOf('.');
        if (dot < 0 || dot == path.length() - 1) {
            return "application/octet-stream";
        }
        String extension = path.substring(dot + 1).toLowerCase(Locale.ROOT);
        return CONTENT_TYPES.getOrDefault(extension, "application/octet-stream");
    }

    /**
     * Sets a long-lived immutable cache header on hashed {@code /assets/*}
     * bundle files (safe because Vite fingerprints every filename with a
     * content hash) and a {@code no-cache} header on {@code index.html} (so
     * browsers always revalidate the SPA shell that references those hashed
     * assets). Every other response is left with no explicit cache header.
     */
    private static void applyCacheControl(HttpServletResponse response, String requestPath, boolean servingIndexFallback) {
        if (servingIndexFallback || "/index.html".equals(requestPath)) {
            response.setHeader("Cache-Control", "no-cache");
        } else if (requestPath.startsWith("/assets/")) {
            response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
    }
}
