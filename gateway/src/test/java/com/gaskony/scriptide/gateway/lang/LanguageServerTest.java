package com.gaskony.scriptide.gateway.lang;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** JSON-RPC handling and the call-site arithmetic behind signature help. */
class LanguageServerTest {

    private static LanguageServer server() {
        // A null ScriptManager exercises the "no gateway" path: HintIndex must
        // degrade to empty rather than throw, so the editor still works without
        // completions instead of the whole channel dying.
        return new LanguageServer(() -> null);
    }

    private static JsonObject request(String method, JsonObject params, Integer id) {
        JsonObject m = new JsonObject();
        m.addProperty("jsonrpc", "2.0");
        m.addProperty("method", method);
        m.add("params", params);
        if (id != null) {
            m.addProperty("id", id);
        }
        return m;
    }

    @Test
    @DisplayName("initialize advertises incremental sync and the trigger characters")
    void initializeAdvertisesCapabilities() {
        JsonObject response = server().handle(request("initialize", new JsonObject(), 1));
        JsonObject caps = response.getAsJsonObject("result").getAsJsonObject("capabilities");
        // 2 = Incremental. Full sync re-sends the whole document per keystroke.
        assertThat(caps.get("textDocumentSync").getAsInt()).isEqualTo(2);
        assertThat(caps.getAsJsonObject("completionProvider")
            .getAsJsonArray("triggerCharacters").get(0).getAsString()).isEqualTo(".");
        assertThat(caps.getAsJsonObject("completionProvider")
            .get("resolveProvider").getAsBoolean()).isTrue();
        assertThat(caps.get("hoverProvider").getAsBoolean()).isTrue();
    }

    @Test
    @DisplayName("a notification gets no reply; a request always does")
    void notificationsGetNoReply() {
        LanguageServer s = server();
        // Replying to a notification is a protocol violation and confuses clients.
        assertThat(s.handle(request("initialized", new JsonObject(), null))).isNull();
        assertThat(s.handle(request("initialize", new JsonObject(), 7))).isNotNull();
    }

    @Test
    @DisplayName("an unknown method answers null rather than erroring")
    void unknownMethodIsQuiet() {
        // Clients probe for optional capabilities; erroring on each fills the
        // console with what looks like faults.
        JsonObject response = server().handle(
            request("textDocument/codeLens", new JsonObject(), 3));
        assertThat(response.has("result")).isTrue();
        assertThat(response.has("error")).isFalse();
    }

    @Test
    @DisplayName("didOpen then didClose tracks the open document set")
    void tracksOpenDocuments() {
        LanguageServer s = server();
        JsonObject open = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", "ignition://p/a");
        td.addProperty("text", "x = 1\n");
        td.addProperty("version", 1);
        open.add("textDocument", td);
        s.handle(request("textDocument/didOpen", open, null));
        assertThat(s.openDocumentCount()).isEqualTo(1);

        JsonObject close = new JsonObject();
        JsonObject id = new JsonObject();
        id.addProperty("uri", "ignition://p/a");
        close.add("textDocument", id);
        s.handle(request("textDocument/didClose", close, null));
        assertThat(s.openDocumentCount()).isZero();
    }

    @Test
    @DisplayName("completion on an unknown document returns an empty list, not an error")
    void completionOnUnknownDocument() {
        JsonObject params = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", "ignition://p/missing");
        params.add("textDocument", td);
        JsonObject pos = new JsonObject();
        pos.addProperty("line", 0);
        pos.addProperty("character", 0);
        params.add("position", pos);

        JsonObject result = server().handle(request("textDocument/completion", params, 5))
            .getAsJsonObject("result");
        assertThat(result.getAsJsonArray("items")).isEmpty();
        assertThat(result.get("isIncomplete").getAsBoolean()).isFalse();
    }

