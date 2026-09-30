package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** The audit summary must identify a script without reproducing it. */
class ExecAuditTest {

    @Test
    @DisplayName("the summary carries a hash, never the source")
    void summaryNeverContainsTheSource() {
        String secret = "password = 'hunter2'\nprint password\n";
        String summary = ExecAudit.summarise(secret);

        // The whole point: an audit table is not a code store, and a credential
        // typed into the console must not be copied into it.
        assertThat(summary).doesNotContain("hunter2");
        assertThat(summary).doesNotContain("password");
        assertThat(summary).matches("sha256=[0-9a-f]{64} bytes=\\d+ lines=\\d+");
    }

    @Test
    @DisplayName("identical sources hash identically, different ones do not")
    void hashIdentifiesTheScript() {
        assertThat(ExecAudit.summarise("print 1\n")).isEqualTo(ExecAudit.summarise("print 1\n"));
        assertThat(ExecAudit.summarise("print 1\n")).isNotEqualTo(ExecAudit.summarise("print 2\n"));
    }

    @Test
    @DisplayName("byte length is measured in UTF-8, not characters")
    void lengthIsUtf8Bytes() {
        // A non-ASCII script must not under-report its size.
        String source = "x = 'café'\n";
        String summary = ExecAudit.summarise(source);
        int expected = source.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        assertThat(summary).contains("bytes=" + expected);
        assertThat(expected).isGreaterThan(source.length());
    }

    @Test
    @DisplayName("a null or empty source is summarised rather than throwing")
    void handlesEmptyInput() {
        assertThat(ExecAudit.summarise(null)).contains("bytes=0").contains("lines=0");
        assertThat(ExecAudit.summarise("")).contains("bytes=0").contains("lines=0");
    }
}
