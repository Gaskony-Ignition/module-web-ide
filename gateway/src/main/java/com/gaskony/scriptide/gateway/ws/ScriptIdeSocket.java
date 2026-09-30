package com.gaskony.scriptide.gateway.ws;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.exec.ExecutionService;
import com.gaskony.scriptide.gateway.exec.PrivateStateRunner;
import com.gaskony.scriptide.gateway.exec.TracebackFormatter;
import com.gaskony.scriptide.gateway.lang.LanguageServer;
import com.gaskony.scriptide.gateway.lang.ProjectIndex;
import com.gaskony.scriptide.gateway.term.TerminalPolicy;
import com.gaskony.scriptide.gateway.term.TerminalService;
import com.gaskony.scriptide.gateway.presence.Presence;
import com.gaskony.scriptide.gateway.presence.PresenceRegistry;
import com.gaskony.scriptide.gateway.term.TerminalSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.python.core.PyObject;
import org.eclipse.jetty.websocket.api.Callback;
import org.eclipse.jetty.websocket.api.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One authenticated browser connection.
 *
 * <p>At P0 this carries a single {@code ping}/{@code pong} exchange, which exists
 * for one reason: to prove that {@code addServlet(SOCKET_SERVLET_PATH, ...)}
 * actually resolves to {@code /system/scriptide} for a NEW module alias. Spike S1
 * answered every other question about this design but could not answer that one
 * without a built module, so it is the last unverified assumption and the deploy
 * gate checks it on every deploy.</p>
 *
 * <p>From P3 this becomes the LSP + execution transport, with a
 * {@code {"ch":"lsp"|"exec","msg":…}} envelope: one authentication handshake, and
 * per-message authorisation — {@code lsp} for any authenticated user,
 * {@code exec} for Administrators only. The channel shape is already honoured
 * here so the wire format does not change under the client later.</p>
 */
public class ScriptIdeSocket implements Session.Listener.AutoDemanding {

    private static final Logger logger = LoggerFactory.getLogger(ScriptIdeSocket.class);

    private final String username;
    private final boolean administrator;
    private final String csrfToken;
    private final String remoteHost;

    /** Stable id for this connection — the per-session execution limit keys on it. */
    private final String sessionId = java.util.UUID.randomUUID().toString();

    /** When this connection opened, shown as "since" beside a peer's name. */
    private final long connectedAt = System.currentTimeMillis();

    private volatile Session session;

    /**
     * Console REPL state, per project.
     *
     * <p>Kept so the console behaves like a REPL: a name bound in one submission is
     * still there in the next. Scoped to THIS socket and never shared — two people
     * at two browsers must not see each other's variables. Dropped on close.</p>
     */
    private final java.util.Map<String, PyObject> consoleLocals =
        new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * The execution this connection started and has not yet been told about.
     *
     * <p>Only needed to answer two questions the socket has to answer for itself:
     * whether a {@code reset} would pull the locals out from under a running
     * script, and what to stop when the browser goes away.</p>
     */
    private volatile String currentExecutionId;

    /**
     * Told when anyone, anywhere, opens or closes a script.
     *
     * <p>Held as a field only so it can be REMOVED on close: the registry is
     * static and outlives this connection, so a listener left behind holds a
     * closed socket and sends into it for the life of the gateway.</p>
     */
    private final PresenceRegistry.Listener presenceListener = version -> sendPresence();

    /**
     * The project this client last reported. Git status is per project, and the
     * push has to know which one to send without asking the browser again.
     */
    private volatile String gitProject;

    private final com.gaskony.scriptide.gateway.git.GitStatusRegistry.Listener gitListener =
        version -> sendGitStatus();

    /** The run in flight, kept so it can be recorded when it finishes. */
    private volatile String runningSource;
    private volatile String runningProject;
    private volatile StringBuilder runningOutput;
    /** When the running execution was dispatched, for its kept duration. */
    private volatile long runningStartedAt;

    /** Stop accumulating output for the history past this — see RunHistory. */
    private static final int RUN_OUTPUT_CAP = 32 * 1024;

