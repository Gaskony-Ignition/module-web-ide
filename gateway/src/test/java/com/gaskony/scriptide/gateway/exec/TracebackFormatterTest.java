package com.gaskony.scriptide.gateway.exec;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompileMode;
import org.python.core.CompilerFlags;
import org.python.core.Py;
import org.python.core.PyCode;
import org.python.core.PyException;
import org.python.core.PyStringMap;
import org.python.core.PySystemState;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;

/**
 * Frame-filename parsing. The spellings asserted here were MEASURED against a
 * real gateway in spike S1 — they are not guesses, and getting them wrong makes
 * a traceback frame silently unclickable.
 */
class TracebackFormatterTest {

    @Test
    @DisplayName("a project-library frame yields its dotted module name")
    void parsesLibraryFrame() {
        // Measured: Ignition spells a frame inside a project library module
        // "<module:spikelib>". That is what makes it resolvable back to
        // ignition/script-python/spikelib and therefore clickable.
        assertThat(TracebackFormatter.libraryModuleOf("<module:spikelib>")).isEqualTo("spikelib");
        assertThat(TracebackFormatter.libraryModuleOf("<module:util.helpers>"))
            .isEqualTo("util.helpers");
    }

    @Test
    @DisplayName("anything that is not a library frame yields null")
    void rejectsNonLibraryFrames() {
        assertThat(TracebackFormatter.libraryModuleOf(
            "<script-ide:MyProject:ignition/script-python/util>")).isNull();
        assertThat(TracebackFormatter.libraryModuleOf("<string>")).isNull();
        assertThat(TracebackFormatter.libraryModuleOf(null)).isNull();
        assertThat(TracebackFormatter.libraryModuleOf("")).isNull();
        // Malformed: prefix present but never closed.
        assertThat(TracebackFormatter.libraryModuleOf("<module:unterminated")).isNull();
        // Empty module name is not a usable target.
        assertThat(TracebackFormatter.libraryModuleOf("<module:>")).isNull();
    }

    @Test
    @DisplayName("a non-Python failure is still reported rather than dropped")
    void describesNonPythonFailure() {
        // A Java-level failure has no Python frames. Returning an empty object
        // would leave the user with a blank panel and no idea anything broke.
        var out = TracebackFormatter.describe(
            new IllegalStateException("pool exhausted"), "<script-ide:P:console>", 0);
        assertThat(out.get("type").getAsString()).isEqualTo("IllegalStateException");
        assertThat(out.get("message").getAsString()).contains("pool exhausted");
        assertThat(out.getAsJsonArray("frames")).isEmpty();
    }

    @Test
    @DisplayName("a null failure describes nothing rather than throwing")
    void handlesNullFailure() {
        assertThat(TracebackFormatter.describe(null, "<f>", 0).size()).isZero();
    }

    // ---- the wire contract, against a REAL Jython failure -------------------
    //
    // These four are the pin. The client reads `type`, `message`, and each
    // frame's `file`/`function`/`line`/`isSubmitted`/`libraryModule` BY NAME, and
    // on 1.4.3 it read a different set of names entirely — `path`, `module`,
    // `functionName`, `isTarget` — so every frame rendered as "<console>, line N"
    // with no function and no exception type. Nothing caught it, because both
    // sides were internally consistent. web/src/api/__fixtures__/execError.json
    // holds the exact output asserted here and the Vitest suite renders from it.

    /** The token a console run is submitted under. Never shown to the user. */
    private static final String CONSOLE_FILE = "<script-ide:Demo:console>";

