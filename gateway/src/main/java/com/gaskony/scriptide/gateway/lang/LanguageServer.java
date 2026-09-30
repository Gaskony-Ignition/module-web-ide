package com.gaskony.scriptide.gateway.lang;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.script.ScriptManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * A Language Server Protocol server, spoken over one WebSocket channel.
 *
 * <h2>Why real LSP rather than a bespoke API</h2>
 *
 * <p>Because everything downstream of the protocol then comes for free from a
 * maintained client: the completion popup and its filtering, the documentation
 * window, signature-help parameter highlighting, diagnostic rendering, and
 * go-to-definition navigation. A bespoke JSON API means reimplementing all of that
 * in the frontend and maintaining it forever.</p>
 *
 * <p>It also forces the details that are otherwise discovered late — UTF-16
 * positions, document versioning, and incremental sync — to be correct from the
 * start rather than retrofitted.</p>
 *
 * <h2>Transport</h2>
 *
 * <p>There is no {@code Content-Length} framing here. The client
 * ({@code @codemirror/lsp-client}) is transport-agnostic and exchanges whole
 * JSON-RPC messages, so each WebSocket text frame is exactly one message. The
 * framing that a stdio server needs is the transport's job, and the transport is
 * a WebSocket.</p>
 *
 * <p>Completions come from two sources: the platform hint tree for built-in and
 * module functions, and the AST index for project-library intelligence —
 * go-to-definition, references, symbols, and library completions, none of which
 * the per-project hint tree carries.</p>
 */
public final class LanguageServer {

    private static final Logger logger = LoggerFactory.getLogger(LanguageServer.class);

    /** Rebuild the hint index at most this often. */
    private static final long HINT_TTL_MILLIS = 60_000;

    private final Supplier<ScriptManager> scriptManagerSupplier;
    private final Map<String, TextDocument> documents = new ConcurrentHashMap<>();

    /** Project-library navigation. Null when the server has no project context. */
    private final ProjectIndex projectIndex;
    private final String project;

    /**
     * Live tag-path completion inside a {@code [...]} string literal.
     * Group 3. Null offers none — a fake in a
     * unit test, or a gateway with no context yet, both take this path.
     */
    private final TagBrowser tagBrowser;

    /**
     * Live database-schema completion inside a SQL string literal.
     * Group 3. Null offers none, same as
     * {@link #tagBrowser}.
     */
    private final DbSchema dbSchema;

    /** Where server-initiated notifications (diagnostics) go. */
    private volatile Consumer<JsonObject> notifier = m -> { };

    private volatile HintIndex hintIndex;

    /**
     * The last outline that PARSED, per document.
     *
     * <p>A buffer is unparseable for most of the time someone is typing — an
     * unclosed bracket, a half-written def. Returning an empty outline for those
     * moments makes the outline panel flicker and empty on nearly every keystroke,
     * which is worse than slightly stale. Every real IDE keeps the last good one,
     * so this does too.</p>
     */
    private final Map<String, ModuleSymbols> lastGoodSymbols = new ConcurrentHashMap<>();

    public LanguageServer(Supplier<ScriptManager> scriptManagerSupplier) {
        this(scriptManagerSupplier, null, null, null, null);
    }

    public LanguageServer(Supplier<ScriptManager> scriptManagerSupplier,
                          ProjectIndex projectIndex, String project) {
        this(scriptManagerSupplier, projectIndex, project, null, null);
    }

    /**
     * @param tagBrowser live tag-path completion inside {@code [...]} string
     *                   literals;
     *                   {@code null} offers none
     * @param dbSchema   live database-schema completion inside SQL string
     *                   literals (same group); {@code null} offers none
     */
    public LanguageServer(Supplier<ScriptManager> scriptManagerSupplier,
                          ProjectIndex projectIndex, String project,
                          TagBrowser tagBrowser, DbSchema dbSchema) {
        this.scriptManagerSupplier = scriptManagerSupplier;
        this.projectIndex = projectIndex;
        this.project = project;
        this.tagBrowser = tagBrowser;
        this.dbSchema = dbSchema;
    }

    /** Install the sink for server-initiated notifications. */
    public void setNotifier(Consumer<JsonObject> notifier) {
        this.notifier = notifier == null ? m -> { } : notifier;
    }

    /**
     * Handle one JSON-RPC message.
     *
     * @return the response to send back, or {@code null} for a notification
     *         (which by definition has no reply)
     */
    public JsonObject handle(JsonObject message) {
        String method = message.has("method") ? message.get("method").getAsString() : null;
        if (method == null) {
            return null;
        }
        boolean isRequest = message.has("id");
        JsonObject params = message.has("params") && message.get("params").isJsonObject()
            ? message.getAsJsonObject("params")
            : new JsonObject();

        try {
            JsonElement result = dispatch(method, params);
            if (!isRequest) {
                return null;
            }
            JsonObject response = new JsonObject();
            response.addProperty("jsonrpc", "2.0");
            response.add("id", message.get("id"));
            response.add("result", result == null ? com.google.gson.JsonNull.INSTANCE : result);
            return response;
        } catch (RuntimeException e) {
            logger.debug("LSP method {} failed: {}", method, e.toString());
            if (!isRequest) {
                return null;
            }
            JsonObject error = new JsonObject();
            // -32603 is the JSON-RPC "internal error" code.
            error.addProperty("code", -32603);
            error.addProperty("message", String.valueOf(e.getMessage()));
            JsonObject response = new JsonObject();
            response.addProperty("jsonrpc", "2.0");
            response.add("id", message.get("id"));
            response.add("error", error);
            return response;
        }
    }

    private JsonElement dispatch(String method, JsonObject params) {
        switch (method) {
            case "initialize":
                return initialize();
            case "initialized":
            case "shutdown":
            case "exit":
                return null;
            case "textDocument/didOpen":
                didOpen(params);
                publishDiagnostics(uriOf(params));
                return null;
            case "textDocument/didChange":
                didChange(params);
                publishDiagnostics(uriOf(params));
                return null;
            case "textDocument/didClose":
                documents.remove(uriOf(params));
                lastGoodSymbols.remove(uriOf(params));
                return null;
            case "textDocument/didSave":
                return null;
            case "textDocument/completion":
                return completion(params);
            case "completionItem/resolve":
                return resolveCompletion(params);
            case "textDocument/hover":
                return hover(params);
            case "textDocument/signatureHelp":
                return signatureHelp(params);
            case "textDocument/definition":
                return definition(params);
            case "textDocument/documentSymbol":
                return documentSymbol(params);
            case "workspace/symbol":
                return workspaceSymbol(params);
            case "scriptide/searchText":
                return searchText(params);
            case "scriptide/unusedSymbols":
                return unusedSymbols();
            case "scriptide/references":
                return references(params);
            default:
                // Unknown methods answer null rather than erroring: an LSP client
                // probes for optional capabilities, and a hard error on each one
                // fills the console with noise that looks like a fault.
                logger.debug("Unhandled LSP method: {}", method);
                return null;
        }
    }

