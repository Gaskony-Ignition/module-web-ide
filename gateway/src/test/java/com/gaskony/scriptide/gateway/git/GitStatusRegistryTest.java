package com.gaskony.scriptide.gateway.git;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.eclipse.jgit.api.Git;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class GitStatusRegistryTest {

    private static final String SCRIPT = "ignition/script-python/Demo/config";

    private static GitStatusRegistry registryOn(Path projects) {
        return new GitStatusRegistry(projects::resolve);
    }

    private static void commitScript(Path dir) throws Exception {
        Path folder = dir.resolve(SCRIPT);
        Files.createDirectories(folder);
        Files.writeString(folder.resolve("code.py"), "x = 1\n");
        try (Git git = Git.init().setDirectory(dir.toFile()).call()) {
            git.add().addFilepattern(".").call();
            git.commit().setMessage("i").setSign(false)
                .setAuthor("t", "t@e.com").setCommitter("t", "t@e.com").call();
        }
    }

    @Test
    void anUnpolledProjectReadsAsNoRepoRatherThanUnknown(@TempDir Path projects) {
        // Deliberate: "not yet polled" and "not a repository" are shown the same
        // because both mean nothing to display, and a third state would put a
        // spinner in the tree of every project that will never be a repo.
        assertEquals(GitSnapshot.NO_REPO, registryOn(projects).statusOf("Never_Polled"));
    }

    @Test
    void anUnchangedPollDoesNotNotify(@TempDir Path projects) throws Exception {
        // The reason the version counter exists. Without this every client
        // re-renders its tree six times a minute over an unchanged tree.
        Path project = projects.resolve("Demo");
        Files.createDirectories(project);
        commitScript(project);

        GitStatusRegistry registry = registryOn(projects);
        AtomicInteger pushes = new AtomicInteger();
        registry.addListener(version -> pushes.incrementAndGet());

        assertTrue(registry.refresh("Demo"), "first read is always a change");
        assertEquals(1, pushes.get());
        assertFalse(registry.refresh("Demo"), "an unchanged tree must not push");
        assertEquals(1, pushes.get());
    }

    @Test
    void aChangeNotifiesExactlyOnce(@TempDir Path projects) throws Exception {
        Path project = projects.resolve("Demo");
        Files.createDirectories(project);
        commitScript(project);

        GitStatusRegistry registry = registryOn(projects);
        registry.refresh("Demo");
        AtomicInteger pushes = new AtomicInteger();
        registry.addListener(version -> pushes.incrementAndGet());

        Files.writeString(project.resolve(SCRIPT).resolve("code.py"), "x = 2\n");
        assertTrue(registry.refresh("Demo"));
        assertEquals(1, pushes.get());
        assertEquals(GitMark.MODIFIED, registry.statusOf("Demo").marks().get(SCRIPT));
    }

    @Test
    void aListenerThatThrowsDoesNotStopTheOthers(@TempDir Path projects) throws Exception {
        // Each listener is one client's socket, and a socket closing mid-broadcast
        // is ordinary traffic. Letting it propagate would leave every client after
        // it in the iteration showing a stale tree.
        Path project = projects.resolve("Demo");
        Files.createDirectories(project);
        commitScript(project);

        GitStatusRegistry registry = registryOn(projects);
        AtomicInteger reached = new AtomicInteger();
        registry.addListener(version -> {
            throw new IllegalStateException("socket closed");
        });
        registry.addListener(version -> reached.incrementAndGet());

        registry.refresh("Demo");
        assertEquals(1, reached.get(), "the second listener must still be told");
    }

    @Test
    void aRemovedListenerIsNotTold(@TempDir Path projects) throws Exception {
        Path project = projects.resolve("Demo");
        Files.createDirectories(project);
        commitScript(project);

        GitStatusRegistry registry = registryOn(projects);
        AtomicInteger pushes = new AtomicInteger();
        GitStatusRegistry.Listener listener = version -> pushes.incrementAndGet();
        registry.addListener(listener);
        registry.removeListener(listener);

        registry.refresh("Demo");
        assertEquals(0, pushes.get(), "a closed socket must stop being written to");
    }

    @Test
    void projectsNobodyIsLookingAtAreForgotten(@TempDir Path projects) {
        GitStatusRegistry registry = registryOn(projects);
        registry.put("Gone", new GitSnapshot(true, "main", "abc1234",
            Map.of(SCRIPT, GitMark.MODIFIED), List.of(), null));
        registry.put("Watched", GitSnapshot.NO_REPO);

        registry.retainProjects(Set.of("Watched"));

        assertEquals(GitSnapshot.NO_REPO, registry.statusOf("Gone"));
    }
}
