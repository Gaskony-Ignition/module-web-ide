package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns a named query's SQL into a prepared statement, so an UNSAVED draft can be
 * tested.
 *
 * <p>A saved query runs through {@code system.db.runNamedQuery}, which does this
 * conversion inside the platform. A draft has no resource to name, so the same job
 * has to happen here before {@code runPrepQuery} sees it. This class is that
 * conversion and nothing else — it does not execute anything.</p>
 *
 * <h2>The three parameter kinds are not interchangeable</h2>
 *
 * <ul>
 *   <li>{@code Parameter} (labelled "Value" in the Designer) becomes a positional
 *       {@code ?} and its value is BOUND. Every occurrence gets its own binding,
 *       in the order they appear, because that is what a positional statement
 *       requires.</li>
 *   <li>{@code QueryString} is substituted into the SQL as TEXT. That is the
 *       platform's semantic for it and the whole reason it exists — a
 *       QueryString parameter holds a SQL fragment, an ORDER BY column, an IN
 *       list. It is therefore an injection point BY DESIGN, and this class does
 *       not pretend otherwise: it is why the test-run is Administrator-only and
 *       goes through the same policy gate as running arbitrary Python.</li>
 *   <li>{@code Database} selects the CONNECTION and never appears in the SQL. A
 *       reference to one is refused rather than bound, because binding it would
 *       silently produce a statement that cannot run.</li>
 * </ul>
 *
 * <h2>What the scanner skips</h2>
 *
 * <p>A colon inside a single-quoted string literal is data, not a placeholder —
 * {@code SELECT 'ratio 3:1'} must survive unchanged, doubled quotes included. A
 * doubled colon is PostgreSQL's cast operator ({@code value::text}), so it is
 * copied through rather than read as a placeholder named {@code text}. An
 * identifier is the maximal run of letters, digits and underscores after the
 * colon, which is what makes {@code :id} and {@code :identifier} distinct rather
 * than one being a prefix match of the other.</p>
 */
final class NamedQuerySql {

    private NamedQuerySql() { /* utility class */ }

    /** SQL with positional placeholders, and the values to bind to them in order. */
    record Prepared(String sql, List<Object> arguments) {
    }

    /**
     * Convert {@code :identifier} placeholders to {@code ?} and collect the bindings.
     *
     * @param sql      the draft SQL, as typed
     * @param declared the query's declared parameters, which decide how each
     *                 reference is treated
     * @param values   already coerced by {@link NamedQueryCodec#coerceParameters}
     * @throws NamedQueryCodec.BadValueException on a reference to something the
     *         query does not declare, or to a {@code Database} parameter
     */
    static Prepared prepare(String sql, List<NamedQuery.Parameter> declared,
                            Map<String, Object> values) {
        Map<String, NamedQuery.ParameterType> kinds = new LinkedHashMap<>();
        for (NamedQuery.Parameter p : declared) {
            kinds.put(p.getIdentifier(),
                p.getType() == null ? NamedQuery.ParameterType.Parameter : p.getType());
        }

        StringBuilder out = new StringBuilder(sql.length());
        List<Object> arguments = new ArrayList<>();
        int i = 0;
        int n = sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            if (c == '\'') {
                i = copyLiteral(sql, i, out);
                continue;
            }
            if (c != ':') {
                out.append(c);
                i++;
                continue;
            }
            // PostgreSQL's cast operator. Copied through: `x::text` is not a
            // placeholder called `text`.
            if (i + 1 < n && sql.charAt(i + 1) == ':') {
                out.append("::");
                i += 2;
                continue;
            }
            if (i + 1 >= n || !isIdentifierStart(sql.charAt(i + 1))) {
                out.append(c);
                i++;
                continue;
            }
            int end = i + 1;
            while (end < n && isIdentifierPart(sql.charAt(end))) {
                end++;
            }
            String identifier = sql.substring(i + 1, end);
            NamedQuery.ParameterType kind = kinds.get(identifier);
            if (kind == null) {
                throw new NamedQueryCodec.BadValueException("The SQL references ':" + identifier
                    + "', which this query does not declare as a parameter (declared: "
                    + kinds.keySet() + ")");
            }
            switch (kind) {
                case QueryString -> {
                    Object value = values.get(identifier);
                    if (value == null) {
                        throw new NamedQueryCodec.BadValueException("QueryString parameter ':"
                            + identifier + "' has no value. A QueryString is substituted into "
                            + "the SQL as text, so it cannot be left empty.");
                    }
                    out.append(value);
                }
                case Database -> throw new NamedQueryCodec.BadValueException(
                    "':" + identifier + "' is a Database parameter: it selects the connection "
                        + "and cannot be used inside the SQL.");
                default -> {
                    out.append('?');
                    // Absent binds null, which is what a nullable column expects
                    // and what runNamedQuery does with an unsupplied parameter.
                    arguments.add(values.get(identifier));
                }
            }
            i = end;
        }
        return new Prepared(out.toString(), arguments);
    }

    /**
     * Copy a single-quoted literal verbatim, including a doubled quote.
     *
     * @return the index just past the literal, or the end of the string when the
     *     literal is unterminated — an unterminated literal is the database's
     *     error to report, not this scanner's
     */
    private static int copyLiteral(String sql, int start, StringBuilder out) {
        int n = sql.length();
        out.append('\'');
        int i = start + 1;
        while (i < n) {
            char c = sql.charAt(i);
            if (c == '\'') {
                if (i + 1 < n && sql.charAt(i + 1) == '\'') {
                    out.append("''");
                    i += 2;
                    continue;
                }
                out.append('\'');
                return i + 1;
            }
            out.append(c);
            i++;
        }
        return n;
    }

    private static boolean isIdentifierStart(char c) {
        return Character.isLetter(c) || c == '_';
    }

    private static boolean isIdentifierPart(char c) {
        return Character.isLetterOrDigit(c) || c == '_';
    }

    /**
     * The connection a run should use: a {@code Database}-type parameter's value
     * wins over the query's own setting, which is the platform's rule.
     *
     * <p>{@code NamedQuery.DATABASE_PARAM_OPTION} — the literal {@code "{}"} — is
     * what the Designer stores in {@code database} to mean "the connection comes
     * from the Database parameter", so it is never a connection name and is
     * translated to the project default here.</p>
     */
    static String connectionFor(NamedQuery query, Map<String, Object> values) {
        for (NamedQuery.Parameter p : query.getParameters() == null
            ? List.<NamedQuery.Parameter>of() : query.getParameters()) {
            if (p.getType() == NamedQuery.ParameterType.Database) {
                Object supplied = values.get(p.getIdentifier());
                if (supplied != null && !String.valueOf(supplied).isBlank()) {
                    return String.valueOf(supplied);
                }
            }
        }
        String database = query.getDatabase();
        if (database == null || NamedQuery.DATABASE_PARAM_OPTION.equals(database)) {
            return "";
        }
        return database;
    }
}
