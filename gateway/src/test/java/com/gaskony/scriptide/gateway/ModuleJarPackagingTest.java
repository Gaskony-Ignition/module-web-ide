package com.gaskony.scriptide.gateway;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIf;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Opens the built {@code .modl} and looks inside it.
 *
 * <p>The estate rule is "verification that actually proves packaging: unzip the
 * built .modl and look — don't infer it from the build file". This automates
 * that. It exists because a plain {@code implementation(...)} dependency
 * compiles fine, appears in the build file, and is then simply absent at
 * runtime; and because the reverse mistake — shipping a library the platform
 * must own — is silent and much worse here than usual:</p>
 *
 * <ul>
 *   <li><b>Jython.</b> Two interpreters on one classpath means two
 *       {@code PySystemState} registries. {@code ScriptManager.interrupt()} would
 *       then walk a {@code _current_frames()} our running script is not in, so the
 *       Stop button would silently stop nothing.</li>
 *   <li><b>Jetty.</b> A second Jetty on the module classpath breaks Gateway
 *       Network.</li>
 *   <li><b>Servlet API / SLF4J.</b> Shipping our own SLF4J risks binding to a NOP
 *       logger and losing every log line this module writes.</li>
 * </ul>
 *
 * <p>Skipped when no {@code .modl} has been built yet, so a bare {@code test} run
 * stays green — but a release build always produces one.</p>
 */
class ModuleJarPackagingTest {

    /** Package prefixes that must NEVER appear in the shipped module. */
    private static final List<String> FORBIDDEN_PREFIXES = List.of(
        "org/python/",
        "org/eclipse/jetty/",
        "jakarta/servlet/",
        "org/slf4j/",
        "com/inductiveautomation/"
    );

    private static Path builtModl() {
        File buildDir = new File("../build");
        File[] candidates = buildDir.listFiles((dir, name) ->
            name.startsWith("WebIDE-") && name.endsWith(".modl") && !name.contains("unsigned"));
        if (candidates == null || candidates.length == 0) {
            // Fall back to the unsigned artefact — packaging content is identical.
            candidates = buildDir.listFiles((dir, name) ->
                name.startsWith("WebIDE-") && name.endsWith(".modl"));
        }
        return (candidates == null || candidates.length == 0) ? null : candidates[0].toPath();
    }

    static boolean modlExists() {
        return builtModl() != null;
    }

    private static List<String> entriesOf(Path modl) throws IOException {
        List<String> names = new ArrayList<>();
        try (ZipFile outer = new ZipFile(modl.toFile())) {
            for (ZipEntry entry : outer.stream().toList()) {
                names.add(entry.getName());
            }
        }
        return names;
    }

    @Test
    @EnabledIf("modlExists")
    @DisplayName("the .modl bundles no library the platform must own")
    void shipsNoBoundaryLibraries() throws IOException {
        Path modl = builtModl();
        List<String> jars = entriesOf(modl).stream().filter(n -> n.endsWith(".jar")).toList();

        assertThat(jars)
            .as("no jars found inside %s — the packaging test would pass vacuously", modl)
            .isNotEmpty();

        Path tmp = Files.createTempDirectory("scriptide-modl-check");
        List<String> offenders = new ArrayList<>();
        try (ZipFile outer = new ZipFile(modl.toFile())) {
            for (String jarName : jars) {
                // The module's OWN jars are the ones under test; a shaded platform
                // class inside a third-party jar we ship would be just as fatal.
                Path extracted = tmp.resolve(jarName.replace('/', '_'));
                try (var in = outer.getInputStream(outer.getEntry(jarName))) {
                    Files.copy(in, extracted);
                }
                try (ZipFile inner = new ZipFile(extracted.toFile())) {
                    for (ZipEntry classEntry : inner.stream().toList()) {
                        String name = classEntry.getName();
                        if (!name.endsWith(".class")) {
                            continue;
                        }
                        for (String forbidden : FORBIDDEN_PREFIXES) {
                            if (name.startsWith(forbidden)) {
                                offenders.add(jarName + " -> " + name);
                            }
                        }
                    }
                }
            }
        }

        assertThat(offenders)
            .as("these classes must be provided by the Gateway at runtime, never shipped. "
                + "A shipped Jython in particular makes the Stop button silently stop nothing.")
            .isEmpty();
    }