    /** Whether this connection has presented its CSRF token on the exec channel. */
    private volatile boolean execUnlocked;

    /**
     * The same, for the terminal channel.
     *
     * <p>A SEPARATE flag rather than reusing {@link #execUnlocked}: the two
     * capabilities have independent kill switches, and unlocking a shell as a
     * side effect of having run a script would make one of those switches a
     * decoration.</p>
     */
    private volatile boolean termUnlocked;

    /**
     * One language server per connection.
     *
     * <p>Per-connection, not shared: the server owns the open-document set, and two
     * browsers editing different files must not see each other's buffers. The
     * expensive part — the hint index — is rebuilt from the gateway and is cheap
     * enough to hold per socket.</p>
     */
    private volatile LanguageServer languageServer;
    private volatile String lspProject;

    public ScriptIdeSocket(String username, boolean administrator,
                           String csrfToken, String remoteHost) {
        this.username = username;
        this.administrator = administrator;
        this.csrfToken = csrfToken;
        this.remoteHost = remoteHost;
    }

    /** The authenticated user behind this socket. Never trusted from the client. */
    public String getUsername() {
        return username;
    }

    /** Whether this connection may use the {@code exec} channel (P2 onward). */
    public boolean isAdministrator() {
        return administrator;
    }

    @Override
    public void onWebSocketOpen(Session session) {
        this.session = session;
        ScriptIdeSocketRegistry.register(this);
        PresenceRegistry presenceRegistry = ScriptIdeSocketRegistry.getPresence();
        if (presenceRegistry != null) {
            presenceRegistry.addListener(presenceListener);
        }
        var gitRegistry = ScriptIdeSocketRegistry.getGitStatus();
        if (gitRegistry != null) {
            gitRegistry.addListener(gitListener);
        }
        logger.debug("Web IDE socket opened for user '{}' (admin={})", username, administrator);
    }

    @Override
    public void onWebSocketText(String message) {
        JsonObject envelope;
        String channel;
        try {
            envelope = JsonParser.parseString(message).getAsJsonObject();
            channel = envelope.has("ch") ? envelope.get("ch").getAsString() : "";
        } catch (RuntimeException e) {
            // Malformed input from a client is expected traffic, not an incident.
            send("{\"ch\":\"error\",\"msg\":{\"error\":\"malformed envelope\"}}");
            return;
        }

        if ("ping".equals(channel)) {
            // P0 liveness probe. Echoes the authenticated identity so the deploy
            // gate proves the whole path — upgrade, auth, and round trip.
            JsonObject msg = new JsonObject();
            msg.addProperty("pong", true);
            msg.addProperty("username", username);
            msg.addProperty("administrator", administrator);
            JsonObject reply = new JsonObject();
            reply.addProperty("ch", "ping");
            reply.add("msg", msg);
            send(reply.toString());
            return;
        }

        if ("lsp".equals(channel)) {
            try {
                handleLsp(envelope.getAsJsonObject("msg"),
                    envelope.has("project") ? envelope.get("project").getAsString() : null);
            } catch (RuntimeException e) {
                logger.debug("lsp frame failed for '{}': {}", username, e.toString());
            }
            return;
        }

        if ("term".equals(channel)) {
            try {
                handleTerminal(envelope.getAsJsonObject("msg"));
            } catch (RuntimeException e) {
                logger.debug("term frame failed for '{}': {}", username, e.toString());
                sendError("term", "Terminal request failed: " + e.getMessage());
            }
            return;
        }

        if ("exec".equals(channel)) {
            try {
                handleExec(envelope.getAsJsonObject("msg"));
            } catch (RuntimeException e) {
                logger.debug("exec frame failed for '{}': {}", username, e.toString());
                sendError("exec", "Execution request failed: " + e.getMessage());
            }
            return;
        }

        if ("git".equals(channel)) {
            try {
                handleGit(envelope.getAsJsonObject("msg"));
            } catch (RuntimeException e) {
                // Same rule as presence: a decoration is never a gate.
                logger.debug("git frame failed for '{}': {}", username, e.toString());
            }
            return;
        }

        if ("presence".equals(channel)) {
            try {
                handlePresence(envelope.getAsJsonObject("msg"));
            } catch (RuntimeException e) {
                // Presence is an indicator, never a gate. A malformed frame costs
                // this client its badges and nothing else.
                logger.debug("presence frame failed for '{}': {}", username, e.toString());
            }
            return;
        }

        // "lsp" arrives in P3.
        sendError("error", "unknown channel: " + channel);
    }

