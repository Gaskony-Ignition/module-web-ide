package com.gaskony.scriptide.gateway.history;

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
 * Every version this IDE has saved, kept on the gateway, per user.
 *
 * <h2>Why</h2>
 *
 * <p>This module writes straight into a RUNNING gateway through
 * {@code ProjectManager.push}, and nothing anywhere keeps a history of that: not
 * the platform, which stores one current version of a resource; not this module,
 * which had none until 1.15.0; and not git, deliberately — Nigel's decision on
 * 01/09/2026 is that this is not becoming a git module. So until now the answer
 * to "I broke it ten minutes ago" was that there was no answer.</p>
 *
 * <h2>What is kept, and the one non-obvious part</h2>
 *
 * <p>Each save appends the version that was WRITTEN. On the first save of a
 * document — when this store has nothing for it — the version that was there
 * BEFORE the write is recorded first. Without that, the state someone started
 * from is the one state the history cannot return them to, which is exactly the
 * one they want: the first save is usually the one that broke it.</p>
 *
 * <h2>Per user, and only their own</h2>
 *
 * <p>The tree is {@code <data dir>/script-ide-history/<user hash>/<doc hash>/}.
 * A user reads their own history and no one else's, which is a privacy position
 * rather than a security one: the content is project source that every reader of
 * this IDE can already fetch. What it stops is one person's working notes —
 * half-finished edits, an experiment reverted an hour later — being browsable by
 * everybody.</p>
 *
 * <p>Both path segments are HASHES, never the names. A username and a resource
 * path are both attacker-influenced strings that would otherwise become
 * directories: {@code ../} in either is a write outside the data directory, and
 * a case-insensitive filesystem quietly merges two distinct users. Hashing
 * removes the whole class rather than filtering for the shapes we thought of.</p>
 *
 * <h2>Bounded, always</h2>
 *
 * <p>{@link #MAX_VERSIONS} per document and {@link #MAX_BYTES_PER_DOCUMENT}
 * across them, pruned oldest-first on every write. A history that can grow
 * without limit on a gateway's data volume is a disk-full incident with a
 * feature attached, and a 65 KB Web Dev HTML file saved on every keystroke-pause
 * would get there quickly.</p>
 */
public final class SaveHistory {

    private static final Logger logger = LoggerFactory.getLogger(SaveHistory.class);

    /** Versions kept per document, per user. */
    public static final int MAX_VERSIONS = 25;

    /** Total bytes kept per document, per user. */
    public static final long MAX_BYTES_PER_DOCUMENT = 2 * 1024 * 1024L;

    /** A single version is not kept at all above this — it is not a file store. */
    public static final int MAX_SINGLE_VERSION_BYTES = 512 * 1024;

    private static final String ROOT_DIR = "script-ide-history";

    private final Path root;

    public SaveHistory(Path dataDir) {
        this.root = dataDir.resolve(ROOT_DIR);
    }

    /** One kept version. */
    public record Version(String id, long savedAt, long size) {
    }

    /**
     * Record a version.
     *
     * <p>Never throws. A history write that fails must not fail the SAVE that
     * triggered it — the user's work is already on the gateway at that point,
     * and turning a successful save into an error because a side-store could not
     * be written would be the worst possible trade.</p>
     */
    public void record(String user, String project, String path, String key, String source) {
        if (source == null || user == null) {
            return;
        }
        byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_SINGLE_VERSION_BYTES) {
            return;
        }
        try {
            Path dir = directoryFor(user, project, path, key);
            Files.createDirectories(dir);
            // The id is the millisecond, with a counter for the case that two
            // saves land inside the same millisecond — which a replace across
            // the project can do, since it writes files in a tight loop.
            long now = System.currentTimeMillis();
            Path file = dir.resolve(now + ".txt");
            int suffix = 0;
            while (Files.exists(file) && suffix < 1000) {
                suffix += 1;
                file = dir.resolve(now + "-" + suffix + ".txt");
            }
            // Written beside and renamed: a half-written version that a reader
            // could see as a complete one is worse than no version at all.
            Path staged = dir.resolve(file.getFileName() + ".part");
            Files.write(staged, bytes);
            Files.move(staged, file, StandardCopyOption.ATOMIC_MOVE);
            prune(dir);
        } catch (IOException | RuntimeException e) {
            logger.debug("Could not record history for {}: {}", path, e.toString());
        }
    }

    /**
     * Record the version that was on the gateway before this save, but only if
     * this document has no history yet.
     *
     * <p>See the class comment: without this the starting state is the one state
     * the history cannot return you to.</p>
     */
    public void recordBaselineIfEmpty(String user, String project, String path, String key,
                                      String previousSource) {
        if (previousSource == null) {
            return;
        }
        try {
            Path dir = directoryFor(user, project, path, key);
            if (Files.isDirectory(dir) && !list(user, project, path, key).isEmpty()) {
                return;
            }
        } catch (RuntimeException e) {
            return;
        }
        record(user, project, path, key, previousSource);
    }

    /** Every kept version for one document, newest first. */
    public List<Version> list(String user, String project, String path, String key) {
        Path dir;
        try {
            dir = directoryFor(user, project, path, key);
        } catch (RuntimeException e) {
            return List.of();
        }
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        List<Version> out = new ArrayList<>();
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.toList()) {
                // getFileName() is null for a root path. Unreachable from a
                // Files.list of a subdirectory, but SpotBugs is right that
                // nothing here guarantees it, and a null here would take out
                // the whole listing rather than one entry.
                Path fileName = file.getFileName();
                String name = fileName == null ? "" : fileName.toString();
                if (!name.endsWith(".txt")) {
                    continue;           // a .part from an interrupted write
                }
                String id = name.substring(0, name.length() - 4);
                out.add(new Version(id, savedAtOf(id), sizeOf(file)));
            }
        } catch (IOException e) {
            logger.debug("Could not list history for {}: {}", path, e.toString());
            return List.of();
        }
        out.sort(Comparator.comparingLong(Version::savedAt).reversed()
            .thenComparing(Version::id, Comparator.reverseOrder()));
        return List.copyOf(out);
    }

    /** One version's content, or empty when there is no such version. */
    public Optional<String> read(String user, String project, String path, String key, String id) {
        if (!isSafeId(id)) {
            return Optional.empty();
        }
        try {
            Path file = directoryFor(user, project, path, key).resolve(id + ".txt");
            if (!Files.isRegularFile(file)) {
                return Optional.empty();
            }
            return Optional.of(Files.readString(file, StandardCharsets.UTF_8));
        } catch (IOException | RuntimeException e) {
            logger.debug("Could not read history {} for {}: {}", id, path, e.toString());
            return Optional.empty();
        }
    }

    /**
     * An id is a timestamp with an optional counter, and nothing else.
     *
     * <p>The id arrives from a query parameter and is joined to a path, so this
     * is the check that stops {@code ../../config/secrets} being read back as a
     * "version". Digits and one hyphen is the whole grammar the writer emits, so
     * the whole grammar the reader accepts.</p>
     */
    static boolean isSafeId(String id) {
        return id != null && id.matches("\\d{1,19}(-\\d{1,3})?");
    }

    /** Oldest versions first, until both caps are satisfied. */
    private void prune(Path dir) throws IOException {
        List<Path> files;
        try (Stream<Path> stream = Files.list(dir)) {
            files = new ArrayList<>(stream.filter(f -> fileNameOf(f).endsWith(".txt"))
                .toList());
        }
        files.sort(Comparator.comparing(SaveHistory::fileNameOf));
        long total = 0;
        for (Path file : files) {
            total += sizeOf(file);
        }
        int index = 0;
        while (index < files.size()
                && (files.size() - index > MAX_VERSIONS || total > MAX_BYTES_PER_DOCUMENT)) {
            Path oldest = files.get(index);
            total -= sizeOf(oldest);
            Files.deleteIfExists(oldest);
            index += 1;
        }
    }

    /** A path's file name, or empty — see the null note in {@link #list}. */
    private static String fileNameOf(Path file) {
        Path name = file.getFileName();
        return name == null ? "" : name.toString();
    }

    private static long sizeOf(Path file) {
        try {
            return Files.size(file);
        } catch (IOException e) {
            return 0;
        }
    }

    private static long savedAtOf(String id) {
        int hyphen = id.indexOf('-');
        String millis = hyphen < 0 ? id : id.substring(0, hyphen);
        try {
            return Long.parseLong(millis);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private Path directoryFor(String user, String project, String path, String key) {
        return root.resolve(hash(user))
            .resolve(hash(project + " " + path + " " + (key == null ? "" : key)));
    }

    /** SHA-256, hex, first 32 characters — see the class comment on why hashes. */
    private static String hash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] out = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(out).substring(0, 32);
        } catch (NoSuchAlgorithmException e) {
            // SHA-256 is mandated by the JLS for every conforming JVM.
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
