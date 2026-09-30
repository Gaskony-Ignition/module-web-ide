package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompilerFlags;
import org.python.core.ParserFacade;
import org.python.antlr.base.mod;

import java.io.StringReader;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The bar for these is ZERO false positives, so half of this file is the
 * negative cases — the same words inside a string, a comment or a docstring.
 *
 * <p>That is the whole reason the checks are structural rather than the seven
 * regular expressions the idea was borrowed as. Every "and not here" test below
 * is one a regex fails.</p>
 */
class StyleChecksTest {

    private static List<StyleChecks.Finding> check(String source) {
        mod tree = ParserFacade.parseExpressionOrModule(
            new StringReader(source), "<test>", new CompilerFlags());
        return StyleChecks.find(tree, source);
    }

    private static List<String> codes(String source) {
        return check(source).stream().map(StyleChecks.Finding::code).toList();
    }

    // ==================== bare except ====================

    @Test
    @DisplayName("a bare except is reported")
    void bareExcept() {
        assertThat(codes("try:\n\tf()\nexcept:\n\tpass\n")).containsExactly("bare-except");
    }

    @Test
    @DisplayName("a named except is not")
    void namedExcept() {
        assertThat(codes("try:\n\tf()\nexcept Exception:\n\tpass\n")).isEmpty();
        assertThat(codes("try:\n\tf()\nexcept ValueError, e:\n\tpass\n")).isEmpty();
    }

    @Test
    @DisplayName("the word `except:` inside a string is not a bare except")
    void bareExceptInAString() {
        // The case a regex cannot tell apart, and the reason for the parser.
        assertThat(codes("message = 'never write except: on its own'\n")).isEmpty();
        assertThat(codes("# except:\nx = 1\n")).isEmpty();
        assertThat(codes("\"\"\"Do not write except: here.\"\"\"\nx = 1\n")).isEmpty();
    }

