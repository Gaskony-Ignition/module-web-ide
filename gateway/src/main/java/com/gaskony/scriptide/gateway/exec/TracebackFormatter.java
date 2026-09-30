package com.gaskony.scriptide.gateway.exec;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.python.core.PyException;
import org.python.core.PyFrame;
import org.python.core.PyObject;
import org.python.core.PyTraceback;
import org.python.core.PyTuple;

/**
 * Turns a failed execution into frames the editor can make clickable.
 *
 * <h2>Structurally, never by regex</h2>
 *
 * <p>The rendered traceback text is for humans. Parsing it back breaks on
 * non-ASCII paths and on nested exceptions, and it is the approach everyone
 * reaches for first. {@link PyTraceback} is a linked list of frames with the
 * filename, function and line already separated — walk that instead.</p>
 *
 * <h2>Which accessor, and why it depends on the call style</h2>
 *
 * <p>{@code ScriptManager.runCode} wraps failures in a {@code JythonExecException}
 * whose {@code getPyCause()} yields the {@link PyException}. This module does not
 * use that path — it calls {@code Py.runCode} directly (see
 * {@link PrivateStateRunner}), which throws the {@link PyException} itself. So the
 * traceback is read straight off the exception. Verified in spike S1.</p>
 *
 * <h2>Frame filenames</h2>
 *
 * <p>The submitted {@code fileName} appears verbatim in the top frame, so a
 * reversible token maps a frame back to its editor tab. A frame inside a project
 * library module is spelled {@code <module:dotted.name>} — measured, and the
 * reason a library frame can be made clickable at all.</p>
 *
 * <p>That token is ours, not the user's, and it must never reach the screen. It
 * is replaced with a display label wherever it appears in free text — see
 * {@link #displayLabel}. On 1.4.3 a syntax error put
 * {@code <script-ide:Mining_Demo:console>} in front of the user verbatim.</p>
 *
 * <h2>Syntax errors are not tracebacks</h2>
 *
 * <p>A compile failure has no frames at all, and its {@code value} is the tuple
 * {@code (msg, (filename, lineno, offset, text))}. Rendering that with
 * {@code toString()} — which is what 1.4.3 did — shows the user a raw PyTuple
 * complete with the internal token and the escaped source line. So the tuple is
 * unpacked here into {@code message} plus top-level {@code line}, {@code offset}
 * and {@code text}, which is everything a caret needs.</p>
 */
public final class TracebackFormatter {

    /** Prefix Ignition gives a frame inside a project library module. */
    static final String LIBRARY_FRAME_PREFIX = "<module:";

    /** Guard against a pathological or cyclic traceback chain. */
    private static final int MAX_FRAMES = 50;

    private TracebackFormatter() { /* utility */ }

    /**
     * Describe a failure as JSON: the exception type, its message, and the frames.
     *
     * @param failure   what the execution threw
     * @param fileName  the token the source was submitted under, so frames
     *                  belonging to the edited document can be flagged
     * @param lineOffset number of lines prepended to the submitted source (for a
     *                  selection run) — subtracted so reported lines match the
     *                  editor
     */
    public static JsonObject describe(Throwable failure, String fileName, int lineOffset) {
        JsonObject out = new JsonObject();
        if (failure == null) {
            return out;
        }

        PyException py = findPyException(failure);
        if (py == null) {
            // A Java-level failure with no Python frames — still report it rather
            // than showing the user a blank Problems panel.
            out.addProperty("type", failure.getClass().getSimpleName());
            out.addProperty("message", String.valueOf(failure.getMessage()));
            out.add("frames", new JsonArray());
            return out;
        }

        String label = displayLabel(fileName);
        out.addProperty("type", typeName(py));
        out.addProperty("rendered", sanitise(safeToString(py), fileName, label));

        SyntaxError syntax = syntaxErrorOf(py);
        if (syntax == null) {
            out.addProperty("message", sanitise(messageOf(py), fileName, label));
        } else {
            out.addProperty("message", sanitise(syntax.message(), fileName, label));
            // The line the compiler objected to, in the EDITOR's numbering — a
            // selection run prepends blank lines and the client must not have to
            // know that.
            out.addProperty("line", Math.max(1, syntax.line() - lineOffset));
            out.addProperty("offset", syntax.offset());
            out.addProperty("text", syntax.text());
        }

        JsonArray frames = new JsonArray();
        PyTraceback tb = py.traceback;
        int guard = 0;
        while (tb != null && guard++ < MAX_FRAMES) {
            JsonObject frame = new JsonObject();
            String file = null;
            String function = null;
            PyFrame f = tb.tb_frame;
            if (f != null && f.f_code != null) {
                file = f.f_code.co_filename;
                function = f.f_code.co_name;
            }
            frame.addProperty("file", file);
            frame.addProperty("function", function);
            frame.addProperty("line", Math.max(1, tb.tb_lineno - lineOffset));
            // Tell the client what it can navigate to, rather than making it
            // re-derive the same string rules.
            frame.addProperty("isSubmitted", fileName != null && fileName.equals(file));
            frame.addProperty("libraryModule", libraryModuleOf(file));
            frames.add(frame);
            tb = (tb.tb_next instanceof PyTraceback next) ? next : null;
        }
        out.add("frames", frames);
        return out;
    }

