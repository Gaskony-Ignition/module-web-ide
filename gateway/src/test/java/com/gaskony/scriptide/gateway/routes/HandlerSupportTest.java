package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Path encoding/decoding — the whole addressing contract for every script route. */
class HandlerSupportTest {

    @Test
    @DisplayName("a normal script path round-trips")
    void roundTripsNormalPath() {
        ResourcePath decoded = HandlerSupport.decodePath("ignition/script-python/util/helpers");
        assertThat(decoded.getResourceType().moduleId()).isEqualTo("ignition");
        assertThat(decoded.getResourceType().typeId()).isEqualTo("script-python");
        assertThat(decoded.getPath().toString()).isEqualTo("util/helpers");
        assertThat(HandlerSupport.encodePath(decoded))
            .isEqualTo("ignition/script-python/util/helpers");
    }

    @Test
    @DisplayName("a two-segment path addresses a type's SINGLETON, with an empty name")
    void twoSegmentPathIsSingleton() {
        // Startup/shutdown/update are stored exactly this way — no name segment at
        // all. The equivalent case (page-config) bit web-designer, so it is asserted
        // here rather than assumed.
        ResourcePath decoded = HandlerSupport.decodePath("ignition/startup");
        assertThat(decoded.getResourceType().typeId()).isEqualTo("startup");
        assertThat(decoded.getPath().toString()).isEmpty();
        assertThat(HandlerSupport.encodePath(decoded)).isEqualTo("ignition/startup");
    }

    @Test
    @DisplayName("a trailing empty name segment is treated as a singleton, not a blank name")
    void trailingSlashIsSingleton() {
        assertThat(HandlerSupport.decodePath("ignition/startup/").getPath().toString()).isEmpty();
    }

    @ParameterizedTest(name = "rejects traversal: {0}")
    @ValueSource(strings = {
        "ignition/script-python/../../etc/passwd",
        "ignition/script-python/util/../../..",
        "ignition/script-python/./x",
    })
    @DisplayName("path-traversal segments are refused outright")
    void rejectsTraversal(String raw) {
        assertThatThrownBy(() -> HandlerSupport.decodePath(raw))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("traversal");
    }

    @ParameterizedTest(name = "rejects malformed: [{0}]")
    @ValueSource(strings = {"", "   ", "ignition", "/script-python", "ignition/"})
    @DisplayName("a malformed path is refused rather than guessed at")
    void rejectsMalformed(String raw) {
        assertThatThrownBy(() -> HandlerSupport.decodePath(raw))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("null is refused")
    void rejectsNull() {
        assertThatThrownBy(() -> HandlerSupport.decodePath(null))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("a '!'-prefixed folder is a legitimate name and is preserved")
    void preservesBangFolders() {
        // Shared libraries are conventionally named "!Library" so they sort first.
        // Rejecting '!' along with '.' would break them.
        ResourcePath decoded = HandlerSupport.decodePath("ignition/script-python/!Library/util");
        assertThat(decoded.getPath().toString()).isEqualTo("!Library/util");
    }

    @Test
    @DisplayName("encodePath is the exact inverse of decodePath for a nested name")
    void encodeIsInverseOfDecode() {
        String raw = "ignition/message/Handlers/OnOrder";
        assertThat(HandlerSupport.encodePath(HandlerSupport.decodePath(raw))).isEqualTo(raw);
    }

    @Test
    @DisplayName("a ResourcePath built directly encodes the same way")
    void encodesDirectlyBuiltPath() {
        ResourcePath rp = new ResourcePath(new ResourceType("ignition", "timer"), "PlantSim");
        assertThat(HandlerSupport.encodePath(rp)).isEqualTo("ignition/timer/PlantSim");
    }

    // ==================== entity tags (1.6.0) ====================

    @Test
    @DisplayName("an ETag is emitted quoted, per RFC 9110")
    void quotesTheSignature() {
        assertThat(HandlerSupport.quoteEtag("abc123")).isEqualTo("\"abc123\"");
    }

    @ParameterizedTest(name = "If-Match [{0}] reduces to the bare signature")
    @ValueSource(strings = {"abc123", "\"abc123\"", "W/\"abc123\"", "  \"abc123\"  ", "W/ \"abc123\""})
    @DisplayName("every entity-tag form a client or proxy may send compares equal")
    void unquotesEveryForm(String raw) {
        // The whole point: a bare value from a page loaded before 1.6.0, a quoted
        // one from a page loaded after it, and a proxy's weak rewrite of either all
        // have to reach the comparison as the same string. Anything else is a
        // permanent 409 that reads on screen as somebody else editing the file.
        assertThat(HandlerSupport.unquoteEtag(raw)).isEqualTo("abc123");
    }

    @Test
    @DisplayName("a signature that merely contains a quote is not mangled")
    void leavesInteriorQuotesAlone() {
        assertThat(HandlerSupport.unquoteEtag("ab\"cd")).isEqualTo("ab\"cd");
    }

    @Test
    @DisplayName("null stays null — an absent If-Match is not an empty signature")
    void keepsNullNull() {
        // The write path distinguishes "no If-Match at all" (428) from a stale one
        // (409), so turning null into "" here would swap one error for the other.
        assertThat(HandlerSupport.unquoteEtag(null)).isNull();
    }
}
