package com.gaskony.scriptide.gateway.lang;

import com.gaskony.scriptide.common.ScriptResourceTypes;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.RuntimeResourceCollection;
import com.inductiveautomation.ignition.common.script.ModuleLibrary;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * An index of every project-library module, so the IDE can navigate a project.
 *
 * <h2>Why this exists at all</h2>
 *
 * <p>Because the platform will not tell us. Spike S1 measured that
 * {@code getProjectScriptManager(p).getHintsTree()} is byte-for-byte the same tree
 * as the gateway's — root {@code [system]} — and contains no project library
 * modules, even though those modules are genuinely importable on that same
 * manager. So platform completions come from {@link HintIndex} and everything
 * about the user's OWN code has to come from here.</p>
 *
 * <h2>Staleness</h2>
 *
 * <p>Each module is cached against its resource signature. A sweep compares
 * signatures and re-parses only what changed, which is cheap because a signature
 * comparison does not read the body. That matters: the alternative is re-parsing
 * every script on every keystroke's worth of index lookup.</p>
 */
public final class ProjectIndex {

    private static final Logger logger = LoggerFactory.getLogger(ProjectIndex.class);

    /** Refuse to index a project larger than this, rather than stalling on it. */
    static final int MAX_MODULES = 5_000;

    private record Cached(String signature, ModuleSymbols symbols) {
    }

    private final ProjectManager projectManager;
    private final Map<String, Map<String, Cached>> byProject = new ConcurrentHashMap<>();

    public ProjectIndex(ProjectManager projectManager) {
        this.projectManager = projectManager;
    }

    /** Every indexed module of a project, refreshing anything stale first. */
    public Map<String, ModuleSymbols> modules(String project) {
        refresh(project);
        Map<String, Cached> cache = byProject.getOrDefault(project, Map.of());
        Map<String, ModuleSymbols> out = new ConcurrentHashMap<>();
        cache.forEach((name, cached) -> out.put(name, cached.symbols()));
        return out;
    }

    /**
     * One module's SOURCE, read on demand.
     *
     * <p>Not cached: the index deliberately keeps names and positions only,
     * because holding every script's body in memory is the difference between a
     * few hundred kilobytes and a project's whole library. This is called for the
     * handful of modules a test run is about to execute, and the runner falls
     * back to importing whatever it does not get.</p>
     *
     * <p>Blank comes back empty rather than as an empty string. A read that
     * failed and a module that is genuinely empty look the same from here, and
     * executing an empty namespace would report every test in it as a missing
     * attribute — the import fallback fails with the real reason instead.</p>
     */
    public Optional<String> source(String project, String moduleName) {
        Optional<RuntimeResourceCollection> collection = projectManager.find(project);
        if (collection.isEmpty() || moduleName == null) {
            return Optional.empty();
        }
        for (Resource resource : collection.get().getResources()) {
            var type = resource.getResourcePath().getResourceType();
            if (ScriptResourceTypes.IGNITION_MODULE.equals(type.moduleId())
                && ScriptResourceTypes.TYPE_SCRIPT_PYTHON.equals(type.typeId())
                && moduleName.equals(moduleNameOf(resource))) {
                String source = readSource(resource);
                return source.isBlank() ? Optional.empty() : Optional.of(source);
            }
        }
        return Optional.empty();
    }

    /** The symbols of one module, or empty if the project has no such module. */
    public Optional<ModuleSymbols> module(String project, String moduleName) {
        return Optional.ofNullable(modules(project).get(moduleName));
    }

    /**
     * Resolve a dotted name to a definition, e.g. {@code util.helpers.compute}.
     *
     * <p>Tries the longest module prefix first, so {@code a.b.c} prefers module
     * {@code a.b} member {@code c} over module {@code a} member {@code b.c} — which
     * is the resolution order Python itself uses.</p>
     */
    public Optional<Definition> resolve(String project, String dotted) {
        Map<String, ModuleSymbols> modules = modules(project);
        if (dotted == null || dotted.isBlank()) {
            return Optional.empty();
        }
        // Whole thing is a module: jump to its top.
        ModuleSymbols whole = modules.get(dotted);
        if (whole != null) {
            return Optional.of(new Definition(dotted, null, 0, 0));
        }
        int dot = dotted.lastIndexOf('.');
        while (dot > 0) {
            String moduleName = dotted.substring(0, dot);
            String member = dotted.substring(dot + 1);
            ModuleSymbols symbols = modules.get(moduleName);
            if (symbols != null) {
                return symbols.find(member)
                    .map(s -> new Definition(moduleName, s.name(), s.line(), s.column()));
            }
            dot = dotted.lastIndexOf('.', dot - 1);
        }
        return Optional.empty();
    }