    // ==================== lifecycle ====================

    private JsonElement initialize() {
        JsonObject completionProvider = new JsonObject();
        JsonArray triggers = new JsonArray();
        triggers.add(".");
        // "[" opens a tag-path string; "/" descends one more level once inside
        // one. Neither is a word character, so without an explicit trigger
        // the client would only offer a completion here on an explicit
        // Ctrl+Space.
        triggers.add("[");
        triggers.add("/");
        completionProvider.add("triggerCharacters", triggers);
        completionProvider.addProperty("resolveProvider", true);

        JsonObject signatureProvider = new JsonObject();
        JsonArray sigTriggers = new JsonArray();
        sigTriggers.add("(");
        sigTriggers.add(",");
        signatureProvider.add("triggerCharacters", sigTriggers);

        JsonObject capabilities = new JsonObject();
        // 2 = Incremental. Full sync would be simpler but re-sends the whole
        // document on every keystroke, which on a 5,000-line script is a lot of
        // JSON per character typed.
        capabilities.addProperty("textDocumentSync", 2);
        capabilities.add("completionProvider", completionProvider);
        capabilities.add("signatureHelpProvider", signatureProvider);
        capabilities.addProperty("hoverProvider", true);
        capabilities.addProperty("definitionProvider", true);
        capabilities.addProperty("documentSymbolProvider", true);
        capabilities.addProperty("workspaceSymbolProvider", true);

        JsonObject serverInfo = new JsonObject();
        serverInfo.addProperty("name", "Web IDE");

        JsonObject result = new JsonObject();
        result.add("capabilities", capabilities);
        result.add("serverInfo", serverInfo);
        return result;
    }

    private void didOpen(JsonObject params) {
        JsonObject doc = params.getAsJsonObject("textDocument");
        String uri = doc.get("uri").getAsString();
        String text = doc.has("text") ? doc.get("text").getAsString() : "";
        int version = doc.has("version") ? doc.get("version").getAsInt() : 0;
        TextDocument document = new TextDocument(uri, text, version);
        documents.put(uri, document);
        // Seed the outline cache, so the first request after opening a file that is
        // momentarily unparseable still has something to show.
        symbolsFor(uri, document);
    }

    private void didChange(JsonObject params) {
        String uri = uriOf(params);
        TextDocument document = documents.get(uri);
        if (document == null) {
            return;
        }
        JsonObject doc = params.getAsJsonObject("textDocument");
        if (doc.has("version")) {
            document.setVersion(doc.get("version").getAsInt());
        }
        for (JsonElement element : params.getAsJsonArray("contentChanges")) {
            JsonObject change = element.getAsJsonObject();
            String text = change.get("text").getAsString();
            if (!change.has("range")) {
                document.setText(text);   // the client chose full replacement
                continue;
            }
            JsonObject range = change.getAsJsonObject("range");
            JsonObject start = range.getAsJsonObject("start");
            JsonObject end = range.getAsJsonObject("end");
            document.applyChange(
                start.get("line").getAsInt(), start.get("character").getAsInt(),
                end.get("line").getAsInt(), end.get("character").getAsInt(), text);
        }
    }

    // ==================== features ====================

    private JsonElement completion(JsonObject params) {
        TextDocument document = documents.get(uriOf(params));
        if (document == null) {
            return emptyCompletionList();
        }
        JsonObject position = params.getAsJsonObject("position");
        int line = position.get("line").getAsInt();
        int character = position.get("character").getAsInt();

        // Group 3: a tag path and a piece of
        // SQL both live INSIDE a string literal, which is a different
        // question from the dotted-name walk below and takes over completion
        // entirely when it answers - offering `system.tag.read` as a
        // completion of a half-typed tag path would be nonsense, and the two
        // features are mutually exclusive by construction (one string cannot
        // be both).
        Optional<TextDocument.StringLiteral> literal = document.stringLiteralAt(line, character);
        if (literal.isPresent()) {
            String content = literal.get().content();
            if (content.startsWith("[")) {
                return tagPathCompletion(line, character, content);
            }
            return databaseCompletion(line, character, content);
        }

        String prefix = document.dottedPrefixAt(line, character);
        // A prefix that STARTS with a dot means the thing before it is an expression
        // we cannot resolve statically - a string literal, a call result, a
        // subscript. Offering root-level names there would suggest `system` as a
        // member of `'abc'.`, which is worse than offering nothing.
        if (prefix.startsWith(".")) {
            return emptyCompletionList();
        }
        int lastDot = prefix.lastIndexOf('.');
        String base = lastDot < 0 ? "" : prefix.substring(0, lastDot);
        String partial = lastDot < 0 ? prefix : prefix.substring(lastDot + 1);

        List<HintIndex.Entry> candidates = index().childrenOf(base);
        JsonArray items = new JsonArray();
        for (HintIndex.Entry entry : candidates) {
            if (!partial.isEmpty()
                && !entry.name().regionMatches(true, 0, partial, 0, partial.length())) {
                continue;
            }
            items.add(completionItem(entry));
        }

        // Snippets are never a member of anything — `system.tag.logger` is not a
        // thing — so they only ever appear for the bare (no-dot) prefix, appended
        // after the API entries.
        if (base.isEmpty()) {
            for (Snippets.Snippet snippet : Snippets.ALL) {
                if (!partial.isEmpty()
                    && !snippet.prefix().regionMatches(true, 0, partial, 0, partial.length())) {
                    continue;
                }
                items.add(snippetCompletionItem(snippet));
            }
        }

        JsonObject list = new JsonObject();
        // isIncomplete=false: the whole candidate set for this prefix is here, so the
        // client may filter locally as the user keeps typing instead of round-tripping.
        list.addProperty("isIncomplete", false);
        list.add("items", items);
        return list;
    }

