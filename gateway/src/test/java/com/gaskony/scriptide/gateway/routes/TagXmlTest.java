package com.gaskony.scriptide.gateway.routes;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TagXmlTest {

    private static final String LEGACY = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Tags>\n"
        + "<Tag name=\"A\" type=\"Folder\" path=\"\"/>\n"
        + "<Tag name=\"B\" type=\"Folder\" path=\"A\"/>\n"
        + "<Tag name=\"c\" type=\"DB\" path=\"A/B\"><Property name=\"DataType\">Int4</Property></Tag>\n"
        + "</Tags>";

    @Test
    @DisplayName("MinVersion marks the 8.x export; its absence marks the flat pre-8 format")
    void detectsFormat() {
        assertThat(TagXml.isCurrentFormat("<Tags MinVersion=\"8.0.0\" locale=\"en_US\"></Tags>")).isTrue();
        assertThat(TagXml.isCurrentFormat(LEGACY)).isFalse();
        assertThat(TagXml.isCurrentFormat(null)).isFalse();
    }

    @Test
    @DisplayName("rebasing prefixes every path attribute, an empty one becoming the base itself")
    void rebasesLegacy() throws Exception {
        String out = TagXml.rebaseLegacy(LEGACY, "Plant/Area");
        assertThat(out).contains("path=\"Plant/Area\"")
            .contains("path=\"Plant/Area/A\"")
            .contains("path=\"Plant/Area/A/B\"")
            // the base's own ancestors become explicit folders
            .contains("name=\"Plant\"").contains("name=\"Area\"")
            .contains("<Property name=\"DataType\">Int4</Property>");
    }

    @Test
    @DisplayName("an import at the provider root is left untouched")
    void rootBaseIsUntouched() throws Exception {
        assertThat(TagXml.rebaseLegacy(LEGACY, "")).isSameAs(LEGACY);
    }

    @Test
    @DisplayName("a document with a DTD is refused rather than expanded")
    void refusesDoctype() {
        String evil = "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]>"
            + "<Tags><Tag name=\"a\" path=\"&e;\"/></Tags>";
        assertThatThrownBy(() -> TagXml.rebaseLegacy(evil, "P")).isInstanceOf(Exception.class);
    }
}
