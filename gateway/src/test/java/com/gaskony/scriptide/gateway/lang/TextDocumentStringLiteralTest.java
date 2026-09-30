package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@link TextDocument#stringLiteralAt} — the trigger for Group 3's live
 * tag-path and database completion, so wrong
 * detection here means the whole feature fires in the wrong place or not at
 * all. Exhaustive on purpose.
 */
class TextDocumentStringLiteralTest {

    private static TextDocument doc(String text) {
        return new TextDocument("ignition://p/x", text, 1);
    }

    @Test
    @DisplayName("inside a single-quoted string")
    void insideSingleQuoted() {
        TextDocument d = doc("x = 'abc\n");
        Optional<TextDocument.StringLiteral> literal = d.stringLiteralAt(0, 8);
        assertThat(literal).isPresent();
        assertThat(literal.get().content()).isEqualTo("abc");
        assertThat(literal.get().quote()).isEqualTo('\'');
    }

    @Test
    @DisplayName("inside a double-quoted string")
    void insideDoubleQuoted() {
        TextDocument d = doc("x = \"abc\n");
        Optional<TextDocument.StringLiteral> literal = d.stringLiteralAt(0, 8);
        assertThat(literal).isPresent();
        assertThat(literal.get().content()).isEqualTo("abc");
        assertThat(literal.get().quote()).isEqualTo('"');
    }

    @Test
    @DisplayName("before any quote is opened")
    void outsideBeforeQuote() {
        TextDocument d = doc("x = 'abc'\n");
        // Cursor sits on "x = " — nothing has been opened yet.
        assertThat(d.stringLiteralAt(0, 2)).isEmpty();
    }

    @Test
    @DisplayName("after a string has already closed on the line")
    void outsideAfterClosedString() {
        TextDocument d = doc("x = 'abc' + y\n");
        // Cursor sits in " + y", well past the closing quote.
        assertThat(d.stringLiteralAt(0, 13)).isEmpty();
    }

    @Test
    @DisplayName("an escaped quote does not close the string")
    void escapedQuoteDoesNotClose() {
        TextDocument d = doc("x = 'it\\'s a test'\n");
        // Cursor placed just after "test", still inside the string: the
        // backslash-quote at index 7-8 must not have ended it early.
        int cursor = "x = 'it\\'s a test".length();
        Optional<TextDocument.StringLiteral> literal = d.stringLiteralAt(0, cursor);
        assertThat(literal).isPresent();
        assertThat(literal.get().content()).isEqualTo("it\\'s a test");
        assertThat(literal.get().quote()).isEqualTo('\'');
    }

    @Test
    @DisplayName("a quote inside a # comment opens nothing")
    void quoteInsideCommentIsInert() {
        TextDocument d = doc("# it's not a string\n");
        // Cursor placed after the apostrophe in "it's" — a naive scan would
        // think a string just opened there.
        int cursor = "# it's".length();
        assertThat(d.stringLiteralAt(0, cursor)).isEmpty();
    }

    @Test
    @DisplayName("a triple-quoted string answers empty, not a guess")
    void tripleQuotedIsRefused() {
        TextDocument single = doc("x = '''abc\n");
        assertThat(single.stringLiteralAt(0, 10)).isEmpty();
        TextDocument dbl = doc("x = \"\"\"abc\n");
        assertThat(dbl.stringLiteralAt(0, 10)).isEmpty();
        // Even right after the three opening quotes, before any content.
        assertThat(single.stringLiteralAt(0, 7)).isEmpty();
    }

    @Test
    @DisplayName("an unterminated single-line string still answers - it is simply still being typed")
    void unterminatedStringStillAnswers() {
        // This is the ordinary live-typing case: nothing has closed the
        // string yet because the user has not typed the closing quote.
        TextDocument d = doc("x = system.tag.readBlocking([\"[default]Are\n");
        int cursor = "x = system.tag.readBlocking([\"[default]Are".length();
        Optional<TextDocument.StringLiteral> literal = d.stringLiteralAt(0, cursor);
        assertThat(literal).isPresent();
        assertThat(literal.get().content()).isEqualTo("[default]Are");
        assertThat(literal.get().quote()).isEqualTo('"');
    }

    @Test
    @DisplayName("a string prefix letter like u/r does not confuse detection")
    void stringPrefixLetterIsHarmless() {
        TextDocument d = doc("x = r'abc\n");
        Optional<TextDocument.StringLiteral> literal = d.stringLiteralAt(0, 9);
        assertThat(literal).isPresent();
        assertThat(literal.get().content()).isEqualTo("abc");
        assertThat(literal.get().quote()).isEqualTo('\'');
    }

    @Test
    @DisplayName("cursor immediately after the opening quote gives empty content")
    void emptyContentRightAfterOpen() {
        TextDocument d = doc("x = '\n");
        Optional<TextDocument.StringLiteral> literal = d.stringLiteralAt(0, 5);
        assertThat(literal).isPresent();
        assertThat(literal.get().content()).isEmpty();
    }
}
