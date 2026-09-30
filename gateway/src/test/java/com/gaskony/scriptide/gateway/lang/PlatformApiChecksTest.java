package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The two platform-API rules.
 *
 * <p>Every negative case here is a false positive that would have shipped, so
 * they carry as much weight as the positive ones — the rule this module works
 * to is that a mark on working code costs more than a missed problem.</p>
 */
class PlatformApiChecksTest {

    /** An index that knows the given paths, with the given ones deprecated. */
    private static PlatformApiChecks.Api index(Set<String> present, Set<String> deprecated) {
        return new PlatformApiChecks.Api() {
            @Override
            public boolean isDeprecated(String dottedPath) {
                return deprecated.contains(dottedPath);
            }

            @Override
            public boolean exists(String dottedPath) {
                return present.contains(dottedPath);
            }
        };
    }

    private static final Set<String> GATEWAY_API = Set.of(
        "system", "system.tag", "system.db", "system.util", "system.perspective",
        "system.tag.readBlocking", "system.db.runQuery", "system.util.getLogger",
        "system.db.runScalarQuery");

    private static List<PlatformApiChecks.Finding> check(String source, boolean gatewayScope) {
        return PlatformApiChecks.find(ModuleSymbols.parse("<t>", source).apiCalls(),
            index(GATEWAY_API, Set.of("system.db.runScalarQuery")), gatewayScope);
    }

    // ==================== deprecation ====================

    @Test
    @DisplayName("a deprecated call is reported wherever it appears")
    void reportsDeprecated() {
        List<PlatformApiChecks.Finding> found = check("system.db.runScalarQuery('x')", false);
        assertThat(found).hasSize(1);
        assertThat(found.get(0).kind()).isEqualTo(PlatformApiChecks.Kind.DEPRECATED);
        assertThat(found.get(0).message()).contains("system.db.runScalarQuery", "deprecated");
    }

    @Test
    @DisplayName("a call that is NOT deprecated is not reported")
    void silentOnCurrentApi() {
        assertThat(check("system.db.runQuery('x')", true)).isEmpty();
    }

    @Test
    @DisplayName("one mark per path, however many times it is called")
    void onePerPath() {
        assertThat(check("system.db.runScalarQuery('a')\nsystem.db.runScalarQuery('b')", false))
            .hasSize(1);
    }

    // ==================== scope ====================

    @Test
    @DisplayName("a package the gateway does not have is reported in a gateway script")
    void reportsClientPackageInGatewayScript() {
        List<PlatformApiChecks.Finding> found = check("system.gui.messageBox('hi')", true);
        assertThat(found).hasSize(1);
        assertThat(found.get(0).kind()).isEqualTo(PlatformApiChecks.Kind.NOT_IN_SCOPE);
        assertThat(found.get(0).message()).contains("system.gui", "Gateway");
    }

    @Test
    @DisplayName("the SAME call in a library module is not reported — a client may import it")
    void silentOutsideGatewayScope() {
        assertThat(check("system.gui.messageBox('hi')", false)).isEmpty();
    }

    @Test
    @DisplayName("one mark per package, not per call")
    void onePerPackage() {
        assertThat(check("system.gui.messageBox('a')\nsystem.gui.confirm('b')", true)).hasSize(1);
    }

    @Test
    @DisplayName("an unknown FUNCTION under a known package is never reported")
    void silentOnUnknownLeaf() {
        // The index is built under a time budget, so a missing leaf can mean the
        // walk gave up. Only a missing package is a claim.
        assertThat(check("system.tag.readBlokcing(['a'])", true)).isEmpty();
    }

    @Test
    @DisplayName("a project script-library root is never judged")
    void silentOnProjectRoots() {
        assertThat(check("MachineDemo.api.read('x')", true)).isEmpty();
    }

    @Test
    @DisplayName("nothing is reported when the index is empty or broken")
    void silentWhenIndexUnusable() {
        List<PlatformApiChecks.Finding> found = PlatformApiChecks.find(
            ModuleSymbols.parse("<t>", "system.gui.messageBox('hi')").apiCalls(),
            index(Set.of(), Set.of()), true);
        assertThat(found).isEmpty();
    }

    @Test
    @DisplayName("a bare `system` passed around is not a package claim")
    void silentOnBareSystem() {
        assertThat(check("f(system)", true)).isEmpty();
    }

    @Test
    @DisplayName("a null index reports nothing rather than everything")
    void silentOnNullIndex() {
        assertThat(PlatformApiChecks.find(
            ModuleSymbols.parse("<t>", "system.gui.messageBox('x')").apiCalls(),
            PlatformApiChecks.of(null), true)).isEmpty();
    }

    @Test
    @DisplayName("deprecation wins over scope for the same call")
    void deprecationTakesPrecedence() {
        List<PlatformApiChecks.Finding> found = PlatformApiChecks.find(
            ModuleSymbols.parse("<t>", "system.old.thing()").apiCalls(),
            index(Set.of("system"), Set.of("system.old.thing")), true);
        assertThat(found).hasSize(1);
        assertThat(found.get(0).kind()).isEqualTo(PlatformApiChecks.Kind.DEPRECATED);
    }
}
