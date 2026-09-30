package com.gaskony.scriptide.gateway.exec;

import com.gaskony.scriptide.gateway.term.PolicySource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;

/**
 * The fleet-wide switches governing script execution.
 *
 * <p>Read on EVERY call, never cached at startup, from two sources in this
 * order:</p>
 *
 * <ol>
 *   <li>the LIVE policy file — see {@link PolicySource} for its location and
 *       format. Editing it turns execution off on a running gateway;</li>
 *   <li>a JVM system property, set in {@code data/ignition.conf} as
 *       {@code wrapper.java.additional.N=-Dkey=value}. Right for a fleet default,
 *       but only readable at boot, so changing one needs a restart;</li>
 *   <li>the built-in default below.</li>
 * </ol>
 *
 * <p>The file wins because it is the more specific and more recent statement of
 * intent. Until 1.5.0 only the system property existed, which made the "no
 * restart needed" claim true of this class and false of the gateway.</p>
 */
public final class ExecPolicy {

    private static final Logger logger = LoggerFactory.getLogger(ExecPolicy.class);

    private static final String PREFIX = "com.gaskony.scriptide.";

    /** Master kill switch. When false every execution request is refused. */
    public static final String PROP_ENABLED = PREFIX + "execution.enabled";

    /** Whether execution demands the Administrator role. */
    public static final String PROP_REQUIRE_ADMIN = PREFIX + "execution.requireAdmin";

    /**
     * Second flag that must ALSO be set before {@link #PROP_REQUIRE_ADMIN} may be
     * turned off.
     *
     * <p>Two flags rather than one on purpose: dropping the admin requirement
     * hands arbitrary Gateway-JVM code execution to every authenticated user. That
     * should not be reachable by a single typo'd property, and it should be
     * obvious in a config file that someone meant it.</p>
     */
    public static final String PROP_ACKNOWLEDGE_RISK = PREFIX + "execution.acknowledgeRisk";

    public static final String PROP_TIMEOUT_SECONDS = PREFIX + "execution.timeoutSeconds";
    public static final String PROP_MAX_CONCURRENT = PREFIX + "execution.maxConcurrent";

    /** When true the full source is written to the module log. Off by default. */
    public static final String PROP_AUDIT_INCLUDE_SOURCE = PREFIX + "audit.includeSource";

    public static final long DEFAULT_TIMEOUT_SECONDS = 60;
    public static final long MAX_TIMEOUT_SECONDS = 600;
    public static final int DEFAULT_MAX_CONCURRENT = 4;
    public static final int MAX_MAX_CONCURRENT = 16;

    private ExecPolicy() { /* static config accessor */ }

    /**
     * Point the live overrides at a file.
     *
     * <p>Delegates: {@link PolicySource} is shared with {@code TerminalPolicy} so
     * one file covers both, and the module hook only has to call this once.</p>
     */
    public static void setPropertiesFile(Path path) {
        PolicySource.setPropertiesFile(path);
    }

    /** The live file first, then the system property. Null when neither sets it. */
    private static String raw(String key) {
        String live = PolicySource.value(key);
        return live != null ? live : System.getProperty(key);
    }

    /** Whether script execution is permitted at all on this gateway. */
    public static boolean executionEnabled() {
        return boolProperty(PROP_ENABLED, true);
    }

    /**
     * Whether the Administrator role is required to execute.
     *
     * <p>Defaults to true, and cannot be turned off by
     * {@link #PROP_REQUIRE_ADMIN} alone — {@link #PROP_ACKNOWLEDGE_RISK} must also
     * be set. When it IS turned off, that is logged as a warning on every single
     * execution rather than once at startup, because a gateway that has been
     * running for six months should still be telling someone.</p>
     */
    public static boolean requireAdmin() {
        boolean requested = boolProperty(PROP_REQUIRE_ADMIN, true);
        if (requested) {
            return true;
        }
        if (!boolProperty(PROP_ACKNOWLEDGE_RISK, false)) {
            logger.warn("{}=false ignored: {} is not set. Script execution still requires "
                    + "the Administrator role.", PROP_REQUIRE_ADMIN, PROP_ACKNOWLEDGE_RISK);
            return true;
        }
        logger.warn("SCRIPT EXECUTION IS OPEN TO EVERY AUTHENTICATED USER on this gateway "
            + "({}=false with {}=true). Any of them can run arbitrary code in the Gateway JVM.",
            PROP_REQUIRE_ADMIN, PROP_ACKNOWLEDGE_RISK);
        return false;
    }

    /** Per-execution wall-clock budget, clamped to a sane range. */
    public static long timeoutSeconds() {
        return clamp(longProperty(PROP_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
            1, MAX_TIMEOUT_SECONDS);
    }

    /** Size of the execution thread pool, clamped. */
    public static int maxConcurrent() {
        return (int) clamp(longProperty(PROP_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
            1, MAX_MAX_CONCURRENT);
    }

    /** Whether to log the full source of each execution (not just its hash). */
    public static boolean auditIncludesSource() {
        return boolProperty(PROP_AUDIT_INCLUDE_SOURCE, false);
    }

    private static boolean boolProperty(String key, boolean fallback) {
        String raw = raw(key);
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        // Strict parse: only "true"/"false" count. A typo must not silently read as
        // false and disable a security control.
        if ("true".equalsIgnoreCase(raw.trim())) {
            return true;
        }
        if ("false".equalsIgnoreCase(raw.trim())) {
            return false;
        }
        logger.warn("Ignoring {}='{}': expected true or false. Using {}.", key, raw, fallback);
        return fallback;
    }

    private static long longProperty(String key, long fallback) {
        String raw = raw(key);
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            logger.warn("Ignoring {}='{}': not a number. Using {}.", key, raw, fallback);
            return fallback;
        }
    }

    private static long clamp(long value, long min, long max) {
        return Math.max(min, Math.min(max, value));
    }
}
