package com.gaskony.scriptide.gateway.lang;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Sorts and de-duplicates one module's leading import block, and suggests an
 * import for a name the module reads but never binds.
 *
 * <h2>Why this is a pure function over text</h2>
 *
 * <p>No {@code ProjectManager}, no gateway context — just {@link #organise}
 * over a source string and a {@link Lookup} the caller supplies. That is what
 * lets a unit test cover every safety rule below without standing up a project.
 * The route handler is the only caller that has to know what a real project
 * looks like; it wires {@link Lookup} to {@link ProjectIndex#search}.</p>
 *
 * <h2>The point of the exercise is the safety rules, not the sorting</h2>
 *
 * <p>Reordering a block of single-line imports is nearly risk-free. Removing a
 * line of somebody's code is not, so every rule below is conservative in the
 * same direction: fail to remove something rather than remove something that
 * was needed. A false "unused" is a broken module; a missed "unused" is a
 * cosmetic miss.</p>
 */
public final class ImportOrganiser {

    private ImportOrganiser() {
    }

    /** A project module that defines a name, so a suggestion can point at it. */
    @FunctionalInterface
    public interface Lookup {
        Optional<String> moduleDefining(String name);
    }

    /**
     * The outcome of one organise pass.
     *
     * @param source      the (possibly unchanged) source
     * @param removed     import statements dropped — exact duplicates, or
     *                    provably unused
     * @param notes       why the block was left alone, partly alone, or could
     *                    not be touched at all
     * @param suggestions imports offered for names the module reads but never
     *                    binds
     */
    public record Result(String source, List<String> removed, List<String> notes,
                         List<Suggestion> suggestions) {

        public Result {
            removed = List.copyOf(removed);
            notes = List.copyOf(notes);
            suggestions = List.copyOf(suggestions);
        }
    }

    /** One offered import. {@code origin} is {@code "project"} or {@code "library"}. */
    public record Suggestion(String name, String statement, String origin) {
    }

    /** Module name handed to {@link ModuleSymbols#parse}; never surfaced to a caller. */
    private static final String PARSE_NAME = "<organise-imports>";

    private static final Pattern EXEC = Pattern.compile("\\bexec\\b");
    private static final Pattern EVAL_CALL = Pattern.compile("\\beval\\s*\\(");
    private static final Pattern GLOBALS_CALL = Pattern.compile("\\bglobals\\s*\\(\\s*\\)");
    private static final Pattern LOCALS_CALL = Pattern.compile("\\blocals\\s*\\(\\s*\\)");

    /**
     * Names that resolve to themselves as a module — {@code json} unknown means
     * {@code import json} — or to a fixed statement for a name whose module
     * differs from it.
     *
     * <p>Deliberately small. This is a fallback for when the project itself does
     * not define the name; a wrong guess here is just a suggestion nobody has to
     * click, so the list favours what actually turns up in Ignition scripts
     * (Java date/time classes included) over completeness.</p>
     */
    private static final Map<String, String> BUILTIN_SUGGESTIONS = builtinSuggestions();

    private static Map<String, String> builtinSuggestions() {
        Map<String, String> out = new LinkedHashMap<>();
        for (String module : List.of("json", "re", "os", "sys", "time", "math", "random",
                "traceback", "csv", "base64", "hashlib", "uuid", "string", "socket",
                "threading", "collections", "itertools", "functools")) {
            out.put(module, "import " + module);
        }
        out.put("datetime", "from datetime import datetime");
        out.put("Date", "from java.util import Date");
        out.put("System", "from java.lang import System");
        out.put("SimpleDateFormat", "from java.text import SimpleDateFormat");
        return Map.copyOf(out);
    }

    /**
     * Organise {@code source}'s leading import block and suggest imports for its
     * unknown names.
     *
     * <p>Never throws. A module that does not parse comes back byte-identical —
     * see {@link ModuleSymbols#parse}, which this delegates to for the same
     * reason: half an AST is not enough to safely rewrite anything.</p>
     */
    public static Result organise(String source, Lookup lookup) {
        String safe = source == null ? "" : source;
        ModuleSymbols symbols = ModuleSymbols.parse(PARSE_NAME, safe);
        if (symbols.syntaxError().isPresent()) {
            return new Result(safe, List.of(),
                List.of("The source has a syntax error and was left unchanged: "
                    + symbols.syntaxError().get()),
                List.of());
        }

        List<Suggestion> suggestions = buildSuggestions(symbols, lookup);

        boolean endsWithNewline = safe.endsWith("\n");
        List<String> lines = new ArrayList<>(Arrays.asList(safe.split("\n", -1)));
        if (endsWithNewline && !lines.isEmpty()) {
            // The split's trailing empty element marks the terminator, not a line.
            lines.remove(lines.size() - 1);
        }

        int blockStart = findBlockStart(lines);
        if (blockStart < 0) {
            // No leading import block — nothing at column 0 before any other code
            // is an import, or the file has no imports at all. Untouched.
            return new Result(safe, List.of(), List.of(), suggestions);
        }
        int blockEnd = findBlockEnd(lines, blockStart);

        String refusal = refusalReason(lines, blockStart, blockEnd);
        if (refusal != null) {
            return new Result(safe, List.of(), List.of(refusal), suggestions);
        }

        List<String> removed = new ArrayList<>();
        List<String> notes = new ArrayList<>();

        ParsedBlock parsed = parseEntries(lines, blockStart, blockEnd);
        List<Entry> entries = dedupe(parsed.entries(), removed);

        List<String> dangers = dangerousConstructs(safe, symbols);
        if (!dangers.isEmpty()) {
            notes.add("The module uses " + String.join(", ", dangers)
                + " — unused imports were left in place. Duplicates were still "
                + "removed and the block was re-sorted.");
        } else {
            // The corpus an "unused" verdict is checked against: the file WITHOUT
            // the block, so an import re-declaring a name elsewhere in the block
            // does not count as a use of it.
            String outside = String.join("\n",
                concat(lines.subList(0, blockStart), lines.subList(blockEnd, lines.size())));
            entries = removeUnused(entries, symbols, outside, removed);
        }

        List<String> rebuiltBlock = rebuild(parsed.orphanComments(), entries);

        List<String> newLines = new ArrayList<>(lines.subList(0, blockStart));
        newLines.addAll(rebuiltBlock);
        newLines.addAll(lines.subList(blockEnd, lines.size()));

        String rebuilt = String.join("\n", newLines) + (endsWithNewline ? "\n" : "");
        return new Result(rebuilt, removed, notes, suggestions);
    }

    private static List<String> concat(List<String> a, List<String> b) {
        List<String> out = new ArrayList<>(a);
        out.addAll(b);
        return out;
    }

    // ==================== finding the block ====================

    private static boolean isBlank(String line) {
        return line.isBlank();
    }

    /** A comment at column 0 — a comment inside a statement never reaches here. */
    private static boolean isComment(String line) {
        return line.startsWith("#");
    }

    private static boolean isImportOrFrom(String line) {
        return line.startsWith("import ") || line.startsWith("from ");
    }

    /**
     * The first line of the leading import block, or -1 when there is none.
     *
     * <p>Blanks, comments, a shebang and the MODULE DOCSTRING are skipped while
     * looking for it. Any other kind of line found before an import means this
     * file has no leading block at all — an import appearing later is "below
     * code" and must not be touched, per the class contract.</p>
     *
     * <p>The docstring has to be skipped or this whole feature is a no-op on
     * exactly the files that are written well: almost every module in this
     * estate opens with one, and treating it as code left every one of them
     * untouched while reporting nothing to change.</p>
     */
    private static int findBlockStart(List<String> lines) {
        int i = 0;
        boolean docstringAllowed = true;
        while (i < lines.size()) {
            String line = lines.get(i);
            if (isBlank(line) || isComment(line)) {
                i++;
                continue;
            }
            if (isImportOrFrom(line)) {
                return i;
            }
            if (docstringAllowed) {
                int after = endOfDocstring(lines, i);
                if (after > i) {
                    // Only the FIRST string can be the docstring. A second one
                    // is a statement, and a file whose imports sit below a
                    // statement is one this must not reorder.
                    docstringAllowed = false;
                    i = after;
                    continue;
                }
            }
            return -1;
        }
        return -1;
    }

    /**
     * One past the last line of a string literal starting at {@code start}, or
     * {@code start} when that line does not begin one.
     *
     * <p>Textual rather than from the AST on purpose. Jython's tree reports a
     * multi-line string's position in a way that is easy to read the wrong way
     * round, and getting it wrong here does not fail — it silently moves the
     * first import INTO the docstring. This only has to recognise the shapes a
     * docstring actually takes, and it returns "not a docstring" for anything
     * else rather than guessing.</p>
     */
    private static int endOfDocstring(List<String> lines, int start) {
        String line = lines.get(start);
        int at = 0;
        // A u/r/b prefix, in either case and either order, is still a string.
        while (at < line.length() && "uUrRbB".indexOf(line.charAt(at)) >= 0) {
            at++;
        }
        if (at >= line.length()) {
            return start;
        }
        String rest = line.substring(at);
        for (String triple : new String[] {"\"\"\"", "'''"}) {
            if (rest.startsWith(triple)) {
                String afterOpener = rest.substring(triple.length());
                if (afterOpener.contains(triple)) {
                    return start + 1;          // opened and closed on one line
                }
                for (int i = start + 1; i < lines.size(); i++) {
                    if (lines.get(i).contains(triple)) {
                        return i + 1;
                    }
                }
                // Unterminated. The file would not have parsed, so this cannot
                // happen -- and if it somehow does, refusing beats guessing.
                return start;
            }
        }
        // A one-line docstring in single quotes: only when the WHOLE line is
        // that string, so `x = 'a'` is code and is not skipped.
        char quote = rest.charAt(0);
        if (quote != '"' && quote != '\'') {
            return start;
        }
        boolean escaped = false;
        for (int i = 1; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (escaped) {
                escaped = false;
            } else if (c == '\\') {
                escaped = true;
            } else if (c == quote) {
                return rest.substring(i + 1).isBlank() ? start + 1 : start;
            }
        }
        return start;
    }

    /** One past the last line of the block: the first line that is not import/blank/comment. */
    private static int findBlockEnd(List<String> lines, int blockStart) {
        int i = blockStart;
        while (i < lines.size()) {
            String line = lines.get(i);
            if (isBlank(line) || isComment(line) || isImportOrFrom(line)) {
                i++;
            } else {
                break;
            }
        }
        return i;
    }

    /**
     * Why the whole rewrite must be refused, or {@code null} to proceed.
     *
     * <p>Only a single-line, column-0 import is safe to move: a backslash
     * continuation or an unclosed bracket means the statement carries on past
     * this line, onto a line the block-finder already excluded (it is indented,
     * or does not itself start with {@code import}/{@code from}) — reordering
     * would separate a statement from its own continuation.</p>
     */
    private static String refusalReason(List<String> lines, int blockStart, int blockEnd) {
        for (int i = blockStart; i < blockEnd; i++) {
            String line = lines.get(i);
            if (!isImportOrFrom(line)) {
                continue;
            }
            String withoutCr = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            if (withoutCr.stripTrailing().endsWith("\\")) {
                return "Line " + (i + 1) + " ends with a backslash continuation — only "
                    + "single-line imports are safe to reorder, so the import block "
                    + "was left unchanged.";
            }
            if (netBrackets(withoutCr) != 0) {
                return "Line " + (i + 1) + " has an unclosed bracket — only single-line "
                    + "imports are safe to reorder, so the import block was left unchanged.";
            }
        }
        return null;
    }

    private static int netBrackets(String line) {
        int net = 0;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                net++;
            } else if (c == ')' || c == ']' || c == '}') {
                net--;
            }
        }
        return net;
    }

    // ==================== rebuilding the block ====================

    /** One import statement, with the comment lines immediately above it. */
    private record Entry(List<String> comments, String statementLine, int lineIndex) {
    }

    /** Comments with no import below them, and every parsed import entry, in source order. */
    private record ParsedBlock(List<String> orphanComments, List<Entry> entries) {
    }

    /**
     * Walk the block, attaching each run of comment lines to the import
     * immediately below it. Blank lines are dropped — see the class Javadoc on
     * why the rebuilt block does not try to preserve them. A run of comments
     * with no import left below it (the block's own tail) is returned separately
     * and re-emitted at the top.
     */
    private static ParsedBlock parseEntries(List<String> lines, int blockStart, int blockEnd) {
        List<Entry> entries = new ArrayList<>();
        List<String> pending = new ArrayList<>();
        for (int i = blockStart; i < blockEnd; i++) {
            String line = lines.get(i);
            if (isComment(line)) {
                pending.add(line);
            } else if (isBlank(line)) {
                continue;
            } else {
                entries.add(new Entry(List.copyOf(pending), line, i));
                pending = new ArrayList<>();
            }
        }
        return new ParsedBlock(List.copyOf(pending), entries);
    }

    /** Drop exact duplicate statements, keeping the first occurrence's comments. */
    private static List<Entry> dedupe(List<Entry> entries, List<String> removed) {
        List<Entry> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Entry entry : entries) {
            String key = entry.statementLine().trim();
            if (seen.add(key)) {
                out.add(entry);
            } else {
                removed.add(key);
            }
        }
        return out;
    }

    /**
     * Drop a statement only when every name it binds matches nowhere in the rest
     * of the file — a plain word-boundary search over the text WITH the block
     * removed, including strings and comments. Over-counting a "use" is the
     * correct direction: it just means an import that could have gone stays.
     */
    private static List<Entry> removeUnused(List<Entry> entries, ModuleSymbols symbols,
                                            String outsideText, List<String> removed) {
        Map<Integer, List<String>> boundNamesByLine = new HashMap<>();
        for (ModuleSymbols.ImportBinding binding : symbols.imports()) {
            if ("*".equals(binding.boundName())) {
                continue;
            }
            boundNamesByLine.computeIfAbsent(binding.line(), k -> new ArrayList<>())
                .add(binding.boundName());
        }

        List<Entry> out = new ArrayList<>();
        for (Entry entry : entries) {
            String trimmed = entry.statementLine().trim();
            boolean isFuture = trimmed.startsWith("from __future__");
            boolean hasNoqa = trimmed.toLowerCase(Locale.ROOT).contains("# noqa");
            List<String> names = boundNamesByLine.getOrDefault(entry.lineIndex(), List.of());
            boolean removable = !isFuture && !hasNoqa && !names.isEmpty()
                && names.stream().distinct().noneMatch(name -> usedOutsideBlock(outsideText, name));
            if (removable) {
                removed.add(trimmed);
            } else {
                out.add(entry);
            }
        }
        return out;
    }

    private static boolean usedOutsideBlock(String text, String name) {
        return Pattern.compile("\\b" + Pattern.quote(name) + "\\b").matcher(text).find();
    }

    /**
     * Sort {@code from __future__} first, then plain {@code import x}, then
     * {@code from x import y} — alphabetically within each group by the text
     * after the leading keyword, so entries group by module name the way a
     * reader expects.
     */
    private static List<String> rebuild(List<String> orphanComments, List<Entry> entries) {
        List<Entry> future = new ArrayList<>();
        List<Entry> plain = new ArrayList<>();
        List<Entry> from = new ArrayList<>();
        for (Entry entry : entries) {
            String trimmed = entry.statementLine().trim();
            if (trimmed.startsWith("from __future__")) {
                future.add(entry);
            } else if (trimmed.startsWith("import ")) {
                plain.add(entry);
            } else {
                from.add(entry);
            }
        }
        Comparator<Entry> bySortKey = Comparator.comparing(ImportOrganiser::sortKey,
            String.CASE_INSENSITIVE_ORDER);
        future.sort(bySortKey);
        plain.sort(bySortKey);
        from.sort(bySortKey);

        List<String> out = new ArrayList<>(orphanComments);
        appendGroup(out, future);
        appendGroup(out, plain);
        appendGroup(out, from);
        return out;
    }

    private static void appendGroup(List<String> out, List<Entry> group) {
        for (Entry entry : group) {
            out.addAll(entry.comments());
            out.add(entry.statementLine());
        }
    }

    private static String sortKey(Entry entry) {
        String trimmed = entry.statementLine().trim();
        if (trimmed.startsWith("import ")) {
            return trimmed.substring("import ".length());
        }
        if (trimmed.startsWith("from ")) {
            return trimmed.substring("from ".length());
        }
        return trimmed;
    }

    // ==================== dangerous constructs ====================

    /**
     * Which of exec/eval/globals/locals/star-import are present, for the note —
     * "say which" rather than a generic refusal.
     */
    private static List<String> dangerousConstructs(String source, ModuleSymbols symbols) {
        List<String> found = new ArrayList<>();
        if (EXEC.matcher(source).find()) {
            found.add("exec");
        }
        if (EVAL_CALL.matcher(source).find()) {
            found.add("eval(");
        }
        if (GLOBALS_CALL.matcher(source).find()) {
            found.add("globals()");
        }
        if (LOCALS_CALL.matcher(source).find()) {
            found.add("locals()");
        }
        if (symbols.imports().stream().anyMatch(ModuleSymbols.ImportBinding::star)) {
            found.add("a star import");
        }
        return found;
    }

    // ==================== suggestions ====================

    private static List<Suggestion> buildSuggestions(ModuleSymbols symbols, Lookup lookup) {
        Set<String> alreadyImported = new HashSet<>();
        for (ModuleSymbols.ImportBinding binding : symbols.imports()) {
            if (!"*".equals(binding.boundName())) {
                alreadyImported.add(binding.boundName());
            }
        }

        List<Suggestion> out = new ArrayList<>();
        for (UnknownNames.Unknown unknown : symbols.unknownNames()) {
            String name = unknown.name();
            if (alreadyImported.contains(name)) {
                continue;
            }
            Optional<String> module = lookup == null ? Optional.empty() : lookup.moduleDefining(name);
            if (module.isPresent()) {
                out.add(new Suggestion(name, "from " + module.get() + " import " + name, "project"));
                continue;
            }
            String statement = BUILTIN_SUGGESTIONS.get(name);
            if (statement != null) {
                out.add(new Suggestion(name, statement, "library"));
            }
        }
        return out;
    }
}
