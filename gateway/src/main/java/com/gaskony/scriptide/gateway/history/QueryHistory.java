package com.gaskony.scriptide.gateway.history;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * What this user has RUN in the Query Browser, kept across gateway restarts.
 *
 * <p>A sibling of {@link RunHistory}, not a parameterisation of it: a console
 * run keeps Jython source and captured stdout/stderr, and a query run keeps a
 * datasource and a row/affected summary instead — different enough fields that
 * sharing one file shape would mean every reader (and every hand edit on disk)
 * telling the two kinds of record apart by which fields happen to be present.
 * The storage SHAPE is deliberately identical though: per-user directory hashed
 * off the username, atomic write via a {@code .part} file, prune-on-write. See
 * {@link RunHistory} for why each of those exists.</p>
 */
public final class QueryHistory {

    private static final Logger logger = LoggerFactory.getLogger(QueryHistory.class);
    private static final Gson GSON = new Gson();

    /** Queries kept per user. */
    public static final int MAX_QUERIES = 50;

    /** SQL above this is not kept — the history is not a script store. */
    public static final int MAX_SQL_CHARS = 64 * 1024;

    private static final String ROOT_DIR = "script-ide-queries";

    /**
     * A monotonic per-JVM counter, not a filesystem existence check. Two runs
     * finishing in the SAME millisecond — two browser tabs, or two runs a fast
     * user fires close together — used to race on {@code Files.exists} then
     * both write the "next free" name; on most filesystems {@code ATOMIC_MOVE}
     * still replaces an existing target, so the loser's record silently
     * vanished. A counter has no such window: two threads calling
     * {@code incrementAndGet()} always get two different numbers.
     */
    private static final AtomicLong SEQUENCE = new AtomicLong();

    private final Path root;

    public QueryHistory(Path dataDir) {
        this.root = dataDir.resolve(ROOT_DIR);
    }

    /** One kept query run. {@code summary} is a short human line — "2 rows", "3 affected". */
    public record Entry(String id, long at, String datasource, String sql, boolean ok,
                        String error, String summary, long durationMs) {
    }

    /**
     * Record one finished run. Never throws — the run already happened and the
     * user already has its result on screen, the same reasoning as
     * {@link RunHistory#record}.
     */
    public void record(String user, String datasource, String sql, boolean ok, String error,
                       String summary, long durationMs) {
        if (user == null || user.isBlank() || sql == null || sql.length() > MAX_SQL_CHARS) {
            return;
        }
        try {
            Path dir = root.resolve(hash(user));
            Files.createDirectories(dir);
            long now = System.currentTimeMillis();
            // <millis>-<sequence>: millis keeps the id roughly time-sortable at a
            // glance; the sequence is what actually guarantees uniqueness, and is
            // what list()'s tie-break sorts on numerically for two records
            // stamped in the same millisecond.
            Path file = dir.resolve(now + "-" + SEQUENCE.incrementAndGet() + ".json");
            JsonObject record = new JsonObject();
            record.addProperty("at", now);
            record.addProperty("datasource", datasource == null ? "" : datasource);
            record.addProperty("sql", sql);
            record.addProperty("ok", ok);
            record.addProperty("summary", summary == null ? "" : summary);
            record.addProperty("durationMs", Math.max(0, durationMs));
            if (error != null && !error.isBlank()) {
                record.addProperty("error", error);
            }
            Path staged = dir.resolve(file.getFileName() + ".part");
            Files.writeString(staged, GSON.toJson(record), StandardCharsets.UTF_8);
            Files.move(staged, file, StandardCopyOption.ATOMIC_MOVE);
            prune(dir);
        } catch (IOException | RuntimeException e) {
            logger.debug("Could not record query history: {}", e.toString());
        }
    }

