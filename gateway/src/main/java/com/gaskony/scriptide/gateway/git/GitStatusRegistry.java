package com.gaskony.scriptide.gateway.git;

import java.nio.file.Path;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The last git status read for each project, and who to tell when it changes.
 *
 * <h2>Why this is polled when presence is pushed</h2>
 *
 * <p>{@link com.gaskony.scriptide.gateway.presence.PresenceRegistry} is fed by
 * events because the platform emits them. Git emits nothing: a file changes on
 * disk and no-one is told, and the changes that matter most here are made by
 * the Designer and by this module's own save route rather than by git at all.
 * So this polls, and the poll is the honest mechanism rather than a shortcut.</p>
 *
 * <h2>Only projects somebody is looking at</h2>
 *
 * <p>A status call walks the whole working tree. Doing that every fifteen
 * seconds for every project on a gateway would spend real disk on answering a
 * question nobody asked, so {@link GitStatusSweep} polls the projects that have
 * a client attached and this registry drops the rest.</p>
 *
 * <p>The version counter exists for the same reason as presence's: a poll that
 * found nothing new must not push, or every client re-renders its tree four
 * times a minute for no reason.</p>
 */
public final class GitStatusRegistry {

    private static final Logger logger = LoggerFactory.getLogger(GitStatusRegistry.class);

    /** Told when any project's status changes; the sockets broadcast from here. */
    @FunctionalInterface
    public interface Listener {
        void gitStatusChanged(long version);
    }

    private final Map<String, GitSnapshot> byProject = new ConcurrentHashMap<>();
    private final Set<Listener> listeners = ConcurrentHashMap.newKeySet();
    private final AtomicLong version = new AtomicLong();

    /** Where a project's working tree lives. Injected so tests need no gateway. */
    private final java.util.function.Function<String, Path> projectDir;

    public GitStatusRegistry(java.util.function.Function<String, Path> projectDir) {
        this.projectDir = projectDir;
    }

    /**
     * The status last read for a project.
     *
     * <p>Returns {@link GitSnapshot#NO_REPO} for a project never polled, which is
     * indistinguishable from one with no repository — deliberately. Both mean
     * "nothing to show", and inventing a third "not yet known" state would put a
     * spinner in the tree that never resolves for the great majority of projects
     * that will never be repos.</p>
     */
    public GitSnapshot statusOf(String project) {
        return byProject.getOrDefault(project, GitSnapshot.NO_REPO);
    }

    public long version() {
        return version.get();
    }

    /**
     * Re-read one project, and say whether anything changed.
     *
     * <p>The comparison is on the whole snapshot, so a commit — which changes
     * HEAD and empties the marks — pushes, and a poll over an untouched tree
     * does not.</p>
     */
    public boolean refresh(String project) {
        GitSnapshot next = GitProbe.read(projectDir.apply(project));
        GitSnapshot previous = byProject.put(project, next);
        if (next.equals(previous)) {
            return false;
        }
        if (next.error() != null && (previous == null || previous.error() == null)) {
            // Once per transition into failure, not once per poll: a repo with a
            // corrupt index would otherwise write four lines a minute forever.
            logger.warn("Cannot read git status for project {}: {}", project, next.error());
        }
        listeners.forEach(l -> notify(l, version.incrementAndGet()));
        return true;
    }

    /** Forget projects nobody is looking at any more. */
    public void retainProjects(Set<String> live) {
        byProject.keySet().retainAll(live);
    }

    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /**
     * A listener that throws must not stop the others being told.
     *
     * <p>Each listener is one client's socket, and a socket closing mid-broadcast
     * is ordinary. Letting that propagate would leave every client after it in
     * the iteration showing a stale tree.</p>
     */
    private void notify(Listener listener, long at) {
        try {
            listener.gitStatusChanged(at);
        } catch (RuntimeException e) {
            logger.debug("git status listener failed", e);
        }
    }

    /** Test seam: install a snapshot without touching a disk. */
    void put(String project, GitSnapshot snapshot) {
        byProject.put(project, snapshot);
    }
}
