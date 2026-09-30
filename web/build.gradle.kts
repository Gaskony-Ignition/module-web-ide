plugins {
    java
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

// Vite writes into build/generated-resources/mounted/ (see vite.config.ts's
// build.outDir) so the output lines up with
// ScriptIdeModuleHook#getMountedResourceFolder() ("mounted").
val projectOutput: String by extra("${layout.buildDirectory.get().asFile}/generated-resources/")

fun isNpmAvailable(): Boolean {
    return try {
        ProcessBuilder("npm", "--version").start().waitFor() == 0
    } catch (e: Exception) {
        false
    }
}

/**
 * Explicit opt-out for a Java-only build: `./gradlew build -PskipWeb`.
 * Read [requireNpm] before using it — the packaged .modl will contain whatever
 * SPA bundle happens to be lying in build/, i.e. a stale one or none at all.
 */
val skipWeb: Boolean = project.hasProperty("skipWeb")

/**
 * Fail loudly when npm/Node is missing.
 *
 * WHY THIS IS NOT `onlyIf { isNpmAvailable() }`: a skipped viteBuild fails
 * nothing. Gradle reports BUILD SUCCESSFUL, :gateway:processResources copies
 * whatever is already in build/generated-resources/, and the .modl ships the
 * PREVIOUS build's JavaScript. A deploy gate that compares the served bundle
 * against the local one then passes too, because both are the stale file — so
 * the whole pipeline reports green while shipping nothing new. This happened on
 * web-designer on 24-25/07/2026. Never restore the silent skip.
 */
fun requireNpm(taskName: String) {
    if (!isNpmAvailable()) {
        throw GradleException(
            "npm/Node is not available, so :web:$taskName cannot run.\n" +
                "Refusing to continue: the packaged .modl would contain a STALE or MISSING " +
                "SPA bundle while the build still reported success.\n" +
                "Fix: install Node.js/npm, or pass -PskipWeb to build the Java side ONLY — " +
                "a -PskipWeb build must never be released."
        )
    }
}

val npmInstall by tasks.registering(Exec::class) {
    group = "build"
    description = "Install npm dependencies"

    workingDir = project.projectDir
    commandLine = if (System.getProperty("os.name").lowercase().contains("windows")) {
        listOf("cmd", "/c", "npm", "install")
    } else {
        listOf("npm", "install")
    }

    inputs.files(
        fileTree(project.projectDir).matching {
            include("**/package.json", "**/package-lock.json")
        }
    )
    outputs.dirs(file("node_modules"))

    onlyIf { !skipWeb && !file("${project.projectDir}/node_modules").exists() }

    doFirst {
        requireNpm("npmInstall")
        logger.lifecycle("Installing npm dependencies...")
    }
}

val viteBuild by tasks.registering(Exec::class) {
    group = "Ignition Module"
    description = "Build the Web IDE SPA with Vite"

    workingDir = project.projectDir
    commandLine = if (System.getProperty("os.name").lowercase().contains("windows")) {
        listOf("cmd", "/c", "npm", "run", "build")
    } else {
        listOf("npm", "run", "build")
    }

    dependsOn(npmInstall)

    inputs.files(project.fileTree(project.projectDir).matching {
        exclude("**/node_modules/**", "**/dist/**", "**/build/**")
    }.toList())
    outputs.dir(projectOutput)

    // No isNpmAvailable() guard here on purpose — see requireNpm.
    onlyIf { !skipWeb }

    doFirst { requireNpm("viteBuild") }
}

val frontendTest by tasks.registering(Exec::class) {
    group = "verification"
    description = "Run Vitest frontend unit tests"

    workingDir = project.projectDir
    commandLine = if (System.getProperty("os.name").lowercase().contains("windows")) {
        listOf("cmd", "/c", "npm", "test")
    } else {
        listOf("npm", "test")
    }

    dependsOn(npmInstall)
    onlyIf { !skipWeb }

    doFirst { requireNpm("frontendTest") }
}

tasks {
    processResources {
        dependsOn(viteBuild, npmInstall)
    }

    // Wired from the FIRST commit, deliberately. On web-designer `frontendTest`
    // was registered but depended on by nothing for 40+ versions, so release
    // builds packaged the frontend without ever running its tests.
    check { dependsOn(frontendTest) }

    clean {
        delete(file("build"))
    }
}

val deepClean by tasks.registering {
    doLast {
        delete(file(".gradle"))
        delete(file("node_modules"))
    }
    dependsOn(project.tasks.named("clean"))
}

// The gateway jar embeds the Vite output, so its processResources must wait.
project(":gateway")?.tasks?.named("processResources")?.configure {
    dependsOn(viteBuild)
}

sourceSets {
    main {
        output.dir(projectOutput, "builtBy" to listOf(viteBuild))
    }
}