    /** This user's queries, newest first. */
    public List<Entry> list(String user) {
        if (user == null || user.isBlank()) {
            return List.of();
        }
        Path dir;
        try {
            dir = root.resolve(hash(user));
        } catch (RuntimeException e) {
            return List.of();
        }
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        List<Entry> out = new ArrayList<>();
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.toList()) {
                Path name = file.getFileName();
                String fileName = name == null ? "" : name.toString();
                if (!fileName.endsWith(".json")) {
                    continue;
                }
                read(file, fileName.substring(0, fileName.length() - 5)).ifPresent(out::add);
            }
        } catch (IOException e) {
            logger.debug("Could not list query history: {}", e.toString());
            return List.of();
        }
        // The tie-break is the id's trailing SEQUENCE, compared as a number —
        // comparing the id strings lexically would sort "...-10" before
        // "...-9" (the character '1' precedes '9'), the wrong way round for two
        // records stamped in the same millisecond.
        Comparator<Entry> bySequenceDescending =
            Comparator.comparingLong((Entry e) -> sequenceOf(e.id())).reversed();
        out.sort(Comparator.comparingLong(Entry::at).reversed().thenComparing(bySequenceDescending));
        return List.copyOf(out);
    }

    /** The numeric suffix of an id shaped {@code <millis>-<sequence>}, or 0 if absent/unparseable. */
    private static long sequenceOf(String id) {
        int dash = id.lastIndexOf('-');
        if (dash < 0 || dash == id.length() - 1) {
            return 0;
        }
        try {
            return Long.parseLong(id.substring(dash + 1));
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** The leading {@code <millis>} of an id shaped {@code <millis>-<sequence>}. */
    private static long millisOf(String id) {
        int dash = id.indexOf('-');
        String prefix = dash < 0 ? id : id.substring(0, dash);
        try {
            return Long.parseLong(prefix);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /** A record file's id: its filename with the {@code .json} extension stripped. */
    private static String idOf(Path file) {
        Path name = file.getFileName();
        String fileName = name == null ? "" : name.toString();
        return fileName.endsWith(".json") ? fileName.substring(0, fileName.length() - 5) : fileName;
    }

    private static Optional<Entry> read(Path file, String id) {
        try {
            JsonObject record = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8),
                JsonObject.class);
            if (record == null) {
                return Optional.empty();
            }
            return Optional.of(new Entry(
                id,
                record.has("at") ? record.get("at").getAsLong() : 0,
                record.has("datasource") ? record.get("datasource").getAsString() : "",
                record.has("sql") ? record.get("sql").getAsString() : "",
                !record.has("ok") || record.get("ok").getAsBoolean(),
                record.has("error") ? record.get("error").getAsString() : null,
                record.has("summary") ? record.get("summary").getAsString() : "",
                record.has("durationMs") ? record.get("durationMs").getAsLong() : 0));
        } catch (IOException | RuntimeException e) {
            // A half-written or hand-edited record is skipped, not fatal.
            return Optional.empty();
        }
    }

    /** Oldest first, until the cap is satisfied. */
    private void prune(Path dir) throws IOException {
        List<Path> files;
        try (Stream<Path> stream = Files.list(dir)) {
            files = new ArrayList<>(stream
                .filter(f -> {
                    Path n = f.getFileName();
                    return n != null && n.toString().endsWith(".json");
                })
                .toList());
        }
        // Numeric (millis, then sequence), not the filename string — the same
        // lexical-vs-numeric trap list() has: "...-10.json" sorts lexically
        // BEFORE "...-9.json", which would prune a newer record as if it were
        // the oldest.
        files.sort(Comparator.comparingLong((Path f) -> millisOf(idOf(f)))
            .thenComparingLong(f -> sequenceOf(idOf(f))));
        for (int i = 0; i < files.size() - MAX_QUERIES; i++) {
            Files.deleteIfExists(files.get(i));
        }
    }

    /** SHA-256, hex, first 32 characters — see {@link SaveHistory}. */
    private static String hash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of()
                .formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)))
                .substring(0, 32);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