    // ==================== Group 3: tag-path / DB-schema completion ====================
    // the borrowed-ideas brief. Both fire only inside a string literal
    // (see the branch in completion() above) and both answer nothing when
    // their provider is null - a fake in a unit test, or a gateway with no
    // context wired up yet.

    /** LSP CompletionItemKind values these two sources use. */
    private static final int KIND_FOLDER = 19;
    private static final int KIND_VALUE = 12;
    private static final int KIND_CLASS = 7;
    private static final int KIND_FIELD = 5;
    private static final int KIND_KEYWORD = 14;

    /** Bound on how many items ONE tag-path or database completion answers. */
    private static final int MAX_LIVE_COMPLETION_ITEMS = 500;

    /**
     * Tag-path completion inside a string literal that starts with {@code [}.
     *
     * <p>Two stages, split on whether the provider bracket has closed yet.
     * Before {@code ]}, the candidates are PROVIDER names, each completing to
     * {@code provider]} - the opening bracket is already typed, so only the
     * closing one and the name are ever inserted. After {@code ]}, the
     * candidates are the children of whatever has been typed of the path so
     * far, split on {@code /}: a folder (or a UDT instance/definition, which
     * browses the same way) completes with a trailing {@code /} so the very
     * next keystroke can descend again; a tag completes bare, with its data
     * type in {@code detail}.</p>
     *
     * <p>Both stages replace only the last segment via a {@code textEdit}
     * rather than an {@code insertText} - {@code /} and {@code [} are not
     * word characters, so the client's own default replacement range would
     * insert alongside what is already typed instead of over it, duplicating
     * the path.</p>
     */
    private JsonElement tagPathCompletion(int line, int character, String content) {
        JsonArray items = new JsonArray();
        if (tagBrowser != null) {
            int close = content.indexOf(']');
            if (close < 0) {
                String partial = content.substring(1);
                int from = character - partial.length();
                for (String provider : tagBrowser.providers()) {
                    if (items.size() >= MAX_LIVE_COMPLETION_ITEMS) {
                        break;
                    }
                    if (!partial.isEmpty()
                        && !provider.regionMatches(true, 0, partial, 0, partial.length())) {
                        continue;
                    }
                    items.add(replacingCompletionItem(
                        provider, KIND_FOLDER, null, provider + "]", line, from, character));
                }
            } else {
                String provider = content.substring(1, close);
                String rest = content.substring(close + 1);
                int lastSlash = rest.lastIndexOf('/');
                String parentPath = lastSlash < 0 ? "" : rest.substring(0, lastSlash);
                String partial = lastSlash < 0 ? rest : rest.substring(lastSlash + 1);
                int from = character - partial.length();
                for (TagBrowser.Child child : tagBrowser.children(provider, parentPath)) {
                    if (items.size() >= MAX_LIVE_COMPLETION_ITEMS) {
                        break;
                    }
                    if (!partial.isEmpty()
                        && !child.name().regionMatches(true, 0, partial, 0, partial.length())) {
                        continue;
                    }
                    String newText = child.folder() ? child.name() + "/" : child.name();
                    items.add(replacingCompletionItem(newText,
                        child.folder() ? KIND_FOLDER : KIND_VALUE,
                        child.folder() ? null : child.dataType(),
                        newText, line, from, character));
                }
            }
        }
        return completionListOf(items);
    }

    /** The SQL that puts the cursor squarely after a table-naming keyword. */
    private static final List<String> SQL_TABLE_KEYWORDS = List.of("FROM", "JOIN", "INTO", "UPDATE");

    /** What "fire at all" means for the database source — see its Javadoc. */
    private static final List<String> SQL_TRIGGERS =
        List.of(" FROM ", " JOIN ", " INTO ", "UPDATE ", "SELECT ");

    /** A small, fixed vocabulary offered alongside columns — not exhaustive. */
    private static final List<String> SQL_KEYWORDS = List.of(
        "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "INSERT", "INTO", "VALUES",
        "UPDATE", "SET", "DELETE", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "ON",
        "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "AS", "DISTINCT", "NULL", "IN",
        "LIKE", "BETWEEN", "IS", "COUNT", "SUM", "AVG", "MIN", "MAX");

    /**
     * Database-schema completion inside a SQL string literal.
     *
     * <p>Fires when the string content, upper-cased, contains one of
     * {@link #SQL_TRIGGERS} - loosely, "this looks like it is going to be a
     * SQL statement" rather than a strict parse, because the string is
     * usually still being typed. Which of the two candidate sets comes back
     * depends on the KEYWORD immediately before whatever identifier is
     * currently being typed: {@code FROM}/{@code JOIN}/{@code INTO}/
     * {@code UPDATE} want a table name, so every configured datasource's
     * tables are offered with the datasource in {@code detail} - the query
     * call's own datasource argument is not knowable at completion time (it
     * is usually typed AFTER the SQL string, as a later argument), so this
     * says which connection each table came from rather than guessing one.
     * Anywhere else, columns from every table are offered (detail
     * {@code datasource.table}) plus a small fixed list of SQL keywords.</p>
     */
    private JsonElement databaseCompletion(int line, int character, String content) {
        JsonArray items = new JsonArray();
        if (dbSchema != null) {
            String upper = content.toUpperCase(Locale.ROOT);
            boolean sqlContext = false;
            for (String trigger : SQL_TRIGGERS) {
                if (upper.contains(trigger)) {
                    sqlContext = true;
                    break;
                }
            }
            if (sqlContext) {
                int i = content.length();
                while (i > 0 && isSqlIdentifierChar(content.charAt(i - 1))) {
                    i--;
                }
                String partial = content.substring(i);
                int from = character - partial.length();
                String beforeUpper = content.substring(0, i).stripTrailing().toUpperCase(Locale.ROOT);
                int lastSpace = beforeUpper.lastIndexOf(' ');
                String lastWord = lastSpace < 0 ? beforeUpper : beforeUpper.substring(lastSpace + 1);

                if (SQL_TABLE_KEYWORDS.contains(lastWord)) {
                    addTableItems(items, partial, line, from, character);
                } else {
                    addColumnItems(items, partial, line, from, character);
                    addKeywordItems(items, partial, line, from, character);
                }
            }
        }
        return completionListOf(items);
    }

