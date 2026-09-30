package com.gaskony.scriptide.gateway.lang;

import java.util.List;

/**
 * The built-in code snippets offered from the completion popup.
 *
 * <p>Bodies are LSP snippet syntax — {@code ${1:placeholder}} for a tab stop with
 * default text, {@code $0} for where the cursor lands last — which the client
 * converts to CodeMirror's own syntax; see {@code lspSnippetToCodeMirror} in
 * {@code web/src/components/lspExtension.ts}. Indentation inside a body is a real
 * tab character, matching this estate's Jython standard and the byte-fidelity
 * rule the editor already holds every saved script to.</p>
 *
 * <p>Every call here is a real Ignition 8.3 scripting function, not a guess —
 * checked against the estate's own verified knowledge
 * ({@code reference-ignition-alarm-query-source-filter.md} for the alarm source
 * filter, {@code reference-webdev-doget-first-byte.md} for why {@code webdev}'s
 * body cannot start with anything but {@code def doGet}) or against documented
 * Ignition 8.3 scripting signatures where no local record exists yet.</p>
 */
public final class Snippets {

    private Snippets() {
    }

    /** One snippet: what triggers it, and the LSP-syntax body it inserts. */
    public record Snippet(String prefix, String label, String detail, String body,
                          String documentation) {
    }

    public static final List<Snippet> ALL = List.of(
        new Snippet("logger", "logger", "Get a named logger",
            "logger = system.util.getLogger(\"${1:Name}\")",
            "Creates a logger under the given name, visible in the gateway's "
                + "Logs viewer."),

        new Snippet("readtag", "readtag", "Read one tag value",
            "value = system.tag.readBlocking([\"${1:[default]Path/Tag}\"])[0].value",
            "Reads a single tag synchronously and unwraps the `QualifiedValue` "
                + "down to its `.value`."),

        new Snippet("writetag", "writetag", "Write one tag value",
            "system.tag.writeBlocking([\"${1:[default]Path/Tag}\"], [${2:value}])",
            "Writes a single tag synchronously."),

        new Snippet("query", "query", "Run a parameterised SELECT",
            "rows = system.db.runPrepQuery(\"${1:SELECT * FROM table WHERE id = ?}\", "
                + "[${2:args}], \"${3:datasource}\")",
            "Runs a parameterised query and returns a `PyDataSet`. `?` markers "
                + "bind positionally against `args`, never string-formatted in."),

        new Snippet("namedquery", "namedquery", "Run a saved named query",
            "rows = system.db.runNamedQuery(\"${1:Path/Name}\", {${2:}})",
            "Runs a query saved as a Named Query resource, with parameters "
                + "passed as a dict."),

        new Snippet("update", "update", "Run a parameterised UPDATE/INSERT/DELETE",
            "count = system.db.runPrepUpdate(\"${1:UPDATE table SET c = ? WHERE id = ?}\", "
                + "[${2:args}], \"${3:datasource}\")",
            "Runs a parameterised update and returns the affected row count."),

        new Snippet("tx", "tx", "A hand-managed database transaction",
            "tx = system.db.beginTransaction(\"${1:datasource}\")\n"
                + "try:\n"
                + "\tsystem.db.runPrepUpdate(\"${2:UPDATE table SET c = ? WHERE id = ?}\", "
                + "[${3:args}], \"${1:datasource}\", tx)\n"
                + "\tsystem.db.commitTransaction(tx)\n"
                + "except Exception as error:\n"
                + "\tsystem.db.rollbackTransaction(tx)\n"
                + "\traise\n"
                + "finally:\n"
                + "\tsystem.db.closeTransaction(tx)",
            "Opens a transaction, runs the work inside it, commits, rolls back "
                + "on failure and always closes the transaction handle."),

        new Snippet("trycatch", "trycatch", "Try/except with logging",
            "try:\n"
                + "\t${1:pass}\n"
                + "except Exception as error:\n"
                + "\tlogger = system.util.getLogger(\"${2:Name}\")\n"
                + "\tlogger.error(str(error))",
            "A try/except that logs the failure instead of swallowing it "
                + "silently."),

        new Snippet("sendmessage", "sendmessage", "Send a project message",
            "system.util.sendMessage(\"${1:project}\", \"${2:handler}\", {${3:}})",
            "Sends a message handled by `system.util.getGlobalMessageHandler` "
                + "or a matching project message handler."),

        new Snippet("dataset", "dataset", "Build a dataset in code",
            "data = system.dataset.toDataSet([${1:\"column\"}], [[${2:value}]])",
            "Builds a `Dataset` from a list of column names and a list of row "
                + "lists."),

        new Snippet("alarms", "alarms", "Query active alarm status",
            "alarms = system.alarm.queryStatus(source=[\"${1:prov:default:/tag:*}\"])",
            "Queries currently active/cleared alarms. `source` needs the "
                + "`/tag:` segment — `prov:default:*` silently matches nothing."),

        new Snippet("jsonload", "jsonload", "Decode a JSON string",
            "data = system.util.jsonDecode(${1:text})",
            "Decodes a JSON string into Jython dicts/lists."),

        new Snippet("jsondump", "jsondump", "Encode a value as JSON",
            "text = system.util.jsonEncode(${1:data}, ${2:2})",
            "Encodes a Jython value as a JSON string; the second argument is "
                + "the indent width."),

        new Snippet("webdev", "webdev", "A Web Dev GET endpoint",
            "def doGet(request, session):\n"
                + "\treturn {'json': {${1:}}}",
            "A Web Dev resource's `doGet` — this must be the very first thing "
                + "in the script, byte zero: anything above it and the endpoint "
                + "answers an empty 200 with nothing logged."),

        new Snippet("timer", "timer", "A gateway timer script body",
            "logger = system.util.getLogger(\"${1:Name}\")\n"
                + "try:\n"
                + "\t${2:pass}\n"
                + "except Exception as error:\n"
                + "\tlogger.error(str(error))",
            "A timer script body with its own logger and a try/except, so a "
                + "failing run logs instead of just stopping silently."),

        new Snippet("tagchange", "tagchange", "A tag change script body",
            // The bound names are this module's own measured list -- see
            // UnknownNames.EVENT_NAMES and Workspace's tag-change stub. There is
            // no `event` in a tag change script: `tagPath` is bound directly, and
            // a snippet that reached for `event.getTagPath()` would teach a name
            // that raises.
            "if initialChange:\n"
                + "\t${1:pass}\n"
                + "elif currentValue.value != previousValue.value:\n"
                + "\t${2:pass}",
            "A tag change script body. `tagPath`, `previousValue`, "
                + "`currentValue`, `initialChange` and `missedEvents` are bound "
                + "for you. The `initialChange` arm matters: the script fires "
                + "once at subscription with no real change behind it."),

        new Snippet("testmodule", "testmodule", "A Web IDE test",
            "from scriptide import test, assertEquals\n"
                + "\n"
                + "@test\n"
                + "def check_${1:name}():\n"
                + "\tassertEquals(${2:actual}, ${3:expected})",
            "A test in this module's own framework — see the Test panel. "
                + "`@test` is what makes a function whose name does not begin "
                + "`test_` a test; the module still has to be one, its last name "
                + "starting with `test` or sitting under a `tests` package."),

        new Snippet("mocktags", "mocktags", "Mock tag reads inside a test",
            "with mockTags({\"${1:[default]Path/Tag}\": ${2:value}}) as tags:\n"
                + "\t${3:pass}",
            "Mocks tag reads for the duration of the `with` block. Import it "
                + "with `from scriptide import mockTags` first.")
    );
}
