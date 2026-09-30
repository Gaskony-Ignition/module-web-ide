package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ScriptResourceTypes;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Optional;

/**
 * What a Web Dev resource actually IS, as opposed to what this module assumed.
 *
 * <h2>The assumption that was wrong</h2>
 *
 * <p>Until 1.9.0 this module treated every Web Dev resource as a set of Python
 * handlers: it intersected the resource's data keys against {@code doGet.py} …
 * {@code doPatch.py} and rendered a row per verb. Measured on the rig
 * (04/09/2026) that is only one of the two shapes the platform writes, and for
 * the other it produced eight empty slots and no way to reach the file at all:</p>
 *
 * <pre>
 * Machine_HMI_Demo/com.inductiveautomation.webdev/resources/
 *   admin/    config.json {"resource-type":"python-resource", ...}  + 8 do*.py
 *   lib/      config.json {"resource-type":"python-resource", ...}  + doGet.py + three.min.js
 *   cell3d/   config.json {"resource-type":"text-resource",
 *                          "content-type":"text/html",
 *                          "text":"&lt;!doctype html&gt;…"}          files: [config.json] ONLY
 * </pre>
 *
 * <p>So there are three things the verb-only model could not express, and all
 * three are on one gateway today:</p>
 *
 * <ol>
 *   <li><b>A text resource has no handlers at all.</b> Its whole body is a
 *       string INSIDE {@code config.json}, under {@code text}, with its MIME
 *       type beside it. {@code cell3d} is 65 KB of HTML held that way.</li>
 *   <li><b>A python resource can carry static files.</b> {@code lib} ships
 *       {@code three.min.js} as an ordinary data key. It was readable through
 *       the content route the whole time and invisible in the tree.</li>
 *   <li><b>The one affordance offered on a text resource was harmful.</b> Every
 *       unimplemented verb rendered an "add {@code doGet}" button, and on
 *       {@code cell3d} pressing it would have put a Python file onto a resource
 *       the platform serves as static HTML.</li>
 * </ol>
 *
 * <h2>The synthetic data key</h2>
 *
 * <p>A text resource's body is not a data key — it is a JSON string field. The
 * rest of this module addresses everything by {@code (path, dataKey)}: the tab
 * identity, the read route, the write route, the LSP document uri. Rather than
 * thread a second addressing mode through all of that, a text resource
 * advertises the key {@link #TEXT_DATA_KEY}, and the read and write routes
 * translate it into a get/put of {@code config.json}'s {@code text} field.</p>
 *
 * <p>{@code config.json#text} cannot collide with a real key: the platform
 * writes data keys as plain filenames, and {@link
 * ScriptResourceRouteHandler#isSafeDataKey} rejects anything with a {@code #} in
 * it, so the synthetic key can never be created by an ordinary write.</p>
 */
// Public, and only these three members are: `ProjectIndex` has to read a Web Dev
// body to search it, and the alternative was duplicating the two-shape model
// (handlers as data keys, a text page inside config.json) in a second package.
// That model has already been got wrong once — see the 1.9.0 note in STATE.md —
// and one copy of it is the whole point.
public final class WebDevResources {

    private static final Logger logger = LoggerFactory.getLogger(WebDevResources.class);

    private WebDevResources() { /* statics only */ }

    /** {@code config.json}'s discriminant, and its two measured values. */
    static final String RESOURCE_TYPE = "resource-type";
    static final String PYTHON_RESOURCE = "python-resource";
    static final String TEXT_RESOURCE = "text-resource";
    /** Where a text resource keeps its MIME type and its body. */
    static final String CONTENT_TYPE = "content-type";
    static final String TEXT = "text";

    /** The key a text resource's body is addressed by. See the class Javadoc. */
    public static final String TEXT_DATA_KEY = "config.json#text";

    /** What the platform serves when a text resource declares nothing. */
    static final String DEFAULT_CONTENT_TYPE = "text/plain";

    /**
     * Upper bound on a file this IDE will call editable, in bytes.
     *
     * <p>Not a limit on what may be READ — the content route serves any key at
     * any size. It is a limit on what the tree invites you to open: a vendored
     * bundle like {@code three.min.js} (670 KB, and minified onto a handful of
     * enormous lines) is a genuinely bad thing to hand a code editor, and the
     * row is more useful saying so than pretending it will open well.</p>
     */
    static final int EDITABLE_MAX_BYTES = 512 * 1024;

    /**
     * Extensions this IDE will open as text.
     *
     * <p>An allowlist rather than a "not obviously binary" guess: opening a PNG
     * in a text editor produces a screenful of replacement characters and a save
     * that would destroy the file, because the round trip is bytes → UTF-8
     * string → bytes and that is lossy for anything that is not text.</p>
     */
    private static final java.util.Set<String> TEXT_EXTENSIONS = java.util.Set.of(
        "js", "mjs", "cjs", "ts", "jsx", "tsx", "css", "scss", "less",
        "html", "htm", "xml", "svg", "json", "txt", "md", "csv", "map", "yaml", "yml");

