package com.gaskony.scriptide.gateway;

import com.gaskony.scriptide.common.ModuleConstants;
import com.gaskony.scriptide.common.ScriptIdePaths;
import com.gaskony.scriptide.gateway.exec.RunOutputRouter;
import com.gaskony.scriptide.gateway.routes.ScriptIdeRouteRegistrar;
import com.gaskony.scriptide.gateway.ws.ScriptIdeSocketRegistry;
import com.gaskony.scriptide.gateway.ws.ScriptIdeWebSocketServlet;
import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import com.inductiveautomation.ignition.gateway.model.AbstractGatewayModuleHook;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.ignition.gateway.web.systemjs.SystemJsModule;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;

/**
 * Gateway module hook for the Web IDE.
 *
 * <p>Gateway scope only. The IDE is a standalone browser SPA served as a full
 * page from {@code /data/scriptide/*} via a catch-all route, not a Designer
 * workspace and not a page embedded in the Gateway navigation shell.</p>
 */
public class ScriptIdeModuleHook extends AbstractGatewayModuleHook {

    private static final Logger logger = LoggerFactory.getLogger(ScriptIdeModuleHook.class);

    private GatewayContext context;

    @Override
    public void setup(GatewayContext context) {
        this.context = context;

        // setup() is for extension-point registration only — no threads, no DB.
        logger.info("Web IDE module setup starting ({})", ModuleConstants.MODULE_ID);
        registerHomeLaunchTile();
        logger.info("Web IDE module setup complete");
    }

    /**
     * Add the Gateway home-page tile that opens the IDE.
     *
     * <p>{@code NavigationModel} has no plain link/href page type — every nav
     * mount pairs an in-shell route with a component — so the tile mounts a
     * trivial launcher component whose only job is to redirect the browser out to
     * the full-page SPA.</p>
     */
    private void registerHomeLaunchTile() {
        SystemJsModule launcher = new SystemJsModule(
            ModuleConstants.LAUNCHER_BUNDLE_NAME,
            ScriptIdePaths.LAUNCHER_JS_RESOURCE_PATH
        );

        context.getWebResourceManager()
            .getNavigationModel()
            .getHome()
            .addCategory(ModuleConstants.GATEWAY_NAV_CATEGORY, cat -> cat
                .label(ModuleConstants.GATEWAY_NAV_LABEL)
                .addPage(ModuleConstants.GATEWAY_NAV_PAGE, page -> page
                    .title(ModuleConstants.GATEWAY_NAV_PAGE_TITLE)
                    .position(100)
                    .mount(ModuleConstants.GATEWAY_MOUNT_PATH,
                        ModuleConstants.LAUNCHER_BUNDLE_NAME, launcher)
                )
            );

        logger.info("Web IDE launch tile added to the Gateway home page (redirects to {})",
            ScriptIdePaths.SPA_LAUNCH_TARGET);
    }

    @Override
    public void startup(LicenseState licenseState) {
        logger.info("Web IDE module starting...");

        // Policy overrides come from a file under the data dir so an operator can
        // turn execution or the terminal off WITHOUT a gateway restart. One call
        // covers both policies; without it the source falls back to -Ddata.dir.
        com.gaskony.scriptide.gateway.term.TerminalPolicy.setPropertiesFile(
            context.getSystemManager().getDataDir().toPath()
                .resolve("modules/scriptide/policy.properties"));

        // Publish the context BEFORE registering the servlet: the container
        // instantiates the servlet through its no-arg constructor and reads the
        // context back out of the registry.
        ScriptIdeSocketRegistry.init(context);
        context.getWebResourceManager()
            .addServlet(ScriptIdePaths.SOCKET_SERVLET_PATH, ScriptIdeWebSocketServlet.class);
        logger.info("Registered Web IDE WebSocket servlet at path spec '{}' (expected public path {})",
            ScriptIdePaths.SOCKET_SERVLET_PATH, ScriptIdePaths.SOCKET_PUBLIC_PATH);

        logger.info("Web IDE available at: {}", ScriptIdePaths.SPA_LAUNCH_TARGET);
        logger.info("Web IDE module started successfully");
    }

    @Override
    public void shutdown() {
        logger.info("Web IDE module shutting down...");

        if (context != null) {
            try {
                context.getWebResourceManager()
                    .removeServlet(ScriptIdePaths.SOCKET_SERVLET_PATH);
            } catch (Exception e) {
                logger.debug("Error removing WebSocket servlet: {}", e.getMessage());
            }
        }
        // Close every open socket so none outlives the module holding a dead context.
        ScriptIdeSocketRegistry.shutdown();
        // After the pool has stopped: give every project its own sys.stdout and
        // sys.stderr back, so none keeps a reference into this unloaded module.
        RunOutputRouter.restoreAll();

        logger.info("Web IDE module shutdown complete");
    }

    @Override
    public void mountRouteHandlers(RouteGroup routes) {
        logger.info("Mounting Web IDE route handlers at {}/*", ScriptIdePaths.DATA_BASE);
        new ScriptIdeRouteRegistrar(context).mountRoutes(routes);
        logger.info("Web IDE route handlers mounted");
    }

    @Override
    public Optional<String> getMountedResourceFolder() {
        return Optional.of(ModuleConstants.MOUNTED_RESOURCE_FOLDER);
    }

    @Override
    public Optional<String> getMountPathAlias() {
        return Optional.of(ScriptIdePaths.MOUNT_ALIAS);
    }

    @Override
    public boolean isFreeModule() {
        return true;
    }

    /**
     * Opt in to Maker Edition.
     *
     * <p>{@code AbstractGatewayModuleHook} defaults this to {@code false}, and
     * without the override Maker silently refuses to start the module, reporting
     * only "not eligible for use with Ignition Maker Edition" — no fault, no other
     * log line. Note that same message also appears when a module fails to load
     * for an unrelated reason (e.g. an SDK version mismatch), so it cannot by
     * itself tell you which case you are in.</p>
     */
    @Override
    public boolean isMakerEditionCompatible() {
        return true;
    }
}
