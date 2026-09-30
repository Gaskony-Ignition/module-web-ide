package com.gaskony.scriptide.gateway.lang;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * One open document, and the position arithmetic every LSP feature depends on.
 *
 * <h2>Positions are UTF-16 code units, not characters and not bytes</h2>
 *
 * <p>That is the LSP specification, and it is the detail that silently corrupts an
 * editor integration if you get it wrong. A line containing an emoji or any
 * character outside the Basic Multilingual Plane occupies TWO UTF-16 units per
 * character, so a naive codepoint-based offset drifts and every completion,
 * diagnostic and go-to-definition after it lands in the wrong place. Java's own
 * {@code String} is UTF-16 internally, so counting {@code char}s is correct here
 * — but only because that happens to match, and it is worth knowing why rather
 * than by luck.</p>
 */
public final class TextDocument {

    private final String uri;
    private String text;
    private int version;

    /** Start offset of each line, rebuilt whenever the text changes. */
    private int[] lineStarts;

    public TextDocument(String uri, String text, int version) {
        this.uri = uri;
        this.version = version;
        setText(text);
    }

    public String uri() {
        return uri;
    }

    public String text() {
        return text;
    }

    public int version() {
        return version;
    }

    public void setVersion(int version) {
        this.version = version;
    }

    /** Replace the whole document (LSP full sync). */
    public void setText(String newText) {
        this.text = newText == null ? "" : newText;
        this.lineStarts = computeLineStarts(this.text);
    }

    /**
     * Apply one incremental change.
     *
     * <p>Ranges are half-open: the end position is exclusive. Applying them in the
     * order the client sent them matters — each is expressed against the document
     * as it stood after the previous one.</p>
     */
    public void applyChange(int startLine, int startChar, int endLine, int endChar,
                            String replacement) {
        int start = offsetOf(startLine, startChar);
        int end = offsetOf(endLine, endChar);
        if (end < start) {
            int swap = start;
            start = end;
            end = swap;
        }
        setText(text.substring(0, start) + replacement + text.substring(end));
    }

    /** Zero-based line count. A document always has at least one line. */
    public int lineCount() {
        return lineStarts.length;
    }

    /**
     * Character offset of a (line, character) position, clamped into the document.
     *
     * <p>Clamped rather than throwing: a client's position can legitimately lag the
     * document by a keystroke, and answering a slightly stale request at the
     * nearest valid spot is far better than failing the whole request.</p>
     */
    public int offsetOf(int line, int character) {
        if (line < 0) {
            return 0;
        }
        if (line >= lineStarts.length) {
            return text.length();
        }
        int lineStart = lineStarts[line];
        int lineEnd = (line + 1 < lineStarts.length) ? lineStarts[line + 1] : text.length();
        // Do not run past the newline into the next line.
        int maxChar = Math.max(0, lineEnd - lineStart);
        return lineStart + Math.min(Math.max(0, character), maxChar);
    }

    /** The text of one line, without its terminator. */
    public String lineText(int line) {
        if (line < 0 || line >= lineStarts.length) {
            return "";
        }
        int start = lineStarts[line];
        int end = (line + 1 < lineStarts.length) ? lineStarts[line + 1] : text.length();
        String raw = text.substring(start, end);
        return raw.endsWith("\n") ? raw.substring(0, raw.length() - 1) : raw;
    }

    /**
     * The dotted expression immediately before a position, e.g. {@code system.tag.re}
     * for a cursor just after {@code re}.
     *
     * <p>Deliberately lexical rather than parsed: a completion is requested while the
     * document is, by definition, half-written and usually not parseable at all.
     * Walking back over identifier characters and dots is what actually works at a
     * cursor. It stops at anything that cannot be part of a dotted name, so a call
     * argument or a string literal does not bleed into the prefix.</p>
     */
    public String dottedPrefixAt(int line, int character) {
        String lineContent = lineText(line);
        int end = Math.min(Math.max(0, character), lineContent.length());
        int start = end;
        while (start > 0) {
            char c = lineContent.charAt(start - 1);
            if (Character.isLetterOrDigit(c) || c == '_' || c == '.') {
                start--;
            } else {
                break;
            }
        }
        return lineContent.substring(start, end);
    }