    private void addTableItems(JsonArray items, String partial, int line, int from, int character) {
        for (String datasource : dbSchema.datasources()) {
            for (String table : dbSchema.tables(datasource)) {
                if (items.size() >= MAX_LIVE_COMPLETION_ITEMS) {
                    return;
                }
                if (!partial.isEmpty() && !table.regionMatches(true, 0, partial, 0, partial.length())) {
                    continue;
                }
                items.add(replacingCompletionItem(table, KIND_CLASS, datasource, table, line, from, character));
            }
        }
    }

    private void addColumnItems(JsonArray items, String partial, int line, int from, int character) {
        for (String datasource : dbSchema.datasources()) {
            for (String table : dbSchema.tables(datasource)) {
                for (String column : dbSchema.columns(datasource, table)) {
                    if (items.size() >= MAX_LIVE_COMPLETION_ITEMS) {
                        return;
                    }
                    if (!partial.isEmpty()
                        && !column.regionMatches(true, 0, partial, 0, partial.length())) {
                        continue;
                    }
                    items.add(replacingCompletionItem(column, KIND_FIELD,
                        datasource + "." + table, column, line, from, character));
                }
            }
        }
    }

    private void addKeywordItems(JsonArray items, String partial, int line, int from, int character) {
        for (String keyword : SQL_KEYWORDS) {
            if (items.size() >= MAX_LIVE_COMPLETION_ITEMS) {
                return;
            }
            if (!partial.isEmpty() && !keyword.regionMatches(true, 0, partial, 0, partial.length())) {
                continue;
            }
            items.add(replacingCompletionItem(keyword, KIND_KEYWORD, null, keyword, line, from, character));
        }
    }

    private static boolean isSqlIdentifierChar(char c) {
        return Character.isLetterOrDigit(c) || c == '_';
    }

    private static JsonObject completionListOf(JsonArray items) {
        JsonObject list = new JsonObject();
        list.addProperty("isIncomplete", false);
        list.add("items", items);
        return list;
    }

    /**
     * One completion item that replaces {@code [fromChar, toChar)} on
     * {@code line} with {@code newText}, via a {@code textEdit} rather than
     * {@code insertText}.
     *
     * <p>Both {@link #tagPathCompletion} and {@link #databaseCompletion} need
     * this: the character just typed to trigger completion — {@code [},
     * {@code /}, a space after a keyword — is not a word character, so a
     * client's default "replace the current word" behaviour would leave the
     * already-typed partial sitting next to the inserted text instead of
     * being replaced by it.</p>
     */
    private static JsonObject replacingCompletionItem(String label, int kind, String detail,
            String newText, int line, int fromChar, int toChar) {
        JsonObject item = new JsonObject();
        item.addProperty("label", label);
        item.addProperty("kind", kind);
        if (detail != null) {
            item.addProperty("detail", detail);
        }
        JsonObject start = new JsonObject();
        start.addProperty("line", line);
        start.addProperty("character", fromChar);
        JsonObject end = new JsonObject();
        end.addProperty("line", line);
        end.addProperty("character", toChar);
        JsonObject range = new JsonObject();
        range.add("start", start);
        range.add("end", end);
        JsonObject textEdit = new JsonObject();
        textEdit.add("range", range);
        textEdit.addProperty("newText", newText);
        item.add("textEdit", textEdit);
        return item;
    }

    private JsonObject completionItem(HintIndex.Entry entry) {
        JsonObject item = new JsonObject();
        item.addProperty("label", entry.name());
        item.addProperty("kind", lspKind(entry.kind()));
        if (entry.detail() != null) {
            item.addProperty("detail", entry.detail());
        }
        if (entry.deprecated()) {
            JsonArray tags = new JsonArray();
            tags.add(1);   // CompletionItemTag.Deprecated
            item.add("tags", tags);
        }
        // The dotted path round-trips through resolve, so the doc window can be
        // filled in on demand rather than sending every docstring up front.
        JsonObject data = new JsonObject();
        data.addProperty("dottedPath", entry.dottedPath());
        item.add("data", data);
        return item;
    }

    /**
     * A built-in snippet as an LSP completion item.
     *
     * <p>No {@code data.dottedPath} is attached — unlike an API entry, a snippet
     * has no gateway API to look up — so a snippet item handed back through
     * {@link #resolveCompletion} takes the early-return path there and comes back
     * unchanged rather than the resolver crashing on a lookup that does not
     * apply. The documentation is filled in here, up front, for the same
     * reason: there is nothing to defer to a resolve round trip.</p>
     */
    private JsonObject snippetCompletionItem(Snippets.Snippet snippet) {
        JsonObject item = new JsonObject();
        item.addProperty("label", snippet.prefix());
        item.addProperty("kind", 15);   // LSP CompletionItemKind.Snippet
        item.addProperty("insertTextFormat", 2);   // LSP InsertTextFormat.Snippet
        item.addProperty("insertText", snippet.body());
        item.addProperty("detail", snippet.detail());
        JsonObject documentation = new JsonObject();
        documentation.addProperty("kind", "markdown");
        documentation.addProperty("value", snippet.documentation());
        item.add("documentation", documentation);
        return item;
    }

    private JsonElement resolveCompletion(JsonObject params) {
        JsonObject item = params.deepCopy();
        if (!item.has("data") || !item.get("data").isJsonObject()) {
            return item;
        }
        String dotted = item.getAsJsonObject("data").get("dottedPath").getAsString();
        index().resolve(dotted).ifPresent(entry -> {
            String docs = markdownFor(entry);
            if (!docs.isEmpty()) {
                JsonObject documentation = new JsonObject();
                documentation.addProperty("kind", "markdown");
                documentation.addProperty("value", docs);
                item.add("documentation", documentation);
            }
        });
        return item;
    }

    private JsonElement hover(JsonObject params) {
        TextDocument document = documents.get(uriOf(params));
        if (document == null) {
            return null;
        }
        JsonObject position = params.getAsJsonObject("position");
        String dotted = fullDottedNameAt(document,
            position.get("line").getAsInt(), position.get("character").getAsInt());
        if (dotted.isEmpty()) {
            return null;
        }
        return index().resolve(dotted).map(entry -> {
            String markdown = markdownFor(entry);
            if (markdown.isEmpty()) {
                return null;
            }
            JsonObject contents = new JsonObject();
            contents.addProperty("kind", "markdown");
            contents.addProperty("value", markdown);
            JsonObject result = new JsonObject();
            result.add("contents", contents);
            return (JsonElement) result;
        }).orElse(null);
    }

