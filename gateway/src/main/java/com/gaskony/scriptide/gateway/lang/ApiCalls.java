package com.gaskony.scriptide.gateway.lang;

import org.python.antlr.Visitor;
import org.python.antlr.ast.Attribute;
import org.python.antlr.ast.Name;
import org.python.antlr.base.expr;
import org.python.antlr.base.mod;

import java.util.ArrayList;
import java.util.List;

/**
 * Every dotted platform path a module NAMES — {@code system.tag.readBlocking},
 * {@code system.gui.messageBox}, {@code system.db.runQuery}.
 *
 * <p>{@link UnknownNames} deliberately stops at the root: {@code foo.bar} asks
 * only about {@code foo}, and its class comment says why — whether
 * {@code system.tag} has a {@code readBlocking} is a different kind of claim and
 * belongs to the hint index. This is that claim, and it is only safe to make
 * because the hint index is read from the RUNNING gateway rather than from a
 * table someone typed: it knows which packages this gateway actually has, in
 * this scope, including the ones third-party modules added.</p>
 *
 * <h2>What is a call here, and what is not</h2>
 *
 * <p>A chain is collected only when it bottoms out in a plain {@link Name}. So
 * {@code system.tag.readBlocking} is one path rooted at {@code system}, and
 * {@code getThing().value.units} is not a path at all — its base is a call, and
 * nothing here can say what type it returned. The base of a rejected chain is
 * still walked normally, so a {@code system.*} path inside its arguments is
 * found.</p>
 *
 * <p>Only the LONGEST chain is reported. Walking {@code a.b.c} naively yields
 * {@code a.b.c}, {@code a.b} and {@code a}; the inner two are consumed while
 * flattening rather than revisited, because three marks under one expression is
 * how a check gets switched off.</p>
 *
 * <h2>Position</h2>
 *
 * <p>The mark goes at the BASE name and runs the length of the whole dotted
 * path. Jython's antlr nodes carry the position of the expression's start, so
 * the base name's own line and column are the reliable pair; measuring from the
 * outermost {@link Attribute} put the mark under the last segment on a chain
 * split across lines.</p>
 */
public final class ApiCalls {

    private ApiCalls() {
    }

    /**
     * One dotted path as written in the source.
     *
     * @param path   the full dotted text, e.g. {@code system.gui.messageBox}
     * @param line   1-based, as the AST reports it
     * @param column 0-based, as the AST reports it
     */
    public record Call(String path, int line, int column) {

        /** The first two segments — {@code system.gui} — or the whole path. */
        public String packagePath() {
            int first = path.indexOf('.');
            if (first < 0) {
                return path;
            }
            int second = path.indexOf('.', first + 1);
            return second < 0 ? path : path.substring(0, second);
        }

        /** The root segment — {@code system}. */
        public String root() {
            int first = path.indexOf('.');
            return first < 0 ? path : path.substring(0, first);
        }
    }

    /**
     * Every dotted path in the module, in source order, longest-chain only.
     *
     * <p>Never throws: an unparsed or half-parsed tree yields an empty list, for
     * the same reason {@link UnknownNames#find} does — half an AST supports no
     * conclusion worth marking a line for.</p>
     */
    public static List<Call> find(mod tree) {
        if (tree == null) {
            return List.of();
        }
        Collector collector = new Collector();
        try {
            tree.accept(collector);
        } catch (Exception e) {
            return List.of();
        }
        return List.copyOf(collector.calls);
    }

    private static final class Collector extends Visitor {
        private final List<Call> calls = new ArrayList<>();

        @Override
        public Object visitAttribute(Attribute node) throws Exception {
            // Flatten inward: `a.b.c` is Attribute(Attribute(Name a, b), c), so
            // the segments come out last-first and are reversed at the end.
            List<String> segments = new ArrayList<>();
            expr current = node;
            while (current instanceof Attribute attribute) {
                segments.add(attribute.getInternalAttr());
                current = attribute.getInternalValue();
            }
            if (!(current instanceof Name base)) {
                // The chain is rooted in something this cannot type — a call, a
                // subscript, a literal. Not a path; walk the base for any real
                // path inside it and report nothing for the chain itself.
                // `visit`, not `accept`: org.python.antlr.Visitor extends a RAW
                // VisitorBase, so accept(this) compiles with an unchecked warning
                // for no benefit. Visitor.visit(PythonTree) is the typed door in.
                return current == null ? null : visit(current);
            }
            segments.add(base.getInternalId());
            StringBuilder path = new StringBuilder();
            for (int i = segments.size() - 1; i >= 0; i--) {
                if (path.length() > 0) {
                    path.append('.');
                }
                path.append(segments.get(i));
            }
            calls.add(new Call(path.toString(), base.getLineno(), base.getCol_offset()));
            // Deliberately NOT super.visitAttribute: its children are the inner
            // links of this same chain, already consumed above.
            return null;
        }
    }
}
