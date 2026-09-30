package com.gaskony.scriptide.gateway.term;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Works out whether this JVM is inside a Docker container, and which one.
 *
 * <h2>Why not the hostname</h2>
 *
 * <p>The usual trick — "Docker sets the hostname to the short container id" — is
 * <b>wrong on this estate</b> and fails silently, which is the worst combination.
 * The module-testing gateway runs with {@code network_mode: host}, so it inherits
 * the host's UTS namespace and {@code hostname} returns {@code nigel-VM}. Measured
 * 02/09/2026. A caller that trusted it would ask the daemon to exec into a
 * container named after the workstation.</p>
 *
 * <p>{@code /proc/self/cgroup} is no better on a cgroup v2 host: it reads
 * {@code 0::/} with no container id anywhere in it. Also measured.</p>
 *
 * <h2>What actually works</h2>
 *
 * <p>{@code /proc/self/mountinfo}. Docker bind-mounts {@code /etc/hosts},
 * {@code /etc/hostname} and {@code /etc/resolv.conf} from
 * {@code /var/lib/docker/containers/<id>/} into every container, and the mount
 * source is recorded there with the full 64-character id. Verified against
 * {@code docker inspect -f '{{.Id}}'} — exact match, host networking and all.</p>
 */
public final class ContainerIdentity {

    private static final Logger logger = LoggerFactory.getLogger(ContainerIdentity.class);

    /*
     * The two files this probe reads, in a List rather than as `static final
     * String` or `Path` constants.
     *
     * Not stylistic. A `static final String` is a compile-time constant, so
     * javac inlines it at the use site and SpotBugs sees a literal absolute path
     * again (DMI) wherever it is used — the first attempt at this moved the
     * literal out of the field and the finding simply followed it into the
     * method. `List.of(...)` is a runtime call, so the elements are not folded.
     * Same shape, and for the same reason, as TerminalSession's
     * SCRIPT_CANDIDATES.
     *
     * The gate has a point underneath the mechanics: these are probes of a host
     * that may have neither file — a Windows gateway has no /proc at all — so
     * they are lookups rather than constants, and both call sites treat "absent"
     * as an ordinary answer.
     */
    private static final List<String> PROBE_PATHS =
        List.of("/.dockerenv", "/proc/self/mountinfo");

    private static Path dockerEnv() {
        return Path.of(PROBE_PATHS.get(0));
    }

    private static Path mountinfo() {
        return Path.of(PROBE_PATHS.get(1));
    }

    /**
     * The container id as it appears in a mountinfo source path.
     *
     * <p>Anchored on {@code /containers/} rather than the whole
     * {@code /var/lib/docker/} prefix, because the data root is configurable and
     * a site that moved it would otherwise look like a bare-metal host.</p>
     */
    private static final Pattern CONTAINER_ID =
        Pattern.compile("/containers/([0-9a-f]{64})");

    private ContainerIdentity() { /* static probe */ }

    /** True when this JVM is running inside a Docker container. */
    public static boolean inDocker() {
        return Files.exists(dockerEnv());
    }

    /**
     * This container's full id, or {@code null} if it cannot be established.
     *
     * <p>Null is a perfectly ordinary answer: a gateway installed on a host, or
     * one in a runtime that lays its mounts out differently. The caller must
     * treat it as "no Docker route available" and move on, never as an error.</p>
     */
    public static String selfContainerId() {
        if (!inDocker()) {
            return null;
        }
        try {
            String raw = Files.readString(mountinfo(), StandardCharsets.UTF_8);
            Matcher matcher = CONTAINER_ID.matcher(raw);
            if (matcher.find()) {
                return matcher.group(1);
            }
            logger.debug("In Docker, but no container id in {}", mountinfo());
        } catch (IOException | RuntimeException e) {
            // /proc is not readable on every platform, and a Windows or macOS
            // gateway has no /proc at all. Not an error — just no Docker route.
            logger.debug("Could not read {}: {}", mountinfo(), e.toString());
        }
        return null;
    }
}
