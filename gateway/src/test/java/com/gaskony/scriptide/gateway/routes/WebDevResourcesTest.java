package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The two shapes a Web Dev resource is written in.
 *
 * <p>The fixtures below are the real {@code config.json} heads from
 * {@code Machine_HMI_Demo} on the module-testing rig, read 04/09/2026 — not
 * invented, because the whole reason this class exists is that the shape this
 * module inferred by analogy was only one of two.</p>
 */
class WebDevResourcesTest {

    /** admin, lib — a set of Python handlers. */
    private static final String PYTHON_CONFIG = """
        {"resource-type":"python-resource",
         "doGet":{"enabled":true,"max-retry-attempts":3,"require-auth":false,
                  "require-https":false,"required-roles":"","user-source":""}}""";

    /** cell3d — 65 KB of HTML, held as a string inside the config file. */
    private static final String TEXT_CONFIG = """
        {"resource-type":"text-resource","content-type":"text/html",
         "text":"<!doctype html>\\n<html lang=\\"en-AU\\">\\n</html>\\n"}""";

    private static JsonObject parse(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    @Nested
    @DisplayName("telling the two apart")
    class Discriminant {

        @Test
        @DisplayName("a text resource is recognised as one")
        void textIsText() {
            assertThat(WebDevResources.isTextResource(parse(TEXT_CONFIG))).isTrue();
        }

        @Test
        @DisplayName("a python resource is NOT — the guard is not vacuous")
        void pythonIsNotText() {
            // The pairing matters more than either half: a predicate that
            // answered true for everything would pass the check above alone,
            // and would then hide the handlers on every endpoint on the gateway.
            assertThat(WebDevResources.isTextResource(parse(PYTHON_CONFIG))).isFalse();
        }

        @Test
        @DisplayName("a config with no discriminant is treated as python")
        void missingIsPython() {
            // What an older resource, or an unparseable config, comes back as.
            // Python is the safe default in both directions: it behaves as this
            // module always has, whereas a resource wrongly called "text" would
            // advertise a body that is not there and hide the handlers that are.
            assertThat(WebDevResources.isTextResource(new JsonObject())).isFalse();
            assertThat(WebDevResources.isTextResource(parse("{\"resource-type\":7}"))).isFalse();
        }
    }

    @Nested
    @DisplayName("a text resource's body")
    class Body {

        @Test
        @DisplayName("is read out of the config's text field")
        void readsBody() {
            assertThat(WebDevResources.body(parse(TEXT_CONFIG)))
                .hasValueSatisfying(text -> assertThat(text).startsWith("<!doctype html>"));
        }

        @Test
        @DisplayName("is absent, not empty, when there is no text field")
        void absentBody() {
            // The read route turns absent into a 404. Returning "" would open an
            // empty editor over a file that is really there, and the first save
            // would then erase it.
            assertThat(WebDevResources.body(parse(PYTHON_CONFIG))).isEmpty();
            assertThat(WebDevResources.body(parse("{\"text\":42}"))).isEmpty();
        }

        @Test
        @DisplayName("is written back WITHOUT losing the content type")
        void preservesContentType() {
            // The failure this prevents: a wholesale {"text": …} overwrite
            // strips the MIME type, and the platform then serves 65 KB of HTML
            // as text/plain — which looks like the page has been destroyed.
            JsonObject next = WebDevResources.withBody(parse(TEXT_CONFIG), "<p>new</p>");
            assertThat(next.get("content-type").getAsString()).isEqualTo("text/html");
            assertThat(next.get("resource-type").getAsString()).isEqualTo("text-resource");
            assertThat(next.get("text").getAsString()).isEqualTo("<p>new</p>");
        }

        @Test
        @DisplayName("is written back keeping fields this build has never heard of")
        void preservesUnknownKeys() {
            JsonObject config = parse(TEXT_CONFIG);
            config.addProperty("some-future-field", "keep me");
            JsonObject next = WebDevResources.withBody(config, "x");
            assertThat(next.get("some-future-field").getAsString()).isEqualTo("keep me");
        }

        @Test
        @DisplayName("does not mutate the document it was given")
        void doesNotMutateInput() {
            JsonObject config = parse(TEXT_CONFIG);
            WebDevResources.withBody(config, "replaced");
            assertThat(config.get("text").getAsString()).startsWith("<!doctype html>");
        }
    }

    @Nested
    @DisplayName("serialising the config back to bytes")
    class Serialise {

        @Test
        @DisplayName("leaves HTML readable rather than escaping every tag")
        void doesNotEscapeHtml() {
            // Gson escapes <, > and & to unicode sequences by DEFAULT. On a
            // 65 KB HTML body that is a file nobody can read again, in the
            // editor or in a diff, while still being valid JSON that serves
            // correctly — so nothing downstream would ever have reported it.
            String written = new String(
                WebDevResources.serialise(WebDevResources.withBody(parse(TEXT_CONFIG), "<b>hi</b>")),
                StandardCharsets.UTF_8);
            assertThat(written).contains("<b>hi</b>");
            assertThat(written).doesNotContain("\\u003c");
        }

        @Test
        @DisplayName("ends with a newline, as the platform writes it")
        void trailingNewline() {
            assertThat(new String(WebDevResources.serialise(parse(PYTHON_CONFIG)),
                StandardCharsets.UTF_8)).endsWith("\n");
        }
    }

    @Nested
    @DisplayName("the files an endpoint carries")
    class Assets {

        @ParameterizedTest(name = "an asset: {0}")
        @ValueSource(strings = { "three.min.js", "site.css", "index.html", "data.json" })
        @DisplayName("anything that is not the config or a verb handler")
        void assets(String key) {
            assertThat(WebDevResources.isAsset(key)).isTrue();
        }

        @ParameterizedTest(name = "not an asset: {0}")
        @ValueSource(strings = { "config.json", "doGet.py", "doPatch.py", "doOptions.py" })
        @DisplayName("the config and the eight handlers are not assets")
        void notAssets(String key) {
            assertThat(WebDevResources.isAsset(key)).isFalse();
        }

        @Test
        @DisplayName("a text file within the size limit is editable")
        void editable() {
            assertThat(WebDevResources.isEditableAsset("site.css", 2048)).isTrue();
        }

        @Test
        @DisplayName("three.min.js is listed but NOT editable — 670 KB, minified")
        void tooLarge() {
            // Measured on the rig. It stays in the listing: a row that says why
            // is a better answer than a file that appears not to exist, which is
            // what this one was until 1.9.0.
            assertThat(WebDevResources.isAsset("three.min.js")).isTrue();
            assertThat(WebDevResources.isEditableAsset("three.min.js", 669_884)).isFalse();
        }

        @ParameterizedTest(name = "not editable: {0}")
        @ValueSource(strings = { "logo.png", "font.woff2", "archive.zip", "README", "x." })
        @DisplayName("a type this IDE cannot round-trip as text is not offered")
        void binaries(String key) {
            // The round trip is bytes → UTF-8 string → bytes, which is lossy for
            // anything that is not text: opening a PNG would show replacement
            // characters and saving it would destroy the file.
            assertThat(WebDevResources.isEditableAsset(key, 1024)).isFalse();
        }
    }

    @Nested
    @DisplayName("the declared content type")
    class ContentType {

        @Test
        @DisplayName("is read from the config")
        void reads() {
            assertThat(WebDevResources.contentType(parse(TEXT_CONFIG))).isEqualTo("text/html");
        }

        @Test
        @DisplayName("falls back to text/plain rather than to nothing")
        void fallsBack() {
            assertThat(WebDevResources.contentType(new JsonObject())).isEqualTo("text/plain");
            assertThat(WebDevResources.contentType(parse("{\"content-type\":\"  \"}")))
                .isEqualTo("text/plain");
        }
    }
}
