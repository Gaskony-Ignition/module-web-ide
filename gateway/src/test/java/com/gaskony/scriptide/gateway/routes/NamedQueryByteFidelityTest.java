package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * What {@code NamedQuery.toResource} actually writes into {@code query.sql}.
 *
 * <p>Measured against the running 8.3.8 gateway on 02/09/2026 and asserted here
 * against the same serialiser from the SDK jar. The rule is the scripts' rule: the
 * text the user typed, nothing added, nothing stripped. A save that normalises a
 * trailing newline turns every subsequent git diff on the project into noise, and
 * it is invisible until someone diffs a repository.</p>
 */
class NamedQueryByteFidelityTest {

    private static byte[] queryFileOf(String sql) {
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery(sql);
        Resource resource = NamedQueryCodecTest.build(q);
        return resource.getData(NamedQueryRouteHandler.QUERY_FILE)
            .orElseThrow(() -> new AssertionError("no query.sql on the built resource"))
            .getBytes();
    }

    @Test
    @DisplayName("no trailing newline is ADDED — 19 bytes for 19 characters")
    void noTrailingNewlineIsAdded() {
        // Measured on the rig: "SELECT :v AS echoed" -> 19 bytes, hex
        // 53454c454354203a76204153206563686f6564.
        byte[] bytes = queryFileOf("SELECT :v AS echoed");

        assertThat(bytes).hasSize(19);
        assertThat(new String(bytes, StandardCharsets.UTF_8)).isEqualTo("SELECT :v AS echoed");
    }

    @Test
    @DisplayName("a trailing newline that was there is PRESERVED")
    void trailingNewlineIsPreserved() {
        // Measured on the rig: "SELECT 1\n" -> 9 bytes. The Designer's own files
        // on the gateway carry one, so stripping it would rewrite every query the
        // Designer ever saved.
        byte[] bytes = queryFileOf("SELECT 1\n");

        assertThat(bytes).hasSize(9);
        assertThat(new String(bytes, StandardCharsets.UTF_8)).isEqualTo("SELECT 1\n");
    }

    @Test
    @DisplayName("an empty query still writes the data key, with zero bytes")
    void emptyQueryStillWritesTheKey() {
        // Measured. It matters because a resource with no query.sql at all is how
        // this handler recognises a FOLDER — an empty query must not look like one.
        byte[] bytes = queryFileOf("");

        assertThat(bytes).isEmpty();
    }

    @Test
    @DisplayName("tabs, CRLF and non-ASCII survive byte for byte")
    void whitespaceAndUnicodeSurvive() {
        String sql = "SELECT\t'café'\r\nFROM t\r\n";
        byte[] bytes = queryFileOf(sql);

        assertThat(bytes).isEqualTo(sql.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("the round trip through the platform's own reader returns the same text")
    void readBackIsIdentical() {
        String sql = "SELECT :a,\n       :b\nFROM t\n";
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery(sql);

        assertThat(NamedQueryCodecTest.readBack(q).getQuery()).isEqualTo(sql);
    }

    @Test
    @DisplayName("query.sql is the ONLY data key a named query carries")
    void oneDataKey() {
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery("SELECT 1");

        assertThat(NamedQueryCodecTest.build(q).getDataKeys())
            .containsExactly(NamedQueryRouteHandler.QUERY_FILE);
    }

    @Test
    @DisplayName("toResource stamps the CURRENT resource version, which is what makes a query runnable")
    void versionIsStamped() {
        // A version-1 resource is not readable by the gateway at all — see
        // docs/NAMED-QUERIES.md §1.5. Every write this module makes goes through
        // toResource precisely so it lands at version 2.
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery("SELECT 1");

        assertThat(NamedQueryCodecTest.build(q).getVersion())
            .isEqualTo(NamedQuery.CURRENT_RESOURCE_VERSION)
            .isEqualTo(2);
    }

    @Test
    @DisplayName("toResource UPGRADES a version-1 builder — this is the whole legacy repair")
    void toResourceUpgradesALegacyBuilder() {
        // The settings POST is what fixes a dead version-1 query, and it does so
        // by rewriting the resource through toResource. If the serialiser
        // preserved the builder's existing version instead of stamping the current
        // one, the save would appear to succeed and the query would still be
        // unrunnable — a repair that silently does nothing. So the upgrade is
        // asserted on a builder that starts at version 1, not on a fresh one.
        Resource legacy = Resource.newBuilder()
            .setResourceCollectionName("TestProject")
            .setResourcePath(new com.inductiveautomation.ignition.common.resourcecollection
                .ResourcePath(NamedQuery.RESOURCE_TYPE, "Legacy"))
            .setVersion(NamedQuery.LEGACY_RESOURCE_VERSION)
            .putData(NamedQueryRouteHandler.QUERY_FILE, "SELECT 1")
            .build();
        assertThat(legacy.getVersion()).isEqualTo(1);

        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setQuery("SELECT 1");
        var builder = legacy.toBuilder();
        NamedQuery.toResource(q).accept(builder);

        assertThat(builder.build().getVersion())
            .as("a settings save on a legacy query must land at version 2 or the repair is a lie")
            .isEqualTo(NamedQuery.CURRENT_RESOURCE_VERSION);
    }
}
