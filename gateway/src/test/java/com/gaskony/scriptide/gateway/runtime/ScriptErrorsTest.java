package com.gaskony.scriptide.gateway.runtime;

import com.inductiveautomation.ignition.common.logging.Level;
import com.inductiveautomation.ignition.common.logging.LogEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Grouping and attribution for the runtime-error list.
 *
 * <p>The query itself needs a gateway; the part with judgement in it is which
 * events belong to a project and how many distinct problems they represent, and
 * that is what is tested here.</p>
 */
class ScriptErrorsTest {

    private static LogEvent event(String loggerName, String message, long at, Level level) {
        LogEvent e = new LogEvent();
        e.setLoggerName(loggerName);
        e.setMessage(message);
        e.setTimestamp(at);
        e.setLevel(level);
        return e;
    }

    /** The real shape, measured off this gateway's log on 05/09/2026. */
    private static final String TIMER_LOGGER =
        "com.inductiveautomation.ignition.common.script.ExtensionFunctionTimerScriptTask";
    private static final String TIMER_MESSAGE =
        "Parse Error in timer script: 'Site_Redgum_Sewer/MyTimerScript @1,000ms '";

    @Test
    @DisplayName("attributes a real timer-script failure to its project")
    void matchesTheMeasuredShape() {
        List<ScriptErrors.ScriptError> found = ScriptErrors.group(
            List.of(event(TIMER_LOGGER, TIMER_MESSAGE, 1000, Level.ERROR)),
            "Site_Redgum_Sewer");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).message()).isEqualTo(TIMER_MESSAGE);
        assertThat(found.get(0).level()).isEqualTo("ERROR");
        assertThat(found.get(0).count()).isEqualTo(1);
    }

    @Test
    @DisplayName("leaves another project's failures alone")
    void ignoresOtherProjects() {
        assertThat(ScriptErrors.group(
            List.of(event(TIMER_LOGGER, TIMER_MESSAGE, 1000, Level.ERROR)),
            "Mining_Demo")).isEmpty();
    }

    @Test
    @DisplayName("collapses a repeating failure into ONE problem with a count")
    void groupsRepeats() {
        // A timer failing every second is 3,600 log lines an hour and one
        // problem. A panel that lists all 3,600 is unusable exactly when it
        // matters most.
        List<ScriptErrors.ScriptError> found = ScriptErrors.group(
            List.of(
                event(TIMER_LOGGER, TIMER_MESSAGE, 1000, Level.ERROR),
                event(TIMER_LOGGER, TIMER_MESSAGE, 2000, Level.ERROR),
                event(TIMER_LOGGER, TIMER_MESSAGE, 3000, Level.ERROR)),
            "Site_Redgum_Sewer");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).count()).isEqualTo(3);
        assertThat(found.get(0).lastSeen()).isEqualTo(3000);
    }

    @Test
    @DisplayName("different messages from the same logger stay separate problems")
    void keepsDistinctMessagesApart() {
        assertThat(ScriptErrors.group(
            List.of(
                event(TIMER_LOGGER, "Parse Error in timer script: 'P/One @1,000ms '", 1000,
                    Level.ERROR),
                event(TIMER_LOGGER, "Parse Error in timer script: 'P/Two @1,000ms '", 2000,
                    Level.ERROR)),
            "P")).hasSize(2);
    }

    @Test
    @DisplayName("most recent first")
    void sortsByRecency() {
        List<ScriptErrors.ScriptError> found = ScriptErrors.group(
            List.of(
                event("a", "old thing in P", 1000, Level.WARN),
                event("b", "new thing in P", 5000, Level.ERROR)),
            "P");
        assertThat(found.get(0).message()).isEqualTo("new thing in P");
    }

    @Test
    @DisplayName("matches on the logger name too, not only the message")
    void matchesOnLoggerName() {
        assertThat(ScriptErrors.group(
            List.of(event("Project[Mining_Demo].Timer", "something failed", 1, Level.ERROR)),
            "Mining_Demo")).hasSize(1);
    }

    @Test
    @DisplayName("keeps the first stack-trace line when there is one")
    void keepsOneTraceLine() {
        LogEvent e = event(TIMER_LOGGER, TIMER_MESSAGE, 1, Level.ERROR);
        e.setException(new String[] {
            "  at org.python.core.Py.SyntaxError(Py.java:1)",
            "  at somewhere.else(Else.java:2)",
        });
        List<ScriptErrors.ScriptError> found = ScriptErrors.group(List.of(e), "Site_Redgum_Sewer");
        assertThat(found.get(0).exception()).isEqualTo("at org.python.core.Py.SyntaxError(Py.java:1)");
    }

    @Test
    @DisplayName("an event with no level is reported rather than dropped")
    void toleratesAMissingLevel() {
        List<ScriptErrors.ScriptError> found = ScriptErrors.group(
            List.of(event("l", "P broke", 1, null)), "P");
        assertThat(found).hasSize(1);
        assertThat(found.get(0).level()).isEqualTo("WARN");
    }

    @Test
    @DisplayName("nothing in, nothing out")
    void emptyInputs() {
        assertThat(ScriptErrors.group(null, "P")).isEmpty();
        assertThat(ScriptErrors.group(List.of(), "P")).isEmpty();
        assertThat(ScriptErrors.forProject(null, "P", 1000)).isEmpty();
    }
}
