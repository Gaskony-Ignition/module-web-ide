package com.gaskony.scriptide.gateway.lang;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executor;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * A per-key cache with a time-to-live and a hard cap on entries, whose MISS
 * path never runs the loader on the calling thread.
 *
 * <p>Built for {@link SdkTagBrowser} and {@link SdkDbSchema}: both browse a
 * tag provider or read JDBC schema, and both are slow enough that running
 * either inline on the keystroke that asked for a completion would make
 * typing wait on a database or a tag-provider round trip. So a miss — the key
 * is absent, or its entry has expired — schedules {@code loader} on
 * {@code refreshExecutor} and answers {@link Optional#empty()} for THIS call;
 * the request that asked for it gets nothing THAT keystroke, and the entry is
 * there for the next one once the background refresh lands. A key already
 * being refreshed is not queued a second time.</p>
 *
 * <p>{@code clock} and {@code refreshExecutor} are constructor arguments
 * rather than statics so a test can supply a fixed clock and a same-thread
 * executor and assert on loader call counts deterministically — there is no
 * sleep anywhere in this class's own test.</p>
 */
final class TtlCache<V> {

    private static final Logger logger = LoggerFactory.getLogger(TtlCache.class);

    private final long ttlMillis;
    private final LongSupplier clock;
    private final Executor refreshExecutor;

    private static final class Entry<V> {
        final V value;
        final long builtAt;

        Entry(V value, long builtAt) {
            this.value = value;
            this.builtAt = builtAt;
        }
    }

    private final Map<String, Entry<V>> entries;

    /** Keys with a refresh in flight, so a hot key is not loaded twice at once. */
    private final Set<String> refreshing = ConcurrentHashMap.newKeySet();

    /**
     * Keys with a {@link #getOrLoadNow} load in flight. A second caller for the
     * SAME key — two browser tabs opening the same table, or a double-click
     * firing before the first click's request lands — joins the first caller's
     * future instead of issuing a second, redundant blocking load.
     */
    private final ConcurrentMap<String, CompletableFuture<V>> loadingNow = new ConcurrentHashMap<>();

    TtlCache(long ttlMillis, int maxEntries, LongSupplier clock, Executor refreshExecutor) {
        this.ttlMillis = ttlMillis;
        this.clock = clock;
        this.refreshExecutor = refreshExecutor;
        // access-order LinkedHashMap evicts the LEAST RECENTLY USED entry once
        // the cap is exceeded - a project with 100k tags, or a database with
        // hundreds of tables, must not grow this cache without bound.
        this.entries = Collections.synchronizedMap(new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Entry<V>> eldest) {
                return size() > maxEntries;
            }
        });
    }

    /**
     * The cached value for {@code key}, or empty on a miss.
     *
     * <p>A miss — absent or expired — schedules {@code loader} on the refresh
     * executor and returns without waiting for it, so this method never opens
     * a connection or browses a tag provider on the calling thread.</p>
     */
    Optional<V> get(String key, Supplier<V> loader) {
        Entry<V> entry = entries.get(key);
        long now = clock.getAsLong();
        if (entry != null && now - entry.builtAt < ttlMillis) {
            return Optional.of(entry.value);
        }
        if (refreshing.add(key)) {
            refreshExecutor.execute(() -> {
                try {
                    entries.put(key, new Entry<>(loader.get(), clock.getAsLong()));
                } catch (RuntimeException e) {
                    // A completion source that fails must not throw across
                    // threads with nothing to catch it - the cache simply
                    // stays as it was (empty, or the last good value).
                    logger.debug("Background refresh failed for '{}': {}", key, e.toString());
                } finally {
                    refreshing.remove(key);
                }
            });
        }
        return Optional.empty();
    }

    /**
     * Like {@link #get}, but a miss runs {@code loader} ON THIS THREAD and
     * waits for it, returning the real value rather than {@link Optional#empty()}.
     *
     * <p>For a caller that is a deliberate action rather than a keystroke —
     * the Query Browser's "browse this table" is a button click, not
     * autocomplete, and blocking briefly on it is the correct, expected
     * behaviour a completion popup could never afford. Still writes through
     * the SAME entries map as {@link #get}, so a background refresh never
     * races this and a completion lookup that follows sees the warmed
     * entry.</p>
     *
     * <p>Single-flight: a key already being loaded by another caller is not
     * loaded a second time. That second caller JOINS the first one's future and
     * gets the same outcome — success or the same exception re-thrown — rather
     * than starting a redundant blocking round trip against the same table.</p>
     */
    V getOrLoadNow(String key, Supplier<V> loader) {
        Entry<V> entry = entries.get(key);
        long now = clock.getAsLong();
        if (entry != null && now - entry.builtAt < ttlMillis) {
            return entry.value;
        }
        CompletableFuture<V> future = new CompletableFuture<>();
        CompletableFuture<V> inFlight = loadingNow.putIfAbsent(key, future);
        if (inFlight != null) {
            return join(inFlight);
        }
        try {
            V value = loader.get();
            entries.put(key, new Entry<>(value, clock.getAsLong()));
            future.complete(value);
            return value;
        } catch (RuntimeException e) {
            future.completeExceptionally(e);
            throw e;
        } finally {
            loadingNow.remove(key, future);
        }
    }

    /** Drop every entry whose key matches, so the next read loads it again. */
    void invalidateIf(java.util.function.Predicate<String> key) {
        // A synchronizedMap's views are not locked for iteration by themselves.
        synchronized (entries) {
            entries.keySet().removeIf(key);
        }
    }

    private static <V> V join(CompletableFuture<V> future) {
        try {
            return future.join();
        } catch (CompletionException e) {
            if (e.getCause() instanceof RuntimeException re) {
                throw re;
            }
            throw e;
        }
    }
}