    /**
     * This client saying which scripts it has open.
     *
     * <p>Declared by the client rather than inferred from what it has READ,
     * because they are different facts: a go-to-definition reads a file nobody
     * has open, and a tab left open reads nothing for hours. The tab strip is the
     * honest source, and it is the thing the person on the other end is looking
     * at.</p>
     *
     * <p>An empty list is a legitimate message, not a no-op — it is what a client
     * sends when the last tab closes, and dropping it would leave a name on a
     * file nobody has.</p>
     */
    private void handlePresence(JsonObject msg) {
        PresenceRegistry registry = ScriptIdeSocketRegistry.getPresence();
        if (registry == null) {
            return;
        }
        if (msg == null) {
            sendPresence();
            return;
        }
        String project = stringOf(msg, "project");
        java.util.List<String> open = new java.util.ArrayList<>();
        if (msg.has("open") && msg.get("open").isJsonArray()) {
            for (var element : msg.getAsJsonArray("open")) {
                if (element != null && element.isJsonPrimitive()) {
                    open.add(element.getAsString());
                }
            }
        }
        registry.put(new Presence.Peer(sessionId, username, remoteHost,
            Presence.Kind.IDE, project, open, connectedAt));
        // Answer this client directly as well as through the broadcast: its own
        // update does not change the peer list it is shown (it is excluded from
        // it), so without this a first frame from a lone client gets no reply and
        // the panel sits on "connecting".
        sendPresence();
    }

    /**
     * Everyone except this connection, as the client renders them.
     *
     * <p>Self-exclusion happens HERE rather than in the browser: the session id is
     * the only reliable way to tell your own tab from a second tab you opened
     * yourself, and it is deliberately never sent to the client.</p>
     */
    private void sendPresence() {
        PresenceRegistry registry = ScriptIdeSocketRegistry.getPresence();
        if (registry == null) {
            return;
        }
        JsonArray peers = new JsonArray();
        for (Presence.Peer peer : registry.peers()) {
            if (peer.sessionId().equals(sessionId)) {
                continue;
            }
            JsonObject item = new JsonObject();
            item.addProperty("username", peer.username());
            item.addProperty("host", peer.host());
            item.addProperty("kind", peer.kind() == Presence.Kind.DESIGNER ? "designer" : "ide");
            item.addProperty("project", peer.project());
            item.addProperty("since", peer.since());
            JsonArray resources = new JsonArray();
            peer.resources().forEach(resources::add);
            item.add("resources", resources);
            peers.add(item);
        }
        JsonObject msg = new JsonObject();
        msg.addProperty("version", registry.version());
        msg.add("peers", peers);
        // Whether per-file Designer presence is actually working on THIS gateway,
        // so the client can say "sessions only" instead of quietly showing less.
        var designer = ScriptIdeSocketRegistry.getDesignerPresence();
        msg.addProperty("designerFeed", designer != null);
        sendOn("presence", msg);
    }

    /**
     * A client naming the project it wants git status for.
     *
     * <p>The first frame also triggers an immediate read rather than waiting for
     * the ten-second sweep. Opening a project and seeing an undecorated tree for
     * ten seconds is indistinguishable from a clean tree, which is the one thing
     * this indicator must never claim falsely.</p>
     */
    private void handleGit(JsonObject msg) {
        var registry = ScriptIdeSocketRegistry.getGitStatus();
        if (registry == null) {
            return;
        }
        String project = msg == null ? null : stringOf(msg, "project");
        if (project != null && !project.isBlank()) {
            gitProject = project;
            registry.refresh(project);
        }
        sendGitStatus();
    }

