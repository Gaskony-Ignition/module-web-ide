pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        maven {
            url = uri("https://nexus.inductiveautomation.com/repository/public/")
        }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        mavenCentral()
        maven {
            url = uri("https://nexus.inductiveautomation.com/repository/public/")
        }
    }
}

enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

rootProject.name = "script-ide"

// Gateway-scope only, like web-designer: the IDE is a browser SPA, so there is
// no ":designer" or ":client" subproject and therefore no ModuleRPC surface.
// Everything the browser needs arrives over HTTP routes and one WebSocket.
include(":common", ":gateway", ":web")
