package com.gaskony.scriptide.gateway.routes;

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
}
