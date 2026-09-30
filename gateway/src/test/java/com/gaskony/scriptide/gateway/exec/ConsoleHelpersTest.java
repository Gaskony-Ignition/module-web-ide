package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompilerFlags;
import org.python.core.ParserFacade;

import java.io.StringReader;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * {@code console.py} is a constant, so what can be asserted is its shape — the
 * same bargain as {@code TestHarnessTest}. A syntax error in it would fail every
 * console session on the gateway with a traceback about our own source.
 */
class ConsoleHelpersTest {

    private static final String SOURCE = ConsoleHelpers.SOURCE;

    @Test
    @DisplayName("it parses as Jython 2.7")
    void parses() {
        // Python 2 on purpose: `print x` is a statement here, so a Python 3
        // parser is not the test either.
        ParserFacade.parseExpressionOrModule(
            new StringReader(SOURCE), "<console.py>", new CompilerFlags());
    }

    @Test
    @DisplayName("it is packaged, not empty")
    void isPresent() {
        // getResourceAsStream returning null is the packaging failure this estate
        // has already shipped once. It throws at class initialisation now; this
        // proves the file has content as well.
        assertThat(SOURCE).contains("def cprint(");
        assertThat(SOURCE).contains("def jsonPrint(");
    }

    @Test
    @DisplayName("it defines exactly the names it advertises")
    void definesWhatItSays() {
        for (String name : ConsoleHelpers.NAMES) {
            assertThat(SOURCE).as("console.py defines " + name).contains("def " + name + "(");
        }
    }

    @Test
    @DisplayName("a colour that will not parse prints plainly rather than raising")
    void aBadColourIsNotFatal() {
        // A colour is not worth failing somebody's print for, and the failure
        // would land on the line they were trying to read.
        assertThat(SOURCE).contains("except ValueError:");
        assertThat(SOURCE).contains("if not prefix:");
    }

    @Test
    @DisplayName("jsonPrint falls back to repr rather than refusing")
    void jsonPrintFallsBack() {
        // A Dataset, a QualifiedValue and any Java object are not JSON. Refusing
        // to print is the wrong answer to "show me what this is".
        assertThat(SOURCE).contains("print repr(value)");
    }

    @Test
    @DisplayName("it never catches bare, so a Stop is not swallowed")
    void noBareExcept() {
        assertThat(SOURCE).doesNotContain("except:");
    }

    @Test
    @DisplayName("it writes through print, so the run's own stream is resolved at call time")
    void printsRatherThanHoldingAStream() {
        // Holding a reference to sys.stdout at definition time would bind the
        // namespace's stream once; `print` resolves through the thread's
        // PySystemState on every call, which is what makes a function defined
        // when the namespace was built write to the run that calls it.
        assertThat(SOURCE).doesNotContain("_sys.stdout");
        assertThat(SOURCE).contains("print prefix");
    }

    @Test
    @DisplayName("installing into nothing is not an error")
    void installIsNullSafe() {
        ConsoleHelpers.install(null);
    }
}