    /** Where a definition lives: which module, and where in it. */
    public record Definition(String moduleName, String symbolName, int line, int column) {
    }

    /** Case-insensitive symbol search across a project, for Ctrl-T quick open. */
    public List<SymbolHit> search(String project, String query, int limit) {
        String needle = query == null ? "" : query.toLowerCase(Locale.ROOT);
        List<SymbolHit> hits = new ArrayList<>();
        for (Map.Entry<String, ModuleSymbols> entry : modules(project).entrySet()) {
            for (ModuleSymbols.Symbol symbol : entry.getValue().symbols()) {
                if (needle.isEmpty()
                    || symbol.name().toLowerCase(Locale.ROOT).contains(needle)) {
                    hits.add(new SymbolHit(entry.getKey(), symbol));
                    if (hits.size() >= limit) {
                        return hits;
                    }
                }
            }
        }
        return hits;
    }

    /** One search result. */
    public record SymbolHit(String moduleName, ModuleSymbols.Symbol symbol) {
    }

    /**
     * Re-parse whatever changed.
     *
     * <p>Signature-diffed rather than event-driven: the resource-change event
     * carries only the collection name, not which resources changed, so there is
     * nothing finer to react to. Comparing signatures recovers the exact delta and
     * does not read a single script body to do it.</p>
     */
    private void refresh(String project) {
        Optional<RuntimeResourceCollection> collectionOpt = projectManager.find(project);
        if (collectionOpt.isEmpty()) {
            byProject.remove(project);
            return;
        }
        Map<String, Cached> cache =
            byProject.computeIfAbsent(project, p -> new ConcurrentHashMap<>());

        List<Resource> scripts = new ArrayList<>();
        for (Resource resource : collectionOpt.get().getResources()) {
            var type = resource.getResourcePath().getResourceType();
            if (ScriptResourceTypes.IGNITION_MODULE.equals(type.moduleId())
                && ScriptResourceTypes.TYPE_SCRIPT_PYTHON.equals(type.typeId())) {
                scripts.add(resource);
            }
        }
        if (scripts.size() > MAX_MODULES) {
            logger.warn("Project '{}' has {} library scripts, above the {} cap — indexing the "
                + "first {} only. Navigation will be incomplete.",
                project, scripts.size(), MAX_MODULES, MAX_MODULES);
            scripts = scripts.subList(0, MAX_MODULES);
        }

        java.util.Set<String> seen = new java.util.HashSet<>();
        for (Resource resource : scripts) {
            String moduleName = moduleNameOf(resource);
            seen.add(moduleName);
            String signature = resource.getResourceSignature().toString();
            Cached existing = cache.get(moduleName);
            if (existing != null && existing.signature().equals(signature)) {
                continue;   // unchanged — do not re-read the body
            }
            String source = readSource(resource);
            cache.put(moduleName, new Cached(signature, ModuleSymbols.parse(moduleName, source)));
        }
        // Drop modules that no longer exist, or a deleted script keeps answering
        // go-to-definition forever.
        cache.keySet().retainAll(seen);
    }

    /** {@code ignition/script-python/util/helpers} → {@code util.helpers}. */
    static String moduleNameOf(Resource resource) {
        return resource.getResourcePath().getPath().toString().replace('/', '.');
    }

    private static String readSource(Resource resource) {
        try {
            String source = ModuleLibrary.deserializeScript(resource);
            return source == null ? "" : source;
        } catch (RuntimeException e) {
            logger.debug("Could not read {}: {}", resource.getResourcePath(), e.getMessage());
            return "";
        }
    }

    /**
     * One matching line from a cross-file search.
     *
     * @param moduleName a LABEL for the results heading — the dotted module name
     *                   for a library script, and the resource's own tail for
     *                   everything else
     * @param resourcePath the encoded resource path, e.g.
     *                     {@code ignition/timer/Hourly}. This, not the label, is
     *                     what identifies the document — a label is for reading
     * @param dataKey which script inside that resource, since a Web Dev endpoint
     *                holds up to eight
     */
    public record TextHit(String moduleName, String resourcePath, String dataKey,
                          int line, int column, String lineText) {
    }

    /** One searchable body: where it lives, what to call it, and its text. */
    private record Searchable(String label, String resourcePath, String dataKey, String text) {
    }