    private JsonElement signatureHelp(JsonObject params) {
        TextDocument document = documents.get(uriOf(params));
        if (document == null) {
            return null;
        }
        JsonObject position = params.getAsJsonObject("position");
        int line = position.get("line").getAsInt();
        int character = position.get("character").getAsInt();
        String lineText = document.lineText(line);
        int cursor = Math.min(Math.max(0, character), lineText.length());

        int open = openCallParen(lineText, cursor);
        if (open < 0) {
            return null;
        }
        String callee = document.dottedPrefixAt(line, open);
        if (callee.isEmpty()) {
            return null;
        }
        return index().resolve(callee).map(entry -> {
            if (entry.kind() != HintIndex.Kind.FUNCTION) {
                return null;
            }
            JsonArray parameters = new JsonArray();
            for (HintIndex.Param p : entry.params()) {
                JsonObject param = new JsonObject();
                param.addProperty("label", p.optional() ? "[" + p.name() + "]" : p.name());
                if (p.documentation() != null) {
                    param.addProperty("documentation", p.documentation());
                }
                parameters.add(param);
            }
            JsonObject signature = new JsonObject();
            signature.addProperty("label", entry.detail() == null
                ? HintIndex.signature(entry.name(), entry.params())
                : entry.detail());
            if (entry.documentation() != null) {
                signature.addProperty("documentation", entry.documentation());
            }
            signature.add("parameters", parameters);

            JsonArray signatures = new JsonArray();
            signatures.add(signature);
            JsonObject result = new JsonObject();
            result.add("signatures", signatures);
            result.addProperty("activeSignature", 0);
            result.addProperty("activeParameter",
                Math.min(countArgumentsBefore(lineText, open, cursor),
                    Math.max(0, entry.params().size() - 1)));
            return (JsonElement) result;
        }).orElse(null);
    }


    /**
     * Go to the definition of the dotted name under the cursor.
     *
     * <p>Only project-library symbols resolve: a platform function like
     * {@code system.tag.readBlocking} has no source file on this gateway to jump
     * to, so it answers null and hover carries the documentation instead.</p>
     */
    private JsonElement definition(JsonObject params) {
        if (projectIndex == null || project == null) {
            return null;
        }
        TextDocument document = documents.get(uriOf(params));
        if (document == null) {
            return null;
        }
        JsonObject position = params.getAsJsonObject("position");
        String dotted = fullDottedNameAt(document,
            position.get("line").getAsInt(), position.get("character").getAsInt());
        if (dotted.isEmpty()) {
            return null;
        }
        // An unqualified name may be a local import alias; resolve it through the
        // module's own import bindings before giving up.
        String resolved = resolveThroughImports(document, dotted);
        return projectIndex.resolve(project, resolved)
            .map(def -> (JsonElement) locationOf(def))
            .orElse(null);
    }

    /**
     * Rewrite a name through the current module's imports.
     *
     * <p>{@code from util import helper} then {@code helper(...)} must resolve to
     * {@code util.helper}, and {@code import x.y as z} then {@code z.f} to
     * {@code x.y.f}. Without this, go-to-definition only works for names already
     * written in full, which is almost never how anyone writes code.</p>
     */
    private String resolveThroughImports(TextDocument document, String dotted) {
        ModuleSymbols symbols = ModuleSymbols.parse("<buffer>", document.text());
        int dot = dotted.indexOf('.');
        String head = dot < 0 ? dotted : dotted.substring(0, dot);
        String tail = dot < 0 ? "" : dotted.substring(dot);
        for (ModuleSymbols.ImportBinding binding : symbols.imports()) {
            if (!binding.boundName().equals(head)) {
                continue;
            }
            if (binding.targetMember() != null) {
                return binding.targetModule() + "." + binding.targetMember() + tail;
            }
            return binding.targetModule() + tail;
        }
        return dotted;
    }

    private JsonObject locationOf(ProjectIndex.Definition def) {
        JsonObject start = new JsonObject();
        start.addProperty("line", def.line());
        start.addProperty("character", def.column());
        JsonObject range = new JsonObject();
        range.add("start", start);
        range.add("end", start.deepCopy());
        JsonObject location = new JsonObject();
        location.addProperty("uri", "ignition://" + project + "/ignition/script-python/"
            + def.moduleName().replace('.', '/'));
        location.add("range", range);
        return location;
    }

    /** Outline of the OPEN buffer — not the saved resource, which may be stale. */
    private JsonElement documentSymbol(JsonObject params) {
        String uri = uriOf(params);
        TextDocument document = documents.get(uri);
        if (document == null) {
            return new JsonArray();
        }
        ModuleSymbols symbols = symbolsFor(uri, document);
        JsonArray out = new JsonArray();
        for (ModuleSymbols.Symbol symbol : symbols.symbols()) {
            JsonObject item = new JsonObject();
            item.addProperty("name", symbol.name());
            item.addProperty("kind", lspSymbolKind(symbol.kind()));
            if (symbol.container() != null) {
                item.addProperty("containerName", symbol.container());
            }
            JsonObject start = new JsonObject();
            start.addProperty("line", symbol.line());
            start.addProperty("character", symbol.column());
            JsonObject range = new JsonObject();
            range.add("start", start);
            range.add("end", start.deepCopy());
            JsonObject location = new JsonObject();
            location.addProperty("uri", document.uri());
            location.add("range", range);
            item.add("location", location);
            out.add(item);
        }
        return out;
    }

    /** Project-wide symbol search, for quick-open. */
    private JsonElement workspaceSymbol(JsonObject params) {
        JsonArray out = new JsonArray();
        if (projectIndex == null || project == null) {
            return out;
        }
        String query = params.has("query") ? params.get("query").getAsString() : "";
        for (ProjectIndex.SymbolHit hit : projectIndex.search(project, query, 200)) {
            JsonObject item = new JsonObject();
            item.addProperty("name", hit.symbol().name());
            item.addProperty("kind", lspSymbolKind(hit.symbol().kind()));
            item.addProperty("containerName", hit.moduleName());
            JsonObject start = new JsonObject();
            start.addProperty("line", hit.symbol().line());
            start.addProperty("character", hit.symbol().column());
            JsonObject range = new JsonObject();
            range.add("start", start);
            range.add("end", start.deepCopy());
            JsonObject location = new JsonObject();
            location.addProperty("uri", "ignition://" + project + "/ignition/script-python/"
                + hit.moduleName().replace('.', '/'));
            location.add("range", range);
            item.add("location", location);
            out.add(item);
        }
        return out;
    }