    /**
     * This client's project, as git sees it.
     *
     * <p>Sends even when there is no repository, and even when reading it failed.
     * A client that receives nothing cannot tell "no repo" from "not answered
     * yet", and would have to guess — so it is told, and shows nothing on
     * purpose rather than by accident.</p>
     */
    private void sendGitStatus() {
        var registry = ScriptIdeSocketRegistry.getGitStatus();
        String project = gitProject;
        if (registry == null || project == null || project.isBlank()) {
            return;
        }
        sendOn("git", gitJson(registry, project));
    }

    /** The wire form of one project's status. Package-private so a test can read it. */
    static JsonObject gitJson(com.gaskony.scriptide.gateway.git.GitStatusRegistry registry,
                              String project) {
        var snapshot = registry.statusOf(project);
        JsonObject msg = new JsonObject();
        msg.addProperty("version", registry.version());
        msg.addProperty("project", project);
        msg.addProperty("repo", snapshot.repo());
        msg.addProperty("branch", snapshot.branch());
        msg.addProperty("head", snapshot.head());
        msg.addProperty("error", snapshot.error());
        JsonObject marks = new JsonObject();
        snapshot.marks().forEach((path, mark) -> marks.addProperty(path, mark.wire()));
        msg.add("marks", marks);
        // Changed files with no tree node — project.json and the like. A count,
        // not a list of paths to decorate, so the summary cannot claim "no
        // changes" while something outside the tree differs.
        msg.addProperty("others", snapshot.others().size());
        return msg;
    }

    /**
     * Handle one JSON-RPC frame on the language channel.
     *
     * <p>Requires authentication (guaranteed by the handshake) but NOT the
     * Administrator role: a read-only user should still get completions, hover and
     * signature help. Only running code is privileged.</p>
     */
    private void handleLsp(JsonObject msg, String project) {
        if (msg == null) {
            return;
        }
        LanguageServer server = languageServerFor(project);
        if (server == null) {
            sendError("lsp", "The module is shutting down.");
            return;
        }
        JsonObject response = server.handle(msg);
        if (response != null) {
            sendOn("lsp", response);
        }
    }

    /** The server for a project, rebuilt if the client switches projects. */
    private LanguageServer languageServerFor(String project) {
        if (ScriptIdeSocketRegistry.getContext() == null) {
            return null;
        }
        String target = (project == null || project.isBlank()) ? "" : project;
        LanguageServer existing = languageServer;
        if (existing != null && target.equals(lspProject)) {
            return existing;
        }
        synchronized (this) {
            if (languageServer == null || !target.equals(lspProject)) {
                // A supplier, not a resolved manager: the project's ScriptManager is
                // replaced when its library is rebuilt, and a captured one would
                // serve a stale API list for the life of the connection.
                var context = ScriptIdeSocketRegistry.getContext();
                ProjectIndex index = target.isEmpty()
                    ? null : new ProjectIndex(context.getProjectManager());
                LanguageServer server = new LanguageServer(() -> {
                    var ctx = ScriptIdeSocketRegistry.getContext();
                    if (ctx == null) {
                        return null;
                    }
                    return target.isEmpty()
                        ? ctx.getScriptManager()
                        : ctx.getProjectManager().getProjectScriptManager(target);
                }, index, target.isEmpty() ? null : target,
                    // Group 3: live tag-path
                    // and database-schema completion. Read from the registry
                    // rather than captured once, same reasoning as the
                    // ScriptManager supplier above — both are rebuilt if the
                    // module ever re-initialises.
                    ScriptIdeSocketRegistry.getTagBrowser(), ScriptIdeSocketRegistry.getDbSchema());
                // Diagnostics are server-initiated, so the server needs a way to
                // push a frame rather than only answering requests.
                server.setNotifier(notification -> sendOn("lsp", notification));
                languageServer = server;
                lspProject = target;
            }
            return languageServer;
        }
    }

