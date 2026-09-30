package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.git.GitSnapshot;
import com.gaskony.scriptide.gateway.git.GitStatusRegistry;
import com.gaskony.scriptide.gateway.ws.ScriptIdeSocketRegistry;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import jakarta.servlet.http.HttpServletResponse;

/**
 * GET /api/git/status?project=X — what has changed since the last commit.
 *
 * <p>Read-only, and there is no sibling that writes. Nigel's decision on
 * 01/09/2026 stands: this module is not becoming a git module, and
 * {@code module-git} already exists for staging, committing and remotes. What is
 * here is the part a person wants while EDITING — which files differ — and it
 * stops there.</p>
 *
 * <h2>The failure this endpoint is shaped around</h2>
 *
 * <p>A tree with no decorations means "nothing has changed". So every way of
 * failing has to be distinguishable from that, and each gets its own field
 * rather than an empty result: {@code repo} false means this project is not
 * version-controlled, {@code error} means the repository is there and could not
 * be read. A caller that sees neither, and no marks, has a genuinely clean
 * tree.</p>
 *
 * <p>{@code others} is a count, not paths. Files like {@code project.json} change
 * and have no node in the tree to decorate, but a summary that ignored them would
 * say "no changes" about a dirty working tree — which is exactly the wrong answer
 * to give somebody about to commit.</p>
 */
public class GitStatusRouteHandler {

    public Object status(RequestContext req, HttpServletResponse resp) {
        String project = req.getParameter("project");
        JsonObject out = new JsonObject();
        out.addProperty("project", project);

        GitStatusRegistry registry = ScriptIdeSocketRegistry.getGitStatus();
        if (registry == null) {
            // The module is up but this feature is not running. Said plainly
            // rather than answered with an empty, clean-looking body.
            out.addProperty("available", false);
            out.addProperty("repo", false);
            out.add("marks", new JsonObject());
            out.addProperty("others", 0);
            return out;
        }
        out.addProperty("available", true);
        if (project == null || project.isBlank()) {
            resp.setStatus(HttpServletResponse.SC_BAD_REQUEST);
            out.addProperty("error", "project is required");
            return out;
        }

        // Read on demand rather than serving the poll's last answer: this
        // endpoint's callers are a person diagnosing and a live suite asserting,
        // and both want the answer as of now.
        registry.refresh(project);
        GitSnapshot snapshot = registry.statusOf(project);

        out.addProperty("version", registry.version());
        out.addProperty("repo", snapshot.repo());
        out.addProperty("branch", snapshot.branch());
        out.addProperty("head", snapshot.head());
        out.addProperty("error", snapshot.error());
        out.addProperty("clean", snapshot.clean());
        out.addProperty("dirty", snapshot.dirty());

        JsonObject marks = new JsonObject();
        snapshot.marks().forEach((path, mark) -> marks.addProperty(path, mark.wire()));
        out.add("marks", marks);

        out.addProperty("others", snapshot.others().size());
        JsonArray otherPaths = new JsonArray();
        snapshot.others().forEach(otherPaths::add);
        // Listed here, unlike on the socket, because this endpoint is what a
        // person reads when the tree looks clean and the summary does not agree.
        out.add("otherPaths", otherPaths);
        return out;
    }
}
