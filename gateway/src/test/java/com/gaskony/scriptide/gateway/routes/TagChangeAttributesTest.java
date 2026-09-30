package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Tag Change attribute validation (R4, 1.16.0).
 *
 * <p>The type was body-only from 1.1.0 until the shape was measured on a real
 * resource. These are the two ARRAY attributes, which no other event type has —
 * everything else on a script resource is a scalar, so the array path is new
 * code rather than a case in existing code.</p>
 */
class TagChangeAttributesTest {

    /** The validator is private; the rule it enforces is what matters here. */
    private static Object coerce(String typeId, String name, String json) throws Exception {
        Method method = null;
        for (Method candidate : ScriptAttributesRouteHandler.class.getDeclaredMethods()) {
            if (candidate.getName().equals("validate")) {
                method = candidate;
                break;
            }
        }
        assertThat(method).as("validate(...) still exists").isNotNull();
        method.setAccessible(true);
        try {
            // validate(name, value, typeId) — the argument order is not the one
            // the call site reads like, which is worth the explicit note here.
            return method.invoke(null, name, JsonParser.parseString(json), typeId);
        } catch (InvocationTargetException e) {
            throw (Exception) e.getCause();
        }
    }

    @Test
    @DisplayName("paths is an array of strings, and comes back as a list")
    @SuppressWarnings("unchecked")
    void acceptsTagPaths() throws Exception {
        Object out = coerce("tag-change", "paths", "[\"[default]A201\", \"[default]B7\"]");
        assertThat((java.util.List<String>) out)
            .containsExactly("[default]A201", "[default]B7");
    }

    @Test
    @DisplayName("a duplicate tag path is dropped — subscribing twice doubles every event")
    @SuppressWarnings("unchecked")
    void dropsDuplicatePaths() throws Exception {
        Object out = coerce("tag-change", "paths", "[\"[default]A\", \"[default]A\"]");
        assertThat((java.util.List<String>) out).containsExactly("[default]A");
    }

    @Test
    @DisplayName("a blank tag path is refused rather than stored")
    void refusesBlankPath() {
        assertThatThrownBy(() -> coerce("tag-change", "paths", "[\"\"]"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("cannot be blank");
    }

    @Test
    @DisplayName("paths must be an array, not a comma-joined string")
    void refusesAStringForPaths() {
        // Storing it as a string would round-trip through this module and be
        // unreadable to the Designer — the worse half of a wrong resource shape,
        // because it looks like it worked.
        assertThatThrownBy(() -> coerce("tag-change", "paths", "\"[default]A,[default]B\""))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("array of strings");
    }

    @Test
    @DisplayName("changeTypes accepts exactly the three the platform defines")
    @SuppressWarnings("unchecked")
    void acceptsChangeTypes() throws Exception {
        Object out = coerce("tag-change", "changeTypes",
            "[\"ValueChange\", \"QualityChange\", \"TimestampChange\"]");
        assertThat((java.util.List<String>) out).hasSize(3);
    }

    @Test
    @DisplayName("an unrecognised change type is refused, not stored and ignored")
    void refusesUnknownChangeType() {
        // The platform ignores one silently, so the script sits there configured
        // and never fires — the exact failure mode this type was held back for.
        assertThatThrownBy(() -> coerce("tag-change", "changeTypes", "[\"AnyChange\"]"))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("must be one of");
    }

    @Test
    @DisplayName("enabled is still a boolean here")
    void acceptsEnabled() throws Exception {
        assertThat(coerce("tag-change", "enabled", "true")).isEqualTo(true);
    }
}