    /** True when this data key is neither the config file nor a verb handler. */
    static boolean isAsset(String key) {
        if (ScriptResourceTypes.WEBDEV_CONFIG_KEY.equals(key)) {
            return false;
        }
        return ScriptResourceTypes.WEBDEV_METHODS.stream()
            .noneMatch(m -> ScriptResourceTypes.webDevKeyFor(m).equals(key));
    }

    /** Whether the tree should offer to open this file in the editor. */
    static boolean isEditableAsset(String key, int length) {
        return length <= EDITABLE_MAX_BYTES && hasEditableExtension(key);
    }

    /** The extension half of {@link #isEditableAsset}, with no size opinion. */
    static boolean hasEditableExtension(String key) {
        if (key == null) {
            return false;
        }
        int dot = key.lastIndexOf('.');
        if (dot < 0 || dot == key.length() - 1) {
            return false;
        }
        return TEXT_EXTENSIONS.contains(key.substring(dot + 1).toLowerCase(Locale.ROOT));
    }

    /**
     * The endpoint's {@code config.json}, or an empty object.
     *
     * <p>A resource with no config file, or with one that does not parse, yields
     * {@code {}} rather than an error: the handler SCRIPTS are still editable,
     * and refusing to open an endpoint because its config file is malformed
     * would lock a user out of the very file they need to fix.</p>
     */
    public static JsonObject parseConfig(Resource resource) {
        try {
            return resource.getData(ScriptResourceTypes.WEBDEV_CONFIG_KEY)
                .map(data -> new String(data.getBytes(), StandardCharsets.UTF_8))
                .map(text -> {
                    try {
                        JsonElement parsed = JsonParser.parseString(text);
                        return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
                    } catch (RuntimeException e) {
                        logger.debug("Unparseable Web Dev config.json: {}", e.getMessage());
                        return new JsonObject();
                    }
                })
                .orElseGet(JsonObject::new);
        } catch (RuntimeException e) {
            logger.debug("Could not read Web Dev config.json: {}", e.getMessage());
            return new JsonObject();
        }
    }

    /**
     * True when the config says this is a text resource.
     *
     * <p>Defaults to FALSE — i.e. to the Python shape — when the discriminant is
     * absent or is not a string. That is the safe default in both directions: a
     * python resource shown as python behaves as it always has, whereas a
     * resource wrongly called "text" would advertise a body that is not there
     * and hide the handlers that are.</p>
     */
    static boolean isTextResource(JsonObject config) {
        JsonElement kind = config.get(RESOURCE_TYPE);
        return kind != null
            && kind.isJsonPrimitive()
            && kind.getAsJsonPrimitive().isString()
            && TEXT_RESOURCE.equals(kind.getAsString());
    }

    /** The declared MIME type, or {@link #DEFAULT_CONTENT_TYPE}. */
    static String contentType(JsonObject config) {
        JsonElement type = config.get(CONTENT_TYPE);
        if (type != null && type.isJsonPrimitive() && type.getAsJsonPrimitive().isString()) {
            String value = type.getAsString().trim();
            if (!value.isEmpty()) {
                return value;
            }
        }
        return DEFAULT_CONTENT_TYPE;
    }

    /** A text resource's body, absent when the config carries no string {@code text}. */
    public static Optional<String> body(JsonObject config) {
        JsonElement text = config.get(TEXT);
        if (text != null && text.isJsonPrimitive() && text.getAsJsonPrimitive().isString()) {
            return Optional.of(text.getAsString());
        }
        return Optional.empty();
    }

    /**
     * Put a new body into a config document, leaving everything else alone.
     *
     * <p>Read-modify-write, like the settings route beside it: the client sends
     * a body, never a document, so a field a newer Ignition adds survives an
     * older build of this module rather than being deleted by a wholesale
     * overwrite.</p>
     */
    static JsonObject withBody(JsonObject config, String text) {
        JsonObject next = config.deepCopy();
        // A resource that lost its discriminant would be served as Python and
        // 404 for every request; restore it while we are writing anyway.
        if (!next.has(RESOURCE_TYPE)) {
            next.addProperty(RESOURCE_TYPE, TEXT_RESOURCE);
        }
        if (!next.has(CONTENT_TYPE)) {
            next.addProperty(CONTENT_TYPE, DEFAULT_CONTENT_TYPE);
        }
        next.addProperty(TEXT, text);
        return next;
    }

    /**
     * Serialise a config document the way the platform writes it.
     *
     * <p>{@code PRETTY_GSON} has {@code disableHtmlEscaping()} on it, which for
     * this file is load-bearing rather than cosmetic. Gson escapes {@code &lt;},
     * {@code &gt;} and {@code &amp;} to unicode escapes by default, so a default
     * instance would rewrite 65 KB of HTML with every tag delimiter spelled out
     * as a six-character escape — still valid JSON, still served correctly, and
     * unreadable in every diff and every editor from then on.</p>
     */
    static byte[] serialise(JsonObject config) {
        return (HandlerSupport.PRETTY_GSON.toJson(config) + "\n").getBytes(StandardCharsets.UTF_8);
    }
}
