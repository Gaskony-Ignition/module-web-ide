package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.ImmutableBytes;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.ChangeOperation;
import com.inductiveautomation.ignition.common.resourcecollection.PushException;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceId;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceSignature;
import com.inductiveautomation.ignition.common.resourcecollection.RuntimeResourceCollection;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import com.inductiveautomation.ignition.gateway.resourcecollection.PushOperation;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The named-query routes' refusals, and the two operations that touch more than
 * one resource.
 *
 * <p>The precondition tests exist for the same reason the script ones do: the risk
 * is not that a legitimate save fails — the user sees that at once — but that one
 * succeeds against something they did not mean. A stale write, a parent project's
 * copy, or a folder rename that moved the folder and left its children behind are
 * all silent.</p>
 */
class NamedQueryRouteHandlerTest {

    private static final String PROJECT = "MyProject";
    private static final String PATH = "Orders/Insert";

    private ProjectManager projectManager;
    private NamedQueryRouteHandler handler;
    private RequestContext req;
    private HttpServletResponse resp;
    private RuntimeResourceCollection collection;
    private final List<Resource> merged = new ArrayList<>();

    @BeforeEach
    void setUp() {
        projectManager = Mockito.mock(ProjectManager.class);
        // No GatewayContext: the datasource list is the only thing that needs one,
        // and its absence must degrade to an empty dropdown rather than a failure.
        handler = new NamedQueryRouteHandler(projectManager, null);
        req = Mockito.mock(RequestContext.class, Mockito.RETURNS_DEEP_STUBS);
        resp = Mockito.mock(HttpServletResponse.class);
        collection = Mockito.mock(RuntimeResourceCollection.class);
        merged.clear();
        when(collection.getResources()).thenReturn(merged);
        when(projectManager.find(PROJECT)).thenReturn(Optional.of(collection));
        when(projectManager.isMutable(PROJECT)).thenReturn(true);
        when(projectManager.getResource(anyString(), any(ResourcePath.class)))
            .thenReturn(Optional.empty());
        when(collection.getResource(any(ResourcePath.class))).thenReturn(Optional.empty());
    }

    // ==================== fixtures ====================

    private static ResourcePath path(String name) {
        return new ResourcePath(NamedQuery.RESOURCE_TYPE, name);
    }

    private static ResourceSignature signature(String name, String token) {
        return new ResourceSignature(new ResourceId(PROJECT, path(name)),
            ImmutableBytes.ofString(token));
    }

    /** A real resource, built by the platform's own serialiser. */
    private static Resource realResource(String name, String sql, String token) {
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery(sql);
        Resource built = Resource.newBuilder()
            .copyFrom(NamedQueryCodecTest.build(q))
            .setResourceCollectionName(PROJECT)
            .setResourcePath(path(name))
            .build();
        Resource spy = Mockito.spy(built);
        // The signature is derived from a real push in production; here it has to
        // be stated so the precondition assertions have something to compare.
        Mockito.doReturn(signature(name, token)).when(spy).getResourceSignature();
        Mockito.doReturn(PROJECT).when(spy).getDefiningCollectionName();
        Mockito.doReturn(List.of(PROJECT)).when(spy).getDefiningCollectionNames();
        return spy;
    }

    /** Present in this project AND in the merged view — the ordinary local case. */
    private void givenOwnResource(Resource resource) {
        ResourcePath rp = resource.getResourcePath();
        when(projectManager.getResource(PROJECT, rp)).thenReturn(Optional.of(resource));
        when(collection.getResource(rp)).thenReturn(Optional.of(resource));
        merged.add(resource);
    }

    private void givenRequest(String project, String pathParam, String ifMatch) {
        when(req.getParameter("project")).thenReturn(project);
        when(req.getParameter("path")).thenReturn(pathParam);
        HttpServletRequest raw = Mockito.mock(HttpServletRequest.class);
        when(raw.getHeader("If-Match")).thenReturn(ifMatch);
        when(req.getRequest()).thenReturn(raw);
    }

    private void givenBody(String json) throws IOException {
        when(req.readBody()).thenReturn(json);
    }

    private void givenPushSucceeds() throws PushException {
        when(projectManager.push(any(PushOperation.class)))
            .thenReturn(CompletableFuture.completedFuture(null));
    }

    @SuppressWarnings("unchecked")
    private List<ChangeOperation> capturePushedOps() throws PushException {
        ArgumentCaptor<PushOperation> captor = ArgumentCaptor.forClass(PushOperation.class);
        verify(projectManager).push(captor.capture());
        return (List<ChangeOperation>) (List<?>) captor.getValue().getChanges();
    }

