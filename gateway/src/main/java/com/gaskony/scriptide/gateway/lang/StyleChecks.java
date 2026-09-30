package com.gaskony.scriptide.gateway.lang;

import org.python.antlr.Visitor;
import org.python.antlr.ast.Assert;
import org.python.antlr.ast.Compare;
import org.python.antlr.ast.Dict;
import org.python.antlr.ast.ExceptHandler;
import org.python.antlr.ast.FunctionDef;
import org.python.antlr.ast.Lambda;
import org.python.antlr.ast.Name;
import org.python.antlr.ast.Num;
import org.python.antlr.ast.Str;
import org.python.antlr.ast.Tuple;
import org.python.antlr.ast.arguments;
import org.python.antlr.ast.cmpopType;
import org.python.antlr.base.expr;
import org.python.antlr.base.mod;
import org.python.core.CompilerFlags;
import org.python.core.ParserFacade;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Seven things that are wrong in Jython however they are spelled.
 *
 * <h2>Over the AST, not over the text</h2>
 *
 * <p>The same checks can be written as regular expressions over the text, and
 * have to be by anything without a parser. This module has one — it runs the
 * interpreter's own — so every check that CAN be structural is structural, and
 * the difference is not cosmetic. A regex for {@code == None}
 * fires inside a docstring that explains why you should not write {@code == None};
 * a regex for a bare {@code except:} fires on the string {@code "except:"} in a log
 * message. The bar for a diagnostic in this module is ZERO false positives, and a
 * lint that cries wolf gets every lint switched off.</p>
 *
 * <p>Only one check here is textual, and it is textual because the thing it is
 * about — which whitespace characters indent the file — is invisible to a parse
 * that has already succeeded.</p>
 *
 * <h2>What is deliberately NOT here</h2>
 *
 * <ul>
 *   <li><b>Unused imports.</b> {@link ImportOrganiser} finds those, where they
 *       come with the one thing a diagnostic cannot offer: a fix.</li>
 *   <li><b>An unclosed string.</b> That is a syntax error, and the real parser
 *       already reports it with a position. A second opinion from a regex would
 *       only disagree.</li>
 *   <li><b>{@code except Exception} instead of {@code Throwable}.</b> True and
 *       important in this estate — a Stop arrives as a Java {@code Error} — but it
 *       is right in the great majority of ordinary project code, so as a lint it
 *       would fire on nearly every file. It stays a rule in {@code CLAUDE.md} for
 *       the code that runs user scripts, not a mark under everybody's else's.</li>
 * </ul>
 *
 * <p>Each finding is a WARNING, never an error. None of these stops the module
 * running, and a yellow mark that is worth reading is worth more than a red one
 * that is not true.</p>
 */
public final class StyleChecks {

    private StyleChecks() { /* static analysis */ }

    /** One finding. Positions are 0-based, as LSP wants them. */
    public record Finding(String code, String message, int line, int column, int endColumn) {
    }

    /**
     * Every finding in one module.
     *
     * @param tree   the parsed module, or null when the source did not parse — in
     *               which case the answer is empty. A file with a syntax error has
     *               one problem worth showing and it is not its indentation.
     * @param source the same source, for the one check that has to look at bytes
     */
    public static List<Finding> find(mod tree, String source) {
        List<Finding> out = new ArrayList<>();
        if (tree != null) {
            Scan scan = new Scan();
            try {
                tree.accept(scan);
                out.addAll(scan.findings);
            } catch (Exception e) {
                // A shape the visitor did not expect is not worth a wrong answer.
                return List.of();
            }
        }
        mixedIndentation(source).ifPresent(out::add);
        return List.copyOf(out);
    }

