package com.gaskony.scriptide.gateway.lang;

import org.python.antlr.Visitor;
import org.python.antlr.ast.Attribute;
import org.python.antlr.ast.ClassDef;
import org.python.antlr.ast.ExceptHandler;
import org.python.antlr.ast.FunctionDef;
import org.python.antlr.ast.Global;
import org.python.antlr.ast.Lambda;
import org.python.antlr.ast.Name;
import org.python.antlr.ast.alias;
import org.python.antlr.ast.arguments;
import org.python.antlr.ast.comprehension;
import org.python.antlr.base.expr;
import org.python.antlr.base.mod;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Names a module USES and never BINDS — the check that catches typed rubbish.
 *
 * <p>Nigel, 04/09/2026, having typed {@code j;sdfj;asdfjk;dksfj} into a script:
 * <em>"I can put absolute garbage in here and it doesn't show up as an error
 * which it really should"</em>. He is right, and the parser is right too: that
 * line is four semicolon-separated expression statements and is perfectly valid
 * Python 2. It fails at RUN time, with a NameError, and until 1.13.0 this
 * module shipped exactly one diagnostic — the Jython syntax error — so nothing
 * ever looked at it.</p>
 *
 * <h2>The rule, and why it is deliberately loose</h2>
 *
 * <p>A false positive here is much worse than a miss. A red mark on working
 * code teaches a reader to ignore the marks, and then the real error goes
 * unread too — so this does NOT implement Python's scope rules. It asks one
 * blunt question:</p>
 *
 * <blockquote>is this name bound ANYWHERE in this module, or a builtin, or one
 * of the names the platform injects?</blockquote>
 *
 * <p>Bound anywhere means: any assignment, augmented assignment, for target,
 * with-as, except-as, import, def, class, function argument, lambda argument,
 * comprehension target or {@code global} declaration, in any scope, whether or
 * not it could actually reach the use. That throws away every genuine scope
 * error — a local read before assignment, a name from a sibling function — and
 * keeps the one thing that is never a false positive: a name that appears in
 * this file exactly once, as a read.</p>
 *
 * <p>Everything the loose rule gives up is a real diagnostic in another tool.
 * It is given up on purpose: this catches the typo and the paste-gone-wrong,
 * which is what the request was, and it cannot cry wolf on a live script.</p>
 *
 * <h2>What is NOT reported</h2>
 *
 * <ul>
 *   <li>Anything after a {@code from x import *} — a star import can bind any
 *       name at all, so no conclusion is available and the whole check turns
 *       off for that module. Silence is the honest answer.</li>
 *   <li>Attributes. {@code foo.bar} asks only about {@code foo}; whether the
 *       platform's {@code system.tag} has a {@code readBlocking} is the hint
 *       index's job and a different kind of claim.</li>
 *   <li>Builtins, and the names Ignition injects into a script's namespace —
 *       {@code system}, {@code event}, {@code self}, and the tag- and
 *       Perspective-event bindings. These are bound by the platform at call
 *       time and appear nowhere in the source, which is exactly the shape this
 *       check reports, so the list below is what stops it being useless.</li>
 * </ul>
 */
public final class UnknownNames {

    private UnknownNames() {
    }

    /** One name that is read and never bound. */
    public record Unknown(String name, int line, int column) {
    }

    /**
     * The names Ignition puts into a script's namespace without them appearing
     * in the source.
     *
     * <p>Everything here is bound by the platform at call time. Without the
     * list this check would report `event` in every Perspective event script and
     * `currentValue` in every tag change script — which is the failure mode that
     * makes a linter get switched off.</p>
     */
    private static final Set<String> INJECTED = Set.of(
            // Always present in a gateway or client scope.
            "system", "shared", "project", "self",
            // Event scripts.
            "event", "session", "page", "view", "perspectiveContext",
            // Tag change scripts.
            "tag", "tagPath", "previousValue", "currentValue", "initialChange",
            "newValue", "missedEvents", "provider",
            // Message handlers, WebDev, alarm pipelines.
            "payload", "messageType", "request", "logger", "alarmEvent",
            // Gateway lifecycle and timer scripts.
            "gatewayContext", "initialCall");

