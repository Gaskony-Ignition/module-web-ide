package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The execution gates. These are security controls, so the tests are about what
 * happens when the configuration is WRONG, not only when it is right.
 */
class ExecPolicyTest {

    @AfterEach
    void clearProperties() {
        System.clearProperty(ExecPolicy.PROP_ENABLED);
        System.clearProperty(ExecPolicy.PROP_REQUIRE_ADMIN);
        System.clearProperty(ExecPolicy.PROP_ACKNOWLEDGE_RISK);
        System.clearProperty(ExecPolicy.PROP_TIMEOUT_SECONDS);
        System.clearProperty(ExecPolicy.PROP_MAX_CONCURRENT);
    }

    @Test
    @DisplayName("execution is on by default and the admin requirement is on by default")
    void secureDefaults() {
        assertThat(ExecPolicy.executionEnabled()).isTrue();
        assertThat(ExecPolicy.requireAdmin()).isTrue();
    }

    @Test
    @DisplayName("the kill switch turns execution off")
    void killSwitchWorks() {
        System.setProperty(ExecPolicy.PROP_ENABLED, "false");
        assertThat(ExecPolicy.executionEnabled()).isFalse();
    }

    @Test
    @DisplayName("dropping the admin requirement needs BOTH flags")
    void adminRequirementNeedsTwoFlags() {
        // One flag alone must not hand arbitrary code execution to every user —
        // that should not be reachable by a single typo'd property.
        System.setProperty(ExecPolicy.PROP_REQUIRE_ADMIN, "false");
        assertThat(ExecPolicy.requireAdmin())
            .as("requireAdmin=false alone must be ignored")
            .isTrue();

        System.setProperty(ExecPolicy.PROP_ACKNOWLEDGE_RISK, "true");
        assertThat(ExecPolicy.requireAdmin())
            .as("both flags set — the operator has explicitly accepted this")
            .isFalse();
    }

    @Test
    @DisplayName("a malformed boolean falls back to the SECURE value, not to false")
    void malformedBooleanFailsSecure() {
        // The dangerous bug: "yes"/"1"/"TRUE " parsed loosely as false would
        // silently disable a control. Anything unrecognised keeps the default.
        System.setProperty(ExecPolicy.PROP_ENABLED, "yes");
        assertThat(ExecPolicy.executionEnabled()).isTrue();

        System.setProperty(ExecPolicy.PROP_REQUIRE_ADMIN, "0");
        System.setProperty(ExecPolicy.PROP_ACKNOWLEDGE_RISK, "true");
        assertThat(ExecPolicy.requireAdmin())
            .as("an unparseable requireAdmin must stay TRUE")
            .isTrue();
    }

    @Test
    @DisplayName("timeout and pool size are clamped to a sane range")
    void numericsAreClamped() {
        System.setProperty(ExecPolicy.PROP_TIMEOUT_SECONDS, "999999");
        assertThat(ExecPolicy.timeoutSeconds()).isEqualTo(ExecPolicy.MAX_TIMEOUT_SECONDS);

        System.setProperty(ExecPolicy.PROP_TIMEOUT_SECONDS, "0");
        assertThat(ExecPolicy.timeoutSeconds()).isEqualTo(1);

        System.setProperty(ExecPolicy.PROP_MAX_CONCURRENT, "1000");
        assertThat(ExecPolicy.maxConcurrent()).isEqualTo(ExecPolicy.MAX_MAX_CONCURRENT);

        System.setProperty(ExecPolicy.PROP_MAX_CONCURRENT, "-5");
        assertThat(ExecPolicy.maxConcurrent()).isEqualTo(1);
    }

    @Test
    @DisplayName("a non-numeric value falls back to the default rather than throwing")
    void malformedNumberFallsBack() {
        System.setProperty(ExecPolicy.PROP_TIMEOUT_SECONDS, "soon");
        assertThat(ExecPolicy.timeoutSeconds()).isEqualTo(ExecPolicy.DEFAULT_TIMEOUT_SECONDS);
    }
}