    /**
     * Plain-text search across every library script in a project.
     *
     * <p>Bodies are read on demand rather than held in the index: the index stores
     * names, kinds and positions only, because keeping every script's source in
     * memory is how an indexer turns a large project into a heap problem. Search is
     * rare and interactive, so paying the read then is the right trade.</p>
     *
     * <p>Results are capped and each line is truncated — a regex-like query that
     * matches every line of a 5,000-line file should return a usable answer, not a
     * megabyte of JSON.</p>
     */
    public List<TextHit> searchText(String project, String query, boolean caseSensitive,
                                    int limit) {
        if (query == null || query.isEmpty()) {
            return new ArrayList<>();
        }
        String needle = caseSensitive ? query : query.toLowerCase(Locale.ROOT);
        return scanProject(project, limit,
            line -> (caseSensitive ? line : line.toLowerCase(Locale.ROOT)).indexOf(needle));
    }

    /**
     * Every place a bare NAME appears in the project's library scripts.
     *
     * <p><strong>This is name-based, not a type-aware find-references</strong>, and
     * every caller has to say so: two unrelated classes with a {@code write} method
     * both answer to {@code write}, and this reports both. A correct implementation
     * needs the type system {@link ModuleSymbols} does not build — see the "no
     * find-references" note in the module's docs. What it does buy over a plain text
     * search is identifier boundaries: {@code compute} no longer matches
     * {@code recompute}, {@code compute_all} or {@code "computed"} inside a word,
     * which is the difference between a usable list and a page of noise.</p>
     *
     * <p>Refused outright for anything that is not a Python identifier, rather than
     * quietly degrading to a substring search under a name that promises more.</p>
     */
    public List<TextHit> searchReferences(String project, String name, int limit) {
        if (!isIdentifier(name)) {
            return new ArrayList<>();
        }
        return scanProject(project, limit, line -> identifierAt(line, name));
    }

