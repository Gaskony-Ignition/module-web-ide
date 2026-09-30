package com.gaskony.scriptide.gateway.term;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.Channels;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * A very small Docker Engine API client, speaking HTTP/1.1 over the daemon's
 * Unix socket, for one purpose: running a shell inside a container as root.
 *
 * <h2>Why this exists at all</h2>
 *
 * <p>This is how every Docker UI opens a root terminal in one click, and Nigel
 * asked for that shape (02/09/2026) because a gateway installed directly on a
 * machine would just be given a real terminal — the browser terminal earns its
 * keep on a <b>containerised</b> gateway, which is exactly the case this
 * handles.</p>
 *
 * <p>The mechanism is worth stating precisely, because it is the opposite of the
 * {@code sudo} route beside it. A process cannot raise its own privilege; only
 * something more privileged can create a privileged process on its behalf. The
 * Docker daemon runs as <b>root on the host</b>, so when it is asked for an exec
 * with {@code User: "0"} it simply creates one — no setuid binary, no sudoers
 * rule, nothing installed in the image.</p>
 *
 * <h2>Why no library, and no docker CLI</h2>
 *
 * <p>docker-java and friends are large, and shipping one through
 * {@code modlImplementation} to make four HTTP requests is not a trade worth
 * making. Shelling out to a {@code docker} binary would put a dependency back in
 * the image, which is the thing this route exists to remove. Java 17 has Unix
 * domain sockets in the JDK ({@link StandardProtocolFamily#UNIX}), so the whole
 * client is the four calls below.</p>
 *
 * <h2>What is deliberately NOT here</h2>
 *
 * <p>Nothing that creates, starts, stops or removes a container, and no image
 * operations. This class execs into <b>one</b> container — the one the caller
 * names, which is always this JVM's own. That is a self-imposed limit rather
 * than a security boundary: anyone who can reach this socket can do all of those
 * things by other means, which is exactly why SECURITY.md treats socket access
 * as host root and says so in those words.</p>
 */
public final class DockerExec {

    private static final Logger logger = LoggerFactory.getLogger(DockerExec.class);

    /**
     * Pinned API version.
     *
     * <p>Well inside the daemon's supported window — a current daemon advertises
     * {@code ApiVersion 1.54, MinAPIVersion 1.40} (measured 02/09/2026). Pinning
     * rather than negotiating: the four endpoints used here have been stable
     * since 1.24, and a version request is a round trip that buys nothing.</p>
     */
    private static final String API = "/v1.41";

    /** Where the daemon listens, best first. */
    private static final List<String> SOCKET_CANDIDATES =
        List.of("/var/run/docker.sock", "/run/docker.sock");

    /** A control request is tiny; a daemon that has not answered by now is gone. */
    private static final int CONTROL_TIMEOUT_MS = 5000;

    /** Environment variable carrying the per-session tag. See {@link #reapScript}. */
    static final String TAG_VARIABLE = "SCRIPTIDE_TERM";

    /**
     * Silence the login chatter before the interactive shell starts.
     *
     * <p>Every terminal opened on this rig began with
     * {@code groups: cannot find name for group ID 984} (Nigel, 04/09/2026:
     * "suppress it"). The cause is exact: Debian's {@code /etc/bash.bashrc}
     * runs {@code $(groups)} to decide whether to print its "use sudo" hint,
     * and gid 984 is the HOST's docker group, added to this container by
     * {@code group_add} so the socket is reachable. It has no name in the
     * container's {@code /etc/group}, so {@code groups} complains — to a
     * terminal where stdout and stderr are one pty, in front of the prompt.</p>
     *
     * <p>The hint itself is meaningless here anyway: this shell is already
     * root. So rather than filtering a stream that cannot be separated, this
     * uses Debian's OWN opt-out, which is the same condition that guards the
     * block — {@code $HOME/.hushlogin}. One empty file, created idempotently,
     * and both the error and the hint it was printed for go away.</p>
     *
     * <p>The outer shell is non-interactive so it reads no rc file; the
     * {@code exec} then starts the interactive one with the file already
     * there.</p>
     */
    private static final String HUSH = ": > \"$HOME/.hushlogin\" 2>/dev/null; ";

    /** How many times to try the post-attach resize before giving up on it. */
    private static final int RESIZE_ATTEMPTS = 3;
    private static final long RESIZE_RETRY_MS = 100;

    /** How long to wait for the shell to take the hint and exit by itself. */
    private static final long POLITE_EXIT_BUDGET_MS = 750;
    private static final long POLITE_EXIT_POLL_MS = 50;

    /** Sent to end the shell, in this order. See {@link Session#close()}. */
    private static final byte ETX = 3;
    private static final byte EOT = 4;

    /**
     * Seconds the reaper waits between {@code SIGHUP} and {@code SIGKILL}.
     *
     * <p>A second is generous for a shell that has already been told to leave
     * twice: measured, an interactive bash and a {@code sleep} both go on the
     * HUP and the KILL pass finds nothing.</p>
     */
    private static final int REAP_GRACE_SECONDS = 1;

    private static final Gson GSON = new Gson();

    private DockerExec() { /* static factory */ }

    /** The daemon socket this host exposes, or {@code null} for none. */
    public static Path socketPath() {
        for (String candidate : SOCKET_CANDIDATES) {
            Path path = Path.of(candidate);
            // isReadable is not enough: a socket we cannot WRITE to is a socket
            // we cannot use, and that is the common failure — the socket is
            // root:docker 0660 and the Gateway's user is in neither.
            if (Files.exists(path) && Files.isReadable(path) && Files.isWritable(path)) {
                return path;
            }
        }
        return null;
    }

    /**
     * Whether a root shell is obtainable through the daemon right now.
     *
     * <p>Proved by asking, exactly as the sudo probe is: the socket is inspected
     * for existence and then <b>used</b>, because a socket that exists and
     * refuses us is indistinguishable from one that works until you try it.</p>
     */
    public static boolean available(String containerId) {
        if (containerId == null) {
            return false;
        }
        Path socket = socketPath();
        if (socket == null) {
            return false;
        }
        try {
            JsonObject info = get(socket, API + "/containers/" + containerId + "/json");
            // Also confirms the id is OUR container and still running — a stale
            // id from a recycled mountinfo would otherwise fail at exec time,
            // by which point the user is looking at a blank terminal.
            return info != null
                && info.has("State")
                && info.getAsJsonObject("State").get("Running").getAsBoolean();
        } catch (Exception e) {
            // WARN, not debug. Somebody deliberately mounted this socket, and
            // the only symptom of it not working is an unprivileged shell —
            // which looks exactly like a gateway where it was never mounted at
            // all. This was logged at debug in the first version and cost a
            // whole diagnosis: `SocketChannel.socket()` throws
            // UnsupportedOperationException on a Unix-domain channel, so every
            // request failed, and the route reported itself simply absent.
            logger.warn("The Docker socket at {} is mounted but not usable, so the terminal "
                + "will not be able to elevate: {}", socket, e.toString());
            return false;
        }
    }

    /**
     * Start a root shell in {@code containerId} and hand back its raw stream.
     *
     * @param shell absolute path, already validated by {@link TerminalPolicy}
     * @param tag   value for {@code SCRIPTIDE_TERM} in the shell's environment,
     *              which is how {@link Session#close()} finds this shell AND
     *              everything it started again later. See {@link #reapScript}.
     */
    public static Session start(String containerId, String shell, String workingDir,
                                int cols, int rows, String tag) throws IOException {
        Path socket = socketPath();
        if (socket == null) {
            throw new IOException("no Docker socket");
        }

        JsonObject create = new JsonObject();
        create.addProperty("AttachStdin", true);
        create.addProperty("AttachStdout", true);
        create.addProperty("AttachStderr", true);
        // Tty:true is doing two jobs. It gives the shell a real pty inside the
        // container — so job control, line editing and `stty size` all work —
        // AND it makes the attached stream RAW. With Tty:false the daemon
        // multiplexes stdout and stderr behind an 8-byte frame header, which
        // would arrive at xterm.js as garbage every few hundred bytes.
        create.addProperty("Tty", true);
        create.addProperty("User", "0");
        if (workingDir != null && !workingDir.isBlank()) {
            create.addProperty("WorkingDir", workingDir);
        }
        create.add("Cmd", GSON.toJsonTree(List.of(shell, "-c", HUSH + "exec " + shell + " -i")));
        // A login-ish environment. TERM is what makes xterm.js and the shell
        // agree on capabilities; the pagers are because nothing in a browser
        // terminal can drive `less`, and a pager waiting for a key it will never
        // receive looks exactly like a hung command.
        // SCRIPTIDE_TERM is not decoration. The shell is the DAEMON's child in the
        // host pid namespace, so this JVM (uid 2003, container pid namespace)
        // can neither see nor signal it, and the Pid the daemon reports for the
        // exec is a host pid that means nothing in here. A tag in the
        // environment is a handle that survives all of that: it is inherited by
        // every process the shell starts, so one sweep of /proc from INSIDE the
        // container finds the shell and its orphaned background jobs alike.
        String safeTag = isSafeTag(tag) ? tag : null;
        List<String> env = new java.util.ArrayList<>(List.of(
            "TERM=xterm-256color", "PAGER=cat", "GIT_PAGER=cat",
            "COLUMNS=" + cols, "LINES=" + rows));
        if (safeTag != null) {
            env.add(TAG_VARIABLE + "=" + safeTag);
        }
        create.add("Env", GSON.toJsonTree(env));

        JsonObject created = post(socket, API + "/containers/" + containerId + "/exec", create);
        if (created == null || !created.has("Id")) {
            throw new IOException("Docker refused the exec: " + created);
        }
        String execId = created.get("Id").getAsString();

        // The hijack. This connection stops being HTTP once the headers are
        // read and becomes the terminal itself, so it is never reused for
        // anything else and every later control call opens its own.
        SocketChannel channel = SocketChannel.open(UnixDomainSocketAddress.of(socket.toString()));
        try {
            JsonObject startBody = new JsonObject();
            startBody.addProperty("Detach", false);
            startBody.addProperty("Tty", true);
            byte[] payload = GSON.toJson(startBody).getBytes(StandardCharsets.UTF_8);

            // NOT Channels.newOutputStream / newInputStream. Both of those take
            // the channel's blockingLock() around every call, so once the pump
            // thread is parked in read() waiting for the shell to say something,
            // a write() of the user's keystrokes waits for that same lock — and
            // the shell says nothing until it gets the keystrokes. Measured
            // 02/09/2026: a prompt arrived, every typed byte was silently
            // swallowed, and close() hung on its ETX so the sweep never ran and
            // the shell leaked. The channel's own read() and write() take
            // separate locks and may run concurrently, which is what a terminal is.
            OutputStream out = new ChannelOutput(channel);
            out.write(("POST " + API + "/exec/" + execId + "/start HTTP/1.1\r\n"
                + "Host: docker\r\n"
                + "Content-Type: application/json\r\n"
                + "Connection: Upgrade\r\n"
                + "Upgrade: tcp\r\n"
                + "Content-Length: " + payload.length + "\r\n\r\n")
                .getBytes(StandardCharsets.UTF_8));
            out.write(payload);
            out.flush();

            InputStream in = new ChannelInput(channel);
            String status = readHeaders(in);
            // 101 on a successful upgrade, 200 when the daemon answers without
            // upgrading — both leave the stream attached and both are fine.
            if (!status.contains(" 101") && !status.contains(" 200")) {
                throw new IOException("Docker would not attach: " + status);
            }

            // The size is set AFTER the attach, and that order is load-bearing.
            //
            // Until 1.5.0 the comment here said the opposite — "the size must be
            // set BEFORE the stream is attached" — and it was measured wrong on
            // 02/09/2026. A POST to /exec/{id}/resize before /exec/{id}/start
            // does not set anything: the daemon has no exec session yet, so it
            // BLOCKS for ten seconds and then answers
            // `500 timeout waiting for exec session ready`. Our own five-second
            // watchdog cut that short, which is why every terminal in 1.4.x took
            // exactly 5.00 s to open and why the resize never applied — the
            // client's own resize after `opened` was doing all the sizing.
            // Attach first and the same call returns 200 in ~90 ms.
            //
            // A short retry because the session becomes ready a moment after the
            // upgrade; three attempts at 100 ms is far inside what a user reads
            // as instant, and a missed resize only costs one redraw.
            for (int attempt = 0; attempt < RESIZE_ATTEMPTS; attempt++) {
                if (resize(socket, execId, cols, rows)) {
                    break;
                }
                try {
                    Thread.sleep(RESIZE_RETRY_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return new Session(socket, execId, channel, in, out, safeTag);
        } catch (IOException e) {
            closeQuietly(channel);
            throw e;
        }
    }

    /**
     * The read half of the hijacked connection, over the channel directly.
     *
     * <p>See the note at the attach: the JDK's channel-to-stream adapters
     * serialise reads and writes on one lock, which turns a duplex terminal
     * into a half-duplex one that only accepts input while output is flowing.</p>
     */
    static final class ChannelInput extends InputStream {
        private final SocketChannel channel;

        ChannelInput(SocketChannel channel) {
            this.channel = channel;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) {
                return 0;
            }
            return channel.read(ByteBuffer.wrap(b, off, len));
        }

        @Override
        public void close() throws IOException {
            channel.close();
        }
    }

    /** The write half, over the channel directly. See {@link ChannelInput}. */
    static final class ChannelOutput extends OutputStream {
        private final SocketChannel channel;

        ChannelOutput(SocketChannel channel) {
            this.channel = channel;
        }

        @Override
        public void write(int b) throws IOException {
            write(new byte[] {(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            ByteBuffer buffer = ByteBuffer.wrap(b, off, len);
            while (buffer.hasRemaining()) {
                channel.write(buffer);
            }
        }

        @Override
        public void close() throws IOException {
            channel.close();
        }
    }

    /** One attached exec: the raw stream plus the calls that steer it. */
    public static final class Session {
        private final Path socket;
        private final String execId;
        private final SocketChannel channel;
        private final InputStream in;
        private final OutputStream out;
        /** Null when the caller gave no usable tag; then close() cannot sweep. */
        private final String tag;

        private Session(Path socket, String execId, SocketChannel channel,
                        InputStream in, OutputStream out, String tag) {
            this.socket = socket;
            this.execId = execId;
            this.channel = channel;
            this.in = in;
            this.out = out;
            this.tag = tag;
        }

        public InputStream output() {
            return in;
        }

        /**
         * Send keystrokes to the shell.
         *
         * <p>A method rather than a getter for the {@code OutputStream}. Handing
         * the stream out let a caller close it independently of the session,
         * which on a hijacked connection half-closes the terminal and leaves an
         * exec the daemon still thinks is attached — and SpotBugs flags the
         * escape (EI) for exactly that reason.</p>
         */
        public void write(byte[] data) throws IOException {
            out.write(data);
            out.flush();
        }

        /**
         * Resize the container-side pty.
         *
         * <p>A real API call, not an {@code stty} typed at the shell — so no
         * command appears at the user's prompt every time the panel is dragged,
         * and it works even while a full-screen program has the terminal.</p>
         */
        public void resize(int cols, int rows) {
            DockerExec.resize(socket, execId, cols, rows);
        }

        /** Exit code once the shell has ended, or {@code null} while it runs. */
        public Integer exitCode() {
            try {
                JsonObject state = get(socket, API + "/exec/" + execId + "/json");
                if (state == null || state.get("Running").getAsBoolean()) {
                    return null;
                }
                return state.has("ExitCode") && !state.get("ExitCode").isJsonNull()
                    ? state.get("ExitCode").getAsInt() : 0;
            } catch (Exception e) {
                return null;
            }
        }

        /**
         * End the shell, and everything it started.
         *
         * <h2>What 1.4.x believed, and what it actually did</h2>
         *
         * <p>This method used to be one line — close the channel — on the belief
         * that "closing the hijacked connection hangs up the container-side pty
         * and the shell exits on SIGHUP". <b>Measured false on 02/09/2026</b>:
         * closing the hijacked {@code /exec/{id}/start} connection does not
         * terminate the exec's process at all. The daemon keeps it running,
         * detached, forever. Thirty-eight orphaned {@code root /bin/bash -i}
         * processes were found in the test container — one for every terminal
         * ever opened — and the 120-minute idle reaper had been calling the same
         * no-op all along, so the promise it makes was never kept either.</p>
         *
         * <h2>Two steps, and why both are needed</h2>
         *
         * <ol>
         *   <li><b>Ask.</b> {@code ETX} interrupts whatever is in the foreground,
         *       {@code EOT} is the end-of-file that makes a shell at an empty
         *       prompt exit, and a literal {@code exit} covers a shell that has
         *       {@code ignoreeof} set. Measured: the shell is gone in about
         *       200 ms and the exec reports a real exit code, which is the
         *       difference between a terminal that closed and one that was
         *       killed.</li>
         *   <li><b>Sweep.</b> The polite step cannot reach a background job:
         *       {@code sleep 300 &} outlives its shell by design, and measured it
         *       does. So a second, non-tty exec walks {@code /proc} for our
         *       per-session tag and signals everything carrying it. It runs
         *       ALWAYS, not only on failure, because the leak the polite step
         *       cannot fix is the normal case rather than the exceptional
         *       one.</li>
         * </ol>
         *
         * <p><b>The exec's own {@code Pid} is not usable for this.</b> The daemon
         * reports it in the HOST pid namespace; this JVM is uid 2003 inside the
         * container's own namespace and can neither see nor signal it. The sweep
         * runs INSIDE the container, as root, created by the daemon — the same
         * mechanism that made the shell in the first place.</p>
         *
         * <p>The sweep is handed to {@link #REAPER} rather than run here: it
         * takes about 1.2 s (a HUP pass, a grace second, a KILL pass) and this
         * method is called from a WebSocket close callback. {@link #awaitReapers}
         * exists so module shutdown can still wait for them.</p>
         */
        public void close() {
            politeExit();
            closeQuietly(channel);
            sweep();
        }

        /**
         * A session with no daemon behind it, for the unit test.
         *
         * <p>Package-visible and deliberately degenerate: no socket, no channel
         * and no tag, so {@link #close()} exercises the exit sequence and nothing
         * else. Production never builds one of these — {@link #start} is the only
         * other constructor caller and it always has all three.</p>
         */
        static Session forTest(OutputStream out) {
            return new Session(null, "test-exec", null, InputStream.nullInputStream(), out, null);
        }

        /** Interrupt, then EOF, then the word. Best effort: the shell may already be gone. */
        private void politeExit() {
            try {
                writeExitSequence(out);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (IOException e) {
                // Already hung up, which is the outcome we wanted anyway.
                logger.debug("Docker terminal {} would not take the exit sequence: {}",
                    execId, e.toString());
                return;
            }
            long deadline = System.currentTimeMillis() + POLITE_EXIT_BUDGET_MS;
            while (System.currentTimeMillis() < deadline) {
                java.util.Optional<Boolean> alive = running();
                if (alive.isEmpty() || !alive.get()) {
                    // Null is "the daemon will not say". Waiting on an answer
                    // that is not coming buys nothing the sweep does not already
                    // cover, so stop asking.
                    return;
                }
                try {
                    Thread.sleep(POLITE_EXIT_POLL_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }

        /** Kill anything still carrying this session's tag, on the reaper thread. */
        private void sweep() {
            if (tag == null) {
                logger.warn("Docker terminal {} has no session tag, so its shell cannot be "
                    + "swept; it may be left running in the container", execId);
                return;
            }
            PENDING_SWEEPS.incrementAndGet();
            REAPER.execute(() -> {
                try {
                    runDetachedControlExec(socket, containerOf(execId), reapScript(tag));
                    // One honest check afterwards. A shell that survived both
                    // steps is a live root process nobody is watching, and that
                    // is a WARN whoever reads this log needs to see.
                    if (running().orElse(false)) {
                        logger.warn("Docker terminal {} is STILL RUNNING after both the exit "
                            + "sequence and the /proc sweep; a root shell has been left behind "
                            + "in the container", execId);
                    }
                } catch (Exception e) {
                    logger.debug("Sweeping Docker terminal {} failed: {}", execId, e.toString());
                } finally {
                    PENDING_SWEEPS.decrementAndGet();
                }
            });
        }

        /** True/false while the daemon will say, empty when it will not. */
        private java.util.Optional<Boolean> running() {
            try {
                JsonObject state = get(socket, API + "/exec/" + execId + "/json");
                return state == null
                    ? java.util.Optional.empty()
                    : java.util.Optional.of(state.get("Running").getAsBoolean());
            } catch (Exception e) {
                return java.util.Optional.empty();
            }
        }

        /** The container this exec belongs to, asked of the daemon rather than remembered. */
        private String containerOf(String id) throws IOException {
            JsonObject state = get(socket, API + "/exec/" + id + "/json");
            if (state != null && state.has("ContainerID")) {
                return state.get("ContainerID").getAsString();
            }
            throw new IOException("the daemon will not say which container exec " + id + " is in");
        }

        public boolean isAlive() {
            return channel.isOpen();
        }
    }

    // ---- ending a shell for good -------------------------------------------

    /**
     * Write the three things that end a shell, in the only order that works.
     *
     * <p>Package-visible and taking a plain stream so the unit test can assert
     * the exact bytes without a daemon — this sequence is the whole of the polite
     * step and getting its order wrong is silent.</p>
     *
     * <ol>
     *   <li>{@code ETX} (^C) first, because {@code EOT} means nothing to a shell
     *       that is not at its prompt; it interrupts whatever is in the
     *       foreground and hands the line discipline back to bash;</li>
     *   <li>a pause, so the interrupt is processed before the next byte lands —
     *       sent in the same write they can be read as one line's worth of
     *       input;</li>
     *   <li>{@code EOT} (^D), the end-of-file that makes a shell at an empty
     *       prompt exit;</li>
     *   <li>{@code exit} as the backstop for a shell with {@code ignoreeof}
     *       set, which turns ^D into a message rather than an exit.</li>
     * </ol>
     */
    static void writeExitSequence(OutputStream out) throws IOException, InterruptedException {
        out.write(new byte[] {ETX});
        out.flush();
        Thread.sleep(POLITE_EXIT_POLL_MS);
        out.write(new byte[] {EOT});
        out.flush();
        out.write("exit\n".getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    /**
     * The thread that sweeps closed terminals.
     *
     * <p>One, and a daemon one, for the same reasons the watchdog is: closes
     * arrive from a WebSocket callback that must not block for the grace second,
     * and nothing here should hold up JVM shutdown. Serial rather than pooled
     * because closes are rare and a queue of them is not worth a pool.</p>
     */
    private static final java.util.concurrent.ExecutorService REAPER =
        java.util.concurrent.Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "script-ide-docker-reaper");
            thread.setDaemon(true);
            return thread;
        });

    /** Sweeps submitted and not yet finished. See {@link #awaitReapers}. */
    private static final java.util.concurrent.atomic.AtomicInteger PENDING_SWEEPS =
        new java.util.concurrent.atomic.AtomicInteger();

    /**
     * Wait for outstanding sweeps, for module shutdown.
     *
     * <p>Shutdown is the one caller that has to wait. Everywhere else the sweep
     * is fire-and-forget, but a module being uninstalled is the last chance to
     * take its root shells with it, and {@link #REAPER}'s thread is a daemon —
     * it is simply dropped when the JVM goes.</p>
     *
     * <p>Counted rather than done with {@code REAPER.shutdown()}, and that is
     * not a style choice: this module is reinstalled on a RUNNING gateway, which
     * is a new module classloader but the same JVM. Shutting a static executor
     * down would be permanent for as long as the class stayed loaded, and every
     * sweep after the first reinstall would be rejected — turning module
     * shutdown, the one place that must not leak, into the thing that broke it.</p>
     *
     * @return true when everything finished inside the budget
     */
    public static boolean awaitReapers(long timeoutMillis) {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (PENDING_SWEEPS.get() > 0) {
            if (System.currentTimeMillis() >= deadline) {
                return false;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return true;
    }

    /**
     * Whether {@code tag} may be interpolated into the sweep script.
     *
     * <p>An allowlist, for the same reason {@code TerminalPolicy.isSafeShellPath}
     * is one: the value ends up inside single quotes in a string handed to
     * {@code sh -c}, and enumerating what a shell treats specially is the kind of
     * list that is wrong the day somebody finds the character it missed. In
     * practice the tag is a UUID we minted, so this only ever fires if a future
     * caller passes something else.</p>
     */
    static boolean isSafeTag(String tag) {
        return tag != null && !tag.isBlank() && tag.matches("[A-Za-z0-9._-]{1,120}");
    }

    /**
     * The {@code sh} script that finds and kills one terminal's processes.
     *
     * <p>Package-visible and pure so it can be unit-tested without a daemon —
     * the matcher is the whole mechanism, and getting it subtly wrong would
     * either leave shells behind or kill somebody else's.</p>
     *
     * <p>How it matches: {@code /proc/PID/environ} is the process's environment
     * as NUL-separated {@code KEY=VALUE} records, so {@code tr} turns it into
     * lines and {@code grep -qx} demands a WHOLE line equal to
     * {@code SCRIPTIDE_TERM=<tag>}. Whole-line is load-bearing — a substring
     * match would also hit any process that merely mentions the tag, including
     * this script's own {@code sh} if it were ever given the tag in its
     * environment. It is not: the tag reaches it only as an argument, and the
     * script skips its own pid anyway.</p>
     *
     * <p>Children are found for free. A shell's environment is inherited, so
     * {@code sleep 300 &} carries the tag too and is swept with its parent —
     * measured, and the reason a tag beats any form of pid bookkeeping.</p>
     *
     * <p>HUP before KILL because HUP is what a closing terminal means and bash
     * passes it on to its own jobs; KILL afterwards for anything that decided to
     * ignore it. Every {@code kill} is silenced: a pid that exited between the
     * scan and the signal is the expected case, not an error.</p>
     */
    static String reapScript(String tag) {
        String match = "'" + TAG_VARIABLE + "=" + tag + "'";
        String pass = "for p in /proc/[0-9]*; do pid=${p#/proc/}; "
            + "[ \"$pid\" = \"$$\" ] && continue; "
            + "tr '\\0' '\\n' < \"$p/environ\" 2>/dev/null | grep -qx " + match
            + " && kill -%s \"$pid\" 2>/dev/null; done";
        return String.format(pass, "HUP") + "; sleep " + REAP_GRACE_SECONDS + "; "
            + String.format(pass, "KILL") + "; exit 0";
    }

    /**
     * Run one short root command in {@code containerId} and wait for it to end.
     *
     * <p>Non-tty on purpose. Nothing reads this output, and {@code Tty:false} is
     * what makes the attached stream close at exit — which is how we know the
     * sweep finished rather than guessing at it.</p>
     */
    private static void runDetachedControlExec(Path socket, String containerId, String script)
            throws IOException {
        JsonObject create = new JsonObject();
        create.addProperty("AttachStdin", false);
        create.addProperty("AttachStdout", true);
        create.addProperty("AttachStderr", true);
        create.addProperty("Tty", false);
        create.addProperty("User", "0");
        create.add("Cmd", GSON.toJsonTree(List.of("/bin/sh", "-c", script)));
        create.add("Env", GSON.toJsonTree(List.of(
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")));

        JsonObject created = post(socket, API + "/containers/" + containerId + "/exec", create);
        if (created == null || !created.has("Id")) {
            throw new IOException("Docker refused the sweep exec: " + created);
        }
        String execId = created.get("Id").getAsString();

        JsonObject startBody = new JsonObject();
        startBody.addProperty("Detach", false);
        startBody.addProperty("Tty", false);
        byte[] payload = GSON.toJson(startBody).getBytes(StandardCharsets.UTF_8);

        try (SocketChannel channel = connect(socket)) {
            // A longer budget than an ordinary control call: this one deliberately
            // sleeps through the grace period before its KILL pass.
            java.util.concurrent.ScheduledFuture<?> watchdog =
                withTimeout(channel, CONTROL_TIMEOUT_MS + (REAP_GRACE_SECONDS + 2) * 1000L);
            try {
                OutputStream out = Channels.newOutputStream(channel);
                out.write(("POST " + API + "/exec/" + execId + "/start HTTP/1.1\r\n"
                    + "Host: docker\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Upgrade: tcp\r\n"
                    + "Content-Length: " + payload.length + "\r\n\r\n")
                    .getBytes(StandardCharsets.UTF_8));
                out.write(payload);
                out.flush();
                InputStream in = Channels.newInputStream(channel);
                readHeaders(in);
                // Drain to EOF: the stream closes when the sweep exits, so this
                // is the completion signal.
                byte[] scratch = new byte[512];
                while (in.read(scratch) != -1) {
                    // discarded
                }
            } finally {
                watchdog.cancel(false);
            }
        }
    }

    // ---- the four requests -------------------------------------------------

    /**
     * Set the pty size.
     *
     * @return true when the daemon accepted it. The caller at attach time retries
     *         on false, because the exec session becomes ready a moment after the
     *         upgrade; every other caller ignores it, since a failed resize costs
     *         a redraw and failing loudly would be noise on every window drag.
     */
    private static boolean resize(Path socket, String execId, int cols, int rows) {
        try {
            get(socket, API + "/exec/" + execId + "/resize?h=" + rows + "&w=" + cols, "POST");
            return true;
        } catch (Exception e) {
            logger.debug("Docker resize failed: {}", e.toString());
            return false;
        }
    }

    private static JsonObject get(Path socket, String path) throws IOException {
        return get(socket, path, "GET");
    }

    private static JsonObject get(Path socket, String path, String method) throws IOException {
        try (SocketChannel channel = connect(socket)) {
            java.util.concurrent.ScheduledFuture<?> watchdog = withTimeout(channel);
            try {
                OutputStream out = Channels.newOutputStream(channel);
                out.write((method + " " + path + " HTTP/1.1\r\nHost: docker\r\n"
                    + "Content-Length: 0\r\nConnection: close\r\n\r\n")
                    .getBytes(StandardCharsets.UTF_8));
                out.flush();
                return readJsonResponse(Channels.newInputStream(channel));
            } finally {
                watchdog.cancel(false);
            }
        }
    }

    private static JsonObject post(Path socket, String path, JsonObject body) throws IOException {
        byte[] payload = GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        try (SocketChannel channel = connect(socket)) {
            java.util.concurrent.ScheduledFuture<?> watchdog = withTimeout(channel);
            try {
                OutputStream out = Channels.newOutputStream(channel);
                out.write(("POST " + path + " HTTP/1.1\r\nHost: docker\r\n"
                    + "Content-Type: application/json\r\n"
                    + "Content-Length: " + payload.length + "\r\nConnection: close\r\n\r\n")
                    .getBytes(StandardCharsets.UTF_8));
                out.write(payload);
                out.flush();
                return readJsonResponse(Channels.newInputStream(channel));
            } finally {
                watchdog.cancel(false);
            }
        }
    }

    /**
     * A daemon-thread watchdog, so a wedged Docker daemon cannot hang a caller.
     *
     * <p>One thread for the whole module, and a daemon one so it never holds up
     * JVM shutdown. Needed because a blocking channel has no read timeout of its
     * own and the calling thread here is a user's terminal-open click.</p>
     */
    private static final java.util.concurrent.ScheduledExecutorService WATCHDOG =
        java.util.concurrent.Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "script-ide-docker-watchdog");
            thread.setDaemon(true);
            return thread;
        });

    /**
     * Open a control connection to the daemon.
     *
     * <p><b>Do not reintroduce {@code channel.socket().setSoTimeout(...)} here.</b>
     * {@link SocketChannel#socket()} is specified to throw
     * {@code UnsupportedOperationException} for a channel that is not IP-based,
     * and a Unix-domain channel is not. The first version of this method called
     * it, so every single control request threw, {@code available()} caught it
     * as "the socket is unusable", and the whole Docker route reported itself
     * absent — on a host where it was mounted and working. The only symptom was
     * an unprivileged shell and one log line reading {@code elevation=none}.</p>
     *
     * <p>Timeouts come from {@link #withTimeout} instead: closing a blocked
     * channel raises {@code AsynchronousCloseException} on the thread stuck in
     * the read, which is the supported way to interrupt one.</p>
     */
    private static SocketChannel connect(Path socket) throws IOException {
        return SocketChannel.open(UnixDomainSocketAddress.of(socket.toString()));
    }

    /** Close {@code channel} after the control timeout, unblocking any read. */
    private static java.util.concurrent.ScheduledFuture<?> withTimeout(SocketChannel channel) {
        return withTimeout(channel, CONTROL_TIMEOUT_MS);
    }

    /** As above, with a budget of the caller's choosing. */
    private static java.util.concurrent.ScheduledFuture<?> withTimeout(SocketChannel channel,
                                                                      long millis) {
        return WATCHDOG.schedule(() -> {
            if (channel.isOpen()) {
                logger.debug("Docker control request timed out; closing the connection");
                closeQuietly(channel);
            }
        }, millis, java.util.concurrent.TimeUnit.MILLISECONDS);
    }

    // ---- HTTP, by hand -----------------------------------------------------

    /**
     * Read the status line and headers, byte at a time, stopping at the blank
     * line.
     *
     * <p>Byte at a time on purpose. A {@code BufferedReader} would read ahead
     * into the body — and on the hijacked connection the "body" is the terminal
     * stream, so the first thing the user typed at would already have been
     * swallowed by a buffer nobody reads again. This is slow and correct, over a
     * few hundred bytes, once per connection.</p>
     *
     * @return the status line
     */
    private static String readHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int consecutiveNewlines = 0;
        int b;
        while ((b = in.read()) != -1) {
            buffer.write(b);
            if (b == '\n') {
                consecutiveNewlines++;
                if (consecutiveNewlines == 2) {
                    break;
                }
            } else if (b != '\r') {
                consecutiveNewlines = 0;
            }
        }
        String headers = buffer.toString(StandardCharsets.UTF_8);
        int eol = headers.indexOf('\n');
        return eol > 0 ? headers.substring(0, eol).trim() : headers.trim();
    }

    /** Headers, then a body that may be either length-delimited or chunked. */
    private static JsonObject readJsonResponse(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int consecutiveNewlines = 0;
        int b;
        while ((b = in.read()) != -1) {
            head.write(b);
            if (b == '\n') {
                consecutiveNewlines++;
                if (consecutiveNewlines == 2) {
                    break;
                }
            } else if (b != '\r') {
                consecutiveNewlines = 0;
            }
        }
        String headers = head.toString(StandardCharsets.UTF_8);
        String body = headers.toLowerCase(java.util.Locale.ROOT).contains("transfer-encoding: chunked")
            ? readChunked(in)
            : new String(in.readAllBytes(), StandardCharsets.UTF_8);
        String trimmed = body.trim();
        if (trimmed.isEmpty() || !trimmed.startsWith("{")) {
            return null;
        }
        return GSON.fromJson(trimmed, JsonObject.class);
    }

    private static String readChunked(InputStream in) throws IOException {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        while (true) {
            StringBuilder sizeLine = new StringBuilder();
            int b;
            while ((b = in.read()) != -1 && b != '\n') {
                if (b != '\r') {
                    sizeLine.append((char) b);
                }
            }
            int size;
            try {
                // A chunk header may carry extensions after a ';'.
                String hex = sizeLine.toString().split(";")[0].trim();
                size = hex.isEmpty() ? 0 : Integer.parseInt(hex, 16);
            } catch (NumberFormatException e) {
                break;
            }
            if (size == 0) {
                break;
            }
            byte[] chunk = in.readNBytes(size);
            body.write(chunk);
            // The CRLF that terminates the chunk.
            in.readNBytes(2);
        }
        return body.toString(StandardCharsets.UTF_8);
    }

    private static void closeQuietly(SocketChannel channel) {
        if (channel == null) {
            return;
        }
        try {
            channel.close();
        } catch (IOException e) {
            logger.debug("Closing the Docker stream failed: {}", e.toString());
        }
    }
}