    @Test
    @DisplayName("the open paren of the CURRENT call is found, not a nested one")
    void findsEnclosingCall() {
        // foo(bar(1), | -> the cursor is an argument of foo, not of bar.
        String line = "system.tag.writeBlocking(paths(1), ";
        int open = LanguageServer.openCallParen(line, line.length());
        assertThat(line.substring(0, open)).isEqualTo("system.tag.writeBlocking");
    }

    @Test
    @DisplayName("no enclosing call is reported when the cursor is outside one")
    void noEnclosingCall() {
        assertThat(LanguageServer.openCallParen("x = 1", 5)).isEqualTo(-1);
        assertThat(LanguageServer.openCallParen("foo(1)", 6)).isEqualTo(-1);
    }

    @Test
    @DisplayName("the active parameter counts only top-level commas")
    void countsActiveParameter() {
        String line = "f(a, g(b, c), ";
        int open = LanguageServer.openCallParen(line, line.length());
        // Commas inside g(...) belong to g, not to f.
        assertThat(LanguageServer.countArgumentsBefore(line, open, line.length())).isEqualTo(2);
    }

    @Test
    @DisplayName("the outline survives a transient syntax error")
    void outlineSurvivesTransientSyntaxError() {
        // A buffer is unparseable for most of the time someone is typing. Blanking
        // the outline on every keystroke is worse than showing a slightly stale one.
        LanguageServer s = server();
        String uri = "ignition://p/m";

        JsonObject open = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", uri);
        td.addProperty("text", "def alpha():\n\tpass\n");
        td.addProperty("version", 1);
        open.add("textDocument", td);
        s.handle(request("textDocument/didOpen", open, null));

        JsonObject idParams = new JsonObject();
        JsonObject idDoc = new JsonObject();
        idDoc.addProperty("uri", uri);
        idParams.add("textDocument", idDoc);
        var before = s.handle(request("textDocument/documentSymbol", idParams, 10))
            .getAsJsonArray("result");
        assertThat(before).hasSize(1);

        // Now break it, the way a half-typed call does.
        JsonObject change = new JsonObject();
        JsonObject changeDoc = new JsonObject();
        changeDoc.addProperty("uri", uri);
        changeDoc.addProperty("version", 2);
        change.add("textDocument", changeDoc);
        com.google.gson.JsonArray changes = new com.google.gson.JsonArray();
        JsonObject full = new JsonObject();
        full.addProperty("text", "def alpha():\n\tpass\n\nx = foo(\n");
        changes.add(full);
        change.add("contentChanges", changes);
        s.handle(request("textDocument/didChange", change, null));

        var after = s.handle(request("textDocument/documentSymbol", idParams, 11))
            .getAsJsonArray("result");
        assertThat(after)
            .as("the outline should hold the last good parse, not empty out")
            .hasSize(1);
        assertThat(after.get(0).getAsJsonObject().get("name").getAsString())
            .isEqualTo("alpha");
    }

    @Test
    @DisplayName("hover resolves the whole name under the cursor, not just what precedes it")
    void hoverUsesFullName() {
        TextDocument d = new TextDocument("u", "system.tag.readBlocking(x)\n", 1);
        // Cursor in the MIDDLE of readBlocking.
        assertThat(LanguageServer.fullDottedNameAt(d, 0, 15))
            .isEqualTo("system.tag.readBlocking");
    }

    // ==================== Group 3: tag-path / DB-schema completion ====================
    // the borrowed-ideas brief, tested against FAKES so these stay unit
    // tests rather than needing a real gateway.

    /** A fixed two-provider, one-folder tag tree, just deep enough to test the branches. */
    private static final class FakeTagBrowser implements TagBrowser {
        @Override
        public List<String> providers() {
            return List.of("default", "other");
        }

        @Override
        public List<Child> children(String provider, String path) {
            if ("default".equals(provider) && "Area1".equals(path)) {
                return List.of(new Child("Sub", true, null), new Child("Temp", false, "Float4"));
            }
            return List.of();
        }
    }

