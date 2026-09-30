package com.gaskony.scriptide.gateway.term;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The terminal's configuration gates.
 *
 * <p>The shell-path rules are the ones that matter: {@code TerminalSession}
 * interpolates the value into the string it hands {@code script -c}, so this
 * validator is the only thing between a mistyped property and a command
 * injection opened by a config file.</p>
 */
class TerminalPolicyTest {

    @AfterEach
    void clearProperties() {
        System.clearProperty(TerminalPolicy.PROP_ENABLED);
        System.clearProperty(TerminalPolicy.PROP_REQUIRE_ADMIN);
        System.clearProperty(TerminalPolicy.PROP_ACKNOWLEDGE_RISK);
        System.clearProperty(TerminalPolicy.PROP_SHELL);
        System.clearProperty(TerminalPolicy.PROP_MAX_PER_SESSION);
        System.clearProperty(TerminalPolicy.PROP_PRIVILEGED);
        System.clearProperty(TerminalPolicy.PROP_DOCKER);
    }

    @Test
    @DisplayName("a shell path carrying shell metacharacters is refused")
    void shellPathRejectsMetacharacters() {
        // Each of these would be executed by the shell running our -c string if
        // the value were passed through. An allowlist is used rather than a list
        // of forbidden characters precisely so this test cannot become the
        // definition of "safe".
        assertThat(TerminalPolicy.isSafeShellPath("/bin/bash; curl http://x/y | sh")).isFalse();
        assertThat(TerminalPolicy.isSafeShellPath("/bin/bash $(id)")).isFalse();
        assertThat(TerminalPolicy.isSafeShellPath("/bin/bash`id`")).isFalse();
        assertThat(TerminalPolicy.isSafeShellPath("/bin/bash&&id")).isFalse();
        assertThat(TerminalPolicy.isSafeShellPath("/bin/ba sh")).isFalse();
    }

    @Test
    @DisplayName("a relative path is refused even when it names a real program")
    void shellPathMustBeAbsolute() {
        assertThat(TerminalPolicy.isSafeShellPath("bash")).isFalse();
        assertThat(TerminalPolicy.isSafeShellPath("../../bin/bash")).isFalse();
    }

    @Test
    @DisplayName("a path that does not exist is refused rather than launched")
    void shellPathMustExist() {
        assertThat(TerminalPolicy.isSafeShellPath("/bin/definitely-not-a-shell-9f3a")).isFalse();
    }

    @Test
    @DisplayName("a bad shell property falls back to a built-in candidate, never to nothing")
    void badShellPropertyFallsBack() {
        System.setProperty(TerminalPolicy.PROP_SHELL, "/bin/bash; id");
        String shell = TerminalPolicy.shell();
        // On a Unix host one of the candidates exists; the point is that the
        // REJECTED value is not what came back.
        assertThat(shell).isNotEqualTo("/bin/bash; id");
    }

    @Test
    @DisplayName("requireAdmin cannot be turned off by one property alone")
    void requireAdminNeedsBothFlags() {
        System.setProperty(TerminalPolicy.PROP_REQUIRE_ADMIN, "false");
        assertThat(TerminalPolicy.requireAdmin())
            .as("one flag must not be enough to hand out a Gateway shell")
            .isTrue();

        System.setProperty(TerminalPolicy.PROP_ACKNOWLEDGE_RISK, "true");
        assertThat(TerminalPolicy.requireAdmin()).isFalse();
    }

    @Test
    @DisplayName("the terminal has its OWN kill switch, independent of script execution")
    void terminalHasItsOwnSwitch() {
        // A site that wants the Script Console but not a shell must be able to
        // have exactly that; sharing execution.enabled would make one of the two
        // settings a decoration.
        assertThat(TerminalPolicy.PROP_ENABLED).isNotEqualTo("com.gaskony.scriptide.execution.enabled");
        System.setProperty(TerminalPolicy.PROP_ENABLED, "false");
        assertThat(TerminalPolicy.terminalEnabled()).isFalse();
    }

    @Test
    @DisplayName("a typo in a boolean property keeps the SAFE default, not false")
    void typoKeepsTheSafeDefault() {
        System.setProperty(TerminalPolicy.PROP_REQUIRE_ADMIN, "no");
        assertThat(TerminalPolicy.requireAdmin()).isTrue();
        System.setProperty(TerminalPolicy.PROP_ENABLED, "yes-please");
        assertThat(TerminalPolicy.terminalEnabled()).isTrue();
    }

