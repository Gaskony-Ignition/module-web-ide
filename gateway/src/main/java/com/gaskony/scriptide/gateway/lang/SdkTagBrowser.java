package com.gaskony.scriptide.gateway.lang;

import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.tags.browsing.NodeDescription;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.TagProvider;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import com.inductiveautomation.ignition.gateway.tags.model.GatewayTagManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

/**
 * {@link TagBrowser} backed by the real Gateway {@link GatewayTagManager}.
 *
 * <p>Every browse is cached (see {@link TtlCache}) and NEVER run on the
 * thread that asked for a completion — a completion popup re-browses the same
 * folder on nearly every keystroke typed inside it, and {@code browseAsync}
 * is a round trip through the tag provider even when the answer has not
 * changed since the last one, 60 seconds ago.</p>
 *
 * <p>Uses {@link SecurityContext#systemContext()} rather than a caller's own
 * roles/zones: the refresh runs on a background thread with no request or
 * socket behind it by the time it executes, and a completion candidate is a
 * NAME only, never a value — see the equivalent reasoning on {@link DbSchema}.
 * Per-tag security therefore has nothing at stake here that it has at stake
 * on an actual read or write.</p>
 */
public final class SdkTagBrowser implements TagBrowser {

    private static final Logger logger = LoggerFactory.getLogger(SdkTagBrowser.class);

    /** Long enough that typing a tag path does not re-browse per keystroke. */
    private static final long TAG_TTL_MILLIS = 60_000;

    private static final int MAX_CACHE_ENTRIES = 500;

    /** Bound on how many children/providers one completion request offers. */
    private static final int MAX_RESULTS = 500;

    private static final long BROWSE_TIMEOUT_SECONDS = 10;

    private static final String PROVIDERS_KEY = "providers";

    private final GatewayTagManager tagManager;
    private final TtlCache<List<String>> providersCache;
    private final TtlCache<List<Child>> childrenCache;

    public SdkTagBrowser(GatewayTagManager tagManager, Executor refreshExecutor) {
        this.tagManager = tagManager;
        // Cap of 1: there is exactly one providers() answer per gateway.
        this.providersCache = new TtlCache<>(TAG_TTL_MILLIS, 1, System::currentTimeMillis, refreshExecutor);
        this.childrenCache =
            new TtlCache<>(TAG_TTL_MILLIS, MAX_CACHE_ENTRIES, System::currentTimeMillis, refreshExecutor);
    }

    @Override
    public List<String> providers() {
        return providersCache.get(PROVIDERS_KEY, this::loadProviders).orElse(List.of());
    }

    private List<String> loadProviders() {
        List<String> names = new ArrayList<>();
        for (TagProvider provider : tagManager.getTagProviders()) {
            names.add(provider.getName());
        }
        return names;
    }

    @Override
    public List<Child> children(String provider, String path) {
        // "]" as a separator: it is the tag-path syntax's own provider
        // terminator, so it can never appear INSIDE a provider name - two
        // distinct (provider, path) pairs can never collide onto one key.
        String key = provider + "]" + path;
        return childrenCache.get(key, () -> loadChildren(provider, path)).orElse(List.of());
    }

    private List<Child> loadChildren(String provider, String path) {
        TagPath parsed = TagPathParser.parseSafe("[" + provider + "]" + (path == null ? "" : path));
        Results<NodeDescription> results;
        try {
            results = tagManager.browseAsync(parsed, BrowseFilter.NONE, SecurityContext.systemContext())
                .get(BROWSE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (Exception e) {
            // Runs on the background refresh thread - nothing is waiting on
            // this call synchronously, so log and leave the cache as it was
            // rather than letting an exception escape onto a pool thread.
            logger.debug("Tag browse failed for completion, provider='{}' path='{}': {}",
                provider, path, e.toString());
            return List.of();
        }
        Collection<NodeDescription> nodes = results == null ? null : results.getResults();
        if (nodes == null) {
            return List.of();
        }
        List<Child> children = new ArrayList<>();
        for (NodeDescription node : nodes) {
            if (children.size() >= MAX_RESULTS) {
                break;
            }
            String name = node.getName();
            if (name == null || name.isBlank()) {
                continue;
            }
            // hasChildren(), not the object-type enum: a plain Folder, a UDT
            // instance and a UDT definition all browse further and all take a
            // trailing "/" the same way, which is the only distinction the
            // completion actually needs.
            boolean folder = node.hasChildren();
            children.add(new Child(name, folder, folder ? null : String.valueOf(node.getDataType())));
        }
        return children;
    }
}
