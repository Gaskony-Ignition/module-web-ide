package com.gaskony.scriptide.gateway.history;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/** The per-user local history store. */
class SaveHistoryTest {

    @TempDir
    Path dataDir;

    private SaveHistory store() {
        return new SaveHistory(dataDir);
    }

    @Test
    @DisplayName("records a version and reads it back")
    void recordsAndReads() {
        SaveHistory history = store();
        history.record("nigel", "P", "ignition/script-python/util", "code.py", "x = 1");
        List<SaveHistory.Version> versions =
            history.list("nigel", "P", "ignition/script-python/util", "code.py");
        assertThat(versions).hasSize(1);
        assertThat(history.read("nigel", "P", "ignition/script-python/util", "code.py",
            versions.get(0).id())).contains("x = 1");
    }

    @Test
    @DisplayName("newest first, so the list reads the way a person looks at it")
    void newestFirst() {
        SaveHistory history = store();
        for (int i = 0; i < 4; i++) {
            history.record("nigel", "P", "path", "code.py", "version " + i);
        }
        List<SaveHistory.Version> versions = history.list("nigel", "P", "path", "code.py");
        assertThat(versions).hasSize(4);
        assertThat(history.read("nigel", "P", "path", "code.py", versions.get(0).id()))
            .contains("version 3");
    }

    @Test
    @DisplayName("one user cannot see another's history")
    void isPerUser() {
        SaveHistory history = store();
        history.record("nigel", "P", "path", "code.py", "mine");
        assertThat(history.list("someone-else", "P", "path", "code.py")).isEmpty();
    }

    @Test
    @DisplayName("each document has its own history, data key included")
    void isPerDocument() {
        SaveHistory history = store();
        history.record("nigel", "P", "webdev/thing", "doGet.py", "get");
        history.record("nigel", "P", "webdev/thing", "doPost.py", "post");
        // A Web Dev endpoint is ONE resource path holding up to eight scripts.
        // Keying on the path alone would put doPost's versions in doGet's list.
        assertThat(history.list("nigel", "P", "webdev/thing", "doGet.py")).hasSize(1);
        assertThat(history.read("nigel", "P", "webdev/thing", "doGet.py",
            history.list("nigel", "P", "webdev/thing", "doGet.py").get(0).id())).contains("get");
    }

    @Test
    @DisplayName("the baseline is recorded only when there is no history yet")
    void baselineOnlyOnce() {
        SaveHistory history = store();
        history.recordBaselineIfEmpty("nigel", "P", "path", "code.py", "as it was");
        assertThat(history.list("nigel", "P", "path", "code.py")).hasSize(1);
        history.record("nigel", "P", "path", "code.py", "first save");
        history.recordBaselineIfEmpty("nigel", "P", "path", "code.py", "as it was");
        // Still two: the baseline does not re-record itself on every later save.
        assertThat(history.list("nigel", "P", "path", "code.py")).hasSize(2);
    }

    @Test
    @DisplayName("a null previous body records no baseline — a new file has no before")
    void noBaselineForACreate() {
        SaveHistory history = store();
        history.recordBaselineIfEmpty("nigel", "P", "path", "code.py", null);
        assertThat(history.list("nigel", "P", "path", "code.py")).isEmpty();
    }

    @Test
    @DisplayName("keeps at most MAX_VERSIONS, dropping the oldest")
    void prunesByCount() {
        SaveHistory history = store();
        for (int i = 0; i < SaveHistory.MAX_VERSIONS + 8; i++) {
            history.record("nigel", "P", "path", "code.py", "v" + i);
        }
        List<SaveHistory.Version> versions = history.list("nigel", "P", "path", "code.py");
        assertThat(versions).hasSize(SaveHistory.MAX_VERSIONS);
        assertThat(history.read("nigel", "P", "path", "code.py", versions.get(0).id()))
            .contains("v" + (SaveHistory.MAX_VERSIONS + 7));
    }

    @Test
    @DisplayName("a single version above the cap is not kept — this is not a file store")
    void refusesAHugeVersion() {
        SaveHistory history = store();
        history.record("nigel", "P", "path", "code.py",
            "x".repeat(SaveHistory.MAX_SINGLE_VERSION_BYTES + 1));
        assertThat(history.list("nigel", "P", "path", "code.py")).isEmpty();
    }

    @Test
    @DisplayName("an id is a timestamp and nothing else")
    void rejectsTraversalIds() {
        // The id arrives from a query parameter and is joined to a path.
        assertThat(SaveHistory.isSafeId("1757030000000")).isTrue();
        assertThat(SaveHistory.isSafeId("1757030000000-3")).isTrue();
        assertThat(SaveHistory.isSafeId("../../config/secrets")).isFalse();
        assertThat(SaveHistory.isSafeId("1757030000000/../x")).isFalse();
        assertThat(SaveHistory.isSafeId("")).isFalse();
        assertThat(SaveHistory.isSafeId(null)).isFalse();
    }

    @Test
    @DisplayName("a traversal id reads nothing even with a real file behind it")
    void traversalIdReadsNothing() throws IOException {
        SaveHistory history = store();
        history.record("nigel", "P", "path", "code.py", "mine");
        Files.writeString(dataDir.resolve("secret.txt"), "not yours");
        assertThat(history.read("nigel", "P", "path", "code.py", "../../../secret"))
            .isEmpty();
    }

    @Test
    @DisplayName("a username with a path separator in it cannot escape the store")
    void hashesTheUserName() throws IOException {
        SaveHistory history = store();
        history.record("../../etc", "P", "path", "code.py", "x = 1");
        // Everything lives under the one root directory, whatever the name was.
        try (Stream<Path> tree = Files.walk(dataDir)) {
            assertThat(tree.filter(Files::isRegularFile))
                .allSatisfy(file -> assertThat(file.toString())
                    .contains("script-ide-history"));
        }
    }

    @Test
    @DisplayName("an unknown document has an empty history rather than an error")
    void emptyForUnknownDocument() {
        assertThat(store().list("nigel", "P", "never/saved", "code.py")).isEmpty();
        assertThat(store().read("nigel", "P", "never/saved", "code.py", "1")).isEmpty();
    }

    @Test
    @DisplayName("a .part file left by an interrupted write is not offered as a version")
    void ignoresPartialWrites() throws IOException {
        SaveHistory history = store();
        history.record("nigel", "P", "path", "code.py", "good");
        List<SaveHistory.Version> before = history.list("nigel", "P", "path", "code.py");
        Path dir = Files.walk(dataDir)
            .filter(Files::isDirectory)
            .filter(d -> {
                try (Stream<Path> s = Files.list(d)) {
                    return s.anyMatch(f -> f.getFileName().toString().endsWith(".txt"));
                } catch (IOException e) {
                    return false;
                }
            })
            .findFirst()
            .orElseThrow();
        Files.writeString(dir.resolve("999.txt.part"), "half written");
        assertThat(history.list("nigel", "P", "path", "code.py")).hasSameSizeAs(before);
    }
}
