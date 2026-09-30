package com.gaskony.scriptide.gateway.presence;

import com.gaskony.scriptide.gateway.presence.Presence.Kind;
import com.gaskony.scriptide.gateway.presence.Presence.Peer;
import com.inductiveautomation.ignition.common.ConcurrencySessionInfo;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceType;
import com.inductiveautomation.ignition.designer.concurrency.ResourceSession;
import com.inductiveautomation.ignition.gateway.event.DesignerResourceSessionEvent;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/**
 * The reflective half, against a stand-in with the platform's exact names.
 *
 * <p>See {@link DesignerResourceSessionEvent} in the test tree for why the
 * stand-in lives in Inductive Automation's package rather than ours.</p>
 */
class DesignerPresenceListenerTest {

    private static final ResourceType LIBRARY = new ResourceType("ignition", "script-python");

    private static ResourceSession session(String id, String user, String... names) {
        List<ResourcePath> paths = java.util.Arrays.stream(names)
            .map(name -> new ResourcePath(LIBRARY, name))
            .toList();
        return new ResourceSession(
            new ConcurrencySessionInfo(id, "10.0.0.9", "sams-laptop", user, 1234L),
            paths);
    }

    @Test
    void readsAnUpdateIntoAPeerWithTheModuleSOwnPathForm() {
        // The path encoding is the load-bearing part: the browser compares these
        // against the paths its own tabs carry, and an indicator that never
        // matches is indistinguishable from nobody being there.
        PresenceRegistry registry = new PresenceRegistry();
        DesignerPresenceListener listener = new DesignerPresenceListener(registry);

        listener.onGatewayEvent(new DesignerResourceSessionEvent.UpdateEvent(
            "Water", session("s1", "sam", "util/helpers")));

        assertThat(registry.peers()).singleElement().satisfies(peer -> {
            assertThat(peer.sessionId()).isEqualTo("s1");
            assertThat(peer.username()).isEqualTo("sam");
            assertThat(peer.kind()).isEqualTo(Kind.DESIGNER);
            assertThat(peer.project()).isEqualTo("Water");
            assertThat(peer.resources())
                .containsExactly("ignition/script-python/util/helpers");
        });
        assertThat(listener.hasSeenEvent()).isTrue();
    }

    @Test
    void prefersTheHostnameBecauseTheSamePersonIsOftenInTwoPlaces() {
        PresenceRegistry registry = new PresenceRegistry();
        new DesignerPresenceListener(registry).onGatewayEvent(
            new DesignerResourceSessionEvent.UpdateEvent("P", session("s1", "sam", "a")));

        assertThat(registry.peers().get(0).host()).isEqualTo("sams-laptop");
    }

    @Test
    void fallsBackToTheAddressWhenThereIsNoHostname() {
        // A blank "where from" answers nothing, which is worse than an IP.
        PresenceRegistry registry = new PresenceRegistry();
        ResourceSession noHost = new ResourceSession(
            new ConcurrencySessionInfo("s1", "10.0.0.9", "  ", "sam", 1L),
            List.of(new ResourcePath(LIBRARY, "a")));

        new DesignerPresenceListener(registry).onGatewayEvent(
            new DesignerResourceSessionEvent.UpdateEvent("P", noHost));

        assertThat(registry.peers().get(0).host()).isEqualTo("10.0.0.9");
    }

    @Test
    void aDestroyRemovesThePeerUnderTheSameIdAnUpdateRecordedItWith() {
        // Measured off 8.3.8's bytecode: ConcurrencySessionInfo.id() IS
        // ClientReqSession.getPublicId(), which is what DestroyEvent carries. If
        // those two ever differ, a closed Designer is never removed and the
        // indicator only ever grows.
        PresenceRegistry registry = new PresenceRegistry();
        DesignerPresenceListener listener = new DesignerPresenceListener(registry);
        listener.onGatewayEvent(new DesignerResourceSessionEvent.UpdateEvent(
            "P", session("s1", "sam", "a")));

        listener.onGatewayEvent(new DesignerResourceSessionEvent.DestroyEvent("P", "s1"));

        assertThat(registry.peers()).isEmpty();
    }

    @Test
    void ignoresEveryOtherEventOnTheBusWithoutTouchingIt() {
        // It subscribes to Object, so it sees the whole gateway's traffic. Two
        // string comparisons and a return is the entire cost for anything else.
        PresenceRegistry registry = new PresenceRegistry();
        DesignerPresenceListener listener = new DesignerPresenceListener(registry);

        listener.onGatewayEvent("a string");
        listener.onGatewayEvent(new Object());
        listener.onGatewayEvent(null);

        assertThat(registry.peers()).isEmpty();
        assertThat(listener.hasSeenEvent()).isFalse();
    }

    @Test
    void anUpdateCarryingNothingIsIgnoredRatherThanThrown() {
        // This runs on the platform's own posting thread, so every failure mode
        // has to end in a return. A renamed accessor is the other one, and it is
        // caught by the same handler and reported once — only the gateway can
        // prove that half, which is what validate_v30_presence.py is for.
        PresenceRegistry registry = new PresenceRegistry();
        DesignerPresenceListener listener = new DesignerPresenceListener(registry);

        assertThatCode(() -> listener.onGatewayEvent(
            new DesignerResourceSessionEvent.UpdateEvent("P", null)))
            .doesNotThrowAnyException();
        assertThat(registry.peers()).isEmpty();
        assertThat(listener.hasSeenEvent()).isFalse();
    }

    @Test
    void aSessionWithNoIdentityIsIgnored() {
        // Without ConcurrencySessionInfo there is no session id, and a peer with
        // no id cannot be deduplicated, replaced, or removed on destroy.
        PresenceRegistry registry = new PresenceRegistry();
        DesignerPresenceListener listener = new DesignerPresenceListener(registry);

        listener.onGatewayEvent(new DesignerResourceSessionEvent.UpdateEvent(
            "P", new ResourceSession(null, List.of())));

        assertThat(registry.peers()).isEmpty();
    }

    @Test
    void anUpdateReplacesThatSessionSResourcesRatherThanAddingToThem() {
        // A Designer sends its CURRENT list, not a delta. Merging would leave a
        // name on every file that session had ever opened.
        PresenceRegistry registry = new PresenceRegistry();
        DesignerPresenceListener listener = new DesignerPresenceListener(registry);
        listener.onGatewayEvent(new DesignerResourceSessionEvent.UpdateEvent(
            "P", session("s1", "sam", "a", "b")));

        listener.onGatewayEvent(new DesignerResourceSessionEvent.UpdateEvent(
            "P", session("s1", "sam", "b")));

        assertThat(registry.peers()).singleElement()
            .extracting(Peer::resources)
            .isEqualTo(List.of("ignition/script-python/b"));
    }
}