    /**
     * Python 2's builtins, as Jython exposes them.
     *
     * <p>Written out rather than read from a live {@code PySystemState}: this
     * class is used from the language server, which must not depend on an
     * interpreter being up, and the set has not changed since Python 2.7.</p>
     */
    private static final Set<String> BUILTINS = Set.of(
            "abs", "all", "any", "apply", "basestring", "bin", "bool", "buffer",
            "bytearray", "bytes", "callable", "chr", "classmethod", "cmp", "coerce",
            "compile", "complex", "copyright", "credits", "delattr", "dict", "dir",
            "divmod", "enumerate", "eval", "execfile", "exit", "file", "filter",
            "float", "format", "frozenset", "getattr", "globals", "hasattr", "hash",
            "help", "hex", "id", "input", "int", "intern", "isinstance", "issubclass",
            "iter", "len", "license", "list", "locals", "long", "map", "max",
            "memoryview", "min", "next", "object", "oct", "open", "ord", "pow",
            "print", "property", "quit", "range", "raw_input", "reduce", "reload",
            "repr", "reversed", "round", "set", "setattr", "slice", "sorted",
            "staticmethod", "str", "sum", "super", "tuple", "type", "unichr",
            "unicode", "vars", "xrange", "zip",
            // Exceptions.
            "ArithmeticError", "AssertionError", "AttributeError", "BaseException",
            "BufferError", "BytesWarning", "DeprecationWarning", "EOFError",
            "EnvironmentError", "Exception", "FloatingPointError", "FutureWarning",
            "GeneratorExit", "IOError", "ImportError", "ImportWarning",
            "IndentationError", "IndexError", "KeyError", "KeyboardInterrupt",
            "LookupError", "MemoryError", "NameError", "NotImplementedError",
            "OSError", "OverflowError", "PendingDeprecationWarning", "ReferenceError",
            "RuntimeError", "RuntimeWarning", "StandardError", "StopIteration",
            "SyntaxError", "SyntaxWarning", "SystemError", "SystemExit", "TabError",
            "TypeError", "UnboundLocalError", "UnicodeDecodeError",
            "UnicodeEncodeError", "UnicodeError", "UnicodeTranslateError",
            "UnicodeWarning", "UserWarning", "ValueError", "Warning",
            "ZeroDivisionError",
            // Constants and dunders that appear at module level.
            "True", "False", "None", "NotImplemented", "Ellipsis", "__debug__",
            "__name__", "__file__", "__doc__", "__builtins__", "__package__",
            "__import__", "__metaclass__");

    /**
     * Drop the names a PROJECT provides — its script-library roots.
     *
     * <p>Not a refinement: without it the check is unusable. Ignition puts every
     * top-level script package into the namespace, so `MachineDemo.api.state()`
     * reads a name called `MachineDemo` that appears nowhere in the file, which
     * is the exact shape this check reports. Run over the 38 scripts on the
     * module rig, the first version of it produced 21 complaints and every
     * single one was a package root — `MachineDemo`, `MiningDemo`, `Access`,
     * `AccessSetup`. Had it shipped, it would have marked a line in essentially
     * every real script in the estate.</p>
     *
     * <p>Kept out of {@link #find} because a module knows nothing about the
     * project it belongs to; the language server does, and calls this. See
     * `UnknownNamesRealScriptsTest`, which exists to catch exactly this class of
     * mistake and did.</p>
     */
    public static List<Unknown> withoutProjectNames(List<Unknown> found, Set<String> provided) {
        if (found.isEmpty() || provided.isEmpty()) {
            return found;
        }
        List<Unknown> out = new ArrayList<>();
        for (Unknown each : found) {
            if (!provided.contains(each.name())) {
                out.add(each);
            }
        }
        return List.copyOf(out);
    }