    /**
     * The top-level names this PROJECT puts into a script's namespace.
     *
     * <p>Its script-library roots: `MachineDemo.api` makes `MachineDemo` a name
     * every script in that project can use without importing it. They appear
     * nowhere in a file's source, so the unknown-name check must be told about
     * them or it reports one false positive per script.
     * See {@link UnknownNames#withoutProjectNames}.</p>
     *
     * <p>Empty when there is no index yet, which turns the check into "report
     * only what is certain minus what we cannot see" — the safe direction.</p>
     */
    private java.util.Set<String> providedNames() {
        if (projectIndex == null || project == null) {
            return java.util.Set.of();
        }
        java.util.Set<String> roots = new java.util.HashSet<>();
        for (String moduleName : projectIndex.modules(project).keySet()) {
            int dot = moduleName.indexOf('.');
            roots.add(dot < 0 ? moduleName : moduleName.substring(0, dot));
        }
        return roots;
    }

    /**
     * Publish diagnostics for one document.
     *
     * <p>FOUR checks. The first two disagree about severity on purpose; the
     * last two both answer to the RUNNING gateway's own API registry rather
     * than to a table — see {@link PlatformApiChecks}.</p>
     *
     * <p>The SYNTAX ERROR comes from the real Jython 2.7 parser and nothing
     * else — the client-side grammar is Python 3, so nothing but the
     * interpreter's own parser is allowed to say a line is wrong. Jython
     * reports only the first error per parse, which matches the Designer's
     * single squiggle.</p>
     *
     * <p>The UNKNOWN NAME is a warning. It is deliberately loose: a name is
     * reported only when it is bound NOWHERE in the module, is not a builtin,
     * and is not one of the names the platform injects. Every scope rule is
     * given up to keep it from ever marking working code — see
     * {@link UnknownNames}.</p>
     *
     * <p>Severity 2, not 1. A name this module never binds can still exist at
     * run time through a mechanism the parser cannot see, and an ERROR that
     * turns out to be fine is how a reader learns to stop reading the marks.</p>
     *
     * <p>The DEPRECATED CALL and the PACKAGE-NOT-IN-SCOPE checks are both
     * warnings for the same reason, and both are narrow by construction: the
     * scope check runs only where the document is CERTAIN to be gateway-scoped
     * (see {@link #isGatewayScoped}), never on a Project Library module, which
     * a Vision client may legitimately import.</p>
     */
    private void publishDiagnostics(String uri) {
        TextDocument document = documents.get(uri);
        if (document == null) {
            return;
        }
        JsonArray diagnostics = new JsonArray();
        ModuleSymbols symbols = ModuleSymbols.parse("<buffer>", document.text());
        symbols.syntaxError().ifPresent(message -> {
            JsonObject start = new JsonObject();
            start.addProperty("line", symbols.errorLine());
            start.addProperty("character", symbols.errorColumn());
            JsonObject end = new JsonObject();
            end.addProperty("line", symbols.errorLine());
            // Extend to the end of the line: a zero-width squiggle is invisible.
            end.addProperty("character",
                Math.max(symbols.errorColumn() + 1,
                    document.lineText(symbols.errorLine()).length()));
            JsonObject range = new JsonObject();
            range.add("start", start);
            range.add("end", end);
            JsonObject diagnostic = new JsonObject();
            diagnostic.add("range", range);
            diagnostic.addProperty("severity", 1);   // Error
            diagnostic.addProperty("source", "jython");
            diagnostic.addProperty("message", message);
            diagnostics.add(diagnostic);
        });

        for (UnknownNames.Unknown unknown
                : UnknownNames.withoutProjectNames(symbols.unknownNames(), providedNames())) {
            // The AST reports 1-based lines and 0-based columns; LSP wants both
            // 0-based. Getting this wrong shifts every mark by one line, which
            // reads as an editor bug rather than an indexer one.
            int line = Math.max(0, unknown.line() - 1);
            JsonObject start = new JsonObject();
            start.addProperty("line", line);
            start.addProperty("character", unknown.column());
            JsonObject end = new JsonObject();
            end.addProperty("line", line);
            end.addProperty("character", unknown.column() + unknown.name().length());
            JsonObject range = new JsonObject();
            range.add("start", start);
            range.add("end", end);
            JsonObject diagnostic = new JsonObject();
            diagnostic.add("range", range);
            diagnostic.addProperty("severity", 2);   // Warning — see above
            diagnostic.addProperty("source", "scriptide");
            diagnostic.addProperty("message",
                "'" + unknown.name() + "' is not defined anywhere in this script, "
                    + "is not a builtin, and is not a name Ignition provides. "
                    + "It will raise NameError if this line runs.");
            diagnostics.add(diagnostic);
        }

        for (PlatformApiChecks.Finding finding
                : PlatformApiChecks.find(symbols.apiCalls(), PlatformApiChecks.of(index()),
                    isGatewayScoped(uri))) {
            // Same 1-based-to-0-based line conversion as the unknown names
            // above, and the mark runs the length of the path as written.
            int line = Math.max(0, finding.call().line() - 1);
            int from = finding.call().column();
            int width = finding.kind() == PlatformApiChecks.Kind.NOT_IN_SCOPE
                ? finding.call().packagePath().length()
                : finding.call().path().length();
            JsonObject start = new JsonObject();
            start.addProperty("line", line);
            start.addProperty("character", from);
            JsonObject end = new JsonObject();
            end.addProperty("line", line);
            end.addProperty("character", from + width);
            JsonObject range = new JsonObject();
            range.add("start", start);
            range.add("end", end);
            JsonObject diagnostic = new JsonObject();
            diagnostic.add("range", range);
            diagnostic.addProperty("severity", 2);   // Warning — never an error
            diagnostic.addProperty("source", "scriptide");
            diagnostic.addProperty("message", finding.message());
            diagnostics.add(diagnostic);
        }

        // Style findings, LAST, so a real error or an undefined name is at the
        // top of the Problems list. These are opinions about correct code; the
        // ones above are statements that it will not work.
        for (StyleChecks.Finding finding : StyleChecks.find(document.text())) {
            JsonObject start = new JsonObject();
            start.addProperty("line", finding.line());
            start.addProperty("character", finding.column());
            JsonObject end = new JsonObject();
            end.addProperty("line", finding.line());
            // Never zero width: a squiggle with no width is invisible, and the
            // Problems row then points at a place with nothing marked.
            end.addProperty("character", Math.max(finding.endColumn(), finding.column() + 1));
            JsonObject range = new JsonObject();
            range.add("start", start);
            range.add("end", end);
            JsonObject diagnostic = new JsonObject();
            diagnostic.add("range", range);
            diagnostic.addProperty("severity", 2);   // Warning — never an error
            diagnostic.addProperty("source", "scriptide");
            diagnostic.addProperty("code", finding.code());
            diagnostic.addProperty("message", finding.message());
            diagnostics.add(diagnostic);
        }

        JsonObject params = new JsonObject();
        params.addProperty("uri", uri);
        // Version-tagged so a client can drop a payload older than its buffer.
        params.addProperty("version", document.version());
        params.add("diagnostics", diagnostics);
        JsonObject notification = new JsonObject();
        notification.addProperty("jsonrpc", "2.0");
        notification.addProperty("method", "textDocument/publishDiagnostics");
        notification.add("params", params);
        notifier.accept(notification);
    }

