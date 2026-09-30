package com.gaskony.scriptide.gateway.lang;

import com.inductiveautomation.ignition.common.script.PackageTreeNode;
import com.inductiveautomation.ignition.common.script.ScriptManager;
import com.inductiveautomation.ignition.common.script.typing.CompletionDescriptor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * A flattened, cached view of the gateway's own scripting API.
 *
 * <p>Built from {@code ScriptManager.getHintsTree()}, which is the same source the
 * real Designer's autocomplete uses. That is the point of the whole module: the
 * completions a user sees come from <b>the gateway they are connected to</b>, so
 * they include the functions of the modules actually installed there, with real
 * parameter names, defaults, types and documentation — none of which a static stub
 * file could know.</p>
 *
 * <h2>What is NOT here</h2>
 *
 * <p>The project's own script library. Spike S1 measured that
 * {@code getProjectScriptManager(p).getHintsTree()} is IDENTICAL to the gateway's
 * — root {@code [system]}, same node count — and does not contain project library
 * modules, even though those modules are genuinely importable on that same
 * manager. Project-library completions therefore come entirely from our own AST
 * index, not from here. Do not go looking for them in this class.</p>
 *
 * <h2>Defensive walking</h2>
 *
 * <p>Every accessor on a descriptor is wrapped: a third-party module's
 * {@code TypeSupplier} is a stranger's code running inside our response, and one
 * bad descriptor must cost one absent field, not the whole tree. The depth and
 * node budgets bound a pathological or cyclic tree.</p>
 */
public final class HintIndex {

    private static final Logger logger = LoggerFactory.getLogger(HintIndex.class);

    static final int MAX_DEPTH = 12;
    static final int MAX_NODES = 20_000;

    /** One completion candidate, already flattened for the wire. */
    public record Entry(String name, String dottedPath, Kind kind, String detail,
                        String documentation, List<Param> params, String returnType,
                        boolean deprecated) {
    }

    /** One parameter of a function. */
    public record Param(String name, String documentation, boolean optional, String defaultValue) {
    }

    /** LSP-ish completion kinds, mapped from the SDK's descriptor kinds. */
    public enum Kind { MODULE, FUNCTION, PROPERTY }

    /** dotted path -> the members directly under it. */
    private final Map<String, List<Entry>> childrenByPath;
    private final long builtAtMillis;

    private HintIndex(Map<String, List<Entry>> childrenByPath, long builtAtMillis) {
        this.childrenByPath = childrenByPath;
        this.builtAtMillis = builtAtMillis;
    }

    public long builtAtMillis() {
        return builtAtMillis;
    }

    /** The members directly under a dotted path, e.g. {@code "system.tag"}. */
    public List<Entry> childrenOf(String dottedPath) {
        return childrenByPath.getOrDefault(dottedPath, List.of());
    }

    /** The root names, e.g. {@code system}. */
    public List<Entry> roots() {
        return childrenOf("");
    }

    /** Resolve one fully-qualified member, e.g. {@code system.tag.readBlocking}. */
    public Optional<Entry> resolve(String dottedPath) {
        int dot = dottedPath.lastIndexOf('.');
        String parent = dot < 0 ? "" : dottedPath.substring(0, dot);
        String name = dot < 0 ? dottedPath : dottedPath.substring(dot + 1);
        return childrenOf(parent).stream().filter(e -> e.name().equals(name)).findFirst();
    }

    /** Every dotted path in the index — used by tests and diagnostics. */
    public int size() {
        return childrenByPath.size();
    }

    /** Build an index from a ScriptManager, never throwing. */
    public static HintIndex build(Supplier<ScriptManager> managerSupplier) {
        Map<String, List<Entry>> map = new HashMap<>();
        long now = System.currentTimeMillis();
        try {
            ScriptManager manager = managerSupplier.get();
            if (manager == null) {
                logger.warn("No ScriptManager available; hint index will be empty");
                return new HintIndex(Map.of(), now);
            }
            PackageTreeNode root = manager.getHintsTree();
            if (root == null) {
                logger.warn("getHintsTree() returned null; hint index will be empty");
                return new HintIndex(Map.of(), now);
            }
            int[] budget = {MAX_NODES};
            walk(root, "", map, 0, budget);
            if (budget[0] <= 0) {
                logger.warn("Hint tree exceeded {} nodes and was truncated", MAX_NODES);
            }
        } catch (Throwable t) {
            // Throwable, not Exception: this walks third-party code.
            logger.warn("Failed to build the hint index: {}", t.toString());
        }
        return new HintIndex(Collections.unmodifiableMap(map), now);
    }

