package com.gaskony.scriptide.gateway.lang;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompilerFlags;
import org.python.core.ParserFacade;

import java.io.StringReader;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The built-in snippets are hand-written LSP bodies with no compile step, so
 * nothing else catches a typo in one until a user hits Tab and gets a
 * SyntaxError. These tests substitute every placeholder with the text an LSP
 * client would actually leave behind after the user accepts the defaults, then
 * run the substituted body through the real Jython 2.7 parser — the same
 * approach {@code TestHarnessTest} uses for the harness's own sources.
 */
class SnippetsTest {

    /** {@code ${1:some text}} — a numbered tab stop carrying default text. */
    private static final Pattern NUMBERED_WITH_TEXT = Pattern.compile("\\$\\{\\d+:([^{}]*)\\}");
    /** {@code ${1}} or {@code $1} (including the final {@code $0}) — bare. */
    private static final Pattern BARE_NUMBERED = Pattern.compile("\\$\\{\\d+\\}|\\$\\d+");

    /**
     * What a body looks like once its tab stops are gone — this is deliberately
     * done HERE, not in {@code Snippets}, so main source never has to carry test
     * fixtures for its own placeholders.
     */
    private static String substituted(String body) {
        String withDefaultsFilledIn =
            NUMBERED_WITH_TEXT.matcher(body).replaceAll(match -> Matcher.quoteReplacement(match.group(1)));
        return BARE_NUMBERED.matcher(withDefaultsFilledIn).replaceAll("placeholder");
    }

    @Test
    @DisplayName("every snippet body parses as Jython 2.7 once its placeholders are filled in")
    void bodiesParse() {
        for (Snippets.Snippet snippet : Snippets.ALL) {
            String code = substituted(snippet.body());
            try {
                ParserFacade.parseExpressionOrModule(
                    new StringReader(code), "<" + snippet.prefix() + ">", new CompilerFlags());
            } catch (RuntimeException e) {
                throw new AssertionError(
                    "snippet '" + snippet.prefix() + "' does not parse once substituted:\n"
                        + code, e);
            }
        }
    }

    @Test
    @DisplayName("prefixes are unique")
    void prefixesAreUnique() {
        Set<String> seen = new HashSet<>();
        for (Snippets.Snippet snippet : Snippets.ALL) {
            assertThat(seen.add(snippet.prefix()))
                .as("duplicate snippet prefix: " + snippet.prefix())
                .isTrue();
        }
    }

    @Test
    @DisplayName("indentation is tabs only, never a tab/space mix")
    void indentationIsTabsOnly() {
        for (Snippets.Snippet snippet : Snippets.ALL) {
            for (String line : snippet.body().split("\n", -1)) {
                int i = 0;
                while (i < line.length() && (line.charAt(i) == '\t' || line.charAt(i) == ' ')) {
                    i++;
                }
                String indent = line.substring(0, i);
                assertThat(indent)
                    .as("leading whitespace of a line in '" + snippet.prefix() + "': " + line)
                    .doesNotContain(" ");
            }
        }
    }

    @Test
    @DisplayName("every snippet is well-formed: non-blank prefix, label, detail and body")
    void fieldsArePresent() {
        for (Snippets.Snippet snippet : Snippets.ALL) {
            assertThat(snippet.prefix()).as("prefix").isNotBlank();
            assertThat(snippet.label()).as("label of " + snippet.prefix()).isNotBlank();
            assertThat(snippet.detail()).as("detail of " + snippet.prefix()).isNotBlank();
            assertThat(snippet.body()).as("body of " + snippet.prefix()).isNotBlank();
            assertThat(snippet.documentation()).as("documentation of " + snippet.prefix()).isNotBlank();
        }
    }

    // ---- offered from LanguageServer#completion ----

    private static LanguageServer server() {
        return new LanguageServer(() -> null);
    }

    private static JsonObject open(String uri, String text) {
        JsonObject params = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", uri);
        td.addProperty("text", text);
        td.addProperty("version", 1);
        params.add("textDocument", td);
        return params;
    }

    private static JsonObject completionAt(String uri, int line, int character) {
        JsonObject params = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", uri);
        params.add("textDocument", td);
        JsonObject pos = new JsonObject();
        pos.addProperty("line", line);
        pos.addProperty("character", character);
        params.add("position", pos);
        return params;
    }

    private static JsonObject request(String method, JsonObject params, int id) {
        JsonObject m = new JsonObject();
        m.addProperty("jsonrpc", "2.0");
        m.addProperty("method", method);
        m.add("params", params);
        m.addProperty("id", id);
        return m;
    }

    private static Set<String> labelsOf(JsonArray items) {
        Set<String> labels = new HashSet<>();
        for (var item : items) {
            labels.add(item.getAsJsonObject().get("label").getAsString());
        }
        return labels;
    }

    @Test
    @DisplayName("a snippet is offered for a bare prefix, kind Snippet, insertTextFormat Snippet")
    void offersSnippetForBarePrefix() {
        LanguageServer s = server();
        String uri = "ignition://p/a";
        s.handle(request("textDocument/didOpen", open(uri, "log"), 0));

        JsonArray items = s.handle(request("textDocument/completion", completionAt(uri, 0, 3), 1))
            .getAsJsonObject("result").getAsJsonArray("items");
        assertThat(labelsOf(items)).contains("logger");

        JsonObject logger = null;
        for (var item : items) {
            if ("logger".equals(item.getAsJsonObject().get("label").getAsString())) {
                logger = item.getAsJsonObject();
            }
        }
        assertThat(logger).as("the logger snippet item").isNotNull();
        assertThat(logger.get("kind").getAsInt()).isEqualTo(15);
        assertThat(logger.get("insertTextFormat").getAsInt()).isEqualTo(2);
        assertThat(logger.get("insertText").getAsString()).contains("system.util.getLogger");
    }

    @Test
    @DisplayName("no snippet is offered after a dot — a snippet is never a member of anything")
    void noSnippetAfterDot() {
        LanguageServer s = server();
        String uri = "ignition://p/b";
        s.handle(request("textDocument/didOpen", open(uri, "system."), 0));

        JsonArray items = s.handle(request("textDocument/completion", completionAt(uri, 0, 7), 1))
            .getAsJsonObject("result").getAsJsonArray("items");
        Set<String> snippetPrefixes = new HashSet<>();
        for (Snippets.Snippet snippet : Snippets.ALL) {
            snippetPrefixes.add(snippet.prefix());
        }
        assertThat(labelsOf(items)).doesNotContainAnyElementsOf(snippetPrefixes);
    }

    @Test
    @DisplayName("a snippet item passed to resolve comes back unchanged")
    void snippetSurvivesResolve() {
        LanguageServer s = server();
        String uri = "ignition://p/c";
        s.handle(request("textDocument/didOpen", open(uri, "log"), 0));
        JsonArray items = s.handle(request("textDocument/completion", completionAt(uri, 0, 3), 1))
            .getAsJsonObject("result").getAsJsonArray("items");
        JsonObject logger = items.get(0).getAsJsonObject();
        for (var item : items) {
            if ("logger".equals(item.getAsJsonObject().get("label").getAsString())) {
                logger = item.getAsJsonObject();
            }
        }

        JsonObject resolveParams = logger.deepCopy();
        JsonObject resolved = s.handle(request("completionItem/resolve", resolveParams, 2))
            .getAsJsonObject("result").getAsJsonObject();
        assertThat(resolved.get("insertText").getAsString())
            .isEqualTo(logger.get("insertText").getAsString());
        assertThat(resolved.get("label").getAsString()).isEqualTo("logger");
    }
}
