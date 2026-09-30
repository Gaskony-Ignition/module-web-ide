package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Position arithmetic — every LSP feature is wrong if this is wrong. */
class TextDocumentTest {

    private static TextDocument doc(String text) {
        return new TextDocument("ignition://p/x", text, 1);
    }

    @Test
    @DisplayName("offsets are UTF-16 code units, so an astral character counts as two")
    void offsetsAreUtf16CodeUnits() {
        // This is the LSP spec, and getting it wrong drifts every position after
        // the first non-BMP character - completions and diagnostics land in the
        // wrong place with nothing to indicate why.
        TextDocument d = doc("x = '😀'\ny = 1\n");
        assertThat("x = '😀'".length()).isEqualTo(8);
        // Character 8 on line 0 is the end of that line, not the middle of the emoji.
        assertThat(d.offsetOf(0, 8)).isEqualTo(8);
        assertThat(d.lineText(1)).isEqualTo("y = 1");
    }

    @Test
    @DisplayName("a position past the end of a line clamps to the line end, not the next line")
    void clampsWithinLine() {
        TextDocument d = doc("ab\ncdef\n");
        // Answering a slightly stale position at the nearest valid spot beats
        // failing the request; but it must not silently run into the next line.
        assertThat(d.offsetOf(0, 999)).isEqualTo(3);
        assertThat(d.offsetOf(1, 999)).isEqualTo(8);
    }

    @Test
    @DisplayName("a line past the end clamps to the document end")
    void clampsPastDocument() {
        TextDocument d = doc("ab\n");
        assertThat(d.offsetOf(99, 0)).isEqualTo(3);
        assertThat(d.lineText(99)).isEmpty();
    }

    @Test
    @DisplayName("an incremental change replaces exactly the given half-open range")
    void appliesIncrementalChange() {
        TextDocument d = doc("hello world\n");
        d.applyChange(0, 6, 0, 11, "there");
        assertThat(d.text()).isEqualTo("hello there\n");
    }

    @Test
    @DisplayName("an insertion is an empty range")
    void appliesInsertion() {
        TextDocument d = doc("ac\n");
        d.applyChange(0, 1, 0, 1, "b");
        assertThat(d.text()).isEqualTo("abc\n");
    }

    @Test
    @DisplayName("a multi-line change re-indexes the lines")
    void reindexesAfterMultiLineChange() {
        TextDocument d = doc("a\nb\nc\n");
        d.applyChange(0, 1, 2, 0, "X\nY\nZ\n");
        assertThat(d.lineText(0)).isEqualTo("aX");
        assertThat(d.lineText(1)).isEqualTo("Y");
        assertThat(d.lineText(2)).isEqualTo("Z");
    }

    @Test
    @DisplayName("the dotted prefix stops at anything that is not part of a name")
    void extractsDottedPrefix() {
        TextDocument d = doc("value = system.tag.re\n");
        assertThat(d.dottedPrefixAt(0, 21)).isEqualTo("system.tag.re");
        // A call argument must not bleed into the prefix.
        TextDocument call = doc("foo(system.tag.re\n");
        assertThat(call.dottedPrefixAt(0, 17)).isEqualTo("system.tag.re");
        // After a string literal the prefix legitimately begins with a dot: the base
        // is an expression, not a name. LanguageServer treats a leading dot as
        // "unresolvable" and offers nothing, rather than suggesting root-level
        // names as members of a string.
        TextDocument str = doc("x = 'abc'.up\n");
        assertThat(str.dottedPrefixAt(0, 12)).isEqualTo(".up");
    }

    @Test
    @DisplayName("a document with no trailing newline still has a last line")
    void handlesNoTrailingNewline() {
        // The Designer writes scripts WITHOUT a terminating newline, so this is the
        // normal case here, not an edge case.
        TextDocument d = doc("def f():\n\treturn 1");
        assertThat(d.lineCount()).isEqualTo(2);
        assertThat(d.lineText(1)).isEqualTo("\treturn 1");
    }
}