    /**
     * Every name read but never bound, in source order.
     *
     * <p>Empty when the module does not parse — a half-parsed AST binds half its
     * names, and reporting the other half as unknown would put a red mark under
     * every variable in a file whose only real problem is one missing colon.
     * Empty too when a star import is present; see the class comment.</p>
     */
    public static List<Unknown> find(mod tree) {
        if (tree == null) {
            return List.of();
        }
        Bindings bindings = new Bindings();
        try {
            tree.accept(bindings);
        } catch (Exception e) {
            return List.of();       // a shape the visitor did not expect
        }
        if (bindings.starImport) {
            return List.of();
        }
        Uses uses = new Uses();
        try {
            tree.accept(uses);
        } catch (Exception e) {
            return List.of();
        }
        List<Unknown> out = new ArrayList<>();
        Set<String> reported = new LinkedHashSet<>();
        for (Unknown use : uses.loads) {
            if (bindings.bound.contains(use.name())
                    || BUILTINS.contains(use.name())
                    || INJECTED.contains(use.name())) {
                continue;
            }
            // One mark per NAME, at its first use. A name typed wrong twenty
            // times is one mistake, and twenty marks down one file is the sort
            // of thing that gets a check turned off.
            if (reported.add(use.name())) {
                out.add(use);
            }
        }
        return List.copyOf(out);
    }

    /** Every name this module binds, in any scope, by any means. */
    private static final class Bindings extends Visitor {
        private final Set<String> bound = new LinkedHashSet<>();
        private boolean starImport;

        private void bindTarget(expr target) {
            // Tuple and list targets nest, and a starred target is Python 3
            // only — walking Names out of the subtree covers every Python 2
            // shape without enumerating them.
            if (target == null) {
                return;
            }
            if (target instanceof Name name) {
                bound.add(name.getInternalId());
                return;
            }
            try {
                target.accept(new Visitor() {
                    @Override
                    public Object visitName(Name node) {
                        bound.add(node.getInternalId());
                        return null;
                    }

                    @Override
                    public Object visitAttribute(Attribute node) {
                        // `a.b = 1` binds nothing; `a` is a USE and is handled
                        // by the other visitor.
                        return null;
                    }
                });
            } catch (Exception ignored) {
                // A target shape the walker cannot read binds nothing here; the
                // loose rule then reports at most one extra name, and never a
                // wrong one, because `bound` only ever grows.
            }
        }

        @Override
        public Object visitAssign(org.python.antlr.ast.Assign node) throws Exception {
            for (expr target : node.getInternalTargets()) {
                bindTarget(target);
            }
            return super.visitAssign(node);
        }

        @Override
        public Object visitAugAssign(org.python.antlr.ast.AugAssign node) throws Exception {
            bindTarget(node.getInternalTarget());
            return super.visitAugAssign(node);
        }

        @Override
        public Object visitFor(org.python.antlr.ast.For node) throws Exception {
            bindTarget(node.getInternalTarget());
            return super.visitFor(node);
        }

        @Override
        public Object visitWith(org.python.antlr.ast.With node) throws Exception {
            bindTarget(node.getInternalOptional_vars());
            return super.visitWith(node);
        }

        @Override
        public Object visitExceptHandler(ExceptHandler node) throws Exception {
            bindTarget(node.getInternalName());
            return super.visitExceptHandler(node);
        }

        @Override
        public Object visitFunctionDef(FunctionDef node) throws Exception {
            bound.add(node.getInternalName());
            bindArguments(node.getInternalArgs());
            return super.visitFunctionDef(node);
        }

        @Override
        public Object visitLambda(Lambda node) throws Exception {
            bindArguments(node.getInternalArgs());
            return super.visitLambda(node);
        }

