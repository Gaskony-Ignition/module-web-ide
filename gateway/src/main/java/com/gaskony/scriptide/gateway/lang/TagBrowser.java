package com.gaskony.scriptide.gateway.lang;

import java.util.List;

/**
 * What {@link LanguageServer} needs to offer live tag-path completion.
 *
 * <p>A pure interface, deliberately: {@link LanguageServer} depends on this
 * and never on the Ignition SDK's tag types directly, so it stays unit-testable
 * with a fake and all SDK contact stays isolated in {@link SdkTagBrowser}. Both
 * methods are reads over an already-authenticated channel and return NAMES
 * only, never a tag's value.</p>
 */
public interface TagBrowser {

    /** Provider names, without the surrounding brackets — e.g. {@code "default"}. */
    List<String> providers();

    /**
     * One level of the tag tree under {@code path} in {@code provider}.
     *
     * @param path a {@code /}-separated path with no leading slash and no
     *             provider brackets, e.g. {@code "Area1/Line2"}; empty for the
     *             provider root
     */
    List<Child> children(String provider, String path);

    /**
     * One child of a browsed tag-tree level.
     *
     * @param folder   true for anything with children of its own (a plain
     *                 folder, a UDT instance, a UDT definition) — the ONLY
     *                 distinction {@link LanguageServer} needs to decide
     *                 whether a completion inserts a trailing {@code /} or
     *                 completes bare
     * @param dataType the tag's data type, for {@code detail}; {@code null}
     *                 for a folder, which has none
     */
    record Child(String name, boolean folder, String dataType) {
    }
}