    /**
     * Handle one frame on the execution channel.
     *
     * <p>Every gate is re-checked HERE, per frame, not once at connect: the policy
     * properties are read live so an operator can disable execution on a running
     * gateway, and a socket opened while execution was enabled must not keep the
     * privilege afterwards.</p>
     *
     * <h2>This method must never wait for a script</h2>
     *
     * <p>The socket is an {@code AutoDemanding} listener: one frame at a time, on
     * the socket thread. Until 1.5.0 the run branch blocked here until the script
     * finished, so the connection was DEAF for the duration — a Stop sent 1.5 s
     * into a 20 s loop was not read until the loop had already ended, and the LSP
     * and the terminal froze with it. So the work is handed to
     * {@link ExecutionService#submit} and the three outbound frames —
     * {@code started}, {@code output}, {@code finished} — are sent from its
     * callbacks instead.</p>
     *
     * <h2>The frames this sends</h2>
     * <ul>
     *   <li>{@code {"event":"started","executionId":…}} — once, when the script
     *       actually begins. AFTER the submit is accepted, so a refusal produces an
     *       {@code error} frame and never a started run that no-one ever finishes.</li>
     *   <li>{@code {"event":"output","executionId":…,"stream":"stdout"|"stderr",
     *       "text":…}} — zero or more, in order within a stream.</li>
     *   <li>{@code {"event":"finished",…}} — once, after the last {@code output}.
     *       Its {@code stdout}/{@code stderr} are EMPTY: everything has already been
     *       streamed, and repeating it here would double-print.</li>
     *   <li>{@code {"event":"reset","project":…}} — the console's locals were dropped.</li>
     * </ul>
     */
    private void handleExec(JsonObject msg) {
        if (msg == null) {
            sendError("exec", "Missing message body");
            return;
        }
        String action = msg.has("action") ? msg.get("action").getAsString() : "run";

        if (!ExecPolicy.executionEnabled()) {
            sendError("exec", "Script execution is disabled on this gateway ("
                + ExecPolicy.PROP_ENABLED + "=false).");
            return;
        }
        if (ExecPolicy.requireAdmin() && !administrator) {
            sendError("exec", "Running scripts requires the Administrator role.");
            return;
        }

        // WebSockets get no CORS preflight, so the same-origin check at handshake is
        // belt; this token is braces. Required once per connection, before anything
        // is executed.
        if (!execUnlocked) {
            String presented = msg.has("csrfToken") ? msg.get("csrfToken").getAsString() : null;
            if (csrfToken == null || presented == null || !csrfToken.equals(presented)) {
                sendError("exec", "CSRF token missing or invalid.");
                return;
            }
            execUnlocked = true;
        }

        ExecutionService service = ScriptIdeSocketRegistry.getExecutionService();
        if (service == null) {
            sendError("exec", "The module is shutting down.");
            return;
        }

        if ("stop".equals(action)) {
            String id = msg.has("executionId") ? msg.get("executionId").getAsString() : null;
            if (id == null) {
                sendError("exec", "stop requires an executionId");
                return;
            }
            JsonObject out = new JsonObject();
            out.addProperty("event", "stopping");
            out.addProperty("executionId", id);
            out.addProperty("detail", service.requestStop(id));
            sendOn("exec", out);
            return;
        }

        if ("reset".equals(action)) {
            handleReset(service, msg);
            return;
        }

        if (!"run".equals(action)) {
            sendError("exec", "unknown exec action: " + action);
            return;
        }

        String project = msg.has("project") ? msg.get("project").getAsString() : null;
        String source = msg.has("source") ? msg.get("source").getAsString() : null;
        if (project == null || project.isBlank() || source == null) {
            sendError("exec", "run requires 'project' and 'source'");
            return;
        }
        // A selection run prepends blank lines so traceback line numbers still match
        // the editor. The client says how many it added; we subtract them back off.
        int lineOffset = msg.has("lineOffset") ? msg.get("lineOffset").getAsInt() : 0;
        String target = msg.has("target") ? msg.get("target").getAsString() : "console";
        boolean isConsole = !msg.has("target");
        String executionId = java.util.UUID.randomUUID().toString();

        ExecAudit audit = ScriptIdeSocketRegistry.getExecAudit();
        if (audit != null) {
            // Before the run, so a script that hangs is still recorded.
            audit.record(username, remoteHost, project, target, source);
        }

        String fileName = "<script-ide:" + project + ":" + target + ">";

        // A console keeps its locals so it behaves like a REPL; a file does not —
        // a file is not a REPL, and carrying state between runs of one would make
        // results depend on invisible history.
        PyObject locals = isConsole
            ? consoleLocals.computeIfAbsent(project, service::newLocals)
            : service.newLocals(project);

        // Claimed BEFORE the submit, not in the started callback: a run sitting in
        // the pool queue has not begun, and a reset in that gap would still swap
        // the locals out from under it.
        currentExecutionId = executionId;
        // Kept so the run can be recorded when it finishes. The outcome carries
        // an EMPTY stdout by contract — every chunk went out as an `output`
        // frame as it was produced — so the only place the whole output exists
        // is here, accumulated as it passes through.
        runningSource = source;
        runningProject = project;
        runningOutput = new StringBuilder();
        runningStartedAt = System.currentTimeMillis();
        try {
            service.submit(executionId, project, source, fileName, locals, username, sessionId,
                () -> sendStarted(executionId),
                (stream, text) -> sendOutput(executionId, stream, text),
                outcome -> sendFinished(executionId, fileName, lineOffset, outcome));
        } catch (ExecutionService.RejectedException e) {
            currentExecutionId = null;
            sendError("exec", e.getMessage());
        }
    }