        @Override
        public Object visitClassDef(ClassDef node) throws Exception {
            bound.add(node.getInternalName());
            return super.visitClassDef(node);
        }

        @Override
        public Object visitGlobal(Global node) throws Exception {
            bound.addAll(node.getInternalNames());
            return super.visitGlobal(node);
        }

        // `comprehension` is a helper node, not a visitable one — VisitorBase has
        // no visitComprehension — so each comprehension FORM binds its own
        // generators' targets. Python 2 leaks a list comprehension's variable
        // into the enclosing scope and the other three do not; under the loose
        // rule that distinction does not matter, because "bound anywhere"
        // ignores scope entirely.
        private void bindGenerators(java.util.List<comprehension> generators) {
            if (generators == null) {
                return;
            }
            for (comprehension each : generators) {
                bindTarget(each.getInternalTarget());
            }
        }

        @Override
        public Object visitListComp(org.python.antlr.ast.ListComp node) throws Exception {
            bindGenerators(node.getInternalGenerators());
            return super.visitListComp(node);
        }

        @Override
        public Object visitSetComp(org.python.antlr.ast.SetComp node) throws Exception {
            bindGenerators(node.getInternalGenerators());
            return super.visitSetComp(node);
        }

        @Override
        public Object visitDictComp(org.python.antlr.ast.DictComp node) throws Exception {
            bindGenerators(node.getInternalGenerators());
            return super.visitDictComp(node);
        }

        @Override
        public Object visitGeneratorExp(org.python.antlr.ast.GeneratorExp node) throws Exception {
            bindGenerators(node.getInternalGenerators());
            return super.visitGeneratorExp(node);
        }

        @Override
        public Object visitImport(org.python.antlr.ast.Import node) throws Exception {
            for (alias each : node.getInternalNames()) {
                bindAlias(each);
            }
            return super.visitImport(node);
        }

        @Override
        public Object visitImportFrom(org.python.antlr.ast.ImportFrom node) throws Exception {
            for (alias each : node.getInternalNames()) {
                if ("*".equals(each.getInternalName())) {
                    starImport = true;
                } else {
                    bindAlias(each);
                }
            }
            return super.visitImportFrom(node);
        }

        private void bindAlias(alias each) {
            String asName = each.getInternalAsname();
            if (asName != null && !asName.isEmpty()) {
                bound.add(asName);
                return;
            }
            // `import a.b.c` binds `a`, not `a.b.c`.
            String name = each.getInternalName();
            int dot = name.indexOf('.');
            bound.add(dot < 0 ? name : name.substring(0, dot));
        }

        private void bindArguments(arguments args) {
            if (args == null) {
                return;
            }
            for (expr arg : args.getInternalArgs()) {
                bindTarget(arg);
            }
            if (args.getInternalVararg() != null) {
                bound.add(args.getInternalVararg());
            }
            if (args.getInternalKwarg() != null) {
                bound.add(args.getInternalKwarg());
            }
        }
    }

    /** Every name READ — a Name node in Load context. */
    private static final class Uses extends Visitor {
        private final List<Unknown> loads = new ArrayList<>();

        @Override
        public Object visitName(Name node) {
            if (node.getInternalCtx() == org.python.antlr.ast.expr_contextType.Load) {
                // The AST is 1-based on lines and 0-based on columns; the caller
                // converts. Kept as the AST reports it so one place does that.
                loads.add(new Unknown(node.getInternalId(), node.getLineno(), node.getCol_offset()));
            }
            return null;
        }

        @Override
        public Object visitAttribute(Attribute node) throws Exception {
            // Descend into the VALUE only: `system.tag.readBlocking` asks about
            // `system` and nothing else. `getInternalAttr` is a String, not a
            // Name, so there is nothing else here to visit anyway — this
            // override exists to say so.
            expr value = node.getInternalValue();
            return value == null ? null : value.accept(this);
        }
    }
}