    /**
     * Cross-file text search — a custom method, namespaced as LSP requires.
     *
     * <p>Custom rather than shoehorned into {@code workspace/symbol}: that method
     * searches SYMBOL names, and a user looking for a string literal or a comment
     * would get nothing back with no indication why.</p>
     */
    private JsonElement searchText(JsonObject params) {
        JsonArray out = new JsonArray();
        if (projectIndex == null || project == null) {
            return out;
        }
        String query = params.has("query") ? params.get("query").getAsString() : "";
        boolean caseSensitive = params.has("caseSensitive")
            && params.get("caseSensitive").getAsBoolean();
        for (ProjectIndex.TextHit hit
            : projectIndex.searchText(project, query, caseSensitive, 500)) {
            out.add(hitJson(hit));
        }
        return out;
    }

    /**
     * Every place a NAME is written in this project's library scripts.
     *
     * <p>Custom rather than {@code textDocument/references}, and deliberately so:
     * the standard method promises a type-aware answer, and this is
     * <strong>name-based</strong> — {@link ProjectIndex#searchReferences} matches
     * whole identifiers, not receivers, so two unrelated {@code write} methods both
     * appear. Answering the standard method with that would be lying in the
     * protocol; a method of our own is a claim the client has to opt into, and the
     * client labels the results as name-based on screen.</p>
     *
     * <p>The name comes from the client rather than from a cursor position, because
     * the same list is wanted from places that have no cursor — a search result, a
     * symbol in the outline.</p>
     */
    private JsonElement references(JsonObject params) {
        JsonArray out = new JsonArray();
        if (projectIndex == null || project == null) {
            return out;
        }
        String name = params.has("name") ? params.get("name").getAsString() : "";
        for (ProjectIndex.TextHit hit : projectIndex.searchReferences(project, name, 500)) {
            out.add(hitJson(hit));
        }
        return out;
    }

    /**
     * Library functions and classes nothing in the project appears to call.
     *
     * <p>Namespaced as our own method for the same reason references is: the
     * answer is NAME-based and the client has to opt into that and label it. A
     * standard method would imply a certainty this cannot have — see
     * {@link ProjectIndex#unusedSymbols}.</p>
     */
    private JsonElement unusedSymbols() {
        JsonArray out = new JsonArray();
        if (projectIndex == null || project == null) {
            return out;
        }
        for (ProjectIndex.UnusedSymbol unused : projectIndex.unusedSymbols(project, 200)) {
            JsonObject item = new JsonObject();
            item.addProperty("module", unused.moduleName());
            item.addProperty("name", unused.symbolName());
            item.addProperty("kind", unused.kind());
            item.addProperty("line", unused.line());
            item.addProperty("character", unused.column());
            item.addProperty("text", unused.symbolName());
            item.addProperty("uri", "ignition://" + project + "/ignition/script-python/"
                + unused.moduleName().replace('.', '/'));
            out.add(item);
        }
        return out;
    }

    /**
     * One cross-file hit as the wire object both search and references return.
     *
     * <p>Shared so the two cannot drift: the client renders them through one
     * results list, and a field present in one shape and absent in the other shows
     * up as a blank row rather than an error.</p>
     */
    private JsonObject hitJson(ProjectIndex.TextHit hit) {
        JsonObject item = new JsonObject();
        item.addProperty("module", hit.moduleName());
        item.addProperty("line", hit.line());
        item.addProperty("character", hit.column());
        item.addProperty("text", hit.lineText());
        // The RESOURCE PATH the hit carries, never a path rebuilt from the label —
        // with gateway event scripts, Web Dev handlers and named-query SQL in the
        // search corpus alongside library scripts, rebuilding a path from
        // `ignition/script-python/` + the dotted module name addresses the wrong
        // resource for three of the four kinds — silently, since the URI is well
        // formed either way.
        String uri = "ignition://" + project + "/" + hit.resourcePath();
        // The data key is part of a document's identity wherever one resource
        // holds several scripts, which is every Web Dev endpoint. `lspUri` on the
        // client omits it for the default key, and `parseLocationUri` reads it
        // back off the fragment.
        if (hit.dataKey() != null && !hit.dataKey().isBlank()
            && !"code.py".equals(hit.dataKey())) {
            uri = uri + "#" + hit.dataKey();
        }
        item.addProperty("uri", uri);
        return item;
    }

    /**
     * Parse a buffer, falling back to the last outline that parsed.
     *
     * <p>Only the OUTLINE falls back. Diagnostics deliberately do not: a stale
     * "no errors" would hide the error the user just introduced, which is the exact
     * moment they need to see it.</p>
     */
    private ModuleSymbols symbolsFor(String uri, TextDocument document) {
        ModuleSymbols parsed = ModuleSymbols.parse("<buffer>", document.text());
        if (parsed.syntaxError().isEmpty()) {
            lastGoodSymbols.put(uri, parsed);
            return parsed;
        }
        return lastGoodSymbols.getOrDefault(uri, parsed);
    }