    private static void walk(PackageTreeNode node, String prefix,
                             Map<String, List<Entry>> map, int depth, int[] budget) {
        if (depth > MAX_DEPTH || budget[0] <= 0) {
            return;
        }
        List<Entry> entries = new ArrayList<>();

        Map<String, PackageTreeNode> children =
            safe(node::children, Map.<String, PackageTreeNode>of());
        for (Map.Entry<String, PackageTreeNode> child : children.entrySet()) {
            if (budget[0]-- <= 0) {
                break;
            }
            String name = child.getKey();
            entries.add(new Entry(name, join(prefix, name), Kind.MODULE, null, null,
                List.of(), null, false));
            walk(child.getValue(), join(prefix, name), map, depth + 1, budget);
        }

        for (CompletionDescriptor.Method method : safe(node::methods, List.<CompletionDescriptor.Method>of())) {
            if (budget[0]-- <= 0) {
                break;
            }
            entries.add(methodEntry(method, prefix));
        }

        for (CompletionDescriptor.Attribute attribute : safe(node::attributes, List.<CompletionDescriptor.Attribute>of())) {
            if (budget[0]-- <= 0) {
                break;
            }
            String name = safe(attribute::getName, "");
            if (name.isEmpty()) {
                continue;
            }
            entries.add(new Entry(name, join(prefix, name), Kind.PROPERTY,
                null, safe(attribute::getDescription, null), List.of(), null,
                safe(attribute::getDeprecation, null) != null));
        }

        entries.sort((a, b) -> a.name().compareToIgnoreCase(b.name()));
        map.put(prefix, List.copyOf(entries));
    }

    private static Entry methodEntry(CompletionDescriptor.Method method, String prefix) {
        String name = safe(method::getName, "");
        List<Param> params = new ArrayList<>();
        for (CompletionDescriptor.Parameter p : safe(method::getParameters, List.<CompletionDescriptor.Parameter>of())) {
            params.add(new Param(
                safe(p::getName, "?"),
                safe(p::getDescription, null),
                safe(() -> p.getOptional(), false),
                safe(p::getDefault, null)));
        }
        String returnType = safe(() -> {
            var rt = method.getReturnType();
            // getName(), never toString(): TypeDescriptor is a Kotlin data class
            // and its toString() is the whole record —
            // `TypeDescriptor(name=None, description=null, …)` — which was what
            // the doc panel showed for every return type until 1.5.0.
            if (rt == null) {
                return null;
            }
            String typeName = rt.getName();
            return (typeName == null || typeName.isBlank()) ? null : typeName;
        }, null);
        return new Entry(name, join(prefix, name), Kind.FUNCTION,
            signature(name, params), safe(method::getDescription, null),
            List.copyOf(params), returnType,
            safe(method::getDeprecation, null) != null);
    }

    /** {@code readBlocking(tagPaths, [timeout])} — optional params in brackets. */
    static String signature(String name, List<Param> params) {
        StringBuilder sb = new StringBuilder(name).append('(');
        for (int i = 0; i < params.size(); i++) {
            if (i > 0) {
                sb.append(", ");
            }
            Param p = params.get(i);
            sb.append(p.optional() ? "[" + p.name() + "]" : p.name());
        }
        return sb.append(')').toString();
    }

    private static String join(String prefix, String name) {
        return prefix.isEmpty() ? name : prefix + "." + name;
    }

    /**
     * Call a platform accessor, substituting a fallback on ANY failure.
     *
     * <p>Throwable rather than Exception because these accessors run third-party
     * module code. One bad descriptor should cost one missing field, not the tree.
     */
    private static <T> T safe(Supplier<T> supplier, T fallback) {
        try {
            T value = supplier.get();
            return value == null ? fallback : value;
        } catch (Throwable t) {
            return fallback;
        }
    }
}
