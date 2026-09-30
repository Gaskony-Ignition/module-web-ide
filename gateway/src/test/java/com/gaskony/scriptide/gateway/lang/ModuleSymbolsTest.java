package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.python.antlr.ast.FunctionDef;
import org.python.antlr.ast.Num;
import org.python.antlr.base.expr;
import org.python.antlr.base.stmt;
import org.python.antlr.runtime.Token;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Parsing real Ignition code.
 *
 * <p>The Python-2 cases are the point of the whole approach: no maintained
 * third-party Python parser handles them, which is why this uses Jython's own.</p>
 */
class ModuleSymbolsTest {

    @ParameterizedTest(name = "parses Python 2 syntax: {0}")
    @ValueSource(strings = {
        "print 'hello'\n",
        "try:\n\tpass\nexcept ValueError, e:\n\tpass\n",
        "x = 10L\n",
        "x = `1`\n",
        "exec 'x=1'\n",
        "x = 0777\n",
        "x = 1 <> 2\n",
        "raise ValueError, 'msg'\n",
    })
    @DisplayName("Python-2-only forms parse without error")
    void parsesPython2(String source) {
        // Every one of these is a syntax error to a Python 3 parser, and all of them
        // appear in real Ignition scripts.
        assertThat(ModuleSymbols.parse("m", source).syntaxError()).isEmpty();
    }

    @Test
    @DisplayName("a syntax error is reported once, with a 0-based line")
    void reportsSyntaxErrorPosition() {
        ModuleSymbols m = ModuleSymbols.parse("m", "a = 1\nb = 2\nc = = 3\n");
        assertThat(m.syntaxError()).isPresent();
        // Third line, 0-based => 2. An off-by-one here puts the squiggle on the
        // wrong line, which reads as an editor bug.
        assertThat(m.errorLine()).isEqualTo(2);
    }

    @Test
    @DisplayName("a module that does not parse still returns, rather than throwing")
    void badModuleDoesNotThrow() {
        // One broken script must not take out the whole project index — and a
        // half-typed script is the normal case, not an edge case.
        ModuleSymbols m = ModuleSymbols.parse("broken", "def f(:\n");
        assertThat(m.syntaxError()).isPresent();
        assertThat(m.symbols()).isEmpty();
    }

    @Test
    @DisplayName("functions, classes, methods and module variables are indexed")
    void indexesDefinitions() {
        ModuleSymbols m = ModuleSymbols.parse("m",
            "CONSTANT = 3\n"
                + "\n"
                + "def compute(a, b=2, *rest, **kw):\n"
                + "\t'''Adds things.'''\n"
                + "\treturn a + b\n"
                + "\n"
                + "class Widget:\n"
                + "\tdef spin(self):\n"
                + "\t\tpass\n");

        assertThat(m.symbols()).extracting(ModuleSymbols.Symbol::name)
            .contains("CONSTANT", "compute", "Widget", "spin");

        var compute = m.find("compute").orElseThrow();
        assertThat(compute.kind()).isEqualTo(ModuleSymbols.SymbolKind.FUNCTION);
        assertThat(compute.signature()).isEqualTo("compute(a, b=..., *rest, **kw)");
        assertThat(compute.documentation()).contains("Adds things");
        assertThat(compute.line()).isEqualTo(2);   // 0-based

        var spin = m.symbols().stream().filter(s -> s.name().equals("spin")).findFirst()
            .orElseThrow();
        assertThat(spin.kind()).isEqualTo(ModuleSymbols.SymbolKind.METHOD);
        assertThat(spin.container()).isEqualTo("Widget");
    }

    @Test
    @DisplayName("a nested function is NOT indexed, because nothing can import it")
    void skipsNestedFunctions() {
        ModuleSymbols m = ModuleSymbols.parse("m",
            "def outer():\n\tdef inner():\n\t\tpass\n\treturn inner\n");
        assertThat(m.symbols()).extracting(ModuleSymbols.Symbol::name)
            .containsExactly("outer");
    }