    /** True for a name this can search: a Python identifier and nothing else. */
    static boolean isIdentifier(String name) {
        if (name == null || name.isEmpty() || Character.isDigit(name.charAt(0))) {
            return false;
        }
        for (int i = 0; i < name.length(); i++) {
            if (!isIdentifierPart(name.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    private static boolean isIdentifierPart(char c) {
        return c == '_' || Character.isLetterOrDigit(c);
    }

    /**
     * The first column at which {@code name} appears in {@code line} as a whole
     * identifier, or -1.
     *
     * <p>The loop matters: the FIRST textual occurrence may be inside a longer word
     * ({@code recompute} contains {@code compute}), and returning -1 there would
     * lose a real reference later on the same line.</p>
     */
    static int identifierAt(String line, String name) {
        int from = 0;
        while (from <= line.length() - name.length()) {
            int at = line.indexOf(name, from);
            if (at < 0) {
                return -1;
            }
            int end = at + name.length();
            boolean leftClear = at == 0 || !isIdentifierPart(line.charAt(at - 1));
            boolean rightClear = end >= line.length() || !isIdentifierPart(line.charAt(end));
            if (leftClear && rightClear) {
                return at;
            }
            from = at + 1;
        }
        return -1;
    }

    /** Where in one line a scan matched, or -1 for no match on that line. */
    private interface LineScan {
        int matchIn(String line);
    }

    /**
     * Walk every searchable body in a project, reporting the FIRST match per line.
     *
     * <p>One hit per line, because the consumer is a results list: a line matching
     * a name three times is still one line to click on, and three rows reading
     * identically is how a results panel stops being scannable.</p>
     *
     * <h3>What "every" means, and why it changed in 1.16.0</h3>
     *
     * <p>Until 1.16.0 this walked <em>library scripts only</em> — the same filter
     * the module index uses — while the IDE had grown to edit gateway event
     * scripts, Web Dev handlers and named-query SQL as well. So search, references
     * and (from 1.15.0) replace all covered about a quarter of what a user can
     * open, and the status line's honest "Named-query SQL is not searched" was the
     * only sign of it. Searching for a string in your own timer script returned
     * nothing, which reads as "it isn't there".</p>
     *
     * <p>The NAME index above stays library-only, and that is not an oversight:
     * go-to-definition, quick-open symbols and completions are about IMPORTABLE
     * modules, and a timer script is not importable. Two corpora, two questions.</p>
     */
    private List<TextHit> scanProject(String project, int limit, LineScan scan) {
        List<TextHit> hits = new ArrayList<>();
        for (Searchable body : searchableBodies(project)) {
            String[] lines = body.text().split("\n", -1);
            for (int i = 0; i < lines.length; i++) {
                int at = scan.matchIn(lines[i]);
                if (at < 0) {
                    continue;
                }
                String text = lines[i];
                if (text.length() > 200) {
                    text = text.substring(0, 200) + "\u2026";
                }
                hits.add(new TextHit(body.label(), body.resourcePath(), body.dataKey(),
                    i, at, text));
                if (hits.size() >= limit) {
                    return hits;
                }
            }
        }
        return hits;
    }

    /**
     * Every body in a project that a user can open in this IDE, with its text.
     *
     * <p>Bodies are read on demand rather than held in the index, for the reason
     * given on {@link #searchText}: names in memory, sources not.</p>
     */
    private List<Searchable> searchableBodies(String project) {
        List<Searchable> out = new ArrayList<>();
        Optional<RuntimeResourceCollection> collectionOpt = projectManager.find(project);
        if (collectionOpt.isEmpty()) {
            return out;
        }
        for (Resource resource : collectionOpt.get().getResources()) {
            var type = resource.getResourcePath().getResourceType();
            String path = type.moduleId() + "/" + type.typeId();
            String tail = resource.getResourcePath().getPath().toString();
            if (!tail.isEmpty()) {
                path = path + "/" + tail;
            }
            try {
                if (ScriptResourceTypes.IGNITION_MODULE.equals(type.moduleId())
                    && ScriptResourceTypes.TYPE_SCRIPT_PYTHON.equals(type.typeId())) {
                    addIfPresent(out, moduleNameOf(resource), path, "code.py",
                        readSource(resource));
                } else if (ScriptResourceTypes.IGNITION_MODULE.equals(type.moduleId())
                    && GATEWAY_EVENT_TYPES.contains(type.typeId())) {
                    // The data key is READ OFF THE RESOURCE, never assumed: a timer
                    // script's is not necessarily `code.py`, and a wrong key here
                    // would silently produce zero hits for a whole resource type.
                    String key = firstPythonKey(resource);
                    if (key != null) {
                        addIfPresent(out, label(type.typeId(), tail), path, key,
                            textOf(resource, key));
                    }
                } else if (WEBDEV_MODULE.equals(type.moduleId())
                    && WEBDEV_TYPE.equals(type.typeId())) {
                    addWebDev(out, resource, path, tail);
                } else if (ScriptResourceTypes.IGNITION_MODULE.equals(type.moduleId())
                    && NAMED_QUERY_TYPE.equals(type.typeId())) {
                    addIfPresent(out, label("named-query", tail), path, NAMED_QUERY_KEY,
                        namedQuerySql(resource));
                }
            } catch (RuntimeException e) {
                // One unreadable resource must not end the search. A project with
                // a legacy named query in it is the normal case, not an error.
                logger.debug("Skipping {} while searching: {}", path, e.toString());
            }
        }
        return out;
    }

    /** The resource's first {@code .py} data key, or null when it has none. */
    private static String firstPythonKey(Resource resource) {
        return resource.getDataKeys().stream()
            .filter(k -> k.endsWith(".py"))
            .findFirst()
            .orElse(null);
    }

    /** One data key's bytes as UTF-8 text, or null. */
    private static String textOf(Resource resource, String key) {
        return resource.getData(key)
            .map(data -> new String(data.getBytes(), java.nio.charset.StandardCharsets.UTF_8))
            .orElse(null);
    }

    private static void addIfPresent(List<Searchable> out, String label, String path,
                                     String key, String text) {
        if (text != null && !text.isEmpty()) {
            out.add(new Searchable(label, path, key, text));
        }
    }

    /**
     * A Web Dev endpoint contributes SEVERAL bodies, not one.
     *
     * <p>Up to eight `do&lt;Method&gt;.py` handlers, plus — for a text resource —
     * the page body that lives inside `config.json` rather than as a data key.
     * Missing the second kind would leave `cell3d.html` unsearchable, which is the
     * single largest file anyone here edits.</p>
     */
    private static void addWebDev(List<Searchable> out, Resource resource, String path,
                                  String tail) {
        for (String key : resource.getDataKeys()) {
            if (!key.endsWith(".py")) {
                continue;
            }
            resource.getData(key).ifPresent(data -> addIfPresent(out,
                label("webdev", tail + "/" + key), path, key,
                new String(data.getBytes(), java.nio.charset.StandardCharsets.UTF_8)));
        }
        var config = com.gaskony.scriptide.gateway.routes.WebDevResources.parseConfig(resource);
        com.gaskony.scriptide.gateway.routes.WebDevResources.body(config).ifPresent(text ->
            addIfPresent(out, label("webdev", tail), path,
                com.gaskony.scriptide.gateway.routes.WebDevResources.TEXT_DATA_KEY, text));
    }

    /** A named query's SQL, or null when the resource cannot be read as one. */
    private static String namedQuerySql(Resource resource) {
        try {
            // `read` throws rather than returning null for a query it cannot
            // parse, so there is nothing to null-check here.
            return com.gaskony.scriptide.gateway.routes.NamedQueryCodec.read(resource).getQuery();
        } catch (Exception e) {
            // Exception, not RuntimeException: the codec declares a checked one,
            // and a version-1 query throws here. Those are unreadable by the
            // PLATFORM too, so not searching them is the honest answer.
            return null;
        }
    }

    /** {@code timer} + {@code Hourly} → {@code timer/Hourly}, for a results heading. */
    private static String label(String kind, String tail) {
        return tail.isEmpty() ? kind : kind + "/" + tail;
    }

    /** The gateway event script types, which hold Python exactly as a library does. */
    private static final java.util.Set<String> GATEWAY_EVENT_TYPES = java.util.Set.of(
        ScriptResourceTypes.TYPE_TIMER, ScriptResourceTypes.TYPE_MESSAGE,
        ScriptResourceTypes.TYPE_TAG_CHANGE, ScriptResourceTypes.TYPE_STARTUP,
        ScriptResourceTypes.TYPE_SHUTDOWN, ScriptResourceTypes.TYPE_UPDATE,
        ScriptResourceTypes.TYPE_SCHEDULED);

    private static final String WEBDEV_MODULE = "com.inductiveautomation.webdev";
    private static final String WEBDEV_TYPE = "resources";
    private static final String NAMED_QUERY_TYPE = "named-query";

    /** The synthetic key a named query's SQL is addressed by. */
    public static final String NAMED_QUERY_KEY = "query.sql";

    /** A top-level library symbol that nothing else in the project names. */
    public record UnusedSymbol(String moduleName, String symbolName, String kind,
                               int line, int column) {
    }

    /**
     * Library functions and classes that nothing in the project appears to call.
     *
     * <h3>What this can and cannot know</h3>
     *
     * <p>It counts whole-identifier occurrences of a name across every searchable
     * body — so a name that appears exactly ONCE appears only at its own
     * definition. That is a real signal and it is the same machinery
     * {@code scriptide/references} uses, with the same honest limit: it is
     * NAME-based. A function called through {@code getattr}, from a Perspective
     * binding, from a Vision window, from an alarm pipeline, or by a gateway that
     * imports the module from outside this project, will look unused and is not.
     * Every surface that shows this must say so — it is a list to READ, never a
     * list to delete from without looking.</p>
     *
     * <p>Names beginning with an underscore are skipped: a leading underscore is
     * Python's own marker for "not part of the interface", so reporting one is
     * reporting a decision the author already made.</p>
     */
    public List<UnusedSymbol> unusedSymbols(String project, int limit) {
        List<UnusedSymbol> out = new ArrayList<>();
        Map<String, ModuleSymbols> modules = modules(project);
        if (modules.isEmpty()) {
            return out;
        }
        // Every body once, rather than once per symbol: a project with 400
        // symbols would otherwise read every script 400 times.
        List<Searchable> bodies = searchableBodies(project);
        Map<String, Integer> counts = new java.util.HashMap<>();
        java.util.Set<String> wanted = new java.util.HashSet<>();
        for (Map.Entry<String, ModuleSymbols> entry : modules.entrySet()) {
            for (ModuleSymbols.Symbol symbol : entry.getValue().symbols()) {
                if (symbol.container() == null && !symbol.name().startsWith("_")) {
                    wanted.add(symbol.name());
                }
            }
        }
        for (Searchable body : bodies) {
            for (String line : body.text().split("\n", -1)) {
                for (String name : wanted) {
                    if (identifierAt(line, name) >= 0) {
                        counts.merge(name, 1, Integer::sum);
                    }
                }
            }
        }
        for (Map.Entry<String, ModuleSymbols> entry : modules.entrySet()) {
            for (ModuleSymbols.Symbol symbol : entry.getValue().symbols()) {
                if (symbol.container() != null || symbol.name().startsWith("_")) {
                    continue;
                }
                // Exactly one line mentions it, and that line is its own `def`.
                if (counts.getOrDefault(symbol.name(), 0) <= 1) {
                    out.add(new UnusedSymbol(entry.getKey(), symbol.name(),
                        symbol.kind().name().toLowerCase(Locale.ROOT),
                        symbol.line(), symbol.column()));
                    if (out.size() >= limit) {
                        return out;
                    }
                }
            }
        }
        return out;
    }

    /** Number of indexed modules in a project — for diagnostics and tests. */
    public int size(String project) {
        return byProject.getOrDefault(project, Map.of()).size();
    }
}
