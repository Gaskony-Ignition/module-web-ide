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
import java.util.stream.Stream;

/**
 * What this user has RUN, kept across gateway restarts.
 *
 * <h2>Why</h2>
 *
 * <p>The Designer's script console forgets everything the moment it closes,
 * which is why people keep scratch scripts in project libraries they never meant
 * to commit — a library module is the only place the Designer offers that
 * survives. This module's console forgot everything too: {@code ExecAudit}
 * records that an execution happened, and deliberately stores a SHA-256 of the
 * source rather than the source itself, because an audit table is not a code
 * store. So nothing anywhere could answer "what did I run twenty minutes ago".</p>
 *
 * <h2>Per user, and bounded, for the same reasons as {@link SaveHistory}</h2>
 *
 * <p>Same tree shape, same hashing of the username, same prune-on-write. The one
 * difference is what a run is: source, the output it produced, and how it ended,
 * as a single JSON document — so re-running one needs no reassembly, and reading
 * one back does not depend on the console still being open.</p>
 *
 * <p>Output is TRUNCATED and the record says so. A script that prints a
 * megabyte is a legitimate thing to run and an illegitimate thing to keep fifty
 * copies of on a gateway's data volume.</p>
 */
public final class RunHistory {

    private static final Logger logger = LoggerFactory.getLogger(RunHistory.class);
    private static final Gson GSON = new Gson();

    /** Runs kept per user. */
    public static final int MAX_RUNS = 50;

    /** Source above this is not kept — the console is not a file store. */
    public static final int MAX_SOURCE_CHARS = 64 * 1024;

    /** Output above this is truncated, and the record says it was. */
    public static final int MAX_OUTPUT_CHARS = 16 * 1024;

    private static final String ROOT_DIR = "script-ide-runs";

    private final Path root;

    public RunHistory(Path dataDir) {
        this.root = dataDir.resolve(ROOT_DIR);
    }

    /**
     * One kept execution.
     *
     * <p>{@code durationMs} is WALL time from the run being dispatched to its
     * finished frame — the same span the console's own clock shows, not the
     * interpreter's CPU time. A run that spent nine of its ten seconds blocked on
     * a database is ten seconds to the person who waited for it, and that is the
     * number worth keeping. Zero means a record written before 1.23.0, which had
     * no duration: shown as blank rather than as an implausibly fast run.</p>
     */
    public record Run(String id, long at, String project, String source, String output,
                      boolean ok, String error, boolean outputTruncated, long durationMs) {
    }

    /**
     * Record one finished execution.
     *
     * <p>Never throws, for the same reason {@link SaveHistory#record} does not:
     * the run already happened and the user already has its output on screen.
     * Failing the console because a side store could not be written would be the
     * worst possible trade.</p>
     */
    public void record(String user, String project, String source, String output,
                       boolean ok, String error, long durationMs) {
        if (user == null || user.isBlank() || source == null) {
            return;
        }
        if (source.length() > MAX_SOURCE_CHARS) {
            return;
        }
        String kept = output == null ? "" : output;
        boolean truncated = kept.length() > MAX_OUTPUT_CHARS;
        if (truncated) {
            kept = kept.substring(0, MAX_OUTPUT_CHARS);
        }
        try {
            Path dir = root.resolve(hash(user));
            Files.createDirectories(dir);
            long now = System.currentTimeMillis();
            Path file = dir.resolve(now + ".json");
            int suffix = 0;
            while (Files.exists(file) && suffix < 1000) {
                suffix += 1;
                file = dir.resolve(now + "-" + suffix + ".json");
            }
            JsonObject record = new JsonObject();
            record.addProperty("at", now);
            record.addProperty("project", project == null ? "" : project);
            record.addProperty("source", source);
            record.addProperty("output", kept);
            record.addProperty("ok", ok);
            record.addProperty("outputTruncated", truncated);
            record.addProperty("durationMs", Math.max(0, durationMs));
            if (error != null && !error.isBlank()) {
                record.addProperty("error", error);
            }
            Path staged = dir.resolve(file.getFileName() + ".part");
            Files.writeString(staged, GSON.toJson(record), StandardCharsets.UTF_8);
            Files.move(staged, file, StandardCopyOption.ATOMIC_MOVE);
            prune(dir);
        } catch (IOException | RuntimeException e) {
            logger.debug("Could not record run history: {}", e.toString());
        }
    }

    /** This user's runs, newest first. */
    public List<Run> list(String user) {
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
        List<Run> out = new ArrayList<>();
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
            logger.debug("Could not list run history: {}", e.toString());
            return List.of();
        }
        out.sort(Comparator.comparingLong(Run::at).reversed()
            .thenComparing(Run::id, Comparator.reverseOrder()));
        return List.copyOf(out);
    }

    private static Optional<Run> read(Path file, String id) {
        try {
            JsonObject record = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8),
                JsonObject.class);
            if (record == null) {
                return Optional.empty();
            }
            return Optional.of(new Run(
                id,
                record.has("at") ? record.get("at").getAsLong() : 0,
                record.has("project") ? record.get("project").getAsString() : "",
                record.has("source") ? record.get("source").getAsString() : "",
                record.has("output") ? record.get("output").getAsString() : "",
                !record.has("ok") || record.get("ok").getAsBoolean(),
                record.has("error") ? record.get("error").getAsString() : null,
                record.has("outputTruncated") && record.get("outputTruncated").getAsBoolean(),
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
        files.sort(Comparator.comparing(f -> {
            Path n = f.getFileName();
            return n == null ? "" : n.toString();
        }));
        for (int i = 0; i < files.size() - MAX_RUNS; i++) {
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
