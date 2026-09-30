package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The unknown-name check, run over REAL scripts rather than invented ones.
 *
 * <p>The invented cases in {@link UnknownNamesTest} say what the rule is. This
 * says whether the rule survives contact with the estate's own code, which is
 * the only question that matters for a check whose whole risk is marking
 * working code. Every script in a project on the module rig — the mining and
 * machine demos, Access Manager, Whiteboard — is expected to come back with
 * NOTHING reported, because all of it runs.</p>
 *
 * <p>Opt-in, because the corpus is not in the repo: dump it with the snippet in
 * docs/STATE.md and point {@code SI_REAL_SCRIPTS} at the directory. Without the
 * variable this skips rather than passing vacuously.</p>
 */
@EnabledIfEnvironmentVariable(named = "SI_REAL_SCRIPTS", matches = ".+")
class UnknownNamesRealScriptsTest {

    @Test
    @DisplayName("reports nothing in any script that actually runs on the gateway")
    void findsNoFalsePositivesInRealCode() throws IOException {
        Path dir = Path.of(System.getenv("SI_REAL_SCRIPTS"));
        List<String> complaints = new ArrayList<>();
        int checked = 0;
        // The script-library roots the gateway provides, taken from the dumped
        // file names (`<Project>__ignition_script-python_<Root>_<rest>__...`).
        // Supplied the way the language server supplies them, so this measures
        // what a user actually sees rather than the raw rule.
        java.util.Set<String> roots = new java.util.HashSet<>();
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.toList()) {
                String name = file.getFileName().toString();
                int marker = name.indexOf("ignition_script-python_");
                if (marker < 0) {
                    continue;
                }
                String rest = name.substring(marker + "ignition_script-python_".length());
                int cut = rest.indexOf('_');
                roots.add(cut < 0 ? rest : rest.substring(0, cut));
            }
        }
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.sorted().toList()) {
                if (Files.isDirectory(file)) {
                    continue;
                }
                ModuleSymbols parsed = ModuleSymbols.parse(file.getFileName().toString(),
                    Files.readString(file));
                if (parsed.syntaxError().isPresent()) {
                    continue;       // not this check's business
                }
                checked++;
                for (UnknownNames.Unknown unknown
                        : UnknownNames.withoutProjectNames(parsed.unknownNames(), roots)) {
                    complaints.add(file.getFileName() + ":" + unknown.line()
                        + " " + unknown.name());
                }
            }
        }
        // A corpus that turned out to be empty would make the assertion below
        // pass while proving nothing.
        assertThat(checked).as("scripts parsed from " + dir).isGreaterThan(10);
        assertThat(complaints)
            .as("names reported in code that runs — every one is a false positive")
            .isEmpty();
    }
}
