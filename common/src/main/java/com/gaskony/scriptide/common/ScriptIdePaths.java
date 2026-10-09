package com.gaskony.scriptide.common;

/**
 * Every route, mount and servlet path string the module uses, in one place.
 *
 * <p>The Gateway exposes a module's surfaces at:</p>
 * <ul>
 *   <li>{@code /res/{MOUNT_ALIAS}/*} — static resources from the mounted folder
 *       (declared by {@code getMountedResourceFolder()}).</li>
 *   <li>{@code /data/{MOUNT_ALIAS}/*} — routes mounted via
 *       {@code mountRouteHandlers(RouteGroup)}. Route constants below are
 *       relative to that base; the platform prefixes it automatically.</li>
 *   <li>{@code /system/{servletPath}} — servlets registered through
 *       {@code WebResourceManager.addServlet(...)}. NOT under {@code /data}.</li>
 * </ul>
 *
 * <p><b>The trailing slash on the SPA URL is load-bearing.</b>
 * {@code /data/scriptide} 404s; {@code /data/scriptide/} works. That is platform
 * dispatcher behaviour, measured on web-designer.</p>
 */
public final class ScriptIdePaths {

    private ScriptIdePaths() { /* constants only */ }

    // ==================== Mount points ====================

    /** Module mount alias — used for both {@code /res/} and {@code /data/}. */
    public static final String MOUNT_ALIAS = "scriptide";

    /** Base of every mounted route. */
    public static final String DATA_BASE = "/data/" + MOUNT_ALIAS;

    /**
     * The full-page SPA landing URL. Note the mandatory trailing slash — see the
     * class Javadoc; without it the platform dispatcher returns 404.
     */
    public static final String SPA_LAUNCH_TARGET = DATA_BASE + "/";

    /** Classpath-served launcher stub backing the Gateway home-page nav tile. */
    public static final String LAUNCHER_JS_RESOURCE_PATH = "/res/" + MOUNT_ALIAS + "/launcher.js";

    // ==================== Routes ====================

    /**
     * Catch-all splat for the SPA shell and its hashed assets.
     *
     * <p><b>MUST be mounted LAST.</b> {@code RouteGroupImpl.findMatchingRoute}
     * streams routes in insertion order, filters by method then path, and takes
     * {@code findFirst()} — first match wins, with no most-specific preference.
     * {@code "/*"} matches everything, so mounting it before any {@code /api/...}
     * route silently shadows every one of them.
     * {@code RouteMountOrderTest} asserts this.</p>
     */
    public static final String ROUTE_SPA_CATCH_ALL = "/*";

    /**
     * Self-describing session probe: {@code GET /api/auth/session}.
     *
     * <p>Mounted OPEN so it can answer {@code {authenticated:false}} for anonymous
     * callers rather than 401 — the SPA uses it to decide between rendering the
     * IDE and rendering a sign-in notice.</p>
     */
    public static final String ROUTE_AUTH_SESSION = "/api/auth/session";

    /** {@code GET /api/projects} — the projects this gateway can edit. */
    public static final String ROUTE_PROJECTS = "/api/projects";

    /**
     * {@code GET /api/scripts?project=X} — the whole editable script tree for one
     * project: project library packages plus every gateway event script, each with
     * its data keys, resource signature and inheritance origin.
     */
    public static final String ROUTE_SCRIPTS = "/api/scripts";

    /**
     * {@code GET|POST|DELETE /api/scripts/content/:path?project=X} — read, write
     * or delete one script body.
     *
     * <p>{@code :path} is {@code <moduleId>/<typeId>/<folder/name>},
     * URL-encoded into ONE route segment (slashes become {@code %2F}) because
     * RouteGroup matches a single segment. A two-segment value addresses a type's
     * singleton, which is how startup/shutdown/update are stored.</p>
     *
     * <p>POST creates when the path does not yet exist in the project and modifies
     * when it does; DELETE removes it. Both require Administrator, a CSRF token
     * and — for anything but a create — an {@code If-Match} signature.</p>
     */
    public static final String ROUTE_SCRIPT_CONTENT = "/api/scripts/content/:path";

    /**
     * {@code GET|POST /api/scripts/attributes/:path?project=X} — the resource's
     * {@code resource.json} attributes (a timer's delay, a handler's threading).
     *
     * <p>A separate route because the content write only calls {@code putData};
     * attributes survive untouched through {@code toBuilder()} and need
     * {@code putAttribute}, which the SDK keeps as a genuinely separate call.</p>
     */
    public static final String ROUTE_SCRIPT_ATTRIBUTES = "/api/scripts/attributes/:path";

    /**
     * The parent project's copy of a resource, for comparing an override.
     *
     * <p>Its own route rather than a flag on the content read: the content route
     * is keyed on THIS project's resource and answering it with another project's
     * body would make one URL mean two things.</p>
     */
    public static final String ROUTE_SCRIPT_INHERITED = "/api/scripts/inherited/:path";

    /**
     * Move one script to a new path.
     *
     * <p>Paths are in the BODY, not the URL: a rename names two of them, and a
     * route template carries one.</p>
     */
    public static final String ROUTE_SCRIPT_RENAME = "/api/scripts/rename";

