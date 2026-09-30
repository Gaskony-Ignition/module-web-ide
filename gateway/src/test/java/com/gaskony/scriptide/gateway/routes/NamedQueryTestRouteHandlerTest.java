package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.ImmutableBytes;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceId;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceSignature;
import com.inductiveautomation.ignition.common.resourcecollection.RuntimeResourceCollection;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The test-run's GATES, and the shape of the Python it generates.
 *
 * <p>What is asserted here is which requests get as far as the execution service
 * and which are turned away before it. The run itself needs a Gateway — a real
 * {@code ScriptManager}, a datasource and a live pool — so it is proved on the rig
 * rather than here. The gates are the part that can be wrong silently: refusing a
 * draft run on a broken query would make the repair path unusable, and allowing a
 * saved run on a legacy one would surface a platform NPE the user cannot act on.</p>
 *
 * <p>A {@code null} execution service is used as the tripwire. Reaching it means
 * every gate before it passed, and it answers 503 — so "did this request get
 * through?" is a single assertion with no interpreter involved.</p>
 */
class NamedQueryTestRouteHandlerTest {

    private static final String PROJECT = "MyProject";
    private static final String PATH = "Orders/Insert";

    private ProjectManager projectManager;
    private RuntimeResourceCollection collection;
    private NamedQueryTestRouteHandler handler;
    private RequestContext req;
    private HttpServletResponse resp;

    @BeforeEach
    void setUp() {
        projectManager = Mockito.mock(ProjectManager.class);
        collection = Mockito.mock(RuntimeResourceCollection.class);
        when(projectManager.find(PROJECT)).thenReturn(Optional.of(collection));
        when(collection.getResource(any(ResourcePath.class))).thenReturn(Optional.empty());
        // Null service: the tripwire that says a request reached the run.
        handler = new NamedQueryTestRouteHandler(projectManager, () -> null, () -> null);
        req = Mockito.mock(RequestContext.class, Mockito.RETURNS_DEEP_STUBS);
        resp = Mockito.mock(HttpServletResponse.class);
    }

    private static ResourcePath path(String name) {
        return new ResourcePath(NamedQuery.RESOURCE_TYPE, name);
    }

    private void givenRequest(String body) throws IOException {
        when(req.getParameter("project")).thenReturn(PROJECT);
        when(req.readBody()).thenReturn(body);
        when(req.getRequest()).thenReturn(Mockito.mock(HttpServletRequest.class));
    }

    private void givenResource(Resource resource) {
        when(collection.getResource(resource.getResourcePath()))
            .thenReturn(Optional.of(resource));
    }

    private static Resource query(String sql, boolean enabled, int version) {
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery(sql);
        q.setEnabled(enabled);
        var builder = Resource.newBuilder()
            .copyFrom(NamedQueryCodecTest.build(q))
            .setResourceCollectionName(PROJECT)
            .setResourcePath(path(PATH));
        if (version != NamedQuery.CURRENT_RESOURCE_VERSION) {
            builder.setVersion(version);
        }
        Resource spy = Mockito.spy(builder.build());
        Mockito.doReturn(new ResourceSignature(new ResourceId(PROJECT, path(PATH)),
            ImmutableBytes.ofString("sig"))).when(spy).getResourceSignature();
        Mockito.doReturn(PROJECT).when(spy).getDefiningCollectionName();
        Mockito.doReturn(List.of(PROJECT)).when(spy).getDefiningCollectionNames();
        return spy;
    }

    /** The service was reached, so every gate before it allowed the request. */
    private void assertReachedTheRun() {
        verify(resp).setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
    }

    private void assertRefusedWith(int status) {
        verify(resp).setStatus(status);
        verify(resp, never()).setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
    }

    // ==================== the gates ====================

