package com.gaskony.scriptide.gateway.lang;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Diagnostics.
 *
 * <p>The governing rule is that a FALSE POSITIVE costs more than a miss: one wrong
 * squiggle on correct code destroys trust in the whole panel. So these tests care
 * as much about staying silent on valid Python 2 as about flagging real errors.</p>
 */
class DiagnosticsTest {

    private static List<JsonObject> diagnosticsFor(String source) {
        List<JsonObject> published = new ArrayList<>();
        LanguageServer server = new LanguageServer(() -> null);
        server.setNotifier(published::add);

        JsonObject params = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", "ignition://p/m");
        td.addProperty("text", source);
        td.addProperty("version", 1);
        params.add("textDocument", td);

        JsonObject message = new JsonObject();
        message.addProperty("jsonrpc", "2.0");
        message.addProperty("method", "textDocument/didOpen");
        message.add("params", params);
        server.handle(message);

        List<JsonObject> out = new ArrayList<>();
        for (JsonObject notification : published) {
            if ("textDocument/publishDiagnostics".equals(
                notification.get("method").getAsString())) {
                JsonArray array = notification.getAsJsonObject("params")
                    .getAsJsonArray("diagnostics");
                array.forEach(e -> out.add(e.getAsJsonObject()));
            }
        }
        return out;
    }

    @Test
    @DisplayName("valid Python 2 produces NO diagnostics")
    void python2IsClean() {
        // The client's grammar is Python 3 and would flag every one of these. Only
        // the real Jython parser is allowed to say a line is wrong, and it says
        // these are fine.
        assertThat(diagnosticsFor("print 'hello'\n")).isEmpty();
        assertThat(diagnosticsFor("try:\n\tpass\nexcept ValueError, e:\n\tpass\n")).isEmpty();
        assertThat(diagnosticsFor("x = 10L\ny = 0777\nz = 1 <> 2\n")).isEmpty();
        assertThat(diagnosticsFor("raise ValueError, 'msg'\n")).isEmpty();
    }

    @Test
    @DisplayName("a real syntax error is reported once, on the right line")
    void reportsRealSyntaxError() {
        List<JsonObject> diagnostics = diagnosticsFor("a = 1\nb = 2\nc = = 3\n");
        assertThat(diagnostics).hasSize(1);   // Jython reports only the first
        JsonObject d = diagnostics.get(0);
        assertThat(d.getAsJsonObject("range").getAsJsonObject("start").get("line").getAsInt())
            .isEqualTo(2);
        assertThat(d.get("severity").getAsInt()).isEqualTo(1);
        assertThat(d.get("source").getAsString()).isEqualTo("jython");
    }

    @Test
    @DisplayName("the squiggle has non-zero width, or it is invisible")
    void squiggleIsVisible() {
        JsonObject range = diagnosticsFor("def f(:\n").get(0).getAsJsonObject("range");
        int start = range.getAsJsonObject("start").get("character").getAsInt();
        int end = range.getAsJsonObject("end").get("character").getAsInt();
        assertThat(end).isGreaterThan(start);
    }

    @Test
    @DisplayName("diagnostics carry the document version so a stale payload can be dropped")
    void diagnosticsAreVersioned() {
        List<JsonObject> published = new ArrayList<>();
        LanguageServer server = new LanguageServer(() -> null);
        server.setNotifier(published::add);

        JsonObject params = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", "ignition://p/m");
        td.addProperty("text", "x = 1\n");
        td.addProperty("version", 42);
        params.add("textDocument", td);
        JsonObject message = new JsonObject();
        message.addProperty("jsonrpc", "2.0");
        message.addProperty("method", "textDocument/didOpen");
        message.add("params", params);
        server.handle(message);

        assertThat(published).isNotEmpty();
        assertThat(published.get(0).getAsJsonObject("params").get("version").getAsInt())
            .isEqualTo(42);
    }

    @Test
    @DisplayName("a document with no trailing newline is not flagged")
    void noTrailingNewlineIsFine() {
        // The Designer writes scripts without one, so flagging it would put a
        // permanent error on almost every file in the estate.
        assertThat(diagnosticsFor("def f():\n\treturn 1")).isEmpty();
    }
}