    /** One datasource, two tables, columns on only one of them. */
    private static final class FakeDbSchema implements DbSchema {
        @Override
        public List<String> datasources() {
            return List.of("MyDb");
        }

        @Override
        public List<String> tables(String datasource) {
            return "MyDb".equals(datasource) ? List.of("Orders", "Users") : List.of();
        }

        @Override
        public List<String> columns(String datasource, String table) {
            if ("MyDb".equals(datasource) && "Orders".equals(table)) {
                return List.of("OrderId", "CustomerId");
            }
            return List.of();
        }

        @Override
        public List<Column> columnDetails(String datasource, String table) {
            if ("MyDb".equals(datasource) && "Orders".equals(table)) {
                return List.of(new Column("OrderId", "int4"), new Column("CustomerId", "int4"));
            }
            return List.of();
        }

        // No caching in this fake, so "now" is the same answer as the
        // completion path — only SdkDbSchema has a miss/background split.
        @Override
        public List<String> tablesNow(String datasource) {
            return tables(datasource);
        }

        @Override
        public List<Column> columnDetailsNow(String datasource, String table) {
            return columnDetails(datasource, table);
        }

        @Override
        public List<Column> columnDetailsNow(String datasource, String schema, String table) {
            return columnDetailsNow(datasource, table);
        }

        @Override
        public TablesDetail tablesDetailedNow(String datasource) {
            List<TableInfo> info = tables(datasource).stream()
                .map(name -> new TableInfo(null, name, "TABLE"))
                .toList();
            return new TablesDetail(info,
                new ConnectionFacts(null, "\"", true, false, "Fake"));
        }
    }

    /** Open {@code text}, request completion at {@code (line, character)}, return the items. */
    private static JsonArray completionItems(LanguageServer s, String uri, String text,
            int line, int character) {
        JsonObject open = new JsonObject();
        JsonObject td = new JsonObject();
        td.addProperty("uri", uri);
        td.addProperty("text", text);
        td.addProperty("version", 1);
        open.add("textDocument", td);
        s.handle(request("textDocument/didOpen", open, null));

        JsonObject params = new JsonObject();
        JsonObject docId = new JsonObject();
        docId.addProperty("uri", uri);
        params.add("textDocument", docId);
        JsonObject pos = new JsonObject();
        pos.addProperty("line", line);
        pos.addProperty("character", character);
        params.add("position", pos);
        return s.handle(request("textDocument/completion", params, 99))
            .getAsJsonObject("result").getAsJsonArray("items");
    }

    private static List<String> labelsOf(JsonArray items) {
        List<String> labels = new ArrayList<>();
        for (var item : items) {
            labels.add(item.getAsJsonObject().get("label").getAsString());
        }
        return labels;
    }

    @Test
    @DisplayName("tag-path completion offers provider names right after '['")
    void tagPathOffersProviders() {
        LanguageServer s = new LanguageServer(() -> null, null, null, new FakeTagBrowser(), null);
        String text = "path = \"[\n";
        int character = "path = \"[".length();
        JsonArray items = completionItems(s, "ignition://p/tag-providers", text, 0, character);

        assertThat(labelsOf(items)).containsExactlyInAnyOrder("default", "other");
        JsonObject item = items.get(0).getAsJsonObject();
        assertThat(item.get("kind").getAsInt()).isEqualTo(19);   // LSP Folder
        assertThat(item.getAsJsonObject("textEdit").get("newText").getAsString())
            .isIn("default]", "other]");
    }

