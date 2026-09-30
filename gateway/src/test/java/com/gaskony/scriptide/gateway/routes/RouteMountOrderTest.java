package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ScriptIdePaths;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;

/**
 * Guards the one ordering property that is a correctness bug rather than a style
 * preference.
 *
 * <p>{@code RouteGroupImpl.findMatchingRoute} streams routes in INSERTION order,
 * filters by method and path, then takes {@code findFirst()}. There is no
 * most-specific-wins rule. So the {@code "/*"} catch-all, which matches every
 * path, must be mounted after every {@code /api/...} route.</p>
 *
 * <p>Get it wrong and there is no error anywhere — the API simply starts
 * returning the HTML shell instead of JSON, which presents as a baffling
 * client-side parse failure a long way from the cause.</p>
 */
class RouteMountOrderTest {

    /** Records the path of every route mounted, in order. */
    private static List<String> recordMountedPaths() {
        List<String> mounted = new ArrayList<>();
        RouteGroup routes = Mockito.mock(RouteGroup.class);

        Mockito.when(routes.newRoute(anyString())).thenAnswer(invocation -> {
            String path = invocation.getArgument(0);
            // RETURNS_SELF covers the whole fluent chain (type/method/accessControl/
            // handler/...), so this mock does not have to track the builder's API.
            RouteGroup.RouteMounter mounter =
                Mockito.mock(RouteGroup.RouteMounter.class, Mockito.RETURNS_SELF);
            // mount() is the commit point — record only when a route is really mounted.
            Mockito.doAnswer(ignored -> {
                mounted.add(path);
                return null;
            }).when(mounter).mount();
            return mounter;
        });

        new ScriptIdeRouteRegistrar(null).mountRoutes(routes);
        return mounted;
    }

    @Test
    @DisplayName("the SPA catch-all is mounted LAST, so it cannot shadow the API")
    void catchAllIsMountedLast() {
        List<String> mounted = recordMountedPaths();

        assertThat(mounted)
            .as("no routes were recorded — the test's RouteGroup mock has drifted "
                + "from the registrar and is asserting nothing")
            .isNotEmpty();

        assertThat(mounted.get(mounted.size() - 1))
            .as("the \"/*\" splat must be mounted last; first-match-wins means "
                + "anything after it is unreachable")
            .isEqualTo(ScriptIdePaths.ROUTE_SPA_CATCH_ALL);
    }

    @Test
    @DisplayName("every API route is mounted before the catch-all")
    void apiRoutesPrecedeTheCatchAll() {
        List<String> mounted = recordMountedPaths();
        int catchAllIndex = mounted.indexOf(ScriptIdePaths.ROUTE_SPA_CATCH_ALL);

        assertThat(catchAllIndex).as("catch-all route was never mounted").isGreaterThanOrEqualTo(0);

        List<String> apiRoutes = mounted.stream().filter(p -> p.startsWith("/api/")).toList();
        assertThat(apiRoutes)
            .as("no /api routes mounted — either the registrar changed or the mock broke")
            .isNotEmpty();

        for (String api : apiRoutes) {
            assertThat(mounted.indexOf(api))
                .as("API route %s is mounted after the catch-all and is therefore unreachable", api)
                .isLessThan(catchAllIndex);
        }
    }

    @Test
    @DisplayName("the session probe is mounted")
    void sessionProbeIsMounted() {
        assertThat(recordMountedPaths()).contains(ScriptIdePaths.ROUTE_AUTH_SESSION);
    }

    @Test
    @DisplayName("every named-query route is mounted, and all of them before the catch-all")
    void namedQueryRoutesAreMountedBeforeTheCatchAll() {
        // The generic assertion above only covers paths that START with /api/, so
        // a named-query route added below the splat would still be caught by it.
        // This one also asserts the routes EXIST: an API that silently loses a
        // route presents as a 404 the client reads as "no such query".
        List<String> mounted = recordMountedPaths();
        int catchAllIndex = mounted.indexOf(ScriptIdePaths.ROUTE_SPA_CATCH_ALL);

        for (String route : List.of(
            ScriptIdePaths.ROUTE_NAMED_QUERIES,
            ScriptIdePaths.ROUTE_NAMED_QUERY_CONTENT,
            ScriptIdePaths.ROUTE_NAMED_QUERY_SETTINGS,
            ScriptIdePaths.ROUTE_NAMED_QUERY_RENAME,
            ScriptIdePaths.ROUTE_NAMED_QUERY_TEST)) {
            assertThat(mounted).as("%s was never mounted", route).contains(route);
            assertThat(mounted.indexOf(route))
                .as("%s is mounted after the catch-all and is therefore unreachable", route)
                .isLessThan(catchAllIndex);
        }
    }

    @Test
    @DisplayName("every database query route is mounted, and all of them before the catch-all")
    void dbQueryRoutesAreMountedBeforeTheCatchAll() {
        List<String> mounted = recordMountedPaths();
        int catchAllIndex = mounted.indexOf(ScriptIdePaths.ROUTE_SPA_CATCH_ALL);

        for (String route : List.of(
            ScriptIdePaths.ROUTE_DB_QUERY_DATASOURCES,
            ScriptIdePaths.ROUTE_DB_QUERY_TABLES,
            ScriptIdePaths.ROUTE_DB_QUERY_COLUMNS,
            ScriptIdePaths.ROUTE_DB_QUERY_RUN,
            ScriptIdePaths.ROUTE_DB_QUERY_CANCEL,
            ScriptIdePaths.ROUTE_DB_QUERY_HISTORY)) {
            assertThat(mounted).as("%s was never mounted", route).contains(route);
            assertThat(mounted.indexOf(route))
                .as("%s is mounted after the catch-all and is therefore unreachable", route)
                .isLessThan(catchAllIndex);
        }
    }

    @Test
    @DisplayName("the content path is mounted three times — one per verb")
    void namedQueryContentCarriesThreeVerbs() {
        // GET, POST and DELETE share one path, and the registrar sets .method()
        // explicitly on the last two. Omitting it silently defaults to GET, and the
        // route then shadows the read instead of accepting writes — a regression
        // this estate has had before, whose only symptom is a write that returns
        // the file it was supposed to replace.
        assertThat(recordMountedPaths())
            .filteredOn(ScriptIdePaths.ROUTE_NAMED_QUERY_CONTENT::equals)
            .hasSize(3);
    }

    @Test
    @DisplayName("the settings path is mounted twice — read and write")
    void namedQuerySettingsCarriesTwoVerbs() {
        assertThat(recordMountedPaths())
            .filteredOn(ScriptIdePaths.ROUTE_NAMED_QUERY_SETTINGS::equals)
            .hasSize(2);
    }
}
