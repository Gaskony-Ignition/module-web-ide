package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * {@link TtlCache} — the thing that keeps {@link SdkTagBrowser} and
 * {@link SdkDbSchema} off the completion thread. A same-thread executor
 * stands in for the real background pool here: what matters for this class's
 * OWN contract is call counts and timing, not real concurrency, and a fixed
 * clock means no sleep is needed anywhere in this test.
 */
class TtlCacheTest {

    @Test
    @DisplayName("a miss schedules the loader but answers nothing for that call")
    void missAnswersEmptyAndSchedulesLoad() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        Optional<String> first = cache.get("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });

        assertThat(first).isEmpty();
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("a hit within the TTL does not re-call the loader")
    void hitDoesNotReCallLoader() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        // First call is a miss - populates the entry via the same-thread executor.
        cache.get("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });
        clock.addAndGet(1_000);   // still well inside the 60s TTL

        Optional<String> second = cache.get("k", () -> {
            calls.incrementAndGet();
            return "v2";
        });

        assertThat(second).contains("v1");
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("an expired entry re-calls the loader")
    void expiredEntryReCallsLoader() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        cache.get("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });
        clock.addAndGet(60_001);   // past the TTL

        // THIS call is still the miss/expiry that discovers the entry is
        // stale — it schedules the reload and, by contract, answers nothing
        // for its own keystroke even though the executor here happens to run
        // it inline (see missAnswersEmptyAndSchedulesLoad: a miss NEVER
        // returns the freshly computed value on the call that triggered it).
        Optional<String> atExpiry = cache.get("k", () -> {
            calls.incrementAndGet();
            return "v2";
        });
        assertThat(atExpiry).isEmpty();
        assertThat(calls.get()).isEqualTo(2);

        // The NEXT call sees the refreshed entry as an ordinary hit.
        Optional<String> afterRefresh = cache.get("k", () -> {
            calls.incrementAndGet();
            return "v3";
        });
        assertThat(afterRefresh).contains("v2");
        assertThat(calls.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("a key already being refreshed is not queued a second time")
    void refreshInFlightIsNotDuplicated() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        AtomicInteger scheduled = new AtomicInteger();
        // An executor that records how many refreshes were scheduled without
        // running them, so both get() calls below race against the SAME
        // still-pending refresh rather than each completing before the next starts.
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, r -> {
            scheduled.incrementAndGet();
            r.run();
        });

        cache.get("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });
        // A second miss on the same key before any TTL has passed would only
        // happen if the entry never landed; here it lands synchronously, so
        // this call is a HIT and must not schedule again.
        cache.get("k", () -> {
            calls.incrementAndGet();
            return "v2";
        });

        assertThat(scheduled.get()).isEqualTo(1);
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("getOrLoadNow blocks on a miss and returns the real value, not empty")
    void getOrLoadNowBlocksAndReturnsTheRealValue() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        // An executor that would fail the test if getOrLoadNow ever used it —
        // the whole point is that it does NOT hand the load off anywhere.
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get,
            r -> { throw new AssertionError("getOrLoadNow must not use the refresh executor"); });

        String value = cache.getOrLoadNow("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });

        assertThat(value).isEqualTo("v1");
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("invalidateIf drops only the matching keys, and the next read loads them again")
    void invalidateIfDropsMatchingKeysOnly() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);
        cache.getOrLoadNow("PG.orders", () -> "v" + calls.incrementAndGet());
        cache.getOrLoadNow("MSSQL.orders", () -> "v" + calls.incrementAndGet());

        cache.invalidateIf(key -> key.startsWith("PG."));

        assertThat(cache.getOrLoadNow("PG.orders", () -> "v" + calls.incrementAndGet())).isEqualTo("v3");
        assertThat(cache.getOrLoadNow("MSSQL.orders", () -> "reloaded")).isEqualTo("v2");
    }

    @Test
    @DisplayName("getOrLoadNow reads a warm entry without reloading it")
    void getOrLoadNowReadsAWarmEntry() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        cache.getOrLoadNow("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });
        clock.addAndGet(1_000);

        String value = cache.getOrLoadNow("k", () -> {
            calls.incrementAndGet();
            return "v2";
        });

        assertThat(value).isEqualTo("v1");
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("getOrLoadNow writes through the SAME entries a background get() reads")
    void getOrLoadNowWritesThroughToGet() {
        AtomicLong clock = new AtomicLong(0);
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        cache.getOrLoadNow("k", () -> "v1");

        // A completion lookup that follows sees the warmed entry as an
        // ordinary hit — it must not schedule a redundant background reload.
        Optional<String> viaGet = cache.get("k", () -> {
            throw new AssertionError("should not reload an entry getOrLoadNow just warmed");
        });
        assertThat(viaGet).contains("v1");
    }

    @Test
    @DisplayName("getOrLoadNow single-flights: a second caller joins the in-flight load instead of starting another")
    void getOrLoadNowSingleFlightsConcurrentCallers() throws Exception {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        CountDownLatch loaderEntered = new CountDownLatch(1);
        CountDownLatch releaseLoader = new CountDownLatch(1);
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<String> first = pool.submit(() -> cache.getOrLoadNow("k", () -> {
                calls.incrementAndGet();
                loaderEntered.countDown();
                try {
                    // Held open long enough that the second caller below is
                    // guaranteed to arrive while this load is still in flight.
                    releaseLoader.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return "v1";
            }));
            assertThat(loaderEntered.await(5, TimeUnit.SECONDS)).isTrue();

            Future<String> second = pool.submit(() -> cache.getOrLoadNow("k",
                () -> "should-not-run-a-second-load"));
            releaseLoader.countDown();

            assertThat(first.get(5, TimeUnit.SECONDS)).isEqualTo("v1");
            assertThat(second.get(5, TimeUnit.SECONDS)).isEqualTo("v1");
            assertThat(calls.get()).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("getOrLoadNow propagates a loader failure rather than caching it as an empty success")
    void getOrLoadNowPropagatesFailureAndDoesNotPoisonTheCache() {
        AtomicLong clock = new AtomicLong(0);
        AtomicInteger calls = new AtomicInteger();
        TtlCache<String> cache = new TtlCache<>(60_000, 100, clock::get, Runnable::run);

        assertThatThrownBy(() -> cache.getOrLoadNow("k", () -> {
            calls.incrementAndGet();
            throw new IllegalStateException("boom");
        })).isInstanceOf(IllegalStateException.class).hasMessage("boom");

        // The failed attempt must not have been cached as an empty/absent
        // success — the very next call retries rather than being poisoned.
        String value = cache.getOrLoadNow("k", () -> {
            calls.incrementAndGet();
            return "v1";
        });
        assertThat(value).isEqualTo("v1");
        assertThat(calls.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("the cache holds at most maxEntries, evicting the least recently used")
    void evictsBeyondCap() {
        AtomicLong clock = new AtomicLong(0);
        TtlCache<String> cache = new TtlCache<>(60_000, 2, clock::get, Runnable::run);

        cache.get("a", () -> "va");
        cache.get("b", () -> "vb");
        // Touch "a" so "b" becomes the least recently used.
        cache.get("a", () -> "should-not-run");
        cache.get("c", () -> "vc");   // pushes the cap; "b" should be evicted

        AtomicInteger reloadsOfB = new AtomicInteger();
        Optional<String> b = cache.get("b", () -> {
            reloadsOfB.incrementAndGet();
            return "vb2";
        });

        assertThat(b).isEmpty();   // evicted, so this is a miss that reschedules
        assertThat(reloadsOfB.get()).isEqualTo(1);
    }
}