    private void verifyNothingPushed() throws PushException {
        verify(projectManager, never()).push(any(PushOperation.class));
    }

    // ==================== content write: 428 / 409 ====================

    @Test
    @DisplayName("content: a modify with no If-Match is a 428")
    void contentModifyWithoutIfMatchIs428() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, null);
        givenBody("{\"sql\":\"SELECT 2\"}");

        handler.writeContent(req, resp);

        verify(resp).setStatus(HandlerSupport.SC_PRECONDITION_REQUIRED);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("content: a stale If-Match is a 409")
    void contentModifyWithStaleIfMatchIs409() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, signature(PATH, "stale").toString());
        givenBody("{\"sql\":\"SELECT 2\"}");

        handler.writeContent(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("content: a matching If-Match reaches the push — the guard is not vacuous")
    void contentModifyWithMatchingIfMatchPushes() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, signature(PATH, "current").toString());
        givenBody("{\"sql\":\"SELECT 2\"}");
        givenPushSucceeds();

        handler.writeContent(req, resp);

        assertThat(capturePushedOps()).hasSize(1);
    }

    @Test
    @DisplayName("content: a CREATE needs no If-Match, and lands at the pinned defaults")
    void contentCreateNeedsNoIfMatch() throws IOException, PushException {
        givenRequest(PROJECT, PATH, null);
        givenBody("{\"sql\":\"SELECT 1\"}");
        givenPushSucceeds();

        handler.writeContent(req, resp);

        List<ChangeOperation> ops = capturePushedOps();
        assertThat(ops).hasSize(1);
        Resource created = ChangeOperation.getResourceFromChange(ops.get(0));
        assertThat(created.getVersion()).isEqualTo(NamedQuery.CURRENT_RESOURCE_VERSION);
        assertThat(created.getAttribute("type").orElseThrow().getAsString()).isEqualTo("Query");
        assertThat(created.getAttribute("enabled").orElseThrow().getAsBoolean()).isTrue();
        assertThat(created.getAttribute("maxReturnSize").orElseThrow().getAsLong())
            .isEqualTo(100L);
    }

    @Test
    @DisplayName("content: settings ride along in the SAME push, so Ctrl+S cannot race itself")
    void contentWriteCarriesSettings() throws IOException, PushException {
        givenRequest(PROJECT, PATH, null);
        givenBody("{\"sql\":\"SELECT :id\",\"settings\":{\"type\":\"ScalarQuery\","
            + "\"parameters\":[{\"identifier\":\"id\",\"sqlType\":\"Int4\"}]}}");
        givenPushSucceeds();

        handler.writeContent(req, resp);

        Resource created = ChangeOperation.getResourceFromChange(capturePushedOps().get(0));
        assertThat(created.getAttribute("type").orElseThrow().getAsString())
            .isEqualTo("ScalarQuery");
        // sqlType 2 is Int4 — a NAME on the wire, an INT on disk.
        assertThat(created.getAttribute("parameters").orElseThrow().toString())
            .contains("\"sqlType\":2");
    }

    @Test
    @DisplayName("content: a bad settings value refuses the whole write, SQL included")
    void badSettingsRefusesTheWholeWrite() throws IOException, PushException {
        givenRequest(PROJECT, PATH, null);
        givenBody("{\"sql\":\"SELECT 1\",\"settings\":{\"cacheUnit\":\"FORTNIGHT\"}}");

        handler.writeContent(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    // ==================== settings write: 428 / 409 ====================

    @Test
    @DisplayName("settings: no If-Match is a 428")
    void settingsWithoutIfMatchIs428() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, null);
        givenBody("{\"settings\":{\"enabled\":false}}");

        handler.writeSettings(req, resp);

        verify(resp).setStatus(HandlerSupport.SC_PRECONDITION_REQUIRED);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("settings: a stale If-Match is a 409")
    void settingsWithStaleIfMatchIs409() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, signature(PATH, "stale").toString());
        givenBody("{\"settings\":{\"enabled\":false}}");

        handler.writeSettings(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("settings: a matching If-Match pushes, and the SQL is not blanked")
    void settingsWriteKeepsTheSql() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1\n", "current"));
        givenRequest(PROJECT, PATH, signature(PATH, "current").toString());
        givenBody("{\"settings\":{\"enabled\":false}}");
        givenPushSucceeds();

        handler.writeSettings(req, resp);

        Resource written = ChangeOperation.getResourceFromChange(capturePushedOps().get(0));
        assertThat(written.getData(NamedQueryRouteHandler.QUERY_FILE).orElseThrow().getBytes())
            .isEqualTo("SELECT 1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(written.getAttribute("enabled").orElseThrow().getAsBoolean()).isFalse();
    }

    @Test
    @DisplayName("settings: an unknown key is a 400 and nothing is pushed")
    void settingsUnknownKeyIs400() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, signature(PATH, "current").toString());
        givenBody("{\"settings\":{\"turbo\":true}}");

        handler.writeSettings(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("settings: a query this project does not define is a 404, never a create")
    void settingsOnAMissingQueryIs404() throws IOException, PushException {
        givenRequest(PROJECT, PATH, "anything");
        givenBody("{\"settings\":{\"enabled\":false}}");

        handler.writeSettings(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_NOT_FOUND);
        verifyNothingPushed();
    }

    // ==================== rename ====================

    @Test
    @DisplayName("rename: a QUERY requires If-Match, and answers {ok, signature}")
    void renameOfAQueryRequiresIfMatch() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, null, null);
        givenBody("{\"path\":\"" + PATH + "\",\"newPath\":\"Orders/Add\"}");

        handler.rename(req, resp);

        verify(resp).setStatus(HandlerSupport.SC_PRECONDITION_REQUIRED);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("rename: a query moves as one create and one delete, in ONE push")
    void renameOfAQueryIsCreateAndDelete() throws IOException, PushException {
        Resource source = realResource(PATH, "SELECT 1\n", "current");
        givenOwnResource(source);
        givenRequest(PROJECT, null, signature(PATH, "current").toString());
        givenBody("{\"path\":\"" + PATH + "\",\"newPath\":\"Orders/Add\"}");
        givenPushSucceeds();

        Object body = handler.rename(req, resp);

        List<ChangeOperation> ops = capturePushedOps();
        assertThat(ops).hasSize(2);
        assertThat(ChangeOperation.getResourceFromChange(ops.get(0)).getResourcePath())
            .isEqualTo(path("Orders/Add"));
        // The SQL must arrive byte-identical: a rename that reformats turns into a
        // full-file diff on every move.
        assertThat(ChangeOperation.getResourceFromChange(ops.get(0))
            .getData(NamedQueryRouteHandler.QUERY_FILE).orElseThrow().getBytes())
            .isEqualTo("SELECT 1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(((JsonObject) body).get("ok").getAsBoolean()).isTrue();
        assertThat(((JsonObject) body).has("moved")).isFalse();
    }

    @Test
    @DisplayName("rename: an IMPLIED folder needs no If-Match and takes its children with it")
    void renameOfAnImpliedFolderMovesChildren() throws IOException, PushException {
        // No resource at "Orders" — the folder exists only because query paths
        // contain slashes. Demanding an If-Match for it would make renaming a
        // folder impossible rather than safe.
        givenOwnResource(realResource("Orders/Insert", "SELECT 1", "a"));
        givenOwnResource(realResource("Orders/Update", "SELECT 2", "b"));
        givenRequest(PROJECT, null, null);
        givenBody("{\"path\":\"Orders\",\"newPath\":\"Sales\"}");
        givenPushSucceeds();

        Object body = handler.rename(req, resp);

        List<ChangeOperation> ops = capturePushedOps();
        assertThat(ops).hasSize(4);
        assertThat(List.of(
            ChangeOperation.getResourceFromChange(ops.get(0)).getResourcePath(),
            ChangeOperation.getResourceFromChange(ops.get(2)).getResourcePath()))
            .containsExactlyInAnyOrder(path("Sales/Insert"), path("Sales/Update"));

        JsonArray moved = ((JsonObject) body).getAsJsonArray("moved");
        assertThat(moved).hasSize(2);
        assertThat(moved.get(0).getAsJsonObject().get("from").getAsString())
            .startsWith("Orders/");
        assertThat(moved.get(0).getAsJsonObject().get("to").getAsString())
            .startsWith("Sales/");
    }

    @Test
    @DisplayName("rename: a destination that already exists is a 409, before anything is pushed")
    void renameOntoAnExistingPathIs409() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenOwnResource(realResource("Orders/Add", "SELECT 2", "other"));
        givenRequest(PROJECT, null, signature(PATH, "current").toString());
        givenBody("{\"path\":\"" + PATH + "\",\"newPath\":\"Orders/Add\"}");

        handler.rename(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("rename: moving a folder into itself is refused")
    void renameIntoItselfIsRefused() throws IOException, PushException {
        givenOwnResource(realResource("Orders/Insert", "SELECT 1", "a"));
        givenRequest(PROJECT, null, null);
        givenBody("{\"path\":\"Orders\",\"newPath\":\"Orders/Nested\"}");

        handler.rename(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("rename: nothing at the path at all is a 404")
    void renameOfNothingIs404() throws IOException, PushException {
        givenRequest(PROJECT, null, "sig");
        givenBody("{\"path\":\"Nowhere\",\"newPath\":\"Elsewhere\"}");

        handler.rename(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_NOT_FOUND);
        verifyNothingPushed();
    }

    // ==================== delete ====================

    @Test
    @DisplayName("delete: no If-Match is a 428")
    void deleteWithoutIfMatchIs428() throws IOException, PushException {
        givenOwnResource(realResource(PATH, "SELECT 1", "current"));
        givenRequest(PROJECT, PATH, null);

        handler.delete(req, resp);

        verify(resp).setStatus(HandlerSupport.SC_PRECONDITION_REQUIRED);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("delete: an inherited-only query is a 404, never a delete of the parent's copy")
    void deleteOfAnInheritedQueryIs404() throws IOException, PushException {
        // The merged lookup would find the parent's copy. Deleting that would edit
        // a project the caller never named.
        Resource inherited = realResource(PATH, "SELECT 1", "current");
        when(collection.getResource(path(PATH))).thenReturn(Optional.of(inherited));
        givenRequest(PROJECT, PATH, signature(PATH, "current").toString());

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_NOT_FOUND);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("delete: a folder takes its children with it, in one push")
    void deleteOfAFolderTakesChildren() throws IOException, PushException {
        givenOwnResource(realResource("Orders", "", "folder"));
        givenOwnResource(realResource("Orders/Insert", "SELECT 1", "a"));
        givenRequest(PROJECT, "Orders", signature("Orders", "folder").toString());
        givenPushSucceeds();

        handler.delete(req, resp);

        assertThat(capturePushedOps()).hasSize(2);
    }

    // ==================== reads: the legacy flag ====================

    @Test
    @DisplayName("a version-1 query LISTS with legacy:true and the platform's defaults, unmodified")
    void legacyQueryIsFlaggedNotRepaired() throws PushException {
        // The gateway cannot read a version-1 resource either — see
        // docs/NAMED-QUERIES.md §1.5 — so the listing says so instead of showing
        // attributes nothing acts on. And it does NOT rewrite it: a listing is a
        // read.
        Resource legacy = Mockito.spy(Resource.newBuilder()
            .setResourceCollectionName(PROJECT)
            .setResourcePath(path(PATH))
            .setVersion(1)
            .putData(NamedQueryRouteHandler.QUERY_FILE, "SELECT 1")
            .putAttribute("type", "UpdateQuery")
            .build());
        Mockito.doReturn(signature(PATH, "legacy")).when(legacy).getResourceSignature();
        Mockito.doReturn(PROJECT).when(legacy).getDefiningCollectionName();
        Mockito.doReturn(List.of(PROJECT)).when(legacy).getDefiningCollectionNames();
        givenOwnResource(legacy);
        when(req.getParameter("project")).thenReturn(PROJECT);

        JsonObject body = (JsonObject) handler.list(req, resp);

        JsonObject row = body.getAsJsonArray("queries").get(0).getAsJsonObject();
        assertThat(row.get("legacy").getAsBoolean()).isTrue();
        assertThat(row.get("path").getAsString()).isEqualTo(PATH);
        // The platform's default, NOT the "UpdateQuery" attribute — because the
        // attribute is not what the gateway reads on a version-1 resource.
        assertThat(row.get("type").getAsString()).isEqualTo("Query");
        verifyNothingPushed();
    }

    @Test
    @DisplayName("a current query lists with legacy:false and its real settings")
    void currentQueryListsItsSettings() {
        Resource current = realResource(PATH, "SELECT 1", "sig");
        givenOwnResource(current);
        when(req.getParameter("project")).thenReturn(PROJECT);

        JsonObject row = ((JsonObject) handler.list(req, resp))
            .getAsJsonArray("queries").get(0).getAsJsonObject();

        assertThat(row.get("legacy").getAsBoolean()).isFalse();
        assertThat(row.get("isFolder").getAsBoolean()).isFalse();
        assertThat(row.get("name").getAsString()).isEqualTo("Insert");
        assertThat(row.get("folder").getAsString()).isEqualTo("Orders");
        assertThat(row.get("origin").getAsString())
            .isEqualTo(ScriptResourceRouteHandler.ORIGIN_LOCAL);
    }

    @Test
    @DisplayName("the type's own folder is not listed as a query")
    void typeFolderIsNotListed() {
        // The platform reports `ignition/named-query` as a resource in its own
        // right once a project holds any query. Listed, it renders as a row named
        // after the type; addressable, it is writable.
        Resource typeFolder = Mockito.spy(Resource.newBuilder()
            .setResourceCollectionName(PROJECT)
            .setResourcePath(new ResourcePath(NamedQuery.RESOURCE_TYPE, ""))
            .setFolder(true)
            .build());
        Mockito.doReturn(signature("", "folder")).when(typeFolder).getResourceSignature();
        merged.add(typeFolder);
        when(req.getParameter("project")).thenReturn(PROJECT);

        assertThat(((JsonObject) handler.list(req, resp)).getAsJsonArray("queries")).isEmpty();
    }

    @Test
    @DisplayName("the settings read publishes the editable allowlist and the vocabulary")
    void settingsReadPublishesTheAllowlist() {
        givenOwnResource(realResource(PATH, "SELECT 1", "sig"));
        givenRequest(PROJECT, PATH, null);

        JsonObject body = (JsonObject) handler.readSettings(req, resp);

        assertThat(body.getAsJsonArray("editable"))
            .as("a non-empty editable list is the allowlist a write enforces")
            .isNotEmpty();
        assertThat(body.getAsJsonArray("editable").size())
            .isEqualTo(NamedQueryCodec.EDITABLE_KEYS.size());
        assertThat(body.getAsJsonObject("vocabulary").getAsJsonArray("sqlType")).hasSize(10);
        assertThat(body.getAsJsonArray("databases"))
            .as("no GatewayContext means an empty dropdown, not a failed read")
            .isEmpty();
        assertThat(body.get("legacy").getAsBoolean()).isFalse();
    }

    @Test
    @DisplayName("an UNCHANGED settings POST on a legacy query still pushes, and lands at version 2")
    void settingsSaveRepairsALegacyQuery() throws IOException, PushException {
        // The client posts the settings it just read, unedited, to repair a
        // version-1 query. If this path short-circuited on "nothing changed", the
        // repair would silently do nothing and the query would stay unrunnable —
        // with a success response on screen.
        Resource legacy = Mockito.spy(Resource.newBuilder()
            .setResourceCollectionName(PROJECT)
            .setResourcePath(path(PATH))
            .setVersion(1)
            .putData(NamedQueryRouteHandler.QUERY_FILE, "SELECT 1\n")
            .build());
        Mockito.doReturn(signature(PATH, "legacy")).when(legacy).getResourceSignature();
        Mockito.doReturn(PROJECT).when(legacy).getDefiningCollectionName();
        Mockito.doReturn(List.of(PROJECT)).when(legacy).getDefiningCollectionNames();
        givenOwnResource(legacy);
        givenRequest(PROJECT, PATH, signature(PATH, "legacy").toString());
        givenBody("{\"settings\":{\"type\":\"Query\",\"enabled\":true}}");
        givenPushSucceeds();

        handler.writeSettings(req, resp);

        Resource written = ChangeOperation.getResourceFromChange(capturePushedOps().get(0));
        assertThat(written.getVersion()).isEqualTo(NamedQuery.CURRENT_RESOURCE_VERSION);
        // And the SQL the resource already held is carried across, not blanked:
        // fromResource returns a null query for a legacy resource, so without the
        // data-key fallback the repair would erase the user's SQL.
        assertThat(written.getData(NamedQueryRouteHandler.QUERY_FILE).orElseThrow().getBytes())
            .isEqualTo("SELECT 1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    // ==================== path validation ====================

    @Test
    @DisplayName("a traversal segment in the path is refused before any lookup")
    void traversalIsRefused() throws IOException, PushException {
        givenRequest(PROJECT, "Orders/../../etc", null);
        givenBody("{\"sql\":\"SELECT 1\"}");

        handler.writeContent(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("an empty segment is refused — 'Orders//Insert' is not a path")
    void emptySegmentIsRefused() throws IOException, PushException {
        givenRequest(PROJECT, "Orders//Insert", null);
        givenBody("{\"sql\":\"SELECT 1\"}");

        handler.writeContent(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("an immutable project refuses every write with a 409")
    void immutableProjectIs409() throws IOException, PushException {
        when(projectManager.isMutable(PROJECT)).thenReturn(false);
        givenRequest(PROJECT, PATH, null);
        givenBody("{\"sql\":\"SELECT 1\"}");

        handler.writeContent(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
        verifyNothingPushed();
    }
}