    @Test
    @DisplayName("a bare except is reported where it is, not where the try is")
    void bareExceptPosition() {
        var found = check("try:\n\tf()\nexcept:\n\tpass\n");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).line()).isEqualTo(2);      // 0-based: the third line
    }

    // ==================== mutable default argument ====================

    @Test
    @DisplayName("a list, dict or set default is reported")
    void mutableDefaults() {
        assertThat(codes("def f(items=[]):\n\tpass\n")).containsExactly("mutable-default");
        assertThat(codes("def f(m={}):\n\tpass\n")).containsExactly("mutable-default");
        assertThat(codes("def f(s=set([1])):\n\tpass\n")).isEmpty();   // a call, not a literal
    }

    @Test
    @DisplayName("an immutable default is not")
    void immutableDefaults() {
        assertThat(codes("def f(x=None, y=0, z='', t=()):\n\tpass\n")).isEmpty();
    }

    @Test
    @DisplayName("a lambda's default counts too")
    void lambdaDefaults() {
        assertThat(codes("f = lambda items=[]: items\n")).containsExactly("mutable-default");
    }

    @Test
    @DisplayName("an empty list INSIDE the body is fine — it is made per call")
    void bodyLiteralIsFine() {
        assertThat(codes("def f():\n\titems = []\n\treturn items\n")).isEmpty();
    }

    // ==================== comparing to None ====================

    @Test
    @DisplayName("== None and != None are reported")
    void compareToNone() {
        assertThat(codes("if x == None:\n\tpass\n")).containsExactly("compare-to-none");
        assertThat(codes("if x != None:\n\tpass\n")).containsExactly("compare-to-none");
        assertThat(codes("if None == x:\n\tpass\n")).containsExactly("compare-to-none");
    }

    @Test
    @DisplayName("`is None` is the right form and is left alone")
    void isNoneIsFine() {
        assertThat(codes("if x is None:\n\tpass\n")).isEmpty();
        assertThat(codes("if x is not None:\n\tpass\n")).isEmpty();
    }

    @Test
    @DisplayName("a chained comparison is checked at every link")
    void chainedComparison() {
        assertThat(codes("if a == b == None:\n\tpass\n")).containsExactly("compare-to-none");
    }

    @Test
    @DisplayName("the words `== None` in a comment or a string are not a comparison")
    void compareToNoneInText() {
        assertThat(codes("# never write == None\nx = 1\n")).isEmpty();
        assertThat(codes("hint = 'x == None is wrong'\n")).isEmpty();
    }

    // ==================== `is` with a literal ====================

    @Test
    @DisplayName("`is` against a string or a number is reported")
    void isWithLiteral() {
        assertThat(codes("if name is 'admin':\n\tpass\n")).containsExactly("is-with-literal");
        assertThat(codes("if count is 5:\n\tpass\n")).containsExactly("is-with-literal");
    }

    @Test
    @DisplayName("`is` against a name is not")
    void isWithName() {
        assertThat(codes("if a is b:\n\tpass\n")).isEmpty();
        assertThat(codes("if a is True:\n\tpass\n")).isEmpty();
    }

    // ==================== assert on a tuple ====================

    @Test
    @DisplayName("asserting a tuple can never fail, and is reported")
    void assertTuple() {
        assertThat(codes("assert (1 == 2, 'this never fires')\n"))
            .containsExactly("assert-tuple");
    }

    @Test
    @DisplayName("an assert with a message, written properly, is not")
    void assertWithMessage() {
        assertThat(codes("assert 1 == 2, 'this does fire'\n")).isEmpty();
        assertThat(codes("assert x\n")).isEmpty();
    }

    @Test
    @DisplayName("asserting an empty tuple is left alone — it is always FALSE, not always true")
    void assertEmptyTuple() {
        // `assert ()` fails every time, which is odd but not the mistake this
        // check is about, and calling it the same thing would be wrong.
        assertThat(codes("assert ()\n")).isEmpty();
    }

    // ==================== duplicate dict key ====================

    @Test
    @DisplayName("a repeated literal key is reported once, on the second one")
    void duplicateKey() {
        var found = check("d = {'a': 1, 'b': 2, 'a': 3}\n");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).code()).isEqualTo("duplicate-key");
        assertThat(found.get(0).column()).isGreaterThan(12);   // the SECOND 'a'
    }

    @Test
    @DisplayName("a repeated numeric key counts, and a string is not the same as a number")
    void duplicateKeyKinds() {
        assertThat(codes("d = {1: 'a', 1: 'b'}\n")).containsExactly("duplicate-key");
        assertThat(codes("d = {1: 'a', '1': 'b'}\n")).isEmpty();
    }

    @Test
    @DisplayName("two expression keys are never called duplicates")
    void expressionKeys() {
        // They may well be equal at runtime and there is no way to know here.
        // Guessing would put a mark under correct code.
        assertThat(codes("d = {a: 1, b: 2}\n")).isEmpty();
        assertThat(codes("d = {f(): 1, f(): 2}\n")).isEmpty();
    }

    // ==================== mixed indentation ====================

    @Test
    @DisplayName("a file indented with both tabs and spaces is reported once")
    void mixedIndent() {
        String source = "def a():\n\treturn 1\n\ndef b():\n    return 2\n";
        var found = StyleChecks.mixedIndentation(source);
        assertThat(found).isPresent();
        assertThat(found.get().code()).isEqualTo("mixed-indent");
        assertThat(found.get().line()).isEqualTo(4);
        assertThat(found.get().message()).contains("tabs").contains("spaces");
    }

    @Test
    @DisplayName("a file that picks one is left alone")
    void consistentIndent() {
        assertThat(StyleChecks.mixedIndentation("def a():\n\treturn 1\n")).isEmpty();
        assertThat(StyleChecks.mixedIndentation("def a():\n    return 1\n")).isEmpty();
        assertThat(StyleChecks.mixedIndentation("")).isEmpty();
        assertThat(StyleChecks.mixedIndentation(null)).isEmpty();
    }

    @Test
    @DisplayName("a continuation line aligned with spaces is still the minority, and is named")
    void mixedIndentNamesTheMinority() {
        String source = "def a():\n\tx = 1\n\ty = 2\n  # aligned with spaces\n\tz = 3\n";
        var found = StyleChecks.mixedIndentation(source);
        assertThat(found).isPresent();
        assertThat(found.get().message()).contains("indents with tabs elsewhere");
    }

    // ==================== the whole ====================

    @Test
    @DisplayName("a file that does not parse gets no style findings at all")
    void unparseableGetsNothing() {
        // It has one problem worth showing and it is not its indentation. The
        // parser's own error is already published.
        assertThat(StyleChecks.find(null, "def f(:\n\tpass")).isEmpty();
    }

    @Test
    @DisplayName("ordinary correct code produces nothing")
    void cleanCode() {
        String source = String.join("\n",
            "\"\"\"A module that does everything right.\"\"\"",
            "import json",
            "",
            "def totals(rows, seen=None):",
            "\tif seen is None:",
            "\t\tseen = {}",
            "\ttry:",
            "\t\treturn json.dumps({'rows': len(rows), 'seen': len(seen)})",
            "\texcept ValueError:",
            "\t\treturn None",
            "");
        assertThat(check(source)).isEmpty();
    }

    @Test
    @DisplayName("several findings in one file all come back")
    void several() {
        String source = String.join("\n",
            "def f(items=[]):",
            "\ttry:",
            "\t\tif items == None:",
            "\t\t\tpass",
            "\texcept:",
            "\t\tpass",
            "");
        assertThat(codes(source))
            .containsExactlyInAnyOrder("bare-except", "mutable-default", "compare-to-none");
    }
}