    private static int lspSymbolKind(ModuleSymbols.SymbolKind kind) {
        // LSP SymbolKind: Class=5, Method=6, Function=12, Variable=13.
        return switch (kind) {
            case CLASS -> 5;
            case METHOD -> 6;
            case FUNCTION -> 12;
            case VARIABLE -> 13;
        };
    }

    // ==================== helpers ====================

    /**
     * The whole dotted name under the cursor, not just the part before it.
     *
     * <p>Hover needs the complete name — a cursor in the middle of
     * {@code readBlocking} must resolve the whole function, not {@code readBlo}.</p>
     */
    static String fullDottedNameAt(TextDocument document, int line, int character) {
        String lineText = document.lineText(line);
        int end = Math.min(Math.max(0, character), lineText.length());
        while (end < lineText.length()) {
            char c = lineText.charAt(end);
            if (Character.isLetterOrDigit(c) || c == '_') {
                end++;
            } else {
                break;
            }
        }
        return document.dottedPrefixAt(line, end);
    }

    /**
     * Index of the '(' of the call the cursor sits inside, or -1.
     *
     * <p>Scans backwards tracking nesting depth, so an argument that is itself a
     * call — {@code foo(bar(1), |} — reports {@code foo}, not {@code bar}.</p>
     */
    static int openCallParen(String lineText, int cursor) {
        int depth = 0;
        for (int i = Math.min(cursor, lineText.length()) - 1; i >= 0; i--) {
            char c = lineText.charAt(i);
            if (c == ')') {
                depth++;
            } else if (c == '(') {
                if (depth == 0) {
                    return i;
                }
                depth--;
            }
        }
        return -1;
    }

    /** How many commas separate the open paren from the cursor, at depth zero. */
    static int countArgumentsBefore(String lineText, int openParen, int cursor) {
        int count = 0;
        int depth = 0;
        for (int i = openParen + 1; i < Math.min(cursor, lineText.length()); i++) {
            char c = lineText.charAt(i);
            if (c == '(' || c == '[' || c == '{') {
                depth++;
            } else if (c == ')' || c == ']' || c == '}') {
                depth--;
            } else if (c == ',' && depth == 0) {
                count++;
            }
        }
        return count;
    }

    static String markdownFor(HintIndex.Entry entry) {
        StringBuilder sb = new StringBuilder();
        if (entry.detail() != null) {
            sb.append("```python\n").append(entry.detail()).append("\n```\n\n");
        }
        if (entry.deprecated()) {
            sb.append("**Deprecated.**\n\n");
        }
        if (entry.documentation() != null && !entry.documentation().isBlank()) {
            sb.append(entry.documentation()).append("\n\n");
        }
        if (!entry.params().isEmpty()) {
            sb.append("**Parameters**\n\n");
            for (HintIndex.Param p : entry.params()) {
                sb.append("- `").append(p.name()).append('`');
                if (p.optional()) {
                    sb.append(" *(optional")
                        .append(p.defaultValue() == null ? "" : ", default `" + p.defaultValue() + "`")
                        .append(")*");
                }
                if (p.documentation() != null && !p.documentation().isBlank()) {
                    sb.append(" — ").append(p.documentation());
                }
                sb.append('\n');
            }
            sb.append('\n');
        }
        if (entry.returnType() != null && !entry.returnType().isBlank()) {
            sb.append("**Returns** ").append(entry.returnType()).append('\n');
        }
        return sb.toString().trim();
    }

    private static int lspKind(HintIndex.Kind kind) {
        // LSP CompletionItemKind: Method=2, Function=3, Module=9, Property=10.
        return switch (kind) {
            case MODULE -> 9;
            case FUNCTION -> 3;
            case PROPERTY -> 10;
        };
    }

    /**
     * True only where a document is CERTAIN to run on the Gateway.
     *
     * <p>The document uri is {@code ignition://<project>/<resource path>}, so
     * the resource type is readable straight off it. Gateway event scripts and
     * Web Dev handlers run on the Gateway and nowhere else; a Project Library
     * module runs wherever it is imported, which includes Vision clients and
     * Perspective sessions, so it returns FALSE and the scope check never sees
     * it.</p>
     *
     * <p>That deliberately gives up the case people most want — a library
     * function calling {@code system.gui} that is only ever used from a timer
     * script. Answering it needs a call graph across scopes, and answering it
     * wrongly puts a warning on correct client code.</p>
     */
    static boolean isGatewayScoped(String uri) {
        if (uri == null) {
            return false;
        }
        // Web Dev handlers are gateway-scope by definition: they are HTTP
        // endpoints served BY the gateway.
        if (uri.contains("/com.inductiveautomation.webdev/")) {
            return true;
        }
        for (String type : GATEWAY_EVENT_TYPES) {
            if (uri.contains("/ignition/" + type + "/") || uri.endsWith("/ignition/" + type)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The gateway event script resource types, from {@code ScriptResourceTypes}.
     *
     * <p>Spelled out here rather than imported so that adding a type to the
     * common module cannot silently widen a diagnostic's blast radius: a new
     * type has to be added deliberately, with someone deciding it is
     * gateway-only.</p>
     */
    private static final java.util.List<String> GATEWAY_EVENT_TYPES = java.util.List.of(
        "timer", "message", "tag-change", "startup", "shutdown", "update", "scheduled");

    private static String uriOf(JsonObject params) {
        return params.getAsJsonObject("textDocument").get("uri").getAsString();
    }

    private static JsonObject emptyCompletionList() {
        JsonObject list = new JsonObject();
        list.addProperty("isIncomplete", false);
        list.add("items", new JsonArray());
        return list;
    }

    /**
     * The hint index, rebuilt on a TTL.
     *
     * <p>A TTL rather than an event subscription because the SDK exposes no
     * listener for module install or removal — so there is nothing to subscribe to
     * for the case that actually changes this tree. Rebuilding a few-hundred-node
     * tree once a minute is cheap, and the alternative is a stale API list after
     * someone installs a module. Do not "improve" this into an event listener
     * without first finding an event that exists.</p>
     */
    private HintIndex index() {
        HintIndex current = hintIndex;
        if (current != null
            && System.currentTimeMillis() - current.builtAtMillis() < HINT_TTL_MILLIS) {
            return current;
        }
        HintIndex rebuilt = HintIndex.build(scriptManagerSupplier);
        hintIndex = rebuilt;
        return rebuilt;
    }

    /** Number of open documents — for diagnostics and tests. */
    public int openDocumentCount() {
        return documents.size();
    }
}