    /**
     * Drop a project's console locals, the way the Designer's Reset does.
     *
     * <p>Refused while that session has a script in flight: the locals map is the
     * one the running script is executing against, and replacing it mid-run gives
     * a NameError from a line that plainly assigns the name.</p>
     */
    private void handleReset(ExecutionService service, JsonObject msg) {
        String project = msg.has("project") ? msg.get("project").getAsString() : null;
        if (project == null || project.isBlank()) {
            sendError("exec", "reset requires 'project'");
            return;
        }
        String inFlight = currentExecutionId;
        if (inFlight != null && service.isRunning(inFlight)) {
            sendError("exec", "A script is still running. Stop it before resetting the console.");
            return;
        }
        consoleLocals.remove(project);
        JsonObject out = new JsonObject();
        out.addProperty("event", "reset");
        out.addProperty("project", project);
        sendOn("exec", out);
    }

    private void sendStarted(String executionId) {
        JsonObject started = new JsonObject();
        started.addProperty("event", "started");
        started.addProperty("executionId", executionId);
        sendOn("exec", started);
    }

    /** One chunk of output, as it is produced. Ordered within a stream. */
    private void sendOutput(String executionId, String stream, String text) {
        StringBuilder buffer = runningOutput;
        if (buffer != null && text != null
            && buffer.length() < RUN_OUTPUT_CAP) {
            buffer.append(text);
        }
        JsonObject out = new JsonObject();
        out.addProperty("event", "output");
        out.addProperty("executionId", executionId);
        out.addProperty("stream", stream);
        out.addProperty("text", text);
        sendOn("exec", out);
    }

    /**
     * The single completion frame.
     *
     * <p>Sent even when the browser has gone — {@link #send} drops quietly on a
     * closed session, and a completion callback that threw would be swallowed by
     * the service and lose the accounting.</p>
     */
    private void sendFinished(String executionId, String fileName, int lineOffset,
                              PrivateStateRunner.Outcome outcome) {
        currentExecutionId = null;
        JsonObject result = new JsonObject();
        result.addProperty("event", "finished");
        result.addProperty("executionId", executionId);
        // Empty by contract: everything went out as `output` frames already.
        result.addProperty("stdout", outcome.stdout());
        result.addProperty("stderr", outcome.stderr());
        result.addProperty("truncated", outcome.truncated());
        result.addProperty("cancelled", outcome.cancelled());
        result.addProperty("ok", outcome.succeeded());
        if (outcome.failure() != null && !outcome.cancelled()) {
            result.add("error", TracebackFormatter.describe(
                outcome.failure(), fileName, lineOffset));
        }
        sendOn("exec", result);
        recordRun(outcome);
    }