    /**
     * One entry from the shared fixture the Vitest suite renders from.
     *
     * <p>Read from {@code web/src/api/__fixtures__/execError.json} rather than
     * duplicated here, because a copy is exactly how the two sides drifted apart
     * in the first place. The path is relative to the gateway project directory,
     * which is Gradle's working directory for this task.</p>
     */
    private static JsonObject fixture(String key) {
        Path path = Path.of("..", "web", "src", "api", "__fixtures__", "execError.json");
        try {
            return JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8))
                .getAsJsonObject().getAsJsonObject(key);
        } catch (IOException e) {
            return fail("could not read " + path.toAbsolutePath() + ": " + e);
        }
    }

    private static PyException failureFrom(String source) {
        PySystemState.initialize();
        try {
            PyCode code = Py.compile_flags(source, CONSOLE_FILE, CompileMode.exec,
                new CompilerFlags());
            Py.runCode(code, null, new PyStringMap());
        } catch (PyException e) {
            return e;
        }
        return fail("that source was supposed to fail");
    }

    @Test
    @DisplayName("a real traceback serialises under the names the client reads")
    void pinsTheFrameContract() {
        JsonObject out = TracebackFormatter.describe(
            failureFrom("def f():\n    return 1/0\nf()\n"), CONSOLE_FILE, 0);

        assertThat(out.get("type").getAsString()).isEqualTo("ZeroDivisionError");
        assertThat(out.get("message").getAsString())
            .isEqualTo("integer division or modulo by zero");
        assertThat(out.has("rendered")).isTrue();

        var frames = out.getAsJsonArray("frames");
        assertThat(frames).hasSize(2);
        // Property names, spelled out. This is the assertion that fails if anyone
        // renames a field on either side.
        assertThat(frames.get(0).getAsJsonObject().keySet())
            .containsExactlyInAnyOrder("file", "function", "line", "isSubmitted",
                "libraryModule");

        JsonObject caller = frames.get(0).getAsJsonObject();
        assertThat(caller.get("function").getAsString()).isEqualTo("<module>");
        assertThat(caller.get("line").getAsInt()).isEqualTo(3);
        assertThat(caller.get("isSubmitted").getAsBoolean()).isTrue();
        assertThat(caller.get("libraryModule").isJsonNull()).isTrue();

        JsonObject inner = frames.get(1).getAsJsonObject();
        assertThat(inner.get("function").getAsString()).isEqualTo("f");
        assertThat(inner.get("line").getAsInt()).isEqualTo(2);
        assertThat(inner.get("file").getAsString()).isEqualTo(CONSOLE_FILE);

        // The WHOLE object, against the very file the client renders from. One
        // artefact, both languages: a rename on either side fails here rather
        // than showing up as an unclickable frame on a gateway three weeks later.
        assertThat(out).isEqualTo(fixture("zeroDivision"));
    }

    @Test
    @DisplayName("a selection run's line numbers come back in the editor's numbering")
    void subtractsTheSelectionOffset() {
        // Two blank lines were prepended, so the failure the user sees on line 1
        // was compiled as line 3.
        JsonObject out = TracebackFormatter.describe(
            failureFrom("\n\n1/0\n"), CONSOLE_FILE, 2);
        assertThat(out.getAsJsonArray("frames").get(0).getAsJsonObject()
            .get("line").getAsInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("a syntax error is unpacked, not printed as a raw tuple")
    void unpacksASyntaxError() {
        // 1.4.3 showed the user this, verbatim, internal token and all:
        //   ("mismatched input '\n' expecting COLON",
        //    ('<script-ide:Mining_Demo:console>', 2, 7, 'if True\n'))
        JsonObject out = TracebackFormatter.describe(
            failureFrom("if True\n  pass\n"), CONSOLE_FILE, 0);

        assertThat(out.get("type").getAsString()).isEqualTo("SyntaxError");
        String message = out.get("message").getAsString();
        assertThat(message).doesNotContain("script-ide").doesNotStartWith("(");
        assertThat(out.get("line").getAsInt()).isEqualTo(1);
        assertThat(out.has("offset")).isTrue();
        assertThat(out.get("text").getAsString()).contains("if True");
        // The whole error, including the rendered form, is free of our token.
        assertThat(out.toString()).doesNotContain("script-ide");
        assertThat(out).isEqualTo(fixture("syntaxError"));
    }

    @Test
    @DisplayName("the submitted token never reaches the user, whatever it is spelled")
    void neverLeaksTheToken() {
        assertThat(TracebackFormatter.displayLabel(CONSOLE_FILE)).isEqualTo("<console>");
        assertThat(TracebackFormatter.displayLabel(
            "<script-ide:Demo:ignition/script-python/util/helpers>"))
            .isEqualTo("ignition/script-python/util/helpers");
        assertThat(TracebackFormatter.displayLabel(null)).isEqualTo("<console>");
        assertThat(TracebackFormatter.displayLabel("nonsense")).isEqualTo("<console>");
    }
}