    @Test
    @DisplayName("tag-path completion browses children after ']', with a correct textEdit range")
    void tagPathOffersChildren() {
        LanguageServer s = new LanguageServer(() -> null, null, null, new FakeTagBrowser(), null);
        String text = "path = \"[default]Area1/\"\n";
        int character = "path = \"[default]Area1/".length();
        JsonArray items = completionItems(s, "ignition://p/tag-children", text, 0, character);

        assertThat(items).hasSize(2);
        JsonObject folder = items.get(0).getAsJsonObject();
        assertThat(folder.get("label").getAsString()).isEqualTo("Sub/");
        assertThat(folder.get("kind").getAsInt()).isEqualTo(19);   // LSP Folder
        JsonObject range = folder.getAsJsonObject("textEdit").getAsJsonObject("range");
        // The partial after the trailing "/" is empty, so the edit is a pure
        // insertion right at the cursor - it must not eat anything before it.
        assertThat(range.getAsJsonObject("start").get("character").getAsInt()).isEqualTo(character);
        assertThat(range.getAsJsonObject("end").get("character").getAsInt()).isEqualTo(character);
        assertThat(folder.getAsJsonObject("textEdit").get("newText").getAsString()).isEqualTo("Sub/");

        JsonObject tag = items.get(1).getAsJsonObject();
        assertThat(tag.get("label").getAsString()).isEqualTo("Temp");
        assertThat(tag.get("kind").getAsInt()).isEqualTo(12);   // LSP Value
        assertThat(tag.get("detail").getAsString()).isEqualTo("Float4");
    }

    @Test
    @DisplayName("database completion offers table names right after FROM")
    void databaseOffersTablesAfterFrom() {
        LanguageServer s = new LanguageServer(() -> null, null, null, null, new FakeDbSchema());
        String text = "sql = \"SELECT * FROM \"\n";
        int character = "sql = \"SELECT * FROM ".length();
        JsonArray items = completionItems(s, "ignition://p/db-tables", text, 0, character);

        assertThat(labelsOf(items)).containsExactlyInAnyOrder("Orders", "Users");
        JsonObject item = items.get(0).getAsJsonObject();
        assertThat(item.get("kind").getAsInt()).isEqualTo(7);   // LSP Class
        assertThat(item.get("detail").getAsString()).isEqualTo("MyDb");
    }

    @Test
    @DisplayName("database completion offers columns (plus keywords) anywhere else in a SQL string")
    void databaseOffersColumnsOtherwise() {
        LanguageServer s = new LanguageServer(() -> null, null, null, null, new FakeDbSchema());
        String text = "sql = \"SELECT \"\n";
        int character = "sql = \"SELECT ".length();
        JsonArray items = completionItems(s, "ignition://p/db-columns", text, 0, character);

        List<String> labels = labelsOf(items);
        assertThat(labels).contains("OrderId", "CustomerId", "WHERE");
        JsonObject column = items.get(0).getAsJsonObject();
        assertThat(column.get("label").getAsString()).isEqualTo("OrderId");
        assertThat(column.get("kind").getAsInt()).isEqualTo(5);   // LSP Field
        assertThat(column.get("detail").getAsString()).isEqualTo("MyDb.Orders");
    }

    @Test
    @DisplayName("a null provider offers nothing, for both tag paths and database schema")
    void nullProvidersOfferNothing() {
        LanguageServer s = server();   // no TagBrowser, no DbSchema
        assertThat(completionItems(s, "ignition://p/no-tag",
            "path = \"[\n", 0, "path = \"[".length())).isEmpty();
        assertThat(completionItems(s, "ignition://p/no-db",
            "sql = \"SELECT \"\n", 0, "sql = \"SELECT ".length())).isEmpty();
    }

    @Test
    @DisplayName("a bare Python prefix still gets API/snippet completions with fakes wired up (no regression)")
    void bareProviderStillGetsSnippetsWithFakesWired() {
        LanguageServer s = new LanguageServer(() -> null, null, null,
            new FakeTagBrowser(), new FakeDbSchema());
        JsonArray items = completionItems(s, "ignition://p/no-string", "log\n", 0, 3);
        assertThat(labelsOf(items)).contains("logger");
    }
}