    /**
     * Keep this run for the user who ran it.
     *
     * <p>After the frame, never before: the client has its answer either way,
     * and a history write that failed must not delay or alter what the console
     * shows.</p>
     */
    private void recordRun(PrivateStateRunner.Outcome outcome) {
        var history = ScriptIdeSocketRegistry.getRunHistory();
        String source = runningSource;
        StringBuilder output = runningOutput;
        // Wall time, taken here rather than inside the runner: what the user
        // waited for includes the dispatch and the streaming, and the runner
        // knows about neither.
        long elapsed = runningStartedAt == 0 ? 0 : System.currentTimeMillis() - runningStartedAt;
        runningSource = null;
        runningOutput = null;
        runningStartedAt = 0;
        if (history == null || source == null) {
            return;
        }
        String error = outcome.cancelled()
            ? "Stopped"
            : outcome.failure() == null ? null : String.valueOf(outcome.failure());
        try {
            history.record(username, runningProject, source,
                output == null ? "" : output.toString(),
                outcome.succeeded(), error, elapsed);
        } catch (RuntimeException e) {
            logger.debug("Could not record run history: {}", e.toString());
        }
    }

    /**
     * Handle one frame on the terminal channel.
     *
     * <p>Gated exactly as {@code exec} is and for the same reasons, but through
     * its OWN policy: a site that wants the Script Console without a Gateway shell
     * sets {@code terminal.enabled=false} and keeps the rest. Every gate is
     * re-read per frame so turning it off takes effect on connections that are
     * already open.</p>
     *
     * <p>Terminal ids are scoped to this connection by {@link TerminalService},
     * so an id from another tab addresses nothing here.</p>
     */
    private void handleTerminal(JsonObject msg) {
        if (msg == null) {
            sendError("term", "Missing message body");
            return;
        }
        String action = msg.has("action") ? msg.get("action").getAsString() : "";

        if (!TerminalPolicy.terminalEnabled()) {
            sendError("term", "The Gateway terminal is disabled on this gateway ("
                + TerminalPolicy.PROP_ENABLED + "=false).");
            return;
        }
        if (TerminalPolicy.requireAdmin() && !administrator) {
            sendError("term", "Opening a Gateway terminal requires the Administrator role.");
            return;
        }
        if (!termUnlocked) {
            String presented = msg.has("csrfToken") ? msg.get("csrfToken").getAsString() : null;
            if (csrfToken == null || presented == null || !csrfToken.equals(presented)) {
                sendError("term", "CSRF token missing or invalid.");
                return;
            }
            termUnlocked = true;
        }

        TerminalService service = ScriptIdeSocketRegistry.getTerminalService();
        if (service == null) {
            sendError("term", "The module is shutting down.");
            return;
        }

        switch (action) {
            case "open" -> openTerminal(service, msg);
            case "input" -> {
                TerminalSession session = service.get(sessionId, stringOf(msg, "id"));
                if (session != null) {
                    session.write(java.util.Base64.getDecoder().decode(stringOf(msg, "data")));
                }
            }
            case "resize" -> {
                TerminalSession session = service.get(sessionId, stringOf(msg, "id"));
                if (session != null) {
                    session.resize(intOf(msg, "cols", 80), intOf(msg, "rows", 24));
                }
            }
            case "close" -> service.close(sessionId, stringOf(msg, "id"));
            default -> sendError("term", "unknown terminal action: " + action);
        }
    }

