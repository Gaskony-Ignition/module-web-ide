package com.gaskony.scriptide.gateway.git;

import java.util.List;
import java.util.Map;

/**
 * What one project's git working tree looked like at one moment.
 *
 * <p>A snapshot always answers, even when the answer is "there is no repository
 * here" or "I could not read it". A status indicator that goes blank on failure
 * is worse than no indicator: a clean tree and an unreadable one look identical,
 * so somebody commits believing nothing changed.</p>
 *
 * @param repo    whether {@code .git} was found at the project root at all
 * @param branch  the current branch, or a short commit id when detached; null when {@code !repo}
 * @param head    short commit id of HEAD, or null on an unborn branch (a repo with no commits)
 * @param marks   resource path (as the tree names it) to its mark
 * @param others  changed files that are not project resources — {@code project.json} and
 *                the like. Counted so the summary is not a lie, never decorated, because
 *                there is no node to put them on.
 * @param error   why this project could not be read, or null. Set with {@code repo} true.
 */
public record GitSnapshot(
    boolean repo,
    String branch,
    String head,
    Map<String, GitMark> marks,
    List<String> others,
    String error) {

    /** No repository at this project. Not an error — most projects are not repos. */
    public static final GitSnapshot NO_REPO =
        new GitSnapshot(false, null, null, Map.of(), List.of(), null);

    public GitSnapshot {
        // COPIED, not wrapped. An unmodifiable view still changes when the map
        // behind it does, and the map behind it belongs to GitProbe's caller —
        // so a snapshot could quietly stop describing the moment it was taken,
        // which is the one thing a snapshot is for.
        marks = marks == null ? Map.of() : Map.copyOf(marks);
        others = others == null ? List.of() : List.copyOf(others);
    }

    /** A repository that is there but could not be read, carrying the reason. */
    public static GitSnapshot failed(String reason) {
        return new GitSnapshot(true, null, null, Map.of(), List.of(), reason);
    }

    /** Resources changed since the last commit. Excludes {@link #others}. */
    public int dirty() {
        return marks.size();
    }

    /** True when the repo was read and nothing has changed. */
    public boolean clean() {
        return repo && error == null && marks.isEmpty() && others.isEmpty();
    }
}
