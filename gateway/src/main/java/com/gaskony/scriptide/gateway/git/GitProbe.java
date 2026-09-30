package com.gaskony.scriptide.gateway.git;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.api.Status;
import org.eclipse.jgit.lib.Constants;
import org.eclipse.jgit.lib.ObjectId;
import org.eclipse.jgit.lib.Repository;
import org.eclipse.jgit.storage.file.FileRepositoryBuilder;

/**
 * Reads a project's git status, in pure Java.
 *
 * <p>Pure Java is not a preference. The rig runs a STOCK Ignition image with no
 * {@code git} binary, and building a custom one to add it is a decision already
 * taken the other way. Shelling out was never on the table.</p>
 *
 * <p>The repository is expected at {@code <dataDir>/projects/<Project>/.git} —
 * the same path {@code module-git} resolves, checked against its
 * {@code GitManager.getProjectFolderPath}. Two modules on one gateway
 * disagreeing about which directory is the repo would be a defect that only
 * shows up as contradictory UI.</p>
 *
 * <p>This class only reads. There is no stage, commit, fetch or checkout here
 * and there should never be one: Nigel's decision on 01/09/2026 is that this
 * module is not becoming a git module.</p>
 */
public final class GitProbe {

    /**
     * Files that live inside a project directory but are not project resources.
     *
     * <p>They are counted rather than dropped — a status line claiming "no
     * changes" while {@code project.json} is modified is the failure this
     * whole feature exists to prevent — but they are never decorated, because
     * the tree has no node to decorate.</p>
     */
    private static boolean isResourceFile(String repoRelative) {
        return repoRelative.contains("/") && !repoRelative.startsWith(".");
    }

    private GitProbe() {
    }

    /** Whether this project directory is the root of a git working tree. */
    public static boolean isRepo(Path projectDir) {
        return projectDir != null && Files.isDirectory(projectDir.resolve(".git"));
    }

    /**
     * Read one project's status.
     *
     * <p>Never throws. Every failure becomes a {@link GitSnapshot#failed} carrying
     * the reason, because the caller is a poll loop feeding a UI: an exception
     * escaping here would either kill the loop or silently blank the indicator.</p>
     */
    public static GitSnapshot read(Path projectDir) {
        if (!isRepo(projectDir)) {
            return GitSnapshot.NO_REPO;
        }
        try (Repository repository = new FileRepositoryBuilder()
                .setGitDir(projectDir.resolve(".git").toFile())
                .setWorkTree(projectDir.toFile())
                .readEnvironment()
                .build();
             Git git = new Git(repository)) {

            String branch = branchOf(repository);
            if (branch == null) {
                // HEAD is there and unreadable. Measured, and the reason this
                // check exists: with an unresolvable HEAD, JGit's status reports
                // EVERY tracked file as untracked — nothing is "in HEAD" — so a
                // whole project renders as newly added and no exception is
                // thrown anywhere. Silently claiming a repository lost its
                // history is the worst answer this class could give.
                return GitSnapshot.failed("HEAD is unreadable");
            }

            Status status = git.status().call();
            Map<String, GitMark> marks = new HashMap<>();
            Set<String> others = new TreeSet<>();

            // Least severe first: `worse` keeps the strongest claim about a
            // resource whose files disagree — one file modified and another
            // deleted is a deletion, not an edit.
            collect(status.getUntracked(), GitMark.ADDED, marks, others);
            collect(status.getAdded(), GitMark.ADDED, marks, others);
            collect(status.getModified(), GitMark.MODIFIED, marks, others);
            collect(status.getChanged(), GitMark.MODIFIED, marks, others);
            collect(status.getMissing(), GitMark.DELETED, marks, others);
            collect(status.getRemoved(), GitMark.DELETED, marks, others);
            collect(status.getConflicting(), GitMark.CONFLICTED, marks, others);

            String head = headOf(repository);
            if (head == null) {
                // An unborn branch: `git init` and nothing committed yet. Every
                // file really is new, so the marks are correct — but hundreds of
                // "added" badges say much less than one line saying there is no
                // commit to compare against, so the client is told by `head`
                // being null and renders that instead.
                return new GitSnapshot(true, branch, null,
                    marks, List.copyOf(others), null);
            }
            return new GitSnapshot(true, branch, head, marks, List.copyOf(others), null);
        } catch (Exception e) {
            // Deliberately broad. JGit throws IOException, its own GitAPIException
            // family, and unchecked ones for a corrupt index; the poll loop wants
            // a reason string from all of them, not three catch blocks and a gap.
            return GitSnapshot.failed(reasonFor(e));
        }
    }

    /**
     * Fold changed FILES into changed RESOURCES.
     *
     * <p>A script is two files — {@code code.py} and {@code resource.json} — in
     * one directory, and every project resource is stored the same way. Reporting
     * files would put two marks on one script and name neither of them anything
     * the tree contains, so the file name is dropped and the directory is the
     * resource. Package folders hold no {@code resource.json} of their own, so
     * they fall out as plain ancestors and the client rolls marks up to them.</p>
     */
    private static void collect(Set<String> paths, GitMark mark,
                                Map<String, GitMark> marks, Set<String> others) {
        for (String path : paths) {
            if (!isResourceFile(path)) {
                others.add(path);
                continue;
            }
            String resource = path.substring(0, path.lastIndexOf('/'));
            marks.merge(resource, mark, GitMark::worse);
        }
    }

    /** Branch name, or a short commit id when HEAD is detached. */
    private static String branchOf(Repository repository) throws java.io.IOException {
        String full = repository.getFullBranch();
        if (full == null) {
            return null;
        }
        if (full.startsWith(Constants.R_HEADS)) {
            return full.substring(Constants.R_HEADS.length());
        }
        // Detached HEAD: getFullBranch() hands back the commit id itself.
        try (var reader = repository.newObjectReader()) {
            return reader.abbreviate(ObjectId.fromString(full)).name();
        }
    }

    /**
     * Short HEAD commit id, or null on an unborn branch.
     *
     * <p>A freshly {@code git init}ed project has a branch and no commit. That is
     * not an error and must not read as one — it is the state a project is in for
     * the first few minutes of being version-controlled.</p>
     */
    private static String headOf(Repository repository) throws java.io.IOException {
        ObjectId head = repository.resolve(Constants.HEAD);
        return head == null ? null : head.abbreviate(7).name();
    }

    /** A reason a person can act on, never an empty string. */
    private static String reasonFor(Exception e) {
        String message = e.getMessage();
        return (message == null || message.isBlank())
            ? e.getClass().getSimpleName()
            : e.getClass().getSimpleName() + ": " + message;
    }
}