    /**
     * The dotted module name of a project-library frame, or null.
     *
     * <p>{@code <module:util.helpers>} → {@code util.helpers}, which maps back to
     * the resource {@code ignition/script-python/util/helpers}.</p>
     */
    static String libraryModuleOf(String coFilename) {
        if (coFilename == null
            || !coFilename.startsWith(LIBRARY_FRAME_PREFIX)
            || !coFilename.endsWith(">")) {
            return null;
        }
        String inner = coFilename.substring(LIBRARY_FRAME_PREFIX.length(), coFilename.length() - 1);
        return inner.isBlank() ? null : inner;
    }

    /** The first PyException in the cause chain, if any. */
    private static PyException findPyException(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof PyException py) {
                return py;
            }
            if (c.getCause() == c) {
                break;
            }
        }
        return null;
    }

    /** The parts of a {@code SyntaxError} that a caret needs. */
    record SyntaxError(String message, int line, int offset, String text) {
    }

    /**
     * Unpack a {@code SyntaxError}'s value tuple, or null when it is not one.
     *
     * <p>Matched on SHAPE — {@code (msg, (file, line, offset, text))} — rather than
     * on the exception's type name, because the same tuple is what any caller has
     * to unpack and the shape is the thing that actually matters. Anything that
     * does not fit falls through to the ordinary message path.</p>
     */
    static SyntaxError syntaxErrorOf(PyException py) {
        try {
            if (!(py.value instanceof PyTuple outer) || outer.size() != 2) {
                return null;
            }
            if (!(outer.pyget(1) instanceof PyTuple detail) || detail.size() < 4) {
                return null;
            }
            String message = String.valueOf(outer.pyget(0));
            int line = intOf(detail.pyget(1), 1);
            int offset = intOf(detail.pyget(2), 0);
            PyObject text = detail.pyget(3);
            return new SyntaxError(message, line, offset,
                text == null ? "" : String.valueOf(text));
        } catch (RuntimeException e) {
            // A malformed value must cost the caret, never the error report.
            return null;
        }
    }

    private static int intOf(PyObject value, int fallback) {
        try {
            return value == null ? fallback : value.asInt();
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    /**
     * What a frame in the submitted source should be CALLED on screen.
     *
     * <p>{@code <script-ide:Proj:console>} → {@code <console>};
     * {@code <script-ide:Proj:ignition/script-python/util/helpers>} → that path.
     * The token is an implementation detail of this module and means nothing to
     * the person reading the error.</p>
     */
    static String displayLabel(String fileName) {
        if (fileName == null || !fileName.startsWith("<script-ide:") || !fileName.endsWith(">")) {
            return "<console>";
        }
        String inner = fileName.substring("<script-ide:".length(), fileName.length() - 1);
        int colon = inner.indexOf(':');
        String target = colon < 0 ? inner : inner.substring(colon + 1);
        return target.isBlank() || "console".equals(target) ? "<console>" : target;
    }

    /** Replace every occurrence of our own token with the display label. */
    private static String sanitise(String text, String fileName, String label) {
        if (text == null) {
            return "";
        }
        return fileName == null ? text : text.replace(fileName, label);
    }

    private static String typeName(PyException py) {
        try {
            if (py.type != null) {
                Object name = py.type.__findattr__("__name__");
                if (name != null) {
                    return name.toString();
                }
                return py.type.toString();
            }
        } catch (RuntimeException e) {
            // Deliberately quiet: a broken exception type must not replace the
            // user's error with one of ours.
        }
        return "Error";
    }

    private static String messageOf(PyException py) {
        try {
            return py.value == null ? "" : py.value.toString();
        } catch (RuntimeException e) {
            return "";
        }
    }

    private static String safeToString(PyException py) {
        try {
            return py.toString();
        } catch (RuntimeException e) {
            return "";
        }
    }
}
