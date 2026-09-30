package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The capture streams, exercised directly.
 *
 * <p>Directly, because the interesting cases are byte-level and a script that
 * produced them would prove nothing extra: a chunk boundary landing inside a
 * multi-byte character, a line that never ends, and the cap.</p>
 */
class StreamingOutputTest {

    private final List<String> chunks = new ArrayList<>();

    private PrivateStateRunner.StreamingOutputStream stream(int limit) {
        return new PrivateStateRunner.StreamingOutputStream(limit, "stdout",
            (name, text) -> chunks.add(text));
    }

    private static byte[] utf8(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("a newline flushes, so print in a loop appears line by line")
    void flushesOnNewline() throws Exception {
        var out = stream(1024);
        out.write(utf8("0\n1\n"));
        // The whole point of the fix: this text is available BEFORE the script ends.
        assertThat(chunks).containsExactly("0\n1\n");
        out.write(utf8("no newline yet"));
        assertThat(chunks).hasSize(1);
        out.finish();
        assertThat(chunks).containsExactly("0\n1\n", "no newline yet");
        // Streamed output is not repeated in the outcome — that is what stops the
        // client double-printing.
        assertThat(out.captured()).isEmpty();
    }

    @Test
    @DisplayName("a long unbroken line flushes at the size threshold")
    void flushesOnSize() throws Exception {
        var out = stream(1024 * 1024);
        out.write(utf8("x".repeat(PrivateStateRunner.FLUSH_AT_BYTES + 10)));
        assertThat(chunks).hasSize(1);
        assertThat(chunks.get(0)).hasSize(PrivateStateRunner.FLUSH_AT_BYTES + 10);
    }

    @Test
    @DisplayName("a character split across two writes survives intact")
    void doesNotMangleASplitCodePoint() throws Exception {
        // The failure this prevents is permanent: once half a character has been
        // sent as U+FFFD, the other half can never repair it.
        byte[] degrees = utf8("25°C\n");
        var out = stream(1024);
        out.write(degrees, 0, 3);   // "25" + the FIRST byte of the two-byte °
        out.flushPending();
        out.write(degrees, 3, degrees.length - 3);
        out.finish();
        assertThat(String.join("", chunks)).isEqualTo("25°C\n");
    }

    @Test
    @DisplayName("the cap drops output, never the script")
    void capsWithoutFailing() throws Exception {
        var out = stream(8);
        out.write(utf8("abcdefghijkl\n"));
        out.finish();
        assertThat(out.truncated()).isTrue();
        assertThat(String.join("", chunks)).isEqualTo("abcdefgh");
    }

    @Test
    @DisplayName("with no listener the outcome carries everything, as before")
    void accumulatingStreamIsUnchanged() throws Exception {
        var out = new PrivateStateRunner.BoundedOutputStream(4);
        out.write(utf8("abcdef"));
        assertThat(out.captured()).isEqualTo("abcd");
        assertThat(out.truncated()).isTrue();
    }
}
