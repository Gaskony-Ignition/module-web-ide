package com.gaskony.scriptide.gateway.lang;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Two claims about the platform API a script calls, both answered by the
 * RUNNING gateway rather than by a table.
 *
 * <h2>Deprecated calls</h2>
 *
 * <p>{@code CompletionDescriptor} carries a deprecation for every function the
 * gateway exposes, {@link HintIndex} has read it since 1.0, and until 1.15.0 it
 * was used for exactly two things: sorting a completion down the list, and
 * printing the word "Deprecated." in a hover card. So the IDE knew a script
 * called a deprecated API and would only say so if you happened to hover the
 * call. Code already written was never marked.</p>
 *
 * <h2>Packages that do not exist in this scope</h2>
 *
 * <p>{@code system.gui} and {@code system.nav} do not exist on a Gateway. A
 * timer script calling {@code system.gui.messageBox} is a mistake that shows up
 * only when the timer next fires, in a log nobody is reading, and it is one of
 * the most common mistakes in Ignition scripting.</p>
 *
 * <p>The check is deliberately narrow, and each narrowing removes a class of
 * false positive rather than a class of bug:</p>
 *
 * <ul>
 *   <li><b>Only where the scope is certain.</b> Gateway event scripts and Web
 *       Dev handlers run on the Gateway and nowhere else. A Project Library
 *       script does not: the same module is legitimately imported by Vision
 *       clients and Perspective sessions, where {@code system.gui} is correct.
 *       So library code is never checked, whatever its hint scope says.</li>
 *   <li><b>Only the PACKAGE, never the function.</b> {@code system.gui} absent
 *       from the whole index is a fact. {@code system.tag.readBlokcing} absent
 *       from a package that IS present looks like a typo and usually is — but
 *       the index is built under a time budget with {@code safe()} wrappers, so
 *       a missing leaf can also mean the walk gave up. One is a claim, the other
 *       is a guess.</li>
 *   <li><b>Only under a root the index knows.</b> If {@code system} itself is
 *       missing the index is empty or broken, and every path would be reported.
 *       Silence is the honest answer to a question we cannot answer.</li>
 * </ul>
 *
 * <p>Both findings are warnings, never errors, on the standing rule for this
 * module: a mark on working code costs more than a missed problem.</p>
 */
public final class PlatformApiChecks {

    private PlatformApiChecks() {
    }

    /** What the check needs to know about the gateway's own API registry. */
    public interface Api {

        /** True when this exact dotted path is present AND marked deprecated. */
        boolean isDeprecated(String dottedPath);

        /** True when this dotted path is present in the index at all. */
        boolean exists(String dottedPath);
    }

    /** Why a call was reported. */
    public enum Kind { DEPRECATED, NOT_IN_SCOPE }

    /** One reported call. */
    public record Finding(ApiCalls.Call call, Kind kind, String message) {
    }

    /**
     * The API roots worth judging.
     *
     * <p>{@code system} is the platform's own, and the only root whose absence
     * from the index means something. A project's script-library root looks
     * identical in the AST and is not the platform's to have — reporting
     * {@code MachineDemo.api.read} as "not available" would be
     * {@link UnknownNames}' 21-false-positive mistake in a new place.</p>
     */
    private static final String PLATFORM_ROOT = "system";

    /**
     * Every finding, in source order, at most one per distinct path.
     *
     * @param gatewayScope true only where the document is certain to run on the
     *                     Gateway — see the class comment
     */
    public static List<Finding> find(List<ApiCalls.Call> calls, Api api, boolean gatewayScope) {
        if (calls == null || calls.isEmpty() || api == null) {
            return List.of();
        }
        // The index has to be present and sane before any absence means
        // anything. `system` missing is an empty or half-built index, not a
        // project full of mistakes.
        boolean indexUsable = api.exists(PLATFORM_ROOT);
        List<Finding> out = new ArrayList<>();
        Set<String> reportedPaths = new LinkedHashSet<>();
        Set<String> reportedPackages = new LinkedHashSet<>();

        for (ApiCalls.Call call : calls) {
            if (!PLATFORM_ROOT.equals(call.root())) {
                continue;
            }
            String path = call.path();
            if (path.equals(PLATFORM_ROOT)) {
                continue;               // a bare `system`, passed around
            }
            if (api.isDeprecated(path)) {
                if (reportedPaths.add(path)) {
                    out.add(new Finding(call, Kind.DEPRECATED,
                        "'" + path + "' is deprecated on this gateway. It still runs, "
                            + "but it is scheduled to be removed — check the function's "
                            + "documentation for what replaces it."));
                }
                continue;
            }
            if (!gatewayScope || !indexUsable) {
                continue;
            }
            String pkg = call.packagePath();
            if (pkg.equals(path) && pkg.indexOf('.') < 0) {
                continue;
            }
            if (api.exists(pkg)) {
                continue;
            }
            // One mark per PACKAGE. A script that calls system.gui four times
            // has made one mistake.
            if (reportedPackages.add(pkg)) {
                out.add(new Finding(call, Kind.NOT_IN_SCOPE,
                    "'" + pkg + "' does not exist on the Gateway, and this script runs "
                        + "on the Gateway. It will raise AttributeError when this line "
                        + "runs — there is no error until then."));
            }
        }
        return List.copyOf(out);
    }

    /** The {@link Api} backed by a real {@link HintIndex}. */
    public static Api of(HintIndex index) {
        if (index == null) {
            return new Api() {
                @Override
                public boolean isDeprecated(String dottedPath) {
                    return false;
                }

                @Override
                public boolean exists(String dottedPath) {
                    return false;
                }
            };
        }
        return new Api() {
            @Override
            public boolean isDeprecated(String dottedPath) {
                return index.resolve(dottedPath).map(HintIndex.Entry::deprecated).orElse(false);
            }

            @Override
            public boolean exists(String dottedPath) {
                return index.resolve(dottedPath).isPresent();
            }
        };
    }
}
