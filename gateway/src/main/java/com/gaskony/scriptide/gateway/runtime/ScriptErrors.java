package com.gaskony.scriptide.gateway.runtime;

import com.inductiveautomation.ignition.common.logging.Level;
import com.inductiveautomation.ignition.common.logging.LogEvent;
import com.inductiveautomation.ignition.common.logging.LogQueryConfig;
import com.inductiveautomation.ignition.common.logging.LogResults;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The errors a project's scripts are ACTUALLY throwing, from the gateway's own
 * log.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Everything the Problems panel showed before 1.15.0 was static analysis of
 * documents this client had open: a syntax error, an undefined name. All of it
 * is about code that has not run. Meanwhile a timer script that has been failing
 * every thirty seconds since Tuesday looks exactly like one that is fine — in
 * this IDE and in the Designer both — because the only place that says otherwise
 * is a log nobody has open.</p>
 *
 * <h2>How a log line is tied to a project — measured, not guessed</h2>
 *
 * <p>Read off this gateway's own log on 05/09/2026:</p>
 *
 * <pre>
 * logger:  com.inductiveautomation.ignition.common.script.ExtensionFunctionTimerScriptTask
 * message: Parse Error in timer script: 'Site_Redgum_Sewer/MyTimerScript @1,000ms '
 * </pre>
 *
 * <p>So the PROJECT and the script name are in the message TEXT, not in the
 * logger name and not in a property. That is the only handle there is, and it is
 * the one used: an event is attributed to a project when the project's name
 * appears in the message or in the logger. There is deliberately no allowlist of
 * logger names — the timer task is one of many, the rest have not been measured,
 * and a list of the ones we happen to have seen would silently hide every other
 * kind of script failure.</p>
 *
 * <p>The cost of that choice is stated on screen rather than hidden: a message
 * that merely mentions the project is included, so the list is "what the gateway
 * logged about this project", not "errors this project's scripts caused". A
 * narrower rule would need a property the platform does not set.</p>
 *
 * <h2>Grouping</h2>
 *
 * <p>Identical messages are collapsed with a count and the most recent
 * timestamp. A script failing every second produces 3,600 log lines an hour and
 * ONE problem, and a panel that lists all 3,600 is unusable exactly when it
 * matters most.</p>
 */
public final class ScriptErrors {

    private static final Logger logger = LoggerFactory.getLogger(ScriptErrors.class);

    /** How far back to look by default. */
    public static final long DEFAULT_WINDOW_MILLIS = 60 * 60 * 1000L;

    /** The widest window a caller may ask for — one day. */
    public static final long MAX_WINDOW_MILLIS = 24 * 60 * 60 * 1000L;

    /** How many raw events are examined before grouping. */
    private static final int MAX_EVENTS = 2000;

    /** How many distinct problems are returned, most recent first. */
    private static final int MAX_GROUPS = 50;

    private ScriptErrors() {
    }

    /** One distinct problem, with how often it happened. */
    public record ScriptError(String loggerName, String level, String message,
                              long lastSeen, int count, String exception) {
    }

    /**
     * Every WARN-or-worse event in the window that names this project.
     *
     * <p>Never throws: a gateway whose log store cannot be queried returns an
     * empty list, because a Problems panel that errors is worse than one that is
     * empty and says why.</p>
     */
    public static List<ScriptError> forProject(GatewayContext context, String project,
                                               long windowMillis) {
        if (context == null || project == null || project.isBlank()) {
            return List.of();
        }
        long window = Math.min(Math.max(windowMillis, 1000L), MAX_WINDOW_MILLIS);
        List<LogEvent> events;
        try {
            LogQueryConfig query = LogQueryConfig.newBuilder()
                .atOrAbove(Level.WARN)
                .newerThan(System.currentTimeMillis() - window)
                .limitTo(MAX_EVENTS)
                .build();
            LogResults results = context.getLoggingManager().queryLogEvents(query);
            events = results == null ? List.of() : results.getEvents();
        } catch (Exception e) {
            logger.debug("Could not query the gateway log: {}", e.toString());
            return List.of();
        }
        return group(events, project);
    }