    @Test
    @DisplayName("a SAVED run on a legacy query is refused, with the reason and the fix")
    void savedRunOnALegacyQueryIsRefused() throws IOException {
        givenResource(query("SELECT 1", true, 1));
        givenRequest("{\"path\":\"" + PATH + "\"}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_CONFLICT);
    }

    @Test
    @DisplayName("a DRAFT run on a legacy query is allowed — that is how the repair is tested")
    void draftRunOnALegacyQueryIsAllowed() throws IOException {
        // The draft path never touches the resource, so a version-1 query is no
        // obstacle. Refusing it would mean the only way to test a fix is to save
        // it first, which makes "try it" destructive.
        givenResource(query("SELECT 1", true, 1));
        givenRequest("{\"path\":\"" + PATH + "\",\"sql\":\"SELECT 1\","
            + "\"settings\":{\"type\":\"Query\"}}");

        handler.test(req, resp);

        assertReachedTheRun();
    }

    @Test
    @DisplayName("a SAVED run on a disabled query is refused")
    void savedRunOnADisabledQueryIsRefused() throws IOException {
        givenResource(query("SELECT 1", false, 2));
        givenRequest("{\"path\":\"" + PATH + "\"}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_CONFLICT);
    }

    @Test
    @DisplayName("a DRAFT run on a disabled query is allowed")
    void draftRunOnADisabledQueryIsAllowed() throws IOException {
        givenResource(query("SELECT 1", false, 2));
        givenRequest("{\"path\":\"" + PATH + "\",\"sql\":\"SELECT 1\","
            + "\"settings\":{\"type\":\"Query\"}}");

        handler.test(req, resp);

        assertReachedTheRun();
    }

    @Test
    @DisplayName("a DRAFT run needs no saved resource at all — a new query can be tested")
    void draftRunNeedsNoResource() throws IOException {
        givenRequest("{\"path\":\"Scratch/New\",\"sql\":\"SELECT 1\","
            + "\"settings\":{\"type\":\"Query\"}}");

        handler.test(req, resp);

        assertReachedTheRun();
    }

    @Test
    @DisplayName("a SAVED run on a query that does not exist is a 404")
    void savedRunOnAMissingQueryIs404() throws IOException {
        givenRequest("{\"path\":\"" + PATH + "\"}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_NOT_FOUND);
    }

    @Test
    @DisplayName("a draft whose SQL names an undeclared parameter is a 400, before any run")
    void draftWithAnUndeclaredParameterIs400() throws IOException {
        givenRequest("{\"path\":\"Scratch/New\",\"sql\":\"SELECT :nope\","
            + "\"settings\":{\"type\":\"Query\"}}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("a parameter value that does not parse is a 400, before any run")
    void badParameterValueIs400() throws IOException {
        givenRequest("{\"path\":\"Scratch/New\",\"sql\":\"SELECT :id\","
            + "\"settings\":{\"type\":\"Query\",\"parameters\":"
            + "[{\"identifier\":\"id\",\"sqlType\":\"Int4\"}]},"
            + "\"parameters\":{\"id\":\"lots\"}}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("a bad settings value in a draft is a 400, not a run against a guessed type")
    void badDraftSettingsIs400() throws IOException {
        givenRequest("{\"path\":\"Scratch/New\",\"sql\":\"SELECT 1\","
            + "\"settings\":{\"type\":\"SelectQuery\"}}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("a missing path is a 400")
    void missingPathIs400() throws IOException {
        givenRequest("{\"parameters\":{}}");

        handler.test(req, resp);

        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    // ==================== the generated source ====================

    @Test
    @DisplayName("both sources are CONSTANTS — no request value is formatted into them")
    void sourcesAreConstant() {
        // The path, the SQL, the arguments and the connection are seeded into the
        // execution's locals instead. Nothing here concatenates user text, so there
        // is nothing for a value to escape from.
        for (String source : List.of(NamedQueryTestRouteHandler.SOURCE_SAVED,
            NamedQueryTestRouteHandler.SOURCE_DRAFT)) {
            assertThat(source).doesNotContain("%s").doesNotContain("+ \"");
            assertThat(source).contains(NamedQueryTestRouteHandler.VAR_RESULT + " = ");
        }
    }

    @Test
    @DisplayName("the saved source calls runNamedQuery; the draft source calls the prepared trio")
    void eachSourceCallsTheRightThing() {
        assertThat(NamedQueryTestRouteHandler.SOURCE_SAVED)
            .contains("runNamedQuery")
            .doesNotContain("runPrepQuery");
        assertThat(NamedQueryTestRouteHandler.SOURCE_DRAFT)
            .contains("runPrepQuery")
            .contains("runScalarPrepQuery")
            .contains("runPrepUpdate")
            .doesNotContain("runNamedQuery");
    }

    @Test
    @DisplayName("the generated source is flat — no def, no class, no comprehension over a Java object")
    void generatedSourceIsFlat() {
        // It must run identically under the one-namespace execution model this
        // module uses: on a gateway running an older build, a function body cannot
        // see the module-level names the run depends on.
        for (String source : List.of(NamedQueryTestRouteHandler.SOURCE_SAVED,
            NamedQueryTestRouteHandler.SOURCE_DRAFT)) {
            assertThat(source).doesNotContain("def ").doesNotContain("class ");
        }
    }

    @Test
    @DisplayName("the row cap the source enforces is the one the codec publishes")
    void rowCapIsShared() {
        assertThat(NamedQueryCodec.TEST_ROW_CAP).isEqualTo(500);
        assertThat(NamedQueryTestRouteHandler.SOURCE_SAVED)
            .contains("'truncatedAt'");
    }
}