    /**
     * {@code GET|POST /api/webdev/config/:path?project=X} — a Web Dev endpoint's
     * per-method settings.
     *
     * <p>Separate from the attributes route because a Web Dev resource has NO
     * editable {@code resource.json} attributes. Everything the Designer shows
     * for an endpoint — enabled, require-auth, require-https, required roles,
     * user source, retry count, per HTTP method — is inside a {@code config.json}
     * DATA FILE. Measured on a real gateway 01/09/2026.</p>
     */
    public static final String ROUTE_WEBDEV_CONFIG = "/api/webdev/config/:path";

    /**
     * {@code GET /api/named-queries?project=X} — every named query in one
     * project, with its inheritance origin and the three fields the tree shows.
     */
    public static final String ROUTE_NAMED_QUERIES = "/api/named-queries";

    /**
     * {@code GET|POST|DELETE /api/named-queries/content/:path?project=X} — the
     * SQL text of one named query.
     *
     * <p>{@code :path} is the query's path INSIDE the project
     * ({@code Folder/Name}), URL-encoded into ONE route segment. Unlike the
     * script routes it carries no {@code <moduleId>/<typeId>} prefix: the type is
     * fixed at {@code ignition/named-query}, and this is the same string
     * {@code system.db.runNamedQuery} takes, which the test-run route needs
     * anyway.</p>
     */
    public static final String ROUTE_NAMED_QUERY_CONTENT = "/api/named-queries/content/:path";

    /**
     * {@code GET|POST /api/named-queries/settings/:path?project=X} — everything
     * the Designer's Settings and Authoring tabs hold except the SQL itself:
     * type, database, caching, fallback, permissions and the parameter list.
     *
     * <p>Separate from the content route because the SQL is {@code text/plain}
     * and these are JSON, and because a client saves them against one ETag but
     * may read either alone.</p>
     */
    public static final String ROUTE_NAMED_QUERY_SETTINGS = "/api/named-queries/settings/:path";

    /**
     * {@code POST /api/named-queries/rename?project=X} — move one query, or a
     * folder and everything under it.
     *
     * <p>Not a verb on the content route: a rename is two resource operations
     * (create at the destination, delete at the source) in ONE push, and a folder
     * rename is 2n of them.</p>
     */
    public static final String ROUTE_NAMED_QUERY_RENAME = "/api/named-queries/rename";

    /**
     * {@code POST /api/named-queries/test?project=X} — run one named query with
     * supplied parameters and return its result.
     *
     * <p>Administrator only, and routed through the same {@code ExecutionService}
     * as the console: it is arbitrary SQL against a live database, so it must not
     * have a second, softer gate than running the equivalent Python by hand.</p>
     */
    public static final String ROUTE_NAMED_QUERY_TEST = "/api/named-queries/test";

    /**
     * The versions this IDE has saved for one document, for the current user.
     *
     * <p>Query parameters rather than a {@code :path} segment: this route takes
     * project, path AND data key, and a Web Dev endpoint's key (`doGet.py`) is
     * part of the document's identity. Encoding three things into one path
     * segment is how the tab-aliasing bug of 1.2.0 happened.</p>
     */
    public static final String ROUTE_HISTORY = "/api/history";

    /** One saved version's source. */
    public static final String ROUTE_HISTORY_CONTENT = "/api/history/content";

    /**
     * This user's finished script-console runs, kept across restarts.
     *
     * <p>No {@code :path} — a run belongs to a person, not to a resource.</p>
     */
    public static final String ROUTE_RUNS = "/api/runs";

    /**
     * Who has a script open right now, across this IDE and the Designer.
     *
     * <p>A route as well as a socket broadcast, for two reasons that are not the
     * same. The socket is how a client stays current; this is how anything that
     * is not a client — a diagnostic, an operator asking "why is my badge not
     * showing", the live suite — can read the same answer without holding a
     * WebSocket open.</p>
     */
    public static final String ROUTE_PRESENCE = "/api/presence";

    /**
     * {@code GET /api/git/status?project=X} — which resources differ from the
     * last commit.
     *
     * <p>READ-ONLY, and this module has no route that writes to a repository.
     * a decision on 01/09/2026: staging, committing and remotes belong to
     * {@code module-git}. This answers the question a person has while editing —
     * what have I changed — and nothing beyond it.</p>
     */
    public static final String ROUTE_GIT_STATUS = "/api/git/status";

    /**
     * {@code GET /api/scripts/export?project=X&path=A&path=B} — a resource zip.
     *
     * <p>Repeated {@code path} parameters rather than one delimited value: a
     * resource path already contains slashes and dots, and every delimiter tried
     * in this module has turned out to be a character some real path contains.
     * The response is {@code application/zip} with a Content-Disposition naming
     * it the way the Designer names its own — see {@code docs/EXPORT-FORMAT.md}.</p>
     */
    public static final String ROUTE_SCRIPTS_EXPORT = "/api/scripts/export";

