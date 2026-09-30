package com.gaskony.scriptide.gateway.routes;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The client-supplied data key.
 *
 * <p>Defence in depth rather than a privilege boundary — reaching this code already
 * requires an Administrator with a valid CSRF token — but a data key has no business
 * containing a path separator, and this module should not be relying on the platform
 * to sanitise one.</p>
 */
class DataKeySafetyTest {

    @ParameterizedTest(name = "accepts: {0}")
    @ValueSource(strings = {
        "code.py", "handleTimerEvent.py", "handleMessage.py",
        "onStartup.py", "handleScheduleEvent.py", "onTagChange.py",
    })
    @DisplayName("every real script data key is accepted")
    void acceptsRealKeys(String key) {
        assertThat(ScriptResourceRouteHandler.isSafeDataKey(key)).isTrue();
    }

    @ParameterizedTest(name = "rejects: {0}")
    @ValueSource(strings = {
        "../../etc/passwd",
        "../code.py",
        "sub/code.py",
        "..\\code.py",
        "code.txt",
        "code.py.bak",
        "",
        "resource.json",
    })
    @DisplayName("anything that is not a plain .py filename is refused")
    void rejectsUnsafeKeys(String key) {
        assertThat(ScriptResourceRouteHandler.isSafeDataKey(key)).isFalse();
    }

    @Test
    @DisplayName("null is refused rather than throwing")
    void rejectsNull() {
        assertThat(ScriptResourceRouteHandler.isSafeDataKey(null)).isFalse();
    }

    @Test
    @DisplayName("an embedded NUL byte is refused")
    void rejectsNulByte() {
        // A NUL can truncate a filename in a native layer further down, turning
        // "code.py\u0000.txt" into something an extension check never saw.
        String withNul = "code.py" + '\u0000' + ".py";
        assertThat(ScriptResourceRouteHandler.isSafeDataKey(withNul)).isFalse();
    }

    @ParameterizedTest(name = "a Web Dev endpoint may carry: {0}")
    @ValueSource(strings = { "doGet.py", "three.min.js", "site.css", "index.html", "data.json" })
    @DisplayName("the Web Dev predicate widens the extension set, and nothing else")
    void acceptsWebDevAssets(String key) {
        // A Web Dev resource is the one place a data key is legitimately not a
        // .py file — `lib` ships three.min.js beside its handler.
        assertThat(ScriptResourceRouteHandler.isSafeWebDevDataKey(key)).isTrue();
    }

    @ParameterizedTest(name = "and still refuses: {0}")
    @ValueSource(strings = {
        "../../etc/passwd", "sub/three.min.js", "..\\x.js", "logo.png", "", "config.json#text",
    })
    @DisplayName("the wider set is still a plain filename this IDE can edit")
    void refusesUnsafeWebDevKeys(String key) {
        // config.json#text in particular: that is the SYNTHETIC key a text
        // resource's body is addressed by. A resource carrying it as a real
        // data key too would have two different bodies answering to one name,
        // and which one won would depend on the order of two branches.
        assertThat(ScriptResourceRouteHandler.isSafeWebDevDataKey(key)).isFalse();
    }

    @Test
    @DisplayName("an ordinary script key cannot reach the wider set")
    void scriptKeysStayPythonOnly() {
        // The two predicates are separate so that a non-Web-Dev write can never
        // put a .js file onto a Project Library resource.
        assertThat(ScriptResourceRouteHandler.isSafeDataKey("three.min.js")).isFalse();
        assertThat(ScriptResourceRouteHandler.isSafeDataKey("index.html")).isFalse();
    }

    @Test
    @DisplayName("the guard is not vacuous — a plainly valid key still passes")
    void guardIsNotVacuous() {
        // Guards that reject everything pass every rejection test. Assert the
        // positive case alongside, so a broken predicate cannot look healthy.
        assertThat(ScriptResourceRouteHandler.isSafeDataKey("code.py")).isTrue();
        // And a key that differs from a valid one ONLY by a separator is refused,
        // which is the property that actually matters.
        assertThat(ScriptResourceRouteHandler.isSafeDataKey("a/code.py")).isFalse();
    }
}
