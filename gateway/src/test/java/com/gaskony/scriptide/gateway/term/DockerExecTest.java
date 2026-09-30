package com.gaskony.scriptide.gateway.term;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The two pieces of {@link DockerExec} that decide whether a terminal actually
 * ends: the exit sequence, and the {@code /proc} matcher that catches whatever
 * the exit sequence could not reach.
 *
 * <p>Neither needs a daemon, which is the point of testing them here. The rest of
 * the class is HTTP over a Unix socket and is proved by running it against a real
 * daemon; these two are pure logic and are where a silent mistake would live. A
 * matcher that matches too widely kills somebody else's process, and one that
 * matches too narrowly leaves a root shell running forever — which is the defect
 * this release exists to fix.</p>
 */
class DockerExecTest {

    @Test
    @DisplayName("close() asks the shell to leave before it hangs up on it")
    void closeSendsTheExitSequence() {
        ByteArrayOutputStream sent = new ByteArrayOutputStream();
        DockerExec.Session session = DockerExec.Session.forTest(sent);

        session.close();

        byte[] bytes = sent.toByteArray();
        // ETX, then EOT, then the word — in that order. ^C first because ^D means
        // nothing to a shell that is not at its prompt, and `exit` last for a
        // shell with ignoreeof set.
        assertThat(bytes[0]).as("^C must come first").isEqualTo((byte) 3);
        assertThat(bytes[1]).as("^D must follow the interrupt").isEqualTo((byte) 4);
        assertThat(new String(bytes, 2, bytes.length - 2, StandardCharsets.UTF_8))
            .isEqualTo("exit\n");
    }

    @Test
    @DisplayName("the sweep matches a whole environment line, never a substring")
    void reapScriptMatchesWholeLines() {
        String script = DockerExec.reapScript("abc-123");

        // grep -qx: a WHOLE line equal to the variable and the tag. A substring
        // match would also hit any process that merely mentions the tag —
        // including one whose command line contains it.
        assertThat(script).contains("grep -qx 'SCRIPTIDE_TERM=abc-123'");
        // /proc/PID/environ is NUL-separated, so it has to be split into lines
        // before grep can see a line at all.
        assertThat(script).contains("tr '\\0' '\\n' < \"$p/environ\"");
        // Only numeric entries: /proc also holds `self`, `net`, `sys` and more.
        assertThat(script).contains("/proc/[0-9]*");
    }

    @Test
    @DisplayName("the sweep signals HUP first, then KILL, and never itself")
    void reapScriptEscalatesAndSkipsItself() {
        String script = DockerExec.reapScript("t");

        assertThat(script.indexOf("kill -HUP"))
            .as("HUP is what a closing terminal means; KILL is the backstop")
            .isLessThan(script.indexOf("kill -KILL"));
        assertThat(script).contains("sleep 1");
        // Without this the sweep's own `sh` is a candidate the moment anybody
        // gives it the tag in its environment.
        assertThat(script).contains("[ \"$pid\" = \"$$\" ] && continue");
        // A pid that exited between the scan and the signal is the expected
        // case, so neither pass may report it.
        assertThat(script).contains("kill -HUP \"$pid\" 2>/dev/null");
        assertThat(script).contains("kill -KILL \"$pid\" 2>/dev/null");
    }

    @Test
    @DisplayName("a tag that could break out of the script is refused")
    void tagsAreAllowlisted() {
        // The tag is interpolated inside single quotes in a string handed to
        // `sh -c`. An allowlist rather than a list of forbidden characters, for
        // the same reason TerminalPolicy.isSafeShellPath uses one.
        assertThat(DockerExec.isSafeTag("f81d4fae-7dec-11d0-a765-00a0c91e6bf6")).isTrue();
        assertThat(DockerExec.isSafeTag("plain.tag_1-2")).isTrue();

        assertThat(DockerExec.isSafeTag("a'; rm -rf / #")).isFalse();
        assertThat(DockerExec.isSafeTag("a b")).isFalse();
        assertThat(DockerExec.isSafeTag("$(id)")).isFalse();
        assertThat(DockerExec.isSafeTag("")).isFalse();
        assertThat(DockerExec.isSafeTag(null)).isFalse();
        assertThat(DockerExec.isSafeTag("x".repeat(121))).isFalse();
    }
}
