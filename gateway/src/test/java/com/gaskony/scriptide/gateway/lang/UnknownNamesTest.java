package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The unknown-name check, tested from both ends.
 *
 * <p>Most of this file is about what must NOT be reported. That is the point:
 * the check exists because Nigel typed rubbish and nothing complained
 * (04/09/2026), but a check that marks working code is worse than no check —
 * a reader who learns to ignore the marks ignores the real one too. So every
 * "finds it" case below has a "and does not find it here" case beside it, and
 * the false-positive half is the larger one.</p>
 */
class UnknownNamesTest {

    private static List<String> unknown(String source) {
        return ModuleSymbols.parse("probe", source).unknownNames().stream()
            .map(UnknownNames.Unknown::name)
            .toList();
    }

    @Nested
    @DisplayName("what it catches")
    class Catches {

        @Test
        @DisplayName("the line that started this: four bare names, all of them rubbish")
        void catchesTheGarbageLine() {
            // Nigel's own input, verbatim. Valid Python 2 — four semicolon-
            // separated expression statements — so the parser is happy and the
            // syntax check says nothing.
            assertThat(ModuleSymbols.parse("probe", "j;sdfj;asdfjk;dksfj").syntaxError())
                .isEmpty();
            assertThat(unknown("j;sdfj;asdfjk;dksfj"))
                .containsExactly("j", "sdfj", "asdfjk", "dksfj");
        }

        @Test
        @DisplayName("a typo in a name that IS defined, one line up")
        void catchesATypo() {
            assertThat(unknown("total = 1\nprint totl\n")).containsExactly("totl");
        }

        @Test
        @DisplayName("reports a name ONCE, at its first use")
        void reportsEachNameOnce() {
            // Twenty marks for one mistake is how a check gets switched off.
            List<UnknownNames.Unknown> found =
                ModuleSymbols.parse("probe", "x = nope\ny = nope\nz = nope\n").unknownNames();
            assertThat(found).hasSize(1);
            assertThat(found.get(0).name()).isEqualTo("nope");
            assertThat(found.get(0).line()).isEqualTo(1);      // 1-based, from the AST
        }

        @Test
        @DisplayName("a call to a function this module never defines or imports")
        void catchesAnUndefinedCall() {
            assertThat(unknown("def go():\n\treturn helper(1)\n")).containsExactly("helper");
        }
    }

    @Nested
    @DisplayName("what it must never report")
    class NeverReports {

        @Test
        @DisplayName("names Ignition injects — this is what keeps it usable")
        void ignoresInjectedNames() {
            assertThat(unknown("system.tag.readBlocking(['a'])")).isEmpty();
            assertThat(unknown("logger.info(event.source)")).isEmpty();
            assertThat(unknown("if not initialChange:\n\tprint currentValue.value\n")).isEmpty();
            assertThat(unknown("shared.thing.go()\nproject.other.go()\n")).isEmpty();
        }

        @Test
        @DisplayName("builtins, including the Python 2 ones")
        void ignoresBuiltins() {
            assertThat(unknown("print len(xrange(10))\nraw_input()\nunicode('x')\n")).isEmpty();
            assertThat(unknown("raise ValueError('x')")).isEmpty();
            assertThat(unknown("try:\n\tpass\nexcept Exception, e:\n\tprint e\n")).isEmpty();
        }

        @Test
        @DisplayName("every way a module can bind a name")
        void ignoresEveryBinding() {
            assertThat(unknown("import os\nprint os.sep\n")).isEmpty();
            assertThat(unknown("from java.lang import System as JSystem\nJSystem.out\n")).isEmpty();
            assertThat(unknown("import a.b.c\nprint a\n")).isEmpty();
            assertThat(unknown("for row in [1]:\n\tprint row\n")).isEmpty();
            assertThat(unknown("a, (b, c) = 1, (2, 3)\nprint a, b, c\n")).isEmpty();
            assertThat(unknown("with open('f') as handle:\n\tprint handle\n")).isEmpty();
            assertThat(unknown("def f(one, two=2, *rest, **kw):\n\treturn one, two, rest, kw\n"))
                .isEmpty();
            assertThat(unknown("f = lambda q: q + 1\nprint f(1)\n")).isEmpty();
            assertThat(unknown("class K(object):\n\tpass\nprint K\n")).isEmpty();
            assertThat(unknown("print [n for n in [1]]\n")).isEmpty();
            assertThat(unknown("print dict((k, v) for k, v in [(1, 2)])\n")).isEmpty();
            assertThat(unknown("counter = 0\ncounter += 1\nprint counter\n")).isEmpty();
        }

        @Test
        @DisplayName("a name bound in ANOTHER scope — the loose rule, on purpose")
        void ignoresCrossScopeUse() {
            // Genuinely a bug in real Python, and genuinely not reported here.
            // Reporting it needs real scope analysis, and getting scope wrong is
            // how a check marks working code. See the class comment.
            assertThat(unknown("def a():\n\tlocalOnly = 1\n\ndef b():\n\treturn localOnly\n"))
                .isEmpty();
        }

        @Test
        @DisplayName("ATTRIBUTES — only the root of a dotted path is a name")
        void ignoresAttributes() {
            // `readBlockingg` is a typo and is NOT this check's business: whether
            // system.tag has that member is a different claim, from the hint
            // index, with a different way of being wrong.
            assertThat(unknown("system.tag.readBlockingg(['a'])")).isEmpty();
            assertThat(unknown("thing = 1\nprint thing.whatever.at.all\n")).isEmpty();
        }

        @Test
        @DisplayName("anything at all, once a star import is in the file")
        void goesSilentOnAStarImport() {
            // A star import can bind any name, so no conclusion is available.
            assertThat(unknown("from os.path import *\nprint join('a')\nprint utterRubbish\n"))
                .isEmpty();
        }

        @Test
        @DisplayName("anything at all, when the module does not parse")
        void goesSilentOnASyntaxError() {
            // Half an AST binds half its names. Marking the other half would put
            // red under every variable in a file whose real problem is one colon.
            ModuleSymbols broken = ModuleSymbols.parse("probe", "def f(:\n\tx = undefinedThing\n");
            assertThat(broken.syntaxError()).isPresent();
            assertThat(broken.unknownNames()).isEmpty();
        }

        @Test
        @DisplayName("a name declared global, and one bound later in the file")
        void ignoresGlobalsAndForwardBindings() {
            assertThat(unknown("def f():\n\tglobal cache\n\tcache = 1\n\ndef g():\n\treturn cache\n"))
                .isEmpty();
            // Used above where it is bound. A real error at run time, and
            // deliberately not reported — "bound anywhere" ignores order too.
            assertThat(unknown("print later\nlater = 1\n")).isEmpty();
        }
    }

    @Nested
    @DisplayName("positions")
    class Positions {

        @Test
        @DisplayName("reports the AST's 1-based line and 0-based column")
        void reportsTheRightPlace() {
            // The whole value of the mark is that it lands on the right line;
            // the server subtracts one on the way out to LSP.
            List<UnknownNames.Unknown> found =
                ModuleSymbols.parse("probe", "a = 1\nb = 2\nc = mystery\n").unknownNames();
            assertThat(found).hasSize(1);
            assertThat(found.get(0).line()).isEqualTo(3);
            assertThat(found.get(0).column()).isEqualTo(4);
        }
    }
}
