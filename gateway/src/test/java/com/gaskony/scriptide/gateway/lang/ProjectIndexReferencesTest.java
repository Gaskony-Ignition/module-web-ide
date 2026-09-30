package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Identifier matching for {@code scriptide/references}.
 *
 * <p>The matching rule is the ONLY thing that separates this from a plain text
 * search, so it is the thing worth testing without a gateway. Everything above it
 * — reading resources, capping results, the JSON shape — is shared with
 * {@code searchText}, which the live LSP suite already exercises.</p>
 */
class ProjectIndexReferencesTest {

    @ParameterizedTest(name = "matches a whole identifier: [{0}]")
    @ValueSource(strings = {
        "compute()",
        "x = compute",
        "return compute(a, b)",
        "\tcompute()",
        "util.compute()",
        "value=compute",
        "[compute]",
        "compute",
    })
    @DisplayName("a whole-word occurrence is found wherever it sits on the line")
    void findsWholeIdentifiers(String line) {
        assertThat(ProjectIndex.identifierAt(line, "compute")).isGreaterThanOrEqualTo(0);
    }

    @ParameterizedTest(name = "does not match inside a longer word: [{0}]")
    @ValueSource(strings = {
        "recompute()",
        "compute_all()",
        "x = precomputed",
        "self._compute()",
        "computeTotal(a)",
    })
    @DisplayName("an identifier inside a longer name is not a reference")
    void ignoresSubstrings(String line) {
        // This is the whole reason references is not just searchText with a nicer
        // label: a project with `compute` and `recompute` in it returns a page of
        // noise from a substring search, and nobody reads the second page.
        assertThat(ProjectIndex.identifierAt(line, "compute")).isEqualTo(-1);
    }

    @Test
    @DisplayName("a real occurrence later on the line survives a substring earlier on it")
    void keepsLookingPastASubstring() {
        // The naive implementation — indexOf once, check the boundaries, give up —
        // loses this line entirely, and it is not a contrived one: a wrapper calling
        // the thing it wraps looks exactly like this.
        String line = "def recompute(x): return compute(x)";
        assertThat(ProjectIndex.identifierAt(line, "compute"))
            .isEqualTo(line.indexOf("return compute") + "return ".length());
    }

    @Test
    @DisplayName("the match column is the identifier's own column, not the line's start")
    void reportsTheColumnOfTheName() {
        assertThat(ProjectIndex.identifierAt("    total = compute()", "compute")).isEqualTo(12);
    }

    @ParameterizedTest(name = "refuses a non-identifier: [{0}]")
    @ValueSource(strings = {"", "1abc", "a b", "a.b", "a(", "*", " a"})
    @DisplayName("anything that is not a Python identifier is refused, not degraded")
    void refusesNonIdentifiers(String name) {
        // Falling back to a substring search here would answer a question nobody
        // asked under a name that promises something stricter.
        assertThat(ProjectIndex.isIdentifier(name)).isFalse();
    }

    @ParameterizedTest(name = "accepts an identifier: [{0}]")
    @ValueSource(strings = {"a", "_x", "compute", "compute2", "__init__", "CONSTANT"})
    @DisplayName("ordinary Python names are accepted")
    void acceptsIdentifiers(String name) {
        assertThat(ProjectIndex.isIdentifier(name)).isTrue();
    }

    @Test
    @DisplayName("null is refused rather than thrown on")
    void refusesNull() {
        assertThat(ProjectIndex.isIdentifier(null)).isFalse();
    }
}
