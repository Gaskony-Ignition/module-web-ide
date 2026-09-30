package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceCollectionManifest;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

/**
 * {@code GET /api/projects} carries each project's parent and whether it can
 * be inherited from. A child of a non-inheritable parent lists no inherited
 * scripts, and without these two fields that is indistinguishable from the
 * listing being broken.
 */
class ProjectsListingTest {

    private static ResourceCollectionManifest manifest(String parent, boolean inheritable) {
        return ResourceCollectionManifest.newBuilder()
            .setTitle("t").setDescription("d").setEnabled(true)
            .setParent(parent).setInheritable(inheritable).build();
    }

    private static JsonObject entry(JsonArray projects, String name) {
        for (var e : projects) {
            if (name.equals(e.getAsJsonObject().get("name").getAsString())) {
                return e.getAsJsonObject();
            }
        }
        throw new AssertionError("no entry for " + name);
    }

    @Test
    @DisplayName("each project reports its parent and inheritability")
    void parentAndInheritable() {
        ProjectManager pm = Mockito.mock(ProjectManager.class);
        when(pm.getNames()).thenReturn(List.of("Parent", "Child", "Loner"));
        when(pm.getManifests()).thenReturn(Map.of(
            "Parent", manifest("", true),
            "Child", manifest("Parent", false),
            "Loner", manifest(null, false)));
        when(pm.isMutable(Mockito.anyString())).thenReturn(true);

        ScriptResourceRouteHandler handler = new ScriptResourceRouteHandler(pm);
        JsonObject body = (JsonObject) handler.projects(
            Mockito.mock(RequestContext.class), Mockito.mock(HttpServletResponse.class));
        JsonArray projects = body.getAsJsonArray("projects");

        assertThat(entry(projects, "Parent").get("inheritable").getAsBoolean()).isTrue();
        assertThat(entry(projects, "Parent").get("parent").isJsonNull()).isTrue();
        assertThat(entry(projects, "Child").get("parent").getAsString()).isEqualTo("Parent");
        assertThat(entry(projects, "Child").get("inheritable").getAsBoolean()).isFalse();
        assertThat(entry(projects, "Loner").get("parent").isJsonNull()).isTrue();
    }

    @Test
    @DisplayName("a project with no manifest is still listed")
    void manifestMissing() {
        ProjectManager pm = Mockito.mock(ProjectManager.class);
        when(pm.getNames()).thenReturn(List.of("Ghost"));
        when(pm.getManifests()).thenReturn(Map.of());
        when(pm.isMutable(Mockito.anyString())).thenReturn(false);

        JsonObject body = (JsonObject) new ScriptResourceRouteHandler(pm).projects(
            Mockito.mock(RequestContext.class), Mockito.mock(HttpServletResponse.class));
        JsonObject ghost = entry(body.getAsJsonArray("projects"), "Ghost");
        assertThat(ghost.get("mutable").getAsBoolean()).isFalse();
        assertThat(ghost.has("parent")).isFalse();
    }
}
