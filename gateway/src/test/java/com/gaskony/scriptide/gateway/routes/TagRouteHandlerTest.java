package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.tags.config.CollisionPolicy;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TagRouteHandlerTest {

    @Test
    @DisplayName("a create with no or an unknown collision policy aborts rather than overwriting")
    void unknownCollisionPolicyAborts() {
        assertThat(TagRouteHandler.collisionPolicy(null)).isEqualTo(CollisionPolicy.Abort);
        assertThat(TagRouteHandler.collisionPolicy("nonsense")).isEqualTo(CollisionPolicy.Abort);
    }

    @Test
    @DisplayName("a named collision policy is honoured whatever its case")
    void namedCollisionPolicyIsHonoured() {
        assertThat(TagRouteHandler.collisionPolicy("overwrite")).isEqualTo(CollisionPolicy.Overwrite);
        assertThat(TagRouteHandler.collisionPolicy("MergeOverwrite")).isEqualTo(CollisionPolicy.MergeOverwrite);
    }

    @Test
    @DisplayName("a copy into its own folder defaults to Rename, anything else to Abort, and a named policy wins")
    void moveCollisionDefaults() {
        assertThat(TagRouteHandler.moveCollisionPolicy(null, true)).isEqualTo(CollisionPolicy.Rename);
        assertThat(TagRouteHandler.moveCollisionPolicy(" ", false)).isEqualTo(CollisionPolicy.Abort);
        assertThat(TagRouteHandler.moveCollisionPolicy("Overwrite", true)).isEqualTo(CollisionPolicy.Overwrite);
    }

    @Test
    @DisplayName("a new tag name may not be blank, padded, or hold a path delimiter")
    void nameValidation() {
        assertThat(TagRouteHandler.validName("Pump_1")).isTrue();
        assertThat(TagRouteHandler.validName("Pump 1")).isTrue();
        assertThat(TagRouteHandler.validName(null)).isFalse();
        assertThat(TagRouteHandler.validName("  ")).isFalse();
        assertThat(TagRouteHandler.validName(" Pump")).isFalse();
        assertThat(TagRouteHandler.validName("a/b")).isFalse();
        assertThat(TagRouteHandler.validName("a[b")).isFalse();
        assertThat(TagRouteHandler.validName("a]b")).isFalse();
    }

    @Test
    @DisplayName("a signature is stable for equal text and differs when one character does")
    void signatureIsStable() {
        assertThat(TagRouteHandler.signature("{\"a\":1}")).isEqualTo(TagRouteHandler.signature("{\"a\":1}"))
            .hasSize(64);
        assertThat(TagRouteHandler.signature("{\"a\":1}")).isNotEqualTo(TagRouteHandler.signature("{\"a\":2}"));
    }

    @Test
    @DisplayName("a save may not rename or retype the tag")
    void identityChecks() {
        JsonObject same = TagRouteHandler.parseObject("{\"name\":\"T1\",\"tagType\":\"AtomicTag\"}");
        assertThat(TagRouteHandler.identityProblem(same, "T1", "AtomicTag")).isNull();
        assertThat(TagRouteHandler.identityProblem(same, "T2", "AtomicTag")).contains("rename");
        assertThat(TagRouteHandler.identityProblem(same, "T1", "Folder")).contains("type");
        assertThat(TagRouteHandler.identityProblem(new JsonObject(), "T1", "Folder")).isNull();
    }

    @Test
    @DisplayName("only a single JSON object parses as a configuration")
    void parseObjectRejectsOtherShapes() {
        assertThat(TagRouteHandler.parseObject("[1]")).isNull();
        assertThat(TagRouteHandler.parseObject("{oops")).isNull();
        assertThat(TagRouteHandler.parseObject("{}")).isNotNull();
    }

    @Test
    @DisplayName("the category key loses its i18n prefix and an unknown one is 'other'")
    void categories() {
        assertThat(TagRouteHandler.categoryOf("tags.editing.category.history")).isEqualTo("history");
        assertThat(TagRouteHandler.categoryOf("tags.editing.category.mystery")).isEqualTo("other");
        assertThat(TagRouteHandler.categoryOf(null)).isEqualTo("other");
    }

    @Test
    @DisplayName("default values serialise as plain JSON: enums by name, NaN as text")
    void plainValues() {
        assertThat(TagRouteHandler.plain(CollisionPolicy.Abort).getAsString()).isEqualTo("Abort");
        assertThat(TagRouteHandler.plain(Double.NaN).getAsString()).isEqualTo("NaN");
        assertThat(TagRouteHandler.plain(null).isJsonNull()).isTrue();
        assertThat(TagRouteHandler.plain(3).getAsInt()).isEqualTo(3);
    }

    @Test
    @DisplayName("local overrides sit over inherited values, merging nested objects and leaving both inputs alone")
    void mergeLaysLocalOverInherited() {
        JsonObject inherited = TagRouteHandler.parseObject("{\"engUnit\":\"m\",\"parameters\":{\"p1\":1,\"p2\":2}}");
        JsonObject local = TagRouteHandler.parseObject("{\"engUnit\":\"cm\",\"parameters\":{\"p1\":9}}");
        JsonObject merged = TagRouteHandler.merge(inherited, local);
        assertThat(merged.get("engUnit").getAsString()).isEqualTo("cm");
        assertThat(merged.getAsJsonObject("parameters").get("p1").getAsInt()).isEqualTo(9);
        assertThat(merged.getAsJsonObject("parameters").get("p2").getAsInt()).isEqualTo(2);
        assertThat(inherited.get("engUnit").getAsString()).isEqualTo("m");
    }
}