    @Test
    @DisplayName("import forms bind the right names")
    void resolvesImportBindings() {
        ModuleSymbols m = ModuleSymbols.parse("m",
            "import system\n"
                + "import a.b.c\n"
                + "import x.y as z\n"
                + "from util import helper\n"
                + "from pkg import thing as other\n"
                + "from wild import *\n");

        assertThat(m.imports()).extracting(ModuleSymbols.ImportBinding::boundName)
            // `import a.b.c` binds `a`, NOT `a.b.c` — treating it as the full path
            // silently breaks resolution of everything under it.
            .contains("system", "a", "z", "helper", "other", "*");

        var dotted = m.imports().stream().filter(i -> i.boundName().equals("a")).findFirst()
            .orElseThrow();
        assertThat(dotted.targetModule()).isEqualTo("a.b.c");

        var star = m.imports().stream().filter(ModuleSymbols.ImportBinding::star).findFirst()
            .orElseThrow();
        // Recorded so undefined-name checking can disable itself for this module
        // rather than emit nonsense about names the star import provides.
        assertThat(star.targetModule()).isEqualTo("wild");
    }

    @Test
    @DisplayName("a script with no trailing newline parses — that is the normal case here")
    void parsesWithoutTrailingNewline() {
        ModuleSymbols m = ModuleSymbols.parse("m", "def f():\n\treturn 1");
        assertThat(m.syntaxError()).isEmpty();
        assertThat(m.find("f")).isPresent();
    }

    // ==================== decoratorsOf ====================

    @Test
    @DisplayName("@test (a Name) records its bare name")
    void decoratorAsName() {
        ModuleSymbols m = ModuleSymbols.parse("m", "@test\ndef check_totals():\n\tpass\n");
        var f = m.find("check_totals").orElseThrow();
        assertThat(f.decorators()).containsExactly("test");
        assertThat(f.hasDecorator("test")).isTrue();
        assertThat(f.hasDecorator("skip")).isFalse();
    }

    @Test
    @DisplayName("@skip('why') (a Call) records the name of the thing being called")
    void decoratorAsCall() {
        ModuleSymbols m = ModuleSymbols.parse("m", "@skip('why')\ndef check_totals():\n\tpass\n");
        assertThat(m.find("check_totals").orElseThrow().decorators()).containsExactly("skip");
    }

    @Test
    @DisplayName("@scriptide.test (an Attribute) records the LAST segment")
    void decoratorAsAttributeKeepsLastSegment() {
        ModuleSymbols m = ModuleSymbols.parse("m", "@scriptide.test\ndef check_totals():\n\tpass\n");
        // Whatever the module was imported as, a reader means "the test decorator" —
        // the dotted prefix is how it was reached, not part of its name.
        assertThat(m.find("check_totals").orElseThrow().decorators()).containsExactly("test");
    }

    @Test
    @DisplayName("several decorators on one def are recorded in source order")
    void decoratorsRecordedInSourceOrder() {
        ModuleSymbols m = ModuleSymbols.parse("m",
            "@skip('why')\n@test\n@scriptide.cases\ndef check_totals():\n\tpass\n");
        assertThat(m.find("check_totals").orElseThrow().decorators())
            .containsExactly("skip", "test", "cases");
    }

    @Test
    @DisplayName("a def with no decorators records an empty list, never null")
    void noDecoratorsIsEmptyNotNull() {
        ModuleSymbols m = ModuleSymbols.parse("m", "def plain():\n\tpass\n");
        assertThat(m.find("plain").orElseThrow().decorators()).isNotNull().isEmpty();
    }