    /**
     * Collapse raw events into distinct problems.
     *
     * <p>Package-private and taking the events directly so the grouping rule can
     * be tested without a gateway — which is the half of this that has logic in
     * it.</p>
     */
    static List<ScriptError> group(List<LogEvent> events, String project) {
        if (events == null || events.isEmpty()) {
            return List.of();
        }
        // Insertion-ordered so events that tie on timestamp keep the order the
        // log returned them in, rather than a hash order that moves per run.
        Map<String, ScriptError> grouped = new LinkedHashMap<>();
        for (LogEvent event : events) {
            if (event == null || !mentions(event, project)) {
                continue;
            }
            String message = event.getMessage() == null ? "" : event.getMessage();
            String key = event.getLoggerName() + " " + message;
            ScriptError existing = grouped.get(key);
            if (existing == null) {
                grouped.put(key, new ScriptError(
                    String.valueOf(event.getLoggerName()),
                    event.getLevel() == null ? "WARN" : event.getLevel().name(),
                    message,
                    event.getTimestamp(),
                    1,
                    firstExceptionLine(event)));
            } else {
                grouped.put(key, new ScriptError(
                    existing.loggerName(), existing.level(), existing.message(),
                    Math.max(existing.lastSeen(), event.getTimestamp()),
                    existing.count() + 1,
                    existing.exception() != null ? existing.exception() : firstExceptionLine(event)));
            }
        }
        List<ScriptError> out = new ArrayList<>(grouped.values());
        out.sort((a, b) -> Long.compare(b.lastSeen(), a.lastSeen()));
        return out.size() > MAX_GROUPS
            ? List.copyOf(out.subList(0, MAX_GROUPS))
            : List.copyOf(out);
    }

    /** How badly one named script is doing, over the window. */
    public record ScriptHealth(String script, int count, long lastSeen) {
    }

    /**
     * Errors attributed to individual gateway event scripts.
     *
     * <h3>What this can honestly claim</h3>
     *
     * <p>The review asked for last fire, duration and NEXT fire on each row. The
     * 8.3.0 SDK exposes none of those: there is no timer-task registry to ask,
     * and inventing a "last run" from a log line that only appears when
     * something FAILS would be worse than showing nothing — a healthy script
     * would read as one that has never run.</p>
     *
     * <p>So this answers the half that is real, and it is the half that costs
     * hours: whether a script has been FAILING, how often, and when it last did.
     * A timer script throwing every thirty seconds since Tuesday looks identical
     * to a healthy one in the Designer and, until now, here.</p>
     *
     * <p>Attribution uses the measured shape — the project and script name are
     * in the message text, as {@code 'Project/ScriptName @1,000ms '} — so a
     * script is matched when its own name appears in an event already
     * attributed to the project. Names are compared as WHOLE segments to keep
     * {@code Hourly} from matching {@code HourlyBackup}.</p>
     */
    public static List<ScriptHealth> byScript(List<ScriptError> errors,
                                              java.util.Collection<String> scriptNames) {
        if (errors == null || errors.isEmpty() || scriptNames == null) {
            return List.of();
        }
        Map<String, ScriptHealth> found = new LinkedHashMap<>();
        for (ScriptError error : errors) {
            String haystack = error.message() + " " + error.loggerName();
            for (String name : scriptNames) {
                if (name == null || name.isBlank() || !mentionsSegment(haystack, name)) {
                    continue;
                }
                ScriptHealth existing = found.get(name);
                found.put(name, existing == null
                    ? new ScriptHealth(name, error.count(), error.lastSeen())
                    : new ScriptHealth(name, existing.count() + error.count(),
                        Math.max(existing.lastSeen(), error.lastSeen())));
            }
        }
        List<ScriptHealth> out = new ArrayList<>(found.values());
        out.sort((a, b) -> Long.compare(b.lastSeen(), a.lastSeen()));
        return List.copyOf(out);
    }

    /**
     * True when {@code name} appears in {@code text} as a whole path segment.
     *
     * <p>Segment, not substring: a script called {@code Hourly} must not be
     * blamed for {@code HourlyBackup}'s failures, and a row that badges the
     * wrong script is worse than one that badges nothing.</p>
     */
    static boolean mentionsSegment(String text, String name) {
        int from = 0;
        while (true) {
            int at = text.indexOf(name, from);
            if (at < 0) {
                return false;
            }
            char before = at == 0 ? '/' : text.charAt(at - 1);
            int end = at + name.length();
            char after = end >= text.length() ? '/' : text.charAt(end);
            if (!isNamePart(before) && !isNamePart(after)) {
                return true;
            }
            from = at + 1;
        }
    }

    private static boolean isNamePart(char c) {
        return c == '_' || Character.isLetterOrDigit(c);
    }

    /** True when this event names the project in its message or its logger. */
    static boolean mentions(LogEvent event, String project) {
        String message = event.getMessage();
        if (message != null && message.contains(project)) {
            return true;
        }
        String name = event.getLoggerName();
        return name != null && name.contains(project);
    }

    /**
     * The first line of the stack trace, when there is one.
     *
     * <p>One line, not the trace: the panel is a list, and the frame that
     * matters to someone reading their own script is almost never the twentieth
     * one. The full trace is in the gateway log, which the panel says.</p>
     */
    private static String firstExceptionLine(LogEvent event) {
        String[] trace = event.getException();
        if (trace == null || trace.length == 0) {
            return null;
        }
        String first = trace[0];
        return first == null || first.isBlank() ? null : first.trim();
    }
}
