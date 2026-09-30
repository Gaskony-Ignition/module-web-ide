plugins {
    `java-library`
    jacoco
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

dependencies {
    implementation(projects.common)

    compileOnly(libs.ignition.common)
    compileOnly(libs.ignition.gateway.api)
    compileOnly(libs.jakarta.servlet)

    // Guava, only for CommonContext.getEventBus(). compileOnly and pinned to the
    // platform's own copy — see the note in gradle/libs.versions.toml.
    compileOnly(libs.guava)

    // Jetty-12 WebSocket API for the LSP/exec socket. compileOnly — the Gateway
    // provides Jetty at runtime; a second Jetty on the module classpath breaks GAN.
    compileOnly(libs.jetty.ee10.websocket.server)
    compileOnly(libs.jetty.websocket.api)

    // Jython. compileOnly ONLY — see the long note in gradle/libs.versions.toml.
    // Shipping a second interpreter would give the JVM two PySystemState
    // registries, and ScriptManager.interrupt() would then look at frames our
    // running script is not in, so Stop would silently stop nothing.
    // ModuleJarPackagingTest asserts no org/python/ classes reach the .modl.
    compileOnly(libs.jython)

    // JSON. Shipped at latest stable via modlImplementation rather than bound to
    // the gateway's bundled gson-2.8.9. Verified 30/07/2026 for this estate that
    // no Gson type crosses an SDK boundary in either direction: the SDK jars
    // contain zero com/google/gson references (IA use a shaded fork), and the
    // default dataroutes ResponseRenderer is Object::toString, so a returned
    // JsonObject is serialised by calling toString() on it — classloader-agnostic.
    modlImplementation(libs.gson)

    // JGit, read-only. The gateway bundles none and the rig's image has no
    // `git` binary, so a status indicator has to read .git in pure Java.
    //
    // slf4j is EXCLUDED, not merely absent: JGit depends on it, and shipping a
    // second copy of a logging facade the Gateway already owns is exactly what
    // ModuleJarPackagingTest exists to refuse. JGit binds to the platform's own
    // slf4j at runtime, which is what puts its warnings in the gateway log
    // rather than nowhere.
    // slf4j is excluded, not merely absent: JGit depends on slf4j-api 1.7.36
    // and would ship it, which ModuleJarPackagingTest refuses — the Gateway owns
    // the logging facade, and a second copy on a module classloader is the same
    // class of fault as a second Jython. The exclusion is on the DEPENDENCY, not
    // the configuration: modlImplementation feeds the compile classpath too, and
    // excluding there took slf4j away from this module's own loggers.
    modlImplementation(libs.jgit) {
        exclude(group = "org.slf4j")
    }

    // The Vite SPA bundle.
    modlImplementation(projects.web)

    // Ignition/servlet/Jetty/Jython types are compileOnly for the shipped module
    // but must be on the TEST classpath directly, since JUnit runs outside a Gateway.
    testImplementation(libs.ignition.common)
    testImplementation(libs.ignition.gateway.api)
    testImplementation(libs.jakarta.servlet)
    testImplementation(libs.guava)
    testImplementation(libs.jetty.ee10.websocket.server)
    testImplementation(libs.jetty.websocket.api)
    testImplementation(libs.jython)
    testImplementation(libs.gson)
    testImplementation(libs.jgit)

    testImplementation(libs.junit.jupiter.api)
    testImplementation(libs.junit.jupiter.params)
    testRuntimeOnly(libs.junit.jupiter.engine)
    testRuntimeOnly(libs.junit.platform.launcher)

    testImplementation(libs.mockito.core)
    testImplementation(libs.mockito.junit.jupiter)
    testImplementation(libs.assertj.core)

    testImplementation(libs.slf4j.api)
    testRuntimeOnly(libs.slf4j.simple)
}

// Pull the Vite build output (build/generated-resources/mounted/**) onto the
// gateway jar's classpath, so it is served both via getMountedResourceFolder()
// at /res/scriptide/* and by SpaAssetRouteHandler's classpath lookup.
sourceSets {
    main {
        resources {
            srcDir(project(":web").layout.buildDirectory.dir("generated-resources"))
        }
    }
}

tasks.test {
    useJUnitPlatform()
    // Fail hung tests fast rather than spinning the executor indefinitely —
    // this module runs user-supplied code, so a runaway test is a real risk.
    systemProperty("junit.jupiter.execution.timeout.default", "60 s")
    testLogging {
        events("passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStandardStreams = false
    }
    finalizedBy(tasks.jacocoTestReport)
}

jacoco {
    toolVersion = "0.8.11"
}

tasks.jacocoTestReport {
    dependsOn(tasks.test)
    reports {
        xml.required.set(true)
        html.required.set(true)
        csv.required.set(false)
    }
}

// No jacocoTestCoverageVerification floor at P0 — there is nothing meaningful to
// floor against yet. Add one once P2's execution tests exist (the plan's
// verification section names the targets).
