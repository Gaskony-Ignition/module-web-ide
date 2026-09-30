package com.gaskony.scriptide.gateway.git;

/**
 * What git says has happened to one resource since the last commit.
 *
 * <p>Ordered by severity, most severe first, because a package's mark is the
 * worst of its children's: a folder holding one conflicted script and forty
 * clean ones must not read as clean. {@link #worse} is the whole reason this is
 * an enum rather than a string.</p>
 *
 * <p>Deliberately fewer states than git has. Staged-versus-unstaged is a
 * distinction you act on, and this module does not stage — it reports. Merging
 * both into one mark keeps the tree honest about what it can offer.</p>
 */
public enum GitMark {
    /** Both sides changed; the working tree holds conflict markers. */
    CONFLICTED("conflicted"),
    /** Tracked, and gone from the working tree. */
    DELETED("deleted"),
    /** Tracked, and different from HEAD. */
    MODIFIED("modified"),
    /** Not in HEAD — newly added, staged or not. */
    ADDED("added");

    private final String wire;

    GitMark(String wire) {
        this.wire = wire;
    }

    /** The lowercase name the API and the UI use. */
    public String wire() {
        return wire;
    }

    /**
     * The more severe of two marks, for rolling children up into a package.
     *
     * <p>Null-tolerant on both sides: a package with one marked child and one
     * unmarked child takes the mark, which is the point.</p>
     */
    public static GitMark worse(GitMark a, GitMark b) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        return a.ordinal() <= b.ordinal() ? a : b;
    }
}
