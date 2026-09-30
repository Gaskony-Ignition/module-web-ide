package com.gaskony.scriptide.gateway.presence;

import com.gaskony.scriptide.gateway.presence.Presence.Kind;
import com.gaskony.scriptide.gateway.presence.Presence.Peer;
import com.google.common.eventbus.EventBus;
import com.google.common.eventbus.Subscribe;
import com.inductiveautomation.ignition.common.ConcurrencySessionInfo;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceType;
import com.inductiveautomation.ignition.designer.concurrency.ResourceSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Designer presence, read from Ignition's own concurrent-editing feed.
 *
 * <h2>What the platform already does, that we are joining</h2>
 *
 * <p>An 8.3 Designer tells the gateway which resources it has open, so that other
 * Designers can show the "also being edited" banner. The gateway keeps that in
 * {@code DesignerConcurrencyManager} and posts {@code DesignerResourceSessionEvent}
 * on the Guava {@link EventBus} that {@code CommonContext.getEventBus()} returns.
 * That accessor IS public SDK, so a module may register on the same bus and see
 * the same events the platform's own manager sees. Nothing here injects, wraps or
 * replaces any platform component.</p>
 *
 * <h2>Why this class is written defensively, and exactly where</h2>
 *
 * <p>{@code DesignerResourceSessionEvent} lives in {@code gateway.jar}, not in
 * the SDK's {@code gateway-api} — checked, 8.3.6 and 8.3.8 both. So it is an
 * INTERNAL type: present at runtime, absent at compile time, and free to change
 * in a patch release. Everything it CARRIES is public SDK — {@link ResourceSession},
 * {@link ConcurrencySessionInfo} and {@link ResourcePath} all ship in the SDK's
 * {@code common} artefact — so the reflection is confined to reaching the
 * accessor, and the values are strongly typed the instant they are in hand.</p>
 *
 * <p>The consequence that matters: if IA renames the event or its accessors, this
 * listener stops contributing and says so ONCE, and the module keeps running with
 * the session-level presence {@link PresenceSweep} provides from supported API.
 * A module that failed to start because a private class moved would be a far
 * worse trade than an indicator that gets less specific.</p>
 *
 * <h2>Subscribing to Object, deliberately</h2>
 *
 * <p>Guava dispatches to a subscriber by its parameter's type, so subscribing to
 * the event class would need it at compile time — the one thing we do not have.
 * Guava also delivers every event to an {@code Object} subscriber, because
 * {@code Object} is a supertype of all of them, so that is what this registers.
 * The handler must therefore stay CHEAP and must never throw: it runs on the
 * posting thread, for every event on the gateway's bus, and a slow subscriber
 * there slows the poster down.</p>
 */
public final class DesignerPresenceListener {

    private static final Logger logger = LoggerFactory.getLogger(DesignerPresenceListener.class);

    /** The internal event types, by name because we cannot name them in code. */
    private static final String UPDATE =
        "com.inductiveautomation.ignition.gateway.event.DesignerResourceSessionEvent$UpdateEvent";
    private static final String DESTROY =
        "com.inductiveautomation.ignition.gateway.event.DesignerResourceSessionEvent$DestroyEvent";

    private final PresenceRegistry registry;

    /** Said once, not once per event: a bus this busy would fill a log in minutes. */
    private final AtomicBoolean warned = new AtomicBoolean();

    /** True once a real event has been understood — what the live suite asserts. */
    private final AtomicBoolean sawEvent = new AtomicBoolean();

    public DesignerPresenceListener(PresenceRegistry registry) {
        this.registry = registry;
    }

    /**
     * Every event on the gateway bus. Almost all of them are not ours.
     *
     * <p>Two string comparisons and a return, for anything else. The work only
     * happens for the two event types this feature is about.</p>
     */
    @Subscribe
    public void onGatewayEvent(Object event) {
        if (event == null) {
            return;
        }
        String type = event.getClass().getName();
        try {
            if (UPDATE.equals(type)) {
                onUpdate(event);
            } else if (DESTROY.equals(type)) {
                onDestroy(event);
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            // The shape changed, or a value was not what it was in 8.3.8. Stop
            // contributing rather than throwing on the platform's own thread.
            if (warned.compareAndSet(false, true)) {
                logger.info(
                    "Designer presence is unavailable on this gateway — {} did not have the "
                        + "shape this module expects ({}). Presence still reports this IDE's "
                        + "own clients and Designer sessions at project level.",
                    type, e.toString());
            }
        }
    }

    /** True once at least one Designer event has been read successfully. */
    public boolean hasSeenEvent() {
        return sawEvent.get();
    }

    private void onUpdate(Object event) throws ReflectiveOperationException {
        String project = (String) accessor(event, "projectName").invoke(event);
        Object raw = accessor(event, "update").invoke(event);
        if (!(raw instanceof ResourceSession session)) {
            return;
        }
        ConcurrencySessionInfo info = session.sessionInfo();
        if (info == null) {
            return;
        }
        sawEvent.set(true);
        registry.put(new Peer(
            info.id(),
            info.username(),
            // The hostname is what makes this useful when it is the SAME person
            // in two places, which is the case the feature exists for. Fall back
            // to the address, because a blank "where from" answers nothing.
            info.hostname() == null || info.hostname().isBlank()
                ? info.ipAddress() : info.hostname(),
            Kind.DESIGNER,
            project,
            encode(session.resources()),
            info.creationTime()));
    }

    private void onDestroy(Object event) throws ReflectiveOperationException {
        Object id = accessor(event, "publicId").invoke(event);
        if (id instanceof String sessionId) {
            registry.remove(sessionId);
        }
    }

    /**
     * A record accessor by name.
     *
     * <p>Not cached: these fire on a Designer opening or closing a resource, which
     * is a human-paced event, and a cache keyed on a class we cannot name is more
     * moving parts than the lookup costs.</p>
     */
    private static Method accessor(Object event, String name) throws NoSuchMethodException {
        Method method = event.getClass().getMethod(name);
        method.setAccessible(true);
        return method;
    }

    /**
     * Resource paths in the form the rest of this module uses.
     *
     * <p>The same {@code <moduleId>/<typeId>/<name>} encoding as
     * {@code HandlerSupport.encodePath}, and it must stay the same: the client
     * compares these against the paths its own tabs carry, and a presence
     * indicator that never matches is indistinguishable from nobody being
     * there.</p>
     */
    private static List<String> encode(Collection<ResourcePath> resources) {
        if (resources == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>(resources.size());
        for (ResourcePath path : resources) {
            if (path == null) {
                continue;
            }
            ResourceType type = path.getResourceType();
            if (type == null) {
                continue;
            }
            // getPath() is non-null; a type-root path answers with an empty one,
            // which is the singleton case and encodes to two segments.
            String tail = path.getPath().toString();
            out.add(type.moduleId() + "/" + type.typeId() + (tail.isEmpty() ? "" : "/" + tail));
        }
        return out;
    }
}
