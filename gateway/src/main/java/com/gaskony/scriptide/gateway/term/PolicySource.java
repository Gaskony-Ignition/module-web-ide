package com.gaskony.scriptide.gateway.term;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;

/**
 * A second, LIVE source for every {@code ExecPolicy} and {@link TerminalPolicy}
 * switch: a properties file the gateway operator can edit while the gateway runs.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Both policy classes were honest about re-reading their values on every call
 * — and every value came from a JVM system property, which is set in
 * {@code data/ignition.conf} and read once, when the JVM starts. So "you can turn
 * the terminal off without restarting anything" was true of the code and false of
 * the gateway: turning it off meant editing {@code ignition.conf} and bouncing
 * the gateway, and the estate rule is that a config change is applied with a
 * settings rescan, never a restart.</p>
 *
 * <p>A properties file closes that gap without giving up the system properties,
 * which are still the right way to state a fleet default at boot. Precedence is
 * <b>file value &gt; system property &gt; built-in default</b>: the file is the
 * more specific and more recent statement of intent, and an operator who has just
 * edited it expects it to win.</p>
 *
 * <h2>The file</h2>
 *
 * <pre>
 * &lt;gateway data dir&gt;/modules/scriptide/policy.properties
 *
 * # Standard java.util.Properties syntax. Keys are the SAME fully-qualified
 * # names used as system properties, so a line can be copied straight out of
 * # ignition.conf with the -D removed. Unknown keys are ignored.
 * com.gaskony.scriptide.execution.enabled=true
 * com.gaskony.scriptide.execution.requireAdmin=true
 * com.gaskony.scriptide.execution.timeoutSeconds=60
 * com.gaskony.scriptide.execution.maxConcurrent=4
 * com.gaskony.scriptide.audit.includeSource=false
 * com.gaskony.scriptide.terminal.enabled=true
 * com.gaskony.scriptide.terminal.requireAdmin=true
 * com.gaskony.scriptide.terminal.shell=/bin/bash
 * com.gaskony.scriptide.terminal.maxPerSession=3
 * com.gaskony.scriptide.terminal.idleMinutes=120
 * com.gaskony.scriptide.terminal.privileged=true
 * com.gaskony.scriptide.terminal.docker=true
 * </pre>
 *
 * <p><b>The module never creates this file.</b> Absent means "no overrides", which
 * is the state every existing gateway is already in, so shipping this changes
 * nothing until somebody writes the file on purpose. It must be readable and
 * writable by the gateway's own operating-system user and by nobody else — it can
 * turn the Administrator requirement off, so its file permissions are a security
 * control in their own right, exactly as {@code ignition.conf}'s are.</p>
 *
 * <h2>Why the file is re-statted rather than watched</h2>
 *
 * <p>Every policy getter is on a hot-ish path (the audit line calls several per
 * terminal open) and a {@code WatchService} would need a thread, a lifecycle and
 * a shutdown hook for a file that changes twice a year. An mtime check at most
 * once every {@link #RECHECK_MILLIS} ms costs one {@code stat} and bounds how
 * stale a value can be at two seconds, which is far inside "a change lands
 * without a restart".</p>
 *
 * <p>Second-resolution mtimes are not relied on: the size is compared too, so two
 * edits inside one filesystem timestamp tick are still noticed unless they are
 * also the same length.</p>
 */
public final class PolicySource {

    private static final Logger logger = LoggerFactory.getLogger(PolicySource.class);

    /** Path under the gateway data directory. */
    static final String RELATIVE_PATH = "modules/scriptide/policy.properties";

    /** How stale a value may be. See the class Javadoc for why this is not a watcher. */
    static final long RECHECK_MILLIS = 2000;

    /** Set by the module hook when it has a {@code GatewayContext}. */
    private static volatile Path configured;

    /** Guards the cache; all mutation happens under it. */
    private static final Object LOCK = new Object();

    private static Properties cache = new Properties();
    private static long lastCheck;
    private static long lastModified = -1;
    private static long lastSize = -1;
    private static Path lastPath;

    private PolicySource() { /* static config accessor */ }

    /**
     * Point the policy classes at the real file.
     *
     * <p>Called from the module hook, which is the only place with a
     * {@code GatewayContext} and therefore the only place that knows the data
     * directory for certain. Optional: {@link #discover()} finds the same file on
     * a stock Ignition install without it.</p>
     */
    public static void setPropertiesFile(Path path) {
        synchronized (LOCK) {
            configured = path;
            // Force the next read to reload, so a hook call takes effect at once
            // rather than up to RECHECK_MILLIS later.
            lastCheck = 0;
            lastModified = -1;
            lastSize = -1;
        }
        logger.debug("Live policy overrides will be read from {}", path);
    }

    /**
     * The file to read, whether or not the hook has named one.
     *
     * <p>The fallback is the platform's own {@code data.dir} system property,
     * which Ignition sets on its JVM command line — measured as
     * {@code -Ddata.dir=data} on 8.3.8, i.e. RELATIVE to the working directory
     * ({@code /usr/local/bin/ignition} in the stock container). It is resolved
     * against {@code user.dir} for exactly that reason; taking it literally would
     * look for the file wherever the gateway happened to be started from.</p>
     */
    static Path discover() {
        Path explicit = configured;
        if (explicit != null) {
            return explicit;
        }
        String dataDir = System.getProperty("data.dir", "data");
        Path base = Path.of(dataDir);
        if (!base.isAbsolute()) {
            base = Path.of(System.getProperty("user.dir", ".")).resolve(base);
        }
        return base.resolve(RELATIVE_PATH);
    }

    /**
     * The override for {@code key}, or {@code null} when the file does not set it.
     *
     * <p>Null rather than a default: the caller still has a system property and a
     * built-in default to fall back through, and returning an empty string here
     * would silently outrank both.</p>
     */
    public static String value(String key) {
        Properties properties = current();
        String raw = properties.getProperty(key);
        return raw == null || raw.isBlank() ? null : raw.trim();
    }

    private static Properties current() {
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            Path path = discover();
            // The path itself can change (the hook lands after first use), so a
            // different path always reloads regardless of the recheck window.
            if (path.equals(lastPath) && now - lastCheck < RECHECK_MILLIS) {
                return cache;
            }
            lastCheck = now;
            lastPath = path;
            try {
                if (!Files.isReadable(path)) {
                    if (lastModified != -1) {
                        logger.info("Live policy file {} is gone; falling back to system "
                            + "properties and built-in defaults", path);
                    }
                    lastModified = -1;
                    lastSize = -1;
                    cache = new Properties();
                    return cache;
                }
                long modified = Files.getLastModifiedTime(path).toMillis();
                long size = Files.size(path);
                if (modified == lastModified && size == lastSize) {
                    return cache;
                }
                Properties loaded = new Properties();
                try (InputStream in = Files.newInputStream(path)) {
                    loaded.load(in);
                }
                lastModified = modified;
                lastSize = size;
                cache = loaded;
                logger.info("Loaded {} live policy override(s) from {}", loaded.size(), path);
            } catch (Exception e) {
                // Keep whatever was last read rather than silently reverting to
                // defaults: a half-written file being saved must not disable a
                // control for the two seconds it takes the editor to finish.
                logger.warn("Could not read the live policy file {}; keeping the previous "
                    + "values: {}", path, e.toString());
            }
            return cache;
        }
    }

    /** Drop every cached value. Test-only; production reloads on mtime. */
    static void resetForTests() {
        synchronized (LOCK) {
            configured = null;
            cache = new Properties();
            lastCheck = 0;
            lastModified = -1;
            lastSize = -1;
            lastPath = null;
        }
    }
}
