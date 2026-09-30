package com.gaskony.scriptide.gateway.presence;

import com.gaskony.scriptide.gateway.presence.Presence.Kind;
import com.gaskony.scriptide.gateway.presence.Presence.Peer;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

class PresenceRegistryTest {

    private static Peer ide(String id, String project, String... resources) {
        return new Peer(id, "nigel", "workstation", Kind.IDE, project, List.of(resources), 1000L);
    }

    private static Peer designer(String id, String project, String... resources) {
        return new Peer(id, "sam", "laptop", Kind.DESIGNER, project, List.of(resources), 2000L);
    }

    @Test
    void findsEveryoneElseOnAFileAndNeverTheCaller() {
        // The property the whole indicator rests on: your own tab must not light
        // it up, or it is on permanently and means nothing.
        PresenceRegistry registry = new PresenceRegistry();
        registry.put(ide("me", "P", "ignition/script-python/util"));
        registry.put(designer("them", "P", "ignition/script-python/util"));

        List<Peer> others = registry.othersOn("P", "ignition/script-python/util", "me");

        assertThat(others).extracting(Peer::sessionId).containsExactly("them");
    }

    @Test
    void doesNotMatchTheSamePathInAnotherProject() {
        // `ignition/script-python/util` exists in every project on the gateway.
        // Keying on the path alone would report a clash between two people who
        // are not in the same file at all.
        PresenceRegistry registry = new PresenceRegistry();
        registry.put(designer("them", "Other", "ignition/script-python/util"));

        assertThat(registry.othersOn("P", "ignition/script-python/util", "me")).isEmpty();
    }

    @Test
    void anIdenticalRedeliveryIsNotAChange() {
        // A Designer re-sends its whole resource list on every open and close, so
        // identical updates are the common case. Bumping the version for each
        // would re-render every client's tree for nothing.
        PresenceRegistry registry = new PresenceRegistry();
        AtomicInteger notifications = new AtomicInteger();
        registry.addListener(version -> notifications.incrementAndGet());

        registry.put(designer("them", "P", "a"));
        registry.put(designer("them", "P", "a"));

        assertThat(notifications.get()).isEqualTo(1);
        assertThat(registry.version()).isEqualTo(1);
    }

    @Test
    void aRealChangeToTheSameSessionDoesNotify() {
        PresenceRegistry registry = new PresenceRegistry();
        AtomicInteger notifications = new AtomicInteger();
        registry.addListener(version -> notifications.incrementAndGet());

        registry.put(designer("them", "P", "a"));
        registry.put(designer("them", "P", "a", "b"));

        assertThat(notifications.get()).isEqualTo(2);
    }

    @Test
    void aSessionLevelSweepNeverBlanksResourcesTheEventFeedFound() {
        // The two feeds race by construction. The sweep sees a Designer session
        // every 15 seconds; its resource list arrives from the event bus. A plain
        // put here would blank the useful half of the answer on every sweep, and
        // the file indicator would flicker on a fifteen-second cycle.
        PresenceRegistry registry = new PresenceRegistry();
        registry.put(designer("them", "P", "ignition/script-python/util"));

        registry.putSessionLevel(designer("them", "P"));

        assertThat(registry.othersOn("P", "ignition/script-python/util", "me"))
            .hasSize(1);
    }

    @Test
    void aSessionLevelPeerIsRecordedWhenNothingIsOpenYet() {
        // A Designer open on a project with no script open is invisible to the
        // concurrency events and still worth knowing about.
        PresenceRegistry registry = new PresenceRegistry();
        registry.putSessionLevel(designer("them", "P"));

        assertThat(registry.peers()).hasSize(1);
        assertThat(registry.peers().get(0).resources()).isEmpty();
    }

    @Test
    void sweepingDropsADesignerThePlatformNoLongerLists() {
        // A Designer that is killed rather than closed sends no destroy event.
        PresenceRegistry registry = new PresenceRegistry();
        registry.put(designer("gone", "P", "a"));
        registry.put(designer("here", "P", "a"));

        registry.retainSessions(Set.of("here"));

        assertThat(registry.peers()).extracting(Peer::sessionId).containsExactly("here");
    }

    @Test
    void sweepingNeverDropsAnIdeClient() {
        // A browser has no ClientReqSession, so it appears in no session list. If
        // the sweep treated absence as departure it would delete every IDE peer
        // fifteen seconds after it connected.
        PresenceRegistry registry = new PresenceRegistry();
        registry.put(ide("browser", "P", "a"));

        registry.retainSessions(Set.of());

        assertThat(registry.peers()).extracting(Peer::sessionId).containsExactly("browser");
    }

    @Test
    void oneFailingListenerStillLetsTheOthersHear() {
        // A half-notified set is how two people end up with different ideas of
        // who is in a file.
        PresenceRegistry registry = new PresenceRegistry();
        List<Long> heard = new ArrayList<>();
        registry.addListener(version -> {
            throw new IllegalStateException("this client is broken");
        });
        registry.addListener(heard::add);

        registry.put(ide("me", "P", "a"));

        assertThat(heard).hasSize(1);
    }

    @Test
    void aPeerWithNoResourcesMatchesNoFile() {
        PresenceRegistry registry = new PresenceRegistry();
        registry.putSessionLevel(designer("them", "P"));

        assertThat(registry.othersOn("P", "ignition/script-python/util", "me")).isEmpty();
    }

    @Test
    void removingWhatIsNotThereIsSilentAndChangesNothing() {
        PresenceRegistry registry = new PresenceRegistry();
        registry.remove("never-existed");

        assertThat(registry.version()).isZero();
    }
}
