package com.gaskony.scriptide.gateway.history;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The per-user Query Browser run history. */
class QueryHistoryTest {

    @TempDir
    Path dataDir;

    private QueryHistory store() {
        return new QueryHistory(dataDir);
    }

    @Test
    @DisplayName("records a run and reads it back, newest first")
    void recordsAndReads() {
        QueryHistory history = store();
        history.record("nigel", "MyDb", "SELECT 1", true, null, "1 row", 12);
        List<QueryHistory.Entry> entries = history.list("nigel");
        assertThat(entries).hasSize(1);
        QueryHistory.Entry entry = entries.get(0);
        assertThat(entry.datasource()).isEqualTo("MyDb");
        assertThat(entry.sql()).isEqualTo("SELECT 1");
        assertThat(entry.ok()).isTrue();
        assertThat(entry.summary()).isEqualTo("1 row");
        assertThat(entry.error()).isNull();
    }

    @Test
    @DisplayName("a failed run keeps its error")
    void keepsTheError() {
        QueryHistory history = store();
        history.record("nigel", "MyDb", "SELET 1", false, "syntax error", null, 3);
        assertThat(history.list("nigel").get(0).error()).isEqualTo("syntax error");
    }

    @Test
    @DisplayName("one user cannot see another's history")
    void isPerUser() {
        QueryHistory history = store();
        history.record("nigel", "MyDb", "SELECT 1", true, null, "1 row", 1);
        assertThat(history.list("someone-else")).isEmpty();
    }

    @Test
    @DisplayName("beyond the cap, the oldest entries are pruned")
    void prunesOldestFirst() {
        QueryHistory history = store();
        for (int i = 0; i < QueryHistory.MAX_QUERIES + 5; i++) {
            history.record("nigel", "MyDb", "SELECT " + i, true, null, "1 row", 1);
        }
        assertThat(history.list("nigel")).hasSize(QueryHistory.MAX_QUERIES);
    }

    @Test
    @DisplayName("more than 10 runs in the same millisecond are all kept and ordered newest-sequence-first")
    void sameMillisecondWritesAreOrderedNumericallyNotLexically() {
        // A tight loop is fast enough that System.currentTimeMillis() can repeat
        // across many calls — exactly the same-millisecond race the reviewer
        // flagged. 15 crosses the lexical-vs-numeric trap: "...-10" must sort
        // after "...-9", which a plain string comparison gets backwards.
        QueryHistory history = store();
        for (int i = 0; i < 15; i++) {
            history.record("nigel", "MyDb", "SELECT " + i, true, null, "run " + i, 1);
        }
        List<QueryHistory.Entry> entries = history.list("nigel");
        assertThat(entries).hasSize(15);
        // Newest write first: SELECT 14 was recorded last.
        assertThat(entries.get(0).sql()).isEqualTo("SELECT 14");
        assertThat(entries.get(14).sql()).isEqualTo("SELECT 0");
        // Strictly descending order throughout, not just at the two ends.
        for (int i = 0; i < entries.size(); i++) {
            assertThat(entries.get(i).sql()).isEqualTo("SELECT " + (14 - i));
        }
    }
}