    @Test
    @DisplayName("only functions and methods can carry a decorator — a class and a "
        + "module variable record none")
    void classAndVariableRecordNoDecorators() {
        ModuleSymbols m = ModuleSymbols.parse("m", "CONSTANT = 1\n\nclass Widget:\n\tpass\n");
        assertThat(m.find("CONSTANT").orElseThrow().decorators()).isEmpty();
        var widget = m.symbols().stream().filter(s -> s.name().equals("Widget")).findFirst()
            .orElseThrow();
        assertThat(widget.decorators()).isEmpty();
    }

    @Test
    @DisplayName("a decorator built by an expression that is none of the three known "
        + "shapes records nothing rather than a guess")
    void unknownDecoratorShapeRecordsNothing() {
        // The Jython 2 grammar accepts only a dotted name, optionally called, as a
        // decorator — @(1+2) and its like are a syntax error (measured against the
        // actual parser), so this shape can only be reached by handing decoratorsOf
        // an AST built directly, never by parsing real source.
        expr bogusDecorator = new Num((Token) null, Integer.valueOf(1));
        FunctionDef function = new FunctionDef((Token) null, "odd", null,
            List.<stmt>of(), List.<expr>of(bogusDecorator));
        assertThat(ModuleSymbols.decoratorsOf(function)).isEmpty();
    }

    @Test
    @DisplayName("a PEP 263 coding declaration does not make the whole file a syntax error")
    void codingDeclarationParses() {
        // Measured 07/09/2026: a StringReader is Unicode text, and Jython refuses
        // a coding declaration in one — "encoding declaration in Unicode string".
        // Untreated, a file with an ordinary `# -*- coding: utf-8 -*-` header got
        // a red mark on line 1 about nothing in its own code, was skipped by test
        // discovery, and contributed nothing to the outline.
        ModuleSymbols symbols = ModuleSymbols.parse("m",
            "# -*- coding: utf-8 -*-\nimport os\n\ndef helper():\n\treturn os\n");

        assertThat(symbols.syntaxError()).isEmpty();
        assertThat(symbols.symbols()).extracting(ModuleSymbols.Symbol::name).contains("helper");
    }

    @Test
    @DisplayName("neutralising the declaration changes no line number and no column")
    void codingDeclarationKeepsEveryPosition() {
        // The reason it edits one word rather than deleting the line: every
        // position this class reports becomes a range in the editor, so a shift
        // of one line puts every mark in the file on the wrong line.
        String source = "#!/usr/bin/env python\n# -*- coding: utf-8 -*-\ndef helper():\n\tpass\n";
        String treated = ModuleSymbols.neutraliseCodingDeclaration(source);

        assertThat(treated).hasSameSizeAs(source);
        assertThat(treated.split("\n", -1)).hasSameSizeAs(source.split("\n", -1));
        assertThat(treated).doesNotContain("coding:");
        assertThat(ModuleSymbols.parse("m", source).find("helper"))
            .get().extracting(ModuleSymbols.Symbol::line).isEqualTo(2);
    }

    @Test
    @DisplayName("only the first two lines can carry one, and only the first is honoured")
    void codingDeclarationScope() {
        // Python looks in the first two lines and takes the first. A `coding:`
        // further down is somebody's prose and must be left alone.
        String late = "x = 1\ny = 2\n# coding: utf-8\n";
        assertThat(ModuleSymbols.neutraliseCodingDeclaration(late)).isEqualTo(late);

        String prose = "def f():\n\t\"\"\"Mentions coding: utf-8 in passing.\"\"\"\n\tpass\n";
        assertThat(ModuleSymbols.neutraliseCodingDeclaration(prose)).isEqualTo(prose);
    }

    @Test
    @DisplayName("a file with no declaration is returned untouched")
    void noDeclarationIsUntouched() {
        String plain = "import os\nprint(os)\n";
        assertThat(ModuleSymbols.neutraliseCodingDeclaration(plain)).isSameAs(plain);
        assertThat(ModuleSymbols.neutraliseCodingDeclaration("")).isEmpty();
    }
}
