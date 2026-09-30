package com.gaskony.scriptide.gateway.exec;

import com.inductiveautomation.ignition.gateway.audit.AuditProfile;
import com.inductiveautomation.ignition.common.audit.DefaultAuditRecord;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Date;
import java.util.HexFormat;

/**
 * Records every script execution.
 *
 * <h2>The hash, not the source</h2>
 *
 * <p>{@code actionValue} carries a SHA-256 of the source plus its size, never the
 * source itself. An audit table is not a code store, a 5,000-line script would
 * blow the column, and the audit trail should not become a second copy of
 * everything anyone has ever run. The hash still answers the question the audit
 * exists for: whether two executions were the same code, and whether a given
 * script was ever run here.</p>
 *
 * <p>The full source can be sent to the MODULE LOG instead, behind
 * {@code ExecPolicy.auditIncludesSource()} — off by default.</p>
 *
 * <h2>Audited before the run, and a failed audit does not block it</h2>
 *
 * <p>Auditing happens before execution so an execution that hangs is still
 * recorded. But if the audit profile is down, the script still runs and an ERROR
 * is logged. Refusing to run when the audit database is unavailable would make
 * the IDE useless at exactly the wrong moment; silently running unaudited would
 * be worse than either. This trade-off is deliberate — if your deployment needs
 * fail-closed auditing, that is a different design decision and should be made
 * explicitly.</p>
 */
public final class ExecAudit {

    private static final Logger logger = LoggerFactory.getLogger(ExecAudit.class);

    /** Appears in the audit table's action column. */
    static final String ACTION = "script-ide-execute";

    private static final String ORIGINATING_SYSTEM = "ScriptIDE";

    /** Ignition's ApplicationScope for the Gateway. */
    private static final int CONTEXT_GATEWAY = 1;

    private final GatewayContext context;

    public ExecAudit(GatewayContext context) {
        this.context = context;
    }

    /**
     * Record one execution attempt.
     *
     * @param username  who ran it
     * @param actorHost their remote address, if known
     * @param project   the project whose scripting context was used
     * @param target    what was run — a resource path, or a console identifier
     * @param source    the code, used only to derive a hash and a size
     */
    public void record(String username, String actorHost, String project,
                       String target, String source) {
        String value = summarise(source);
        try {
            AuditProfile profile = profileFor(project);
            if (profile == null) {
                // No audit profile configured anywhere. Do not fail silently — this
                // is still a security-relevant event and it belongs somewhere.
                logger.warn("No audit profile configured; Web IDE execution NOT audited. "
                        + "user='{}' project='{}' target='{}' {}",
                    username, project, target, value);
                return;
            }
            profile.audit(new DefaultAuditRecord.Builder()
                .action(ACTION)
                .actionTarget(project + "/" + target)
                .actionValue(value)
                .actor(username)
                .actorHost(actorHost == null ? "" : actorHost)
                .originatingContext(CONTEXT_GATEWAY)
                .originatingSystem(ORIGINATING_SYSTEM)
                .statusCode(0)
                .timestamp(new Date())
                .build());
        } catch (Exception e) {
            // See the class Javadoc: the run proceeds. ERROR, not WARN — an audit
            // gap on an execution endpoint is a real problem even though it is not
            // a fatal one.
            logger.error("Failed to audit a Web IDE execution (it will still run). "
                    + "user='{}' project='{}' target='{}' {}: {}",
                username, project, target, value, e.toString());
        }

        if (ExecPolicy.auditIncludesSource()) {
            logger.info("Web IDE execution source [user={} project={} target={}]:\n{}",
                username, project, target, source);
        }
    }

    /** Project profile first, falling back to the gateway's. */
    private AuditProfile profileFor(String project) {
        try {
            AuditProfile profile = context.getAuditManager().getProfileForProject(project);
            if (profile != null) {
                return profile;
            }
        } catch (Exception e) {
            logger.debug("No project audit profile for '{}': {}", project, e.getMessage());
        }
        try {
            return context.getAuditManager().getGatewayAuditProfile();
        } catch (Exception e) {
            logger.debug("No gateway audit profile: {}", e.getMessage());
            return null;
        }
    }

    /** {@code sha256=<64 hex> bytes=<n> lines=<n>} — identifying, not reproducing. */
    static String summarise(String source) {
        String text = source == null ? "" : source;
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        String hash;
        try {
            hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated by the JLS, so this cannot happen; still, never
            // let it stop the audit record from being written.
            hash = "unavailable";
        }
        int lines = text.isEmpty() ? 0 : text.split("\n", -1).length;
        return "sha256=" + hash + " bytes=" + bytes.length + " lines=" + lines;
    }
}