    private void openTerminal(TerminalService service, JsonObject msg) {
        try {
            TerminalSession session = service.open(
                sessionId, username, remoteHost,
                intOf(msg, "cols", 80), intOf(msg, "rows", 24),
                (id, bytes) -> {
                    JsonObject out = new JsonObject();
                    out.addProperty("event", "data");
                    out.addProperty("id", id);
                    out.addProperty("data", java.util.Base64.getEncoder().encodeToString(bytes));
                    sendOn("term", out);
                },
                (id, code) -> {
                    JsonObject out = new JsonObject();
                    out.addProperty("event", "exit");
                    out.addProperty("id", id);
                    out.addProperty("code", code);
                    sendOn("term", out);
                });
            JsonObject out = new JsonObject();
            out.addProperty("event", "opened");
            out.addProperty("id", session.id());
            out.addProperty("pty", session.hasPty());
            sendOn("term", out);
        } catch (TerminalService.RejectedException e) {
            sendError("term", e.getMessage());
        }
    }

    private static String stringOf(JsonObject msg, String key) {
        return msg.has(key) && !msg.get(key).isJsonNull() ? msg.get(key).getAsString() : "";
    }

    private static int intOf(JsonObject msg, String key, int fallback) {
        try {
            return msg.has(key) ? msg.get(key).getAsInt() : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    /** Send one message on a channel. */
    private void sendOn(String channel, JsonObject msg) {
        JsonObject envelope = new JsonObject();
        envelope.addProperty("ch", channel);
        envelope.add("msg", msg);
        send(envelope.toString());
    }

    private void sendError(String channel, String message) {
        JsonObject msg = new JsonObject();
        msg.addProperty("error", message);
        sendOn(channel, msg);
    }

    @Override
    public void onWebSocketClose(int statusCode, String reason) {
        // Drop the REPL state with the connection — it is per-user and must not
        // outlive the socket that owns it.
        consoleLocals.clear();
        // And stop whatever it was running. Nobody is left to read the result, and
        // a busy loop nobody can see is exactly what the abandoned counter is for.
        ExecutionService executions = ScriptIdeSocketRegistry.getExecutionService();
        if (executions != null) {
            executions.stopAllFor(sessionId);
        }
        // A shell outliving the tab that opened it is a process nobody can see
        // and nobody will close.
        TerminalService terminals = ScriptIdeSocketRegistry.getTerminalService();
        if (terminals != null) {
            terminals.closeAllFor(sessionId);
        }
        PresenceRegistry presenceRegistry = ScriptIdeSocketRegistry.getPresence();
        if (presenceRegistry != null) {
            presenceRegistry.removeListener(presenceListener);
            // Remove BEFORE unregistering the socket: the peer entry is what
            // other people see, and a name left on a file by a browser that has
            // gone is exactly the stale indicator this feature must not produce.
            presenceRegistry.remove(sessionId);
        }
        var gitRegistry = ScriptIdeSocketRegistry.getGitStatus();
        if (gitRegistry != null) {
            // The registry outlives this socket, so a listener left behind keeps
            // a closed connection reachable and every later poll writes to it.
            gitRegistry.removeListener(gitListener);
        }
        ScriptIdeSocketRegistry.unregister(this);
        logger.debug("Web IDE socket closed for '{}' ({}: {})", username, statusCode, reason);
    }

    @Override
    public void onWebSocketError(Throwable cause) {
        // Debug, not error: a browser tab closing mid-frame is routine.
        logger.debug("Web IDE socket error for '{}': {}", username, cause.toString());
        ScriptIdeSocketRegistry.unregister(this);
    }

    /** Send a text frame, swallowing send failures on a dead connection. */
    protected void send(String text) {
        Session current = this.session;
        if (current == null || !current.isOpen()) {
            return;
        }
        try {
            current.sendText(text, Callback.NOOP);
        } catch (RuntimeException e) {
            logger.debug("Failed to send on Web IDE socket for '{}': {}", username, e.getMessage());
        }
    }

    /** Close this socket because the module is shutting down. */
    void closeForShutdown() {
        Session current = this.session;
        if (current != null && current.isOpen()) {
            current.close(1001 /* going away */, "Web IDE module shutting down", Callback.NOOP);
        }
    }
}