    @Test
    @EnabledIf("modlExists")
    @DisplayName("the .modl contains the built SPA, not an empty shell")
    void shipsTheSpaBundle() throws IOException {
        Path modl = builtModl();
        List<String> jars = entriesOf(modl).stream().filter(n -> n.endsWith(".jar")).toList();

        Path tmp = Files.createTempDirectory("scriptide-modl-spa");
        boolean foundIndex = false;
        boolean foundAsset = false;
        try (ZipFile outer = new ZipFile(modl.toFile())) {
            for (String jarName : jars) {
                Path extracted = tmp.resolve(jarName.replace('/', '_'));
                try (var in = outer.getInputStream(outer.getEntry(jarName))) {
                    Files.copy(in, extracted);
                }
                try (ZipFile inner = new ZipFile(extracted.toFile())) {
                    for (ZipEntry e : inner.stream().toList()) {
                        if ("mounted/index.html".equals(e.getName())) {
                            foundIndex = true;
                        }
                        if (e.getName().startsWith("mounted/assets/") && e.getName().endsWith(".js")) {
                            foundAsset = true;
                        }
                    }
                }
            }
        }

        // A .modl that installs cleanly and then serves a blank page is the
        // failure this catches — the exact shape of the stale-bundle incident.
        assertThat(foundIndex).as("mounted/index.html missing from the .modl").isTrue();
        assertThat(foundAsset).as("no hashed mounted/assets/*.js in the .modl").isTrue();
    }

    @Test
    @EnabledIf("modlExists")
    @DisplayName("the .modl bundles both Jython test-harness resources")
    void shipsTestHarnessResources() throws IOException {
        // TestHarness reads these with getResourceAsStream at class-init and fails
        // loudly if either is missing — but only ONCE something actually runs a
        // test. This is the same failure class already recorded for this estate: a
        // green build that ships a .modl missing a file nobody had asserted was in
        // it, caught here instead of by the first user to run a test.
        Path modl = builtModl();
        List<String> jars = entriesOf(modl).stream().filter(n -> n.endsWith(".jar")).toList();

        Path tmp = Files.createTempDirectory("scriptide-modl-testharness");
        boolean foundScriptide = false;
        boolean foundRunner = false;
        boolean foundConsole = false;
        try (ZipFile outer = new ZipFile(modl.toFile())) {
            for (String jarName : jars) {
                Path extracted = tmp.resolve(jarName.replace('/', '_'));
                try (var in = outer.getInputStream(outer.getEntry(jarName))) {
                    Files.copy(in, extracted);
                }
                try (ZipFile inner = new ZipFile(extracted.toFile())) {
                    for (ZipEntry e : inner.stream().toList()) {
                        if ("com/gaskony/scriptide/gateway/testing/scriptide.py".equals(e.getName())) {
                            foundScriptide = true;
                        }
                        if ("com/gaskony/scriptide/gateway/testing/runner.py".equals(e.getName())) {
                            foundRunner = true;
                        }
                        // ConsoleHelpers reads this one the same way, and it is
                        // seeded into every execution namespace.
                        if ("com/gaskony/scriptide/gateway/exec/console.py".equals(e.getName())) {
                            foundConsole = true;
                        }
                    }
                }
            }
        }

        assertThat(foundScriptide).as("scriptide.py missing from the .modl").isTrue();
        assertThat(foundRunner).as("runner.py missing from the .modl").isTrue();
        assertThat(foundConsole).as("console.py missing from the .modl").isTrue();
    }
}
