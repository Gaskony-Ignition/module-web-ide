package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.ImmutableBytes;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceId;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceSignature;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import com.inductiveautomation.ignition.gateway.resourcecollection.PushOperation;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import com.inductiveautomation.ignition.common.resourcecollection.PushException;

import java.io.IOException;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * The delete status map.
 *
 * <p>Delete is the one operation in this module that destroys work and cannot be
 * undone from inside it, so every branch that REFUSES is asserted individually.
 * The risk being guarded is not that a legitimate delete fails — the user sees
 * that immediately — but that a delete succeeds against something the caller did
 * not mean: a stale version, a different project, or a parent's script reached
 * through inheritance.</p>
 */
class ScriptDeleteHandlerTest {

    private static final String PROJECT = "MyProject";
    private static final String PATH = "ignition/script-python/util/helpers";

    private ProjectManager projectManager;
    private ScriptResourceRouteHandler handler;
    private RequestContext req;
    private HttpServletResponse resp;

    @BeforeEach
    void setUp() {
        projectManager = Mockito.mock(ProjectManager.class);
        handler = new ScriptResourceRouteHandler(projectManager);
        req = Mockito.mock(RequestContext.class, Mockito.RETURNS_DEEP_STUBS);
        resp = Mockito.mock(HttpServletResponse.class);
    }

    /** A real signature, so equality behaves exactly as it does in production. */
    private static ResourceSignature signature(String token) {
        ResourcePath path = HandlerSupport.decodePath(PATH);
        return new ResourceSignature(new ResourceId(PROJECT, path),
            ImmutableBytes.ofString(token));
    }

    private void givenRequest(String project, String path, String ifMatch) {
        Mockito.when(req.getParameter("project")).thenReturn(project);
        Mockito.when(req.getParameter("path")).thenReturn(path);
        HttpServletRequest raw = Mockito.mock(HttpServletRequest.class);
        Mockito.when(raw.getHeader("If-Match")).thenReturn(ifMatch);
        Mockito.when(req.getRequest()).thenReturn(raw);
    }

    private void givenProject(boolean exists, boolean mutable) {
        Mockito.when(projectManager.find(PROJECT))
            .thenReturn(exists ? Optional.of(Mockito.mock(
                com.inductiveautomation.ignition.common.resourcecollection
                    .RuntimeResourceCollection.class)) : Optional.empty());
        Mockito.when(projectManager.isMutable(PROJECT)).thenReturn(mutable);
    }

    private void givenExistingResource(ResourceSignature sig) {
        Resource resource = Mockito.mock(Resource.class);
        Mockito.when(resource.getResourceSignature()).thenReturn(sig);
        Mockito.when(projectManager.getResource(anyString(), any(ResourcePath.class)))
            .thenReturn(Optional.of(resource));
    }

    @Test
    @DisplayName("a missing project parameter is a 400, and nothing is pushed")
    void missingProjectIs400() throws IOException, PushException {
        givenRequest(null, PATH, "sig");

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("a path that is not a script type is refused before anything else")
    void nonScriptPathIsRefused() throws IOException, PushException {
        givenRequest(PROJECT, "ignition/perspective-views/Page", "sig");

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("an unknown project is a 404")
    void unknownProjectIs404() throws IOException, PushException {
        givenRequest(PROJECT, PATH, "sig");
        givenProject(false, true);

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_NOT_FOUND);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("an immutable project is a 409")
    void immutableProjectIs409() throws IOException, PushException {
        givenRequest(PROJECT, PATH, "sig");
        givenProject(true, false);

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("a script this project does not OWN is a 404, never a delete of the parent's")
    void inheritedOnlyScriptIs404() throws IOException, PushException {
        // The merged lookup would find the parent's copy. Deleting that would edit
        // a project the caller never named — the single worst outcome available
        // here, so it gets its own test.
        givenRequest(PROJECT, PATH, "sig");
        givenProject(true, true);
        Mockito.when(projectManager.getResource(anyString(), any(ResourcePath.class)))
            .thenReturn(Optional.empty());

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_NOT_FOUND);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("no If-Match is a 428 — you must have read the script first")
    void missingIfMatchIs428() throws IOException, PushException {
        givenRequest(PROJECT, PATH, null);
        givenProject(true, true);
        givenExistingResource(signature("current"));

        handler.delete(req, resp);

        verify(resp).setStatus(HandlerSupport.SC_PRECONDITION_REQUIRED);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("a stale If-Match is a 409 — the script moved on since it was read")
    void staleIfMatchIs409() throws IOException, PushException {
        ResourceSignature current = signature("current");
        givenRequest(PROJECT, PATH, signature("stale").toString());
        givenProject(true, true);
        givenExistingResource(current);

        handler.delete(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
        verifyNothingPushed();
    }

    @Test
    @DisplayName("the guard is not vacuous — a matching If-Match reaches the push")
    void matchingIfMatchReachesThePush() throws IOException, PushException {
        // Without this, every assertion above would still pass if delete() simply
        // returned an error unconditionally.
        ResourceSignature current = signature("current");
        givenRequest(PROJECT, PATH, current.toString());
        givenProject(true, true);
        givenExistingResource(current);

        handler.delete(req, resp);

        verify(projectManager).push(any(PushOperation.class));
    }

    private void verifyNothingPushed() throws PushException {
        verify(projectManager, never()).push(any(PushOperation.class));
    }
}
