package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The identifier matcher the unused report and find-references both stand on.
 *
 * <p>{@code unusedSymbols} itself needs a live {@code ProjectManager} and is
 * covered by `validate_v24_reach.py` against the real gateway. What is testable
 * here — and is the whole correctness of the report — is the rule that decides
 * whether a line MENTIONS a name: get that wrong in either direction and the
 * report either lists things that are used or hides things that are not.</p>
 */
class UnusedSymbolsTest {

    @Test
    @DisplayName("a bare call is a mention")
    void findsACall() {
        assertThat(ProjectIndex.identifierAt("\treturn compute(x)", "compute")).isEqualTo(8);
    }

    @Test
    @DisplayName("a longer word CONTAINING the name is not")
    void ignoresSubstrings() {
        // The difference between a usable report and a page of noise: `recompute`
        // must not count as a use of `compute`, or nothing is ever unused.
        assertThat(ProjectIndex.identifierAt("recompute(x)", "compute")).isEqualTo(-1);
        assertThat(ProjectIndex.identifierAt("compute_all(x)", "compute")).isEqualTo(-1);
        assertThat(ProjectIndex.identifierAt("x = computed", "compute")).isEqualTo(-1);
    }

    @Test
    @DisplayName("a real use LATER on a line whose first hit was a substring still counts")
    void keepsLookingPastASubstring() {
        // The loop that makes this work: returning -1 at the first textual hit
        // would lose the genuine reference after it, and the symbol would be
        // reported unused on the strength of the line that uses it.
        assertThat(ProjectIndex.identifierAt("recompute(compute(x))", "compute"))
            .isEqualTo(10);
    }

    @Test
    @DisplayName("a dotted use counts — the segment stands alone")
    void findsDottedUse() {
        assertThat(ProjectIndex.identifierAt("helpers.compute(1)", "compute")).isEqualTo(8);
    }

    @Test
    @DisplayName("a name in a string or a comment counts as a mention")
    void countsStringsAndComments() {
        // Deliberate, and stated on the report: this is a text scan. Over-counting
        // means "possibly used", which keeps a live function OFF a list someone
        // might delete from. Under-counting would be the dangerous direction.
        assertThat(ProjectIndex.identifierAt("# see compute", "compute")).isGreaterThan(0);
        assertThat(ProjectIndex.identifierAt("x = 'compute'", "compute")).isGreaterThan(0);
    }

    @Test
    @DisplayName("only a Python identifier can be searched at all")
    void refusesNonIdentifiers() {
        assertThat(ProjectIndex.isIdentifier("compute")).isTrue();
        assertThat(ProjectIndex.isIdentifier("_private")).isTrue();
        assertThat(ProjectIndex.isIdentifier("1st")).isFalse();
        assertThat(ProjectIndex.isIdentifier("has space")).isFalse();
        assertThat(ProjectIndex.isIdentifier("")).isFalse();
        assertThat(ProjectIndex.isIdentifier(null)).isFalse();
    }
}
