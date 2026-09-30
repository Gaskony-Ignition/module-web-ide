package com.gaskony.scriptide.gateway.git;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.eclipse.jgit.api.Git;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Against REAL repositories, built by JGit in a temp directory.
 *
 * <p>Not mocks. The thing worth testing is the fold from changed FILES to
 * changed RESOURCES, and the input to that fold is whatever JGit's status
 * command actually returns — which is the part a mock would let me assume.</p>
 */
class GitProbeTest {

    private static final String SCRIPT = "ignition/script-python/Demo/config";

    /** A project directory that is a git repo with one committed script. */
    private static Git projectWithScript(Path dir) throws Exception {
        Git git = Git.init().setDirectory(dir.toFile()).call();
        writeScript(dir, SCRIPT, "def value():\n\treturn 1\n");
        git.add().addFilepattern(".").call();
        git.commit().setMessage("initial").setSign(false)
            .setAuthor("t", "t@example.com").setCommitter("t", "t@example.com").call();
        return git;
    }

    private static void writeScript(Path dir, String resource, String code) throws IOException {
        Path folder = dir.resolve(resource);
        Files.createDirectories(folder);
        Files.writeString(folder.resolve("code.py"), code);
        Files.writeString(folder.resolve("resource.json"), "{\"scope\":\"G\"}");
    }

    @Test
    void aDirectoryThatIsNotARepoIsNotAnError(@TempDir Path dir) {
        // Most projects on a gateway are not repositories, so this is the common
        // case and must be cheap and silent — never an error state in the UI.
        assertSame(GitSnapshot.NO_REPO, GitProbe.read(dir));
        assertFalse(GitProbe.isRepo(dir));
    }

    @Test
    void aMissingDirectoryAnswersRatherThanThrowing(@TempDir Path dir) {
        // The poll loop calls this for whatever project a client named. A project
        // deleted between the client's frame and the poll must not kill the sweep.
        assertSame(GitSnapshot.NO_REPO, GitProbe.read(dir.resolve("gone")));
    }

    @Test
    void aCleanRepoIsClean(@TempDir Path dir) throws Exception {
        try (Git git = projectWithScript(dir)) {
            assertNotNull(git);
        }
        GitSnapshot snapshot = GitProbe.read(dir);
        assertTrue(snapshot.repo());
        assertTrue(snapshot.clean(), "expected clean, marks were " + snapshot.marks());
        assertNull(snapshot.error());
        assertNotNull(snapshot.head());
    }

    @Test
    void twoChangedFilesInOneScriptAreONEMark(@TempDir Path dir) throws Exception {
        // THE point of the fold. A script is code.py plus resource.json, and the
        // Designer rewrites both on every save. Reporting files would put two
        // marks on one script and name neither of them anything the tree holds.
        try (Git git = projectWithScript(dir)) {
            writeScript(dir, SCRIPT, "def value():\n\treturn 2\n");
            Files.writeString(dir.resolve(SCRIPT).resolve("resource.json"), "{\"scope\":\"A\"}");
            assertNotNull(git);
        }
        GitSnapshot snapshot = GitProbe.read(dir);
        assertEquals(1, snapshot.marks().size(), "marks were " + snapshot.marks());
        assertEquals(GitMark.MODIFIED, snapshot.marks().get(SCRIPT));
    }

    @Test
    void aNewScriptIsAdded(@TempDir Path dir) throws Exception {
        try (Git git = projectWithScript(dir)) {
            writeScript(dir, "ignition/script-python/Demo/fresh", "x = 1\n");
            assertNotNull(git);
        }
        GitSnapshot snapshot = GitProbe.read(dir);
        assertEquals(GitMark.ADDED, snapshot.marks().get("ignition/script-python/Demo/fresh"));
    }

    @Test
    void aDeletedScriptKeepsItsPathSoTheClientCanRollItUp(@TempDir Path dir) throws Exception {
        // The resource is gone, so the tree has no node for it. The path is still
        // reported, because the client walks UP from it to the parent package —
        // which does exist — and marks that. Dropping it would make a deletion
        // the one change the indicator cannot show.
        try (Git git = projectWithScript(dir)) {
            Files.delete(dir.resolve(SCRIPT).resolve("code.py"));
            Files.delete(dir.resolve(SCRIPT).resolve("resource.json"));
            assertNotNull(git);
        }
        GitSnapshot snapshot = GitProbe.read(dir);
        assertEquals(GitMark.DELETED, snapshot.marks().get(SCRIPT));
    }

