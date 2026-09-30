package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The platform-API checks against the estate's own scripts.
 *
 * <p>{@link UnknownNamesRealScriptsTest} earned this file's existence: over the
 * same 38 scripts, the first version of that check produced 21 complaints and
 * every one was a false positive. Invented fixtures only contain the cases you
 * already know about, so any check that judges a NAME gets a corpus test before
 * it ships.</p>
 *
 * <p>What can honestly be asserted here is narrower than for unknown names,
 * because the scope rule's answer comes from the live gateway's index rather
 * than from anything in this repo. So this pins the two things that are ours:
 * the walker's output on real code, and the two guards that must hold whatever
 * the index says.</p>
 *
 * <p>Opt-in: dump the corpus and point {@code SI_REAL_SCRIPTS} at it. Without
 * the variable this skips rather than passing vacuously.</p>
 */
@EnabledIfEnvironmentVariable(named = "SI_REAL_SCRIPTS", matches = ".+")
class PlatformApiRealScriptsTest {

    /** Every dotted path the corpus names, with its file, for the assertions below. */
    private record Seen(String file, ApiCalls.Call call) {
    }

    private static List<Seen> corpus() throws IOException {
        Path dir = Path.of(System.getenv("SI_REAL_SCRIPTS"));
        List<Seen> out = new java.util.ArrayList<>();
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.sorted().toList()) {
                if (Files.isDirectory(file)) {
                    continue;
                }
                String source = Files.readString(file);
                for (ApiCalls.Call call : ModuleSymbols.parse("<c>", source).apiCalls()) {
                    out.add(new Seen(file.getFileName().toString(), call));
                }
            }
        }
        return out;
    }

    @Test
    @DisplayName("the walker finds real platform calls, and every path is well formed")
    void extractsWellFormedPaths() throws IOException {
        List<Seen> seen = corpus();
        Set<String> packages = new LinkedHashSet<>();
        for (Seen each : seen) {
            if ("system".equals(each.call().root())) {
                packages.add(each.call().packagePath());
            }
            assertThat(each.call().path())
                .as("path in %s", each.file())
                .matches("[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*");
            assertThat(each.call().line()).as("line in %s", each.file()).isGreaterThan(0);
            assertThat(each.call().column()).as("column in %s", each.file())
                .isGreaterThanOrEqualTo(0);
        }
        // A corpus, not a stub: real Ignition scripts call the platform.
        assertThat(packages).as("distinct system.* packages in the corpus").isNotEmpty();
    }

    @Test
    @DisplayName("reports NOTHING when the index knows everything — it cannot fire on shape")
    void silentWhenEverythingExists() throws IOException {
        PlatformApiChecks.Api knowsAll = new PlatformApiChecks.Api() {
            @Override
            public boolean isDeprecated(String dottedPath) {
                return false;
            }

            @Override
            public boolean exists(String dottedPath) {
                return true;
            }
        };
        for (Seen each : corpus()) {
            assertThat(PlatformApiChecks.find(List.of(each.call()), knowsAll, true))
                .as("finding in %s for %s", each.file(), each.call().path())
                .isEmpty();
        }
    }

    @Test
    @DisplayName("reports NOTHING when the index is empty — a broken index is not a bad project")
    void silentWhenIndexIsEmpty() throws IOException {
        PlatformApiChecks.Api knowsNothing = new PlatformApiChecks.Api() {
            @Override
            public boolean isDeprecated(String dottedPath) {
                return false;
            }

            @Override
            public boolean exists(String dottedPath) {
                return false;
            }
        };
        for (Seen each : corpus()) {
            assertThat(PlatformApiChecks.find(List.of(each.call()), knowsNothing, true))
                .as("finding in %s for %s", each.file(), each.call().path())
                .isEmpty();
        }
    }
}
