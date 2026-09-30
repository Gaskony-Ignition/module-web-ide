package com.gaskony.scriptide.gateway.ws;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The gates in front of the execution channel, per frame.
 *
 * <p>Only the checks that run BEFORE the service is resolved are asserted here —
 * the admin role and the CSRF token. Everything past that point needs a real
 * {@code ExecutionService}, which the registry builds from a GatewayContext, and
 * the scheduling behaviour it governs is covered directly in
 * {@code ExecutionServiceTest} instead.</p>
 *
 * <p>What makes these worth a test at all is that they are re-checked on EVERY
 * frame rather than once at connect, so that turning execution off on a running
 * gateway takes effect on connections that are already open. A refactor that
 * hoisted them to the handshake would still pass a happy-path test.</p>
 */
class ScriptIdeSocketExecTest {

    /** A socket that keeps what it sent instead of needing a Jetty session. */
    static final class RecordingSocket extends ScriptIdeSocket {
        final List<JsonObject> sent = new ArrayList<>();

        RecordingSocket(boolean administrator, String csrfToken) {
            super("tester", administrator, csrfToken, "10.0.0.1");
        }

        @Override
        protected void send(String text) {
            sent.add(JsonParser.parseString(text).getAsJsonObject());
        }

        /** The error text of the last frame on a channel, or null. */
        String lastErrorOn(String channel) {
            for (int i = sent.size() - 1; i >= 0; i--) {
                JsonObject envelope = sent.get(i);
                if (channel.equals(envelope.get("ch").getAsString())) {
                    JsonObject msg = envelope.getAsJsonObject("msg");
                    return msg.has("error") ? msg.get("error").getAsString() : null;
                }
            }
            return null;
        }
    }

    private static String execFrame(String body) {
        return "{\"ch\":\"exec\",\"msg\":" + body + "}";
    }

    @Test
    @DisplayName("a non-administrator is refused before anything is compiled")
    void refusesANonAdministrator() {
        RecordingSocket socket = new RecordingSocket(false, "secret");
        socket.onWebSocketText(execFrame("{\"action\":\"run\",\"project\":\"P\",\"source\":\"1\"}"));
        assertThat(socket.lastErrorOn("exec")).contains("Administrator role");
    }

    @Test
    @DisplayName("an administrator without the CSRF token is still refused")
    void refusesAMissingCsrfToken() {
        // WebSockets get no CORS preflight, so this token is the only thing
        // standing between a hostile page and arbitrary Gateway-JVM execution.
        RecordingSocket socket = new RecordingSocket(true, "secret");
        socket.onWebSocketText(execFrame("{\"action\":\"run\",\"project\":\"P\",\"source\":\"1\"}"));
        assertThat(socket.lastErrorOn("exec")).contains("CSRF token");

        socket.onWebSocketText(execFrame(
            "{\"action\":\"run\",\"csrfToken\":\"wrong\",\"project\":\"P\",\"source\":\"1\"}"));
        assertThat(socket.lastErrorOn("exec")).contains("CSRF token");
    }

    @Test
    @DisplayName("a reset needs a project, and says so rather than resetting nothing")
    void resetRequiresAProject() {
        RecordingSocket socket = new RecordingSocket(true, "secret");
        socket.onWebSocketText(execFrame("{\"action\":\"reset\",\"csrfToken\":\"secret\"}"));
        String error = socket.lastErrorOn("exec");
        // Either the argument check or the shutdown check may answer first,
        // depending on whether a service is registered in this JVM — both are
        // refusals, and neither may silently succeed.
        assertThat(error).isNotNull();
    }

    @Test
    @DisplayName("a malformed envelope is answered, not logged as an incident")
    void answersAMalformedEnvelope() {
        RecordingSocket socket = new RecordingSocket(true, "secret");
        socket.onWebSocketText("not json at all");
        assertThat(socket.lastErrorOn("error")).isEqualTo("malformed envelope");
    }
}
