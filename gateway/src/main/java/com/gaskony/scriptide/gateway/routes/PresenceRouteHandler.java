package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.presence.Presence;
import com.gaskony.scriptide.gateway.presence.PresenceRegistry;
import com.gaskony.scriptide.gateway.ws.ScriptIdeSocketRegistry;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import jakarta.servlet.http.HttpServletResponse;

/**
 * GET /api/presence — who has a script open, right now.
 *
 * <h2>Why this exists when the socket already pushes it</h2>
 *
 * <p>They serve different callers. A connected client stays current from the
 * socket and never needs this. Everything else does: a person asking why their
 * badge is not showing, a support case where the answer is "the Designer feed is
 * off on that gateway", and the live suite, which has to be able to read the
 * module's own claim about itself rather than infer it from pixels.</p>
 *
 * <p>{@code designerFeed} is the field that matters here. It says whether this
 * gateway's platform event type still has the shape the module reads, and it is
 * the one thing that can go quietly false after an Ignition upgrade — see
 * {@code DesignerPresenceListener}. Anything that says "presence is working"
 * without checking it is not checking the half that breaks.</p>
 *
 * <h2>Sessions are never named to the browser</h2>
 *
 * <p>The session id is the registry's key and stays server-side. It identifies a
 * live Designer or browser connection, and a client that had one could ask the
 * platform about somebody else's session. Name, host and project are what a
 * person needs to go and talk to a colleague; the id adds nothing to that.</p>
 */
public class PresenceRouteHandler {

    /**
     * Everyone, optionally narrowed to one project.
     *
     * <p>Not narrowed to the caller's own open files: the useful question at the
     * project level is "who else is in here at all", including a Designer that
     * has opened nothing yet, and that peer belongs to no file.</p>
     */
    public Object presence(RequestContext req, HttpServletResponse resp) {
        String project = req.getParameter("project");
        PresenceRegistry registry = ScriptIdeSocketRegistry.getPresence();
        JsonObject out = new JsonObject();
        JsonArray peers = new JsonArray();
        if (registry != null) {
            for (Presence.Peer peer : registry.peers()) {
                if (project != null && !project.isBlank() && !project.equals(peer.project())) {
                    continue;
                }
                JsonObject item = new JsonObject();
                item.addProperty("username", peer.username());
                item.addProperty("host", peer.host());
                item.addProperty("kind",
                    peer.kind() == Presence.Kind.DESIGNER ? "designer" : "ide");
                item.addProperty("project", peer.project());
                item.addProperty("since", peer.since());
                JsonArray resources = new JsonArray();
                peer.resources().forEach(resources::add);
                item.add("resources", resources);
                peers.add(item);
            }
            out.addProperty("version", registry.version());
        } else {
            out.addProperty("version", -1);
        }
        out.add("peers", peers);
        // Registered at all — the listener is on the bus and its shape held.
        out.addProperty("designerFeed",
            ScriptIdeSocketRegistry.getDesignerPresence() != null);
        // Whether a real Designer event has been READ, as distinct from the
        // listener merely being attached. The first is a claim about this
        // build; the second is evidence from this gateway, and only the second
        // can prove the internal type has not changed under us.
        var listener = ScriptIdeSocketRegistry.getDesignerPresence();
        out.addProperty("designerEventSeen", listener != null && listener.hasSeenEvent());
        return out;
    }
}
