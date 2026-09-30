package com.gaskony.scriptide.gateway.term;

import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The live policy file: precedence, and that an edit lands without a restart.
 *
 * <p>Both properties are the whole reason the file exists. Precedence decides
 * whether an operator's edit is obeyed or silently outranked by a
 * {@code -D} they set six months ago; the re-read decides whether "turn the
 * terminal off" means editing a file or bouncing a production gateway.</p>
 */
class PolicySourceTest {

    @AfterEach
    void reset() {
        PolicySource.resetForTests();
        System.clearProperty(ExecPolicy.PROP_ENABLED);
        System.clearProperty(TerminalPolicy.PROP_ENABLED);
        System.clearProperty(TerminalPolicy.PROP_MAX_PER_SESSION);
    }

    /** Write the file and age its mtime, so the next read cannot see a stale one. */
    private static void write(Path file, String body) throws IOException {
        Files.writeString(file, body);
        Files.setLastModifiedTime(file, FileTime.fromMillis(System.currentTimeMillis()));
    }

    @Test
    @DisplayName("with no file, the system property and the default still decide")
    void absentFileChangesNothing(@TempDir Path dir) {
        PolicySource.setPropertiesFile(dir.resolve("policy.properties"));

        assertThat(ExecPolicy.executionEnabled()).isTrue();
        assertThat(TerminalPolicy.terminalEnabled()).isTrue();

        System.setProperty(TerminalPolicy.PROP_ENABLED, "false");
        assertThat(TerminalPolicy.terminalEnabled()).isFalse();
    }

    @Test
    @DisplayName("the file outranks a system property, for exec and terminal alike")
    void fileBeatsSystemProperty(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("policy.properties");
        PolicySource.setPropertiesFile(file);

        // The -D says on; the file, which somebody edited more recently and more
        // specifically, says off. The file wins.
        System.setProperty(ExecPolicy.PROP_ENABLED, "true");
        System.setProperty(TerminalPolicy.PROP_ENABLED, "true");
        write(file, ExecPolicy.PROP_ENABLED + "=false\n"
            + TerminalPolicy.PROP_ENABLED + "=false\n");

        assertThat(ExecPolicy.executionEnabled()).isFalse();
        assertThat(TerminalPolicy.terminalEnabled()).isFalse();
    }

    @Test
    @DisplayName("a key the file does not set falls through to the system property")
    void unsetKeysFallThrough(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("policy.properties");
        PolicySource.setPropertiesFile(file);
        write(file, ExecPolicy.PROP_ENABLED + "=false\n");
        System.setProperty(TerminalPolicy.PROP_MAX_PER_SESSION, "5");

        assertThat(ExecPolicy.executionEnabled()).isFalse();
        assertThat(TerminalPolicy.maxPerSession())
            .as("a file that says nothing about a key must not override it")
            .isEqualTo(5);
    }

    @Test
    @DisplayName("editing the file lands without a restart, inside the recheck window")
    void editsLandWithoutARestart(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("policy.properties");
        PolicySource.setPropertiesFile(file);
        write(file, TerminalPolicy.PROP_ENABLED + "=false\n");
        assertThat(TerminalPolicy.terminalEnabled()).isFalse();

        // The whole point of the class. A JVM system property could not do this
        // without restarting the gateway, and the estate rule forbids that.
        Thread.sleep(PolicySource.RECHECK_MILLIS + 100);
        write(file, TerminalPolicy.PROP_ENABLED + "=true\n");

        assertThat(TerminalPolicy.terminalEnabled())
            .as("the edit must be picked up on the next read")
            .isTrue();
    }

    @Test
    @DisplayName("a value is not re-read more than once per recheck window")
    void readsAreThrottled(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("policy.properties");
        PolicySource.setPropertiesFile(file);
        write(file, TerminalPolicy.PROP_ENABLED + "=false\n");
        assertThat(TerminalPolicy.terminalEnabled()).isFalse();

        // Immediately overwritten, with no wait. The stat is throttled, so this
        // must NOT be visible yet — that throttle is what keeps a getter called
        // several times per terminal open off the filesystem.
        write(file, TerminalPolicy.PROP_ENABLED + "=true\n");
        assertThat(TerminalPolicy.terminalEnabled())
            .as("inside the recheck window the cached value stands")
            .isFalse();
    }

    @Test
    @DisplayName("a malformed file value still falls back to the SECURE default")
    void malformedFileValueFailsSecure(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("policy.properties");
        PolicySource.setPropertiesFile(file);
        // "yes" is not "true", and must not be read loosely as false — that would
        // disable a security control by way of a typo in a file an operator
        // edits by hand, which is the whole risk of making it editable.
        write(file, TerminalPolicy.PROP_REQUIRE_ADMIN + "=yes\n");

        assertThat(TerminalPolicy.requireAdmin()).isTrue();
    }

    @Test
    @DisplayName("with no hook call the file is still discovered from data.dir")
    void discoveryFallsBackToTheDataDir() {
        PolicySource.resetForTests();
        String previous = System.getProperty("data.dir");
        try {
            // Measured on 8.3.8: Ignition starts its JVM with -Ddata.dir=data,
            // relative to the working directory. Taking it literally would look
            // for the file wherever the gateway happened to be started from.
            System.setProperty("data.dir", "data");
            Path found = PolicySource.discover();

            assertThat(found).isAbsolute();
            assertThat(found.toString()).endsWith(PolicySource.RELATIVE_PATH);
        } finally {
            if (previous == null) {
                System.clearProperty("data.dir");
            } else {
                System.setProperty("data.dir", previous);
            }
        }
    }
}
