package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The dotted-path walker behind the platform API checks. */
class ApiCallsTest {

    private static List<String> paths(String source) {
        return ModuleSymbols.parse("<t>", source).apiCalls().stream()
            .map(ApiCalls.Call::path)
            .toList();
    }

    @Test
    @DisplayName("collects a full dotted path, not its prefixes")
    void collectsLongestChainOnly() {
        assertThat(paths("system.tag.readBlocking(['a'])"))
            .containsExactly("system.tag.readBlocking");
    }

    @Test
    @DisplayName("collects each distinct path in source order")
    void collectsEveryPath() {
        assertThat(paths("system.db.runQuery('x')\nsystem.util.getLogger('y')"))
            .containsExactly("system.db.runQuery", "system.util.getLogger");
    }

    @Test
    @DisplayName("a chain rooted in a call is not a path — its type is unknowable here")
    void ignoresChainsRootedInACall() {
        assertThat(paths("getThing().value.units")).isEmpty();
    }

    @Test
    @DisplayName("but a real path inside the rejected chain's base is still found")
    void walksIntoTheBaseOfARejectedChain() {
        assertThat(paths("system.tag.readBlocking(['a'])[0].value.quality"))
            .containsExactly("system.tag.readBlocking");
    }

    @Test
    @DisplayName("a bare name is not a path")
    void ignoresBareNames() {
        assertThat(paths("x = 1\nprint x")).isEmpty();
    }

    @Test
    @DisplayName("a path in an argument is found")
    void findsPathsInArguments() {
        assertThat(paths("foo(system.tag.readBlocking(['a']))"))
            .contains("system.tag.readBlocking");
    }

    @Test
    @DisplayName("the mark goes at the BASE name, with the AST's own 1-based line")
    void positionsAtTheBaseName() {
        List<ApiCalls.Call> calls = ModuleSymbols.parse("<t>",
            "def go():\n\treturn system.gui.messageBox('hi')\n").apiCalls();
        assertThat(calls).hasSize(1);
        assertThat(calls.get(0).line()).isEqualTo(2);
        // "\treturn " is one tab plus seven characters; the AST counts the tab as one.
        assertThat(calls.get(0).column()).isEqualTo(8);
    }

    @Test
    @DisplayName("a module that does not parse yields nothing")
    void emptyOnParseFailure() {
        assertThat(paths("def broken(:\n")).isEmpty();
    }

    @Test
    @DisplayName("packagePath is the first two segments; root is the first")
    void splitsPathsForTheChecks() {
        ApiCalls.Call call = new ApiCalls.Call("system.gui.messageBox", 1, 0);
        assertThat(call.packagePath()).isEqualTo("system.gui");
        assertThat(call.root()).isEqualTo("system");

        ApiCalls.Call two = new ApiCalls.Call("system.gui", 1, 0);
        assertThat(two.packagePath()).isEqualTo("system.gui");

        ApiCalls.Call one = new ApiCalls.Call("system", 1, 0);
        assertThat(one.packagePath()).isEqualTo("system");
        assertThat(one.root()).isEqualTo("system");
    }
}