    @Test
    void deletionBeatsModificationOnTheSameResource(@TempDir Path dir) throws Exception {
        // One file edited, the other removed. "Modified" would understate it.
        try (Git git = projectWithScript(dir)) {
            Files.writeString(dir.resolve(SCRIPT).resolve("code.py"), "y = 2\n");
            Files.delete(dir.resolve(SCRIPT).resolve("resource.json"));
            assertNotNull(git);
        }
        assertEquals(GitMark.DELETED, GitProbe.read(dir).marks().get(SCRIPT));
    }

    @Test
    void projectJsonIsCountedButNeverDecorated(@TempDir Path dir) throws Exception {
        // It has no node in the tree, so it cannot be marked — but a summary
        // that ignored it would say "no changes" about a dirty working tree.
        try (Git git = projectWithScript(dir)) {
            Files.writeString(dir.resolve("project.json"), "{\"title\":\"Demo\"}");
            assertNotNull(git);
        }
        GitSnapshot snapshot = GitProbe.read(dir);
        assertTrue(snapshot.marks().isEmpty(), "marks were " + snapshot.marks());
        assertTrue(snapshot.others().contains("project.json"));
        assertFalse(snapshot.clean(), "a changed project.json is not a clean tree");
    }

    @Test
    void gitignoredFilesAreNotChanges(@TempDir Path dir) throws Exception {
        // Whatever the repo ignores, this must ignore. Reporting an ignored file
        // as added would put a permanent mark on a tree that is genuinely clean.
        try (Git git = projectWithScript(dir)) {
            Files.writeString(dir.resolve(".gitignore"), "ignored/\n");
            git.add().addFilepattern(".gitignore").call();
            git.commit().setMessage("ignore").setSign(false)
                .setAuthor("t", "t@example.com").setCommitter("t", "t@example.com").call();
            Files.createDirectories(dir.resolve("ignored"));
            Files.writeString(dir.resolve("ignored/thing.txt"), "x");
        }
        assertTrue(GitProbe.read(dir).clean());
    }

    @Test
    void aRepoWithNoCommitsHasNoHeadAndIsNotAnError(@TempDir Path dir) throws Exception {
        // The state a project is in for the first few minutes of being version
        // controlled. Reading it as a failure would greet everybody who runs
        // `git init` with an error.
        try (Git git = Git.init().setDirectory(dir.toFile()).call()) {
            assertNotNull(git);
        }
        GitSnapshot snapshot = GitProbe.read(dir);
        assertTrue(snapshot.repo());
        assertNull(snapshot.error());
        assertNull(snapshot.head());
        assertNotNull(snapshot.branch());
    }

    @Test
    void anUnreadableHeadIsAnErrorAndNotAProjectFullOfNewFiles(@TempDir Path dir)
            throws Exception {
        // MEASURED, and the reason GitProbe checks the branch before asking for
        // status at all. With an unresolvable HEAD, JGit reports every tracked
        // file as UNTRACKED — nothing is "in HEAD" — so the first version of
        // this class marked an entire committed project as newly added, threw
        // nothing, and logged nothing. A tree claiming a repository lost its
        // history is worse than one that admits it cannot read the repository.
        try (Git git = projectWithScript(dir)) {
            assertNotNull(git);
        }
        Files.writeString(dir.resolve(".git/HEAD"), "this is not a ref\n");
        GitSnapshot snapshot = GitProbe.read(dir);
        assertTrue(snapshot.repo());
        assertEquals("HEAD is unreadable", snapshot.error());
        assertTrue(snapshot.marks().isEmpty(), "marks were " + snapshot.marks());
        assertFalse(snapshot.clean());
    }

    @Test
    void aCorruptObjectStoreCarriesItsReason(@TempDir Path dir) throws Exception {
        // A different corruption, reaching a different code path: this one DOES
        // throw out of JGit, and the reason has to survive as a string rather
        // than becoming an empty, clean-looking snapshot.
        try (Git git = projectWithScript(dir)) {
            assertNotNull(git);
        }
        Files.writeString(dir.resolve(".git/index"), "garbage");
        GitSnapshot snapshot = GitProbe.read(dir);
        assertTrue(snapshot.repo());
        assertNotNull(snapshot.error(), "a corrupt index must carry a reason");
        assertFalse(snapshot.error().isBlank());
        assertFalse(snapshot.clean());
    }
}
