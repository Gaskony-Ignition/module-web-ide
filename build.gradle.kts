plugins {
    base
    id("io.ia.sdk.modl") version "0.5.0"
    id("com.github.spotbugs") version "6.4.8" apply false
    id("org.owasp.dependencycheck") version "12.2.0" apply false
}

// ── OWASP Dependency Check ──────────────────────────────────────────────────
apply(plugin = "org.owasp.dependencycheck")
configure<org.owasp.dependencycheck.gradle.extension.DependencyCheckExtension> {
    failBuildOnCVSS = 7.0f
    formats = listOf("HTML", "JSON")
    analyzers.assemblyEnabled = false
}

version = "1.29.1"
group = "com.gaskony"

allprojects {
    version = rootProject.version
    group = "com.gaskony"
}

ignitionModule {
    fileName.set("WebIDE-${project.version}")
    name.set("Web IDE")
    id.set("com.gaskony.scriptide")
    moduleVersion.set(project.version.toString())
    moduleDescription.set(
        "A browser-based Jython IDE for Ignition, served straight from the Gateway: " +
            "edit Project Library and Gateway event scripts with completions taken from the " +
            "running gateway, live error checking, project-wide navigation, and a script " +
            "console that runs on the Gateway."
    )
    requiredIgnitionVersion.set("8.3.0")
    freeModule.set(true)

    // Gateway-scope only — the IDE is a standalone browser SPA, not a Designer
    // workspace, so no ":designer" project or scope exists.
    projectScopes.putAll(mapOf(
        ":gateway" to "G",
        ":common" to "GD"
    ))

    hooks.putAll(mapOf(
        "com.gaskony.scriptide.gateway.ScriptIdeModuleHook" to "G"
    ))

    // Auto-skips signing when the keystore is absent (e.g. a contributor build).
    // Set ignition.signing.keystoreFile in gradle.properties to sign locally.
    val keystoreFilePath = (findProperty("ignition.signing.keystoreFile") as? String) ?: ""
    skipModlSigning.set(keystoreFilePath.isBlank() || !file(keystoreFilePath).exists())
}

// ── Static analysis ──────────────────────────────────────────────────────────
subprojects {
    plugins.withType<JavaPlugin> {
        apply(plugin = "checkstyle")
        apply(plugin = "com.github.spotbugs")

        configure<CheckstyleExtension> {
            toolVersion = "10.26.1"
            configFile = rootProject.file("config/checkstyle/checkstyle.xml")
            isIgnoreFailures = true
        }

        configure<com.github.spotbugs.snom.SpotBugsExtension> {
            ignoreFailures.set(false)
            effort.set(com.github.spotbugs.snom.Effort.MAX)
            reportLevel.set(com.github.spotbugs.snom.Confidence.MEDIUM)
            excludeFilter.set(rootProject.file("config/spotbugs/exclude.xml"))
        }

        tasks.matching { it.name == "spotbugsTest" }.configureEach {
            enabled = false
        }
    }
}

// ── Version sync ─────────────────────────────────────────────────────────────
tasks.register("syncVersion") {
    group = "versioning"
    description = "Syncs project.version to every file that embeds it"
    doLast {
        val ver = project.version.toString()
        fun sync(f: File, pattern: Regex, replacement: String) {
            if (!f.exists()) return
            val text = f.readText()
            val updated = text.replace(pattern, replacement)
            if (updated != text) { f.writeText(updated); logger.lifecycle("  synced ${f.name} -> $ver") }
        }
        sync(file("README.md"),
            Regex("""(?m)^\*\*Version\*\*:\s*[\d.]+"""), "**Version**: $ver")
        sync(file("README.md"),
            Regex("""WebIDE-[\d.]+\.modl"""), "WebIDE-$ver.modl")
        sync(file("CLAUDE.md"),
            Regex("""(?m)^\*\*Version\*\*:\s*[\d.]+"""), "**Version**: $ver")
        sync(file("CLAUDE.md"),
            Regex("""WebIDE-[\d.]+\.modl"""), "WebIDE-$ver.modl")
        sync(file("web/package.json"),
            Regex(""""version":\s*"[\d.]+""""), "\"version\": \"$ver\"")
        logger.lifecycle("syncVersion: all files set to $ver")
    }
}

tasks.named("assembleModlStructure") {
    dependsOn("syncVersion")
}