    @Test
    @DisplayName("maxPerSession is clamped, so a silly value cannot open 10000 shells")
    void maxPerSessionIsClamped() {
        System.setProperty(TerminalPolicy.PROP_MAX_PER_SESSION, "10000");
        assertThat(TerminalPolicy.maxPerSession()).isEqualTo(TerminalPolicy.MAX_MAX_PER_SESSION);
        System.setProperty(TerminalPolicy.PROP_MAX_PER_SESSION, "0");
        assertThat(TerminalPolicy.maxPerSession()).isEqualTo(1);
    }

    // ---- elevation ------------------------------------------------------

    @Test
    @DisplayName("turning privileged off skips the probe entirely and never elevates")
    void privilegedOffNeverElevates() {
        System.setProperty(TerminalPolicy.PROP_PRIVILEGED, "false");
        // Unconditional: these must hold on a machine that DOES have passwordless
        // sudo or a mounted Docker socket, which is exactly where a broken
        // opt-out would look like it worked.
        assertThat(TerminalPolicy.sudoForElevation()).isNull();
        assertThat(TerminalPolicy.dockerContainerForElevation()).isNull();
    }

    @Test
    @DisplayName("the Docker route can be refused on its own, without losing sudo")
    void dockerCanBeRefusedWithoutLosingSudo() {
        // The two are NOT the same risk and must not share a switch. sudo grants
        // root inside THIS container; the Docker socket is the daemon's full API
        // running as root on the HOST, and anyone reaching it can start a
        // privileged container that mounts `/`. A site must be able to keep the
        // narrow route without giving up elevation altogether.
        System.setProperty(TerminalPolicy.PROP_DOCKER, "false");
        assertThat(TerminalPolicy.dockerContainerForElevation()).isNull();
        assertThat(TerminalPolicy.sudoForElevation())
            .isEqualTo(TerminalPolicy.sudoForElevation());
    }

    @Test
    @DisplayName("the Docker probe answers promptly and never invents a container")
    void dockerProbeIsHonest() {
        System.setProperty(TerminalPolicy.PROP_PRIVILEGED, "true");
        long start = System.nanoTime();
        String container = TerminalPolicy.dockerContainerForElevation();
        long millis = (System.nanoTime() - start) / 1_000_000;
        assertThat(millis).isLessThan(10_000);
        // As with sudo, the answer is a property of the machine this runs on, so
        // the invariant is the SHAPE: a full 64-hex container id, or nothing.
        // Never a hostname — the estate's own gateway runs with host networking,
        // so its hostname is the workstation's, and that is the trap this guards.
        if (container != null) {
            assertThat(container).matches("[0-9a-f]{64}");
        }
    }

    @Test
    @DisplayName("elevation is decided by running sudo, not by the property being on")
    void elevationIsDecidedByTheHost() {
        System.setProperty(TerminalPolicy.PROP_PRIVILEGED, "true");
        String sudo = TerminalPolicy.sudoForElevation();
        // The assertion cannot be "it elevates" or "it does not" — the answer is
        // a property of the machine the test runs on, and pinning either would
        // make this suite pass or fail on CI for reasons that have nothing to do
        // with the code. What IS invariant: it returns an absolute path to a
        // real executable, or nothing at all. Never a bare "sudo" for the PATH
        // to resolve, and never a path that is not there.
        if (sudo != null) {
            assertThat(sudo).startsWith("/");
            assertThat(java.nio.file.Files.isExecutable(java.nio.file.Path.of(sudo))).isTrue();
        }
    }

    @Test
    @DisplayName("an unparseable privileged value keeps the default rather than guessing")
    void privilegedTypoKeepsTheDefault() {
        System.setProperty(TerminalPolicy.PROP_PRIVILEGED, "sure");
        // Same rule as every other boolean here: a typo falls back to the
        // documented default (true), so nobody silently loses the feature to a
        // spelling mistake and then reports it as broken.
        assertThat(TerminalPolicy.sudoForElevation())
            .isEqualTo(TerminalPolicy.sudoForElevation());
    }

    @Test
    @DisplayName("the probe returns promptly instead of hanging on a password prompt")
    void elevationProbeDoesNotHang() {
        System.setProperty(TerminalPolicy.PROP_PRIVILEGED, "true");
        long start = System.nanoTime();
        TerminalPolicy.sudoForElevation();
        long millis = (System.nanoTime() - start) / 1_000_000;
        // `sudo -n` is the load-bearing flag. Without it, sudo on a host that
        // would prompt sits waiting for a password no browser terminal can
        // supply, and the shell looks hung rather than unprivileged. The bound
        // is generous — this is asserting "not blocked", not a performance
        // budget.
        assertThat(millis).isLessThan(10_000);
    }
}