    /**
     * The same findings, from source text alone.
     *
     * <p>What the language server calls, because it publishes diagnostics for an
     * OPEN BUFFER rather than for an indexed module — so there is no tree lying
     * about to hand in. That is one extra parse of one file per keystroke, which
     * is cheap; retaining every indexed module's tree to avoid it would not be.</p>
     *
     * <p>The coding declaration is neutralised the same way
     * {@link ModuleSymbols#parse} does it, or a file with a {@code utf-8} header
     * would get no style findings at all for a reason that has nothing to do with
     * its style.</p>
     */
    public static List<Finding> find(String source) {
        if (source == null || source.isBlank()) {
            return List.of();
        }
        try {
            mod tree = ParserFacade.parseExpressionOrModule(
                new StringReader(ModuleSymbols.neutraliseCodingDeclaration(source)),
                "<style>", new CompilerFlags());
            return find(tree, source);
        } catch (RuntimeException e) {
            // A file that does not parse has one problem worth showing, and it is
            // not its indentation. The parser's own error is already published.
            return List.of();
        }
    }

    /**
     * A file indented with both tabs and spaces.
     *
     * <p>Reported once, on the first line that disagrees with the file's own
     * majority, rather than on every line: the fix is one decision about the whole
     * file, so one mark is the actionable form of it.</p>
     *
     * <p>This estate writes Jython with TABS, and byte fidelity is a rule — this
     * module never converts one to the other on a save — so a file that mixes them
     * stays mixed until somebody is told.</p>
     */
    static java.util.Optional<Finding> mixedIndentation(String source) {
        if (source == null || source.isEmpty()) {
            return java.util.Optional.empty();
        }
        String[] lines = source.split("\n", -1);
        int tabbed = 0;
        int spaced = 0;
        for (String line : lines) {
            if (line.startsWith("\t")) {
                tabbed++;
            } else if (line.startsWith(" ") && !line.isBlank()) {
                spaced++;
            }
        }
        if (tabbed == 0 || spaced == 0) {
            return java.util.Optional.empty();
        }
        boolean tabsWin = tabbed >= spaced;
        String majority = tabsWin ? "tabs" : "spaces";
        String minority = tabsWin ? "spaces" : "tabs";
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i];
            boolean odd = tabsWin
                ? line.startsWith(" ") && !line.isBlank()
                : line.startsWith("\t");
            if (odd) {
                int width = 0;
                while (width < line.length()
                    && (line.charAt(width) == ' ' || line.charAt(width) == '\t')) {
                    width++;
                }
                return java.util.Optional.of(new Finding("mixed-indent",
                    "This file indents with " + majority + " elsewhere and with " + minority
                        + " here. Jython accepts both and means different things by them.",
                    i, 0, width));
            }
        }
        return java.util.Optional.empty();
    }

    /** The structural half. */
    private static final class Scan extends Visitor {

        private final List<Finding> findings = new ArrayList<>();

        private void add(String code, String message, int line, int column, int width) {
            findings.add(new Finding(code, message,
                Math.max(0, line - 1), Math.max(0, column), Math.max(0, column) + width));
        }

        @Override
        public Object visitExceptHandler(ExceptHandler node) throws Exception {
            if (node.getInternalType() == null) {
                // The one that has cost this estate a release. A Stop and the
                // execution timeout arrive as a Java Error, which is a Throwable
                // and not an Exception, and a bare except swallows it — leaving a
                // Stop button that appears to work and does nothing.
                add("bare-except",
                    "A bare `except:` also catches a Stop and a Java Error, so the code "
                        + "carries on after something that was meant to end it. Name what "
                        + "you mean to handle.",
                    node.getLineno(), node.getCol_offset(), "except:".length());
            }
            return super.visitExceptHandler(node);
        }

        @Override
        public Object visitFunctionDef(FunctionDef node) throws Exception {
            mutableDefaults(node.getInternalArgs());
            return super.visitFunctionDef(node);
        }

        @Override
        public Object visitLambda(Lambda node) throws Exception {
            mutableDefaults(node.getInternalArgs());
            return super.visitLambda(node);
        }

        /**
         * A default argument that is a list, dict or set literal.
         *
         * <p>It is created ONCE, when the {@code def} runs, and every call that
         * does not pass one shares it — so a function that appends to its own
         * default grows a longer answer every time it is called. It reads as a
         * fresh empty container and is not one.</p>
         */
        private void mutableDefaults(arguments args) {
            if (args == null || args.getInternalDefaults() == null) {
                return;
            }
            for (expr value : args.getInternalDefaults()) {
                String kind = literalKind(value);
                if (kind != null) {
                    add("mutable-default",
                        "This default " + kind + " is created once and shared by every call "
                            + "that does not pass one. Use None and build it inside.",
                        value.getLineno(), value.getCol_offset(), 2);
                }
            }
        }

        private static String literalKind(expr value) {
            if (value instanceof org.python.antlr.ast.List) {
                return "list";
            }
            if (value instanceof Dict) {
                return "dict";
            }
            if (value instanceof org.python.antlr.ast.Set) {
                return "set";
            }
            return null;
        }

        @Override
        public Object visitCompare(Compare node) throws Exception {
            List<cmpopType> operators = node.getInternalOps();
            List<expr> right = node.getInternalComparators();
            if (operators != null && right != null) {
                for (int i = 0; i < operators.size() && i < right.size(); i++) {
                    expr left = i == 0 ? node.getInternalLeft() : right.get(i - 1);
                    check(operators.get(i), left, right.get(i), node);
                }
            }
            return super.visitCompare(node);
        }

        private void check(cmpopType operator, expr left, expr right, Compare node) {
            if ((operator == cmpopType.Eq || operator == cmpopType.NotEq)
                && (isNone(left) || isNone(right))) {
                // == asks the object; `is` asks whether it IS None. A class with
                // its own __eq__ can answer either way, so the two are genuinely
                // different questions and only one of them is the one meant.
                add("compare-to-none",
                    "Compare to None with `is` / `is not`. `==` calls the object's own "
                        + "__eq__, which can answer anything it likes.",
                    node.getLineno(), node.getCol_offset(), 1);
            }
            if ((operator == cmpopType.Is || operator == cmpopType.IsNot)
                && (isLiteral(left) || isLiteral(right))) {
                // `is` compares identity. Two equal literals are sometimes the
                // same object and sometimes not, which is how this passes in
                // testing and fails in production on a longer string.
                add("is-with-literal",
                    "`is` compares identity, not value. Whether two equal literals are "
                        + "the same object is an implementation detail — use `==`.",
                    node.getLineno(), node.getCol_offset(), 1);
            }
        }

        private static boolean isNone(expr value) {
            // Python 2 has no None keyword node: it is an ordinary Name.
            return value instanceof Name name && "None".equals(name.getInternalId());
        }

        private static boolean isLiteral(expr value) {
            return value instanceof Str || value instanceof Num;
        }

        @Override
        public Object visitAssert(Assert node) throws Exception {
            if (node.getInternalTest() instanceof Tuple tuple
                && tuple.getInternalElts() != null && !tuple.getInternalElts().isEmpty()) {
                // `assert (x == 1, 'message')` asserts a two-element tuple, which
                // is always true. It never fails, and it looks exactly like an
                // assertion with a message. Worth its own check now that this
                // module ships a test framework people write assertions in.
                add("assert-tuple",
                    "This asserts a tuple, which is always true, so the assertion can "
                        + "never fail. Write `assert x, 'message'` without the brackets.",
                    node.getLineno(), node.getCol_offset(), "assert".length());
            }
            return super.visitAssert(node);
        }

        @Override
        public Object visitDict(Dict node) throws Exception {
            List<expr> keys = node.getInternalKeys();
            if (keys != null) {
                Set<String> seen = new LinkedHashSet<>();
                for (expr key : keys) {
                    String literal = literalValue(key);
                    // Only literal keys: two expressions can be equal at runtime
                    // and there is no way to know that here, so guessing would
                    // put a mark under correct code.
                    if (literal != null && !seen.add(literal)) {
                        add("duplicate-key",
                            "This key appears twice in the same dict, so the first value is "
                                + "discarded.",
                            key.getLineno(), key.getCol_offset(), literal.length());
                    }
                }
            }
            return super.visitDict(node);
        }

        private static String literalValue(expr key) {
            if (key instanceof Str str) {
                return "s:" + str.getInternalS().toString();
            }
            if (key instanceof Num num) {
                return "n:" + num.getInternalN().toString();
            }
            return null;
        }
    }
}