    /** One string literal's content up to some cursor, and which quote it used. */
    public record StringLiteral(String content, char quote) {
    }

    /**
     * If {@code character} sits inside a single-line string literal on
     * {@code line}, that literal's content up to the cursor and its quote
     * character; empty otherwise.
     *
     * <h2>Why this exists</h2>
     *
     * <p>A tag path or a piece of SQL is written INSIDE a Jython string
     * literal — {@code system.tag.readBlocking(["[default]Area/Tag"])} — so
     * the trigger for both kinds of live completion is "is the cursor inside
     * a string", which is a different question from the dotted-name walk
     * {@link #dottedPrefixAt} already does for API completions.</p>
     *
     * <h2>What this deliberately does not attempt</h2>
     *
     * <p>Like {@link #lineText} and {@link #dottedPrefixAt}, this looks at
     * exactly ONE line. A triple-quoted string ({@code '''} or {@code """})
     * is a genuinely multi-line construct, and a single-line scan cannot know
     * where one actually starts or ends without reading backward through the
     * whole document — so a triple-quote opener anywhere before the cursor
     * makes this answer empty rather than guessing wrong and popping a
     * tag-path menu open in the middle of a docstring. A PLAIN single- or
     * double-quoted string that has simply not been closed yet on this line is
     * not the same thing — that is the ordinary, expected state while someone
     * is mid-keystroke typing a tag path, and it still answers, using
     * whatever has been typed so far as the content.</p>
     *
     * <p>Escaping and comments are handled the way the Jython lexer would: a
     * backslash escapes the very next character, so {@code 'it\'s'} never
     * closes early on the escaped quote, and a {@code #} outside any string
     * starts a comment running to the end of the line — a quote character
     * inside a comment opens nothing. A string prefix letter such as
     * {@code u} or {@code r} needs no special handling: it is just an
     * ordinary character sitting before the quote that opens the string.</p>
     */
    public Optional<StringLiteral> stringLiteralAt(int line, int character) {
        String lineContent = lineText(line);
        int end = Math.min(Math.max(0, character), lineContent.length());

        char quote = 0;          // 0 == not currently inside a string
        int contentStart = -1;
        boolean escaped = false;
        boolean inComment = false;

        for (int i = 0; i < end; i++) {
            char c = lineContent.charAt(i);
            if (inComment) {
                continue;
            }
            if (quote != 0) {
                if (escaped) {
                    escaped = false;
                } else if (c == '\\') {
                    escaped = true;
                } else if (c == quote) {
                    quote = 0;
                    contentStart = -1;
                }
                continue;
            }
            if (c == '#') {
                inComment = true;
            } else if (c == '\'' || c == '"') {
                // A triple-quote opener is a multi-line construct this
                // single-line scan cannot safely resolve - see the Javadoc.
                if (i + 2 < lineContent.length()
                    && lineContent.charAt(i + 1) == c && lineContent.charAt(i + 2) == c) {
                    return Optional.empty();
                }
                quote = c;
                contentStart = i + 1;
            }
        }

        if (quote == 0 || contentStart < 0) {
            return Optional.empty();
        }
        return Optional.of(new StringLiteral(lineContent.substring(contentStart, end), quote));
    }

    private static int[] computeLineStarts(String text) {
        List<Integer> starts = new ArrayList<>();
        starts.add(0);
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                starts.add(i + 1);
            }
        }
        int[] out = new int[starts.size()];
        for (int i = 0; i < out.length; i++) {
            out[i] = starts.get(i);
        }
        return out;
    }
}
