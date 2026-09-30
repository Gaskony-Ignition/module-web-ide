package com.gaskony.scriptide.common;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Locks down the measured differences between script resource types.
 *
 * <p>These are not tautologies. Every assertion here encodes something that was
 * measured from a resource the real Designer wrote and that a reasonable person
 * would otherwise get wrong by generalising from a sibling type.</p>
 */
class ScriptResourceTypesTest {

    @Test
    @DisplayName("a timer's threading flag is sharedThread; a message handler's is threadType")
    void threadingAttributesDifferBetweenTypes() {
        // The single most tempting thing to "tidy up" into one shared attribute.
        // They are different names AND different JSON types.
        var timer = ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_TIMER).orElseThrow();
        var message = ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_MESSAGE).orElseThrow();

        assertThat(timer.attributeAllowlist()).contains("sharedThread").doesNotContain("threadType");
        assertThat(message.attributeAllowlist()).contains("threadType").doesNotContain("sharedThread");
    }

    @Test
    @DisplayName("startup, shutdown and update are singletons; the rest are not")
    void singletonsAreMarked() {
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_STARTUP)
            .orElseThrow().singleton()).isTrue();
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_SHUTDOWN)
            .orElseThrow().singleton()).isTrue();
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_UPDATE)
            .orElseThrow().singleton()).isTrue();
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_TIMER)
            .orElseThrow().singleton()).isFalse();
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_SCRIPT_PYTHON)
            .orElseThrow().singleton()).isFalse();
    }

    @Test
    @DisplayName("Tag Change carries exactly the three attributes measured on a real resource")
    void tagChangeAttributesAreMeasured() {
        // Body-only from 1.1.0 to 1.15.x, because the tag-path list's attribute
        // name was unknown and guessing it would put a value on a live gateway
        // that the Designer never reads — configured-looking and inert.
        //
        // Measured 06/09/2026 off `_wd_scratch_/ignition/tag-change/...`, a real
        // resource written by the platform:
        //
        //   "paths": ["[default]A201"],
        //   "changeTypes": ["ValueChange", "QualityChange", "TimestampChange"],
        //   "enabled": true
        //
        // EXACTLY these three. If you are here to add a fourth from analogy, go
        // and measure it instead; that is a smaller job than the bug it prevents.
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_TAG_CHANGE)
            .orElseThrow().attributeAllowlist())
            .containsExactlyInAnyOrder("enabled", "paths", "changeTypes");
    }

    @Test
    @DisplayName("Scheduled carries cronExpression — without it the type is unconfigurable")
    void scheduledCarriesCron() {
        // Measured off a real resource: {"cronExpression": "*/30 * * * *",
        // "enabled": true}. Until 1.1.0 this was empty, which meant a scheduled
        // script could be edited here but never given a schedule.
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_SCHEDULED)
            .orElseThrow().attributeAllowlist())
            .containsExactlyInAnyOrder("enabled", "cronExpression");
    }

    @Test
    @DisplayName("every event type that can be disabled exposes `enabled`")
    void enabledIsMeasuredNotInferred() {
        // `enabled` is the one attribute every measured gateway event type
        // carries, and it is the tick box the Designer shows on all of them.
        // Verified by round-tripping a write through a real gateway, not by
        // reasoning from Startup — see docs/STATE.md.
        for (String typeId : new String[] {
            ScriptResourceTypes.TYPE_TIMER,
            ScriptResourceTypes.TYPE_MESSAGE,
            ScriptResourceTypes.TYPE_STARTUP,
            ScriptResourceTypes.TYPE_SHUTDOWN,
            ScriptResourceTypes.TYPE_UPDATE,
            ScriptResourceTypes.TYPE_SCHEDULED,
        }) {
            assertThat(ScriptResourceTypes.byTypeId(typeId).orElseThrow().attributeAllowlist())
                .as("%s must expose the Designer's Enabled tick box", typeId)
                .contains("enabled");
        }
        // The Project Library is not an event and has no enabled flag — asserting
        // its ABSENCE keeps the loop above from being a vacuous "contains".
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_SCRIPT_PYTHON)
            .orElseThrow().attributeAllowlist()).doesNotContain("enabled");
    }

    @Test
    @DisplayName("each type's create-time data key matches what the Designer writes")
    void createKeysMatchTheDesigner() {
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_SCRIPT_PYTHON)
            .orElseThrow().createKey()).isEqualTo("code.py");
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_TIMER)
            .orElseThrow().createKey()).isEqualTo("handleTimerEvent.py");
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_MESSAGE)
            .orElseThrow().createKey()).isEqualTo("handleMessage.py");
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_SCHEDULED)
            .orElseThrow().createKey()).isEqualTo("handleScheduleEvent.py");
        assertThat(ScriptResourceTypes.byTypeId(ScriptResourceTypes.TYPE_STARTUP)
            .orElseThrow().createKey()).isEqualTo("onStartup.py");
    }

    @Test
    @DisplayName("only ignition/* script types are editable — not views, tags or anything else")
    void onlyScriptTypesAreEditable() {
        assertThat(ScriptResourceTypes.isEditable("ignition", "script-python")).isTrue();
        assertThat(ScriptResourceTypes.isEditable("ignition", "timer")).isTrue();
        // The routes are generic over <moduleId>/<typeId>, so this guard is what
        // stops an Administrator rewriting a Perspective view through the script
        // editor's endpoint.
        assertThat(ScriptResourceTypes.isEditable("com.inductiveautomation.perspective", "views"))
            .isFalse();
        assertThat(ScriptResourceTypes.isEditable("ignition", "named-query")).isFalse();
        assertThat(ScriptResourceTypes.isEditable("ignition", "nonsense")).isFalse();
    }

    @Test
    @DisplayName("hintScope values are the ApplicationScope bitmask, not an ordinal")
    void hintScopeValuesAreTheBitmask() {
        // 0=None, 1=Gateway, 2=Designer, 7=All. Notably 3..6 are NOT valid, which
        // an ordinal-style enum would happily allow.
        assertThat(ScriptResourceTypes.HINT_SCOPE_VALUES).containsExactlyInAnyOrder(0, 1, 2, 7);
    }

    @Test
    @DisplayName("threadType values are case-sensitive exactly as the Designer writes them")
    void threadTypeValuesAreCaseSensitive() {
        assertThat(ScriptResourceTypes.THREAD_TYPE_VALUES).containsExactlyInAnyOrder(
            "Shared", "Dedicated");
        assertThat(ScriptResourceTypes.THREAD_TYPE_VALUES).doesNotContain("shared", "dedicated");
    }
}
