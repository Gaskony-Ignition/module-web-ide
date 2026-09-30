package com.gaskony.scriptide.gateway.git;

import java.util.Set;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Re-reads git status for the projects somebody currently has open.
 *
 * <p>The project set comes from the live sockets rather than from the gateway's
 * project list, and that is the whole cost control: a status call walks a working
 * tree, and most projects on a gateway are not repositories and have nobody
 * looking at them. Polling those would be disk spent on a question no client
 * asked.</p>
 *
 * <p>Ten seconds, not fifteen. Presence's period is about how long a name that
 * has ALREADY left may linger; this one is about how long after saving a script
 * the tree admits the script changed, which a person is watching for.</p>
 */
public final class GitStatusSweep implements Runnable {

    private static final Logger logger = LoggerFactory.getLogger(GitStatusSweep.class);

    /** How often each watched project is re-read. See the class note. */
    public static final int PERIOD_SECONDS = 10;

    private final GitStatusRegistry registry;
    private final Supplier<Set<String>> watchedProjects;

    public GitStatusSweep(GitStatusRegistry registry, Supplier<Set<String>> watchedProjects) {
        this.registry = registry;
        this.watchedProjects = watchedProjects;
    }

    @Override
    public void run() {
        try {
            Set<String> projects = watchedProjects.get();
            if (projects == null) {
                return;
            }
            for (String project : projects) {
                registry.refresh(project);
            }
            registry.retainProjects(projects);
        } catch (RuntimeException e) {
            // Most executors cancel a scheduled task that throws, and an
            // indicator that quietly stopped updating is worse than one that
            // missed a pass — it still looks authoritative.
            logger.debug("Git status sweep failed: {}", e.toString());
        }
    }
}