    /**
     * {@code POST /api/scripts/import/inspect?project=X} — what is in this zip.
     *
     * <p>Writes nothing. Its own route rather than a flag on the import: a route
     * that writes when a parameter is present and does not when it is absent is
     * one typo away from an unintended write, and this one takes an uploaded
     * archive from a browser.</p>
     */
    public static final String ROUTE_SCRIPTS_IMPORT_INSPECT = "/api/scripts/import/inspect";

    /** {@code POST /api/scripts/import?project=X&path=A} — write the selection. */
    public static final String ROUTE_SCRIPTS_IMPORT = "/api/scripts/import";

    /**
     * {@code GET /api/tests?project=X} — the tests this project declares.
     *
     * <p>Discovery only; it runs nothing, so it takes the authenticated gate.
     * What counts as a test is {@code TestDiscovery}'s convention, and the
     * response states it so the panel can show the rule rather than an empty
     * list.</p>
     */
    public static final String ROUTE_TESTS = "/api/tests";

    /**
     * {@code POST /api/tests/run?project=X} — run some or all of them.
     *
     * <p>Gateway-write gated and routed through the same {@code ExecutionService}
     * as the console, because running a test IS running arbitrary project code:
     * it must not have a second, softer gate than pasting the same call into the
     * console next to it.</p>
     */
    public static final String ROUTE_TESTS_RUN = "/api/tests/run";

    /** What this project's scripts are actually throwing, from the gateway log. */
    public static final String ROUTE_RUNTIME_ERRORS = "/api/runtime/errors";

    /**
     * {@code POST /api/scripts/organise-imports?project=X} — sort and
     * de-duplicate the leading import block of the buffer in the body, and
     * suggest an import for each name it reads but never binds.
     *
     * <p>Authenticated, not Administrator: it writes nothing to the gateway,
     * it transforms text the caller already holds and hands it back for the
     * editor to apply as an ordinary local edit. See
     * {@code com.gaskony.scriptide.gateway.lang.ImportOrganiser}.</p>
     */
    public static final String ROUTE_ORGANISE_IMPORTS = "/api/scripts/organise-imports";

    /**
     * {@code GET /api/db-queries/datasources} — every configured datasource, with
     * its live {@code DatasourceStatus} where that is a cheap in-memory read.
     */
    public static final String ROUTE_DB_QUERY_DATASOURCES = "/api/db-queries/datasources";

    /**
     * {@code GET /api/db-queries/tables?datasource=X} — table and view names in
     * one datasource, for the schema tree.
     *
     * <p>Gateway-write gated, not merely authenticated: a name in this tree is
     * only useful to someone about to query it, and the run route already
     * requires the same gate — two thresholds for one feature would just be a
     * second place for them to drift apart.</p>
     */
    public static final String ROUTE_DB_QUERY_TABLES = "/api/db-queries/tables";

    /**
     * {@code GET /api/db-queries/columns?datasource=X&table=Y} — column name and
     * type for one table.
     */
    public static final String ROUTE_DB_QUERY_COLUMNS = "/api/db-queries/columns";

    /**
     * {@code POST /api/db-queries/run} — execute arbitrary SQL against one
     * datasource and return every result it produces.
     *
     * <p>Administrator-gated and CSRF-checked exactly like
     * {@link #ROUTE_NAMED_QUERY_TEST}: this is arbitrary SQL against a live
     * database submitted by hand, not a saved and reviewed resource, so it must
     * not have a softer gate than pasting the equivalent
     * {@code system.db.runPrepUpdate} into the console.</p>
     */
    public static final String ROUTE_DB_QUERY_RUN = "/api/db-queries/run";

    /**
     * {@code POST /api/db-queries/cancel} — stop one in-flight run by the run id
     * the client generated for it.
     */
    public static final String ROUTE_DB_QUERY_CANCEL = "/api/db-queries/cancel";

    /**
     * {@code GET /api/db-queries/history} — this user's past ad hoc queries.
     *
     * <p>Its own store, separate from {@link #ROUTE_RUNS}: a console run keeps
     * Jython source and captured output, and a query run keeps a datasource and a
     * row/affected summary — different enough fields that sharing one store would
     * mean every reader special-casing which kind of run a record is.</p>
     */
    public static final String ROUTE_DB_QUERY_HISTORY = "/api/db-queries/history";

    // ==================== Servlets (NOT under /data) ====================

    /**
     * Path spec for the combined LSP + execution WebSocket, registered via
     * {@code WebResourceManager.addServlet(...)} in the hook's {@code startup()}.
     * Resolves publicly to {@code /system/scriptide}.
     *
     * <p>It is a servlet, not a {@code RouteGroup} route, because {@code RouteGroup}
     * has no protocol-upgrade path. Spike S1 could not verify that a NEW alias
     * resolves as expected (that needs a built module) — it is the one unproven
     * assumption in the design, and the deploy gate's socket check exists for it.</p>
     */
    public static final String SOCKET_SERVLET_PATH = MOUNT_ALIAS;

    /** Public URL the servlet above resolves to. */
    public static final String SOCKET_PUBLIC_PATH = "/system/" + SOCKET_SERVLET_PATH;
}
