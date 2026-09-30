package com.gaskony.scriptide.common;

/**
 * Single source of truth for module-level identifiers and mount configuration.
 *
 * <p>Any string appearing in more than one Java or Gradle file MUST live here (or
 * in {@link ScriptIdePaths} for route strings) and be imported everywhere else.
 * Never hardcode these values — web-designer's own registrar Javadoc records that
 * a duplicated route string is how a mount silently stops matching.</p>
 */
public final class ModuleConstants {

    private ModuleConstants() { /* constants only */ }

    // ==================== Core identifiers ====================

    /** Ignition module ID — must match id.set(...) in build.gradle.kts. */
    public static final String MODULE_ID = "com.gaskony.scriptide";

    /** Human-readable module name. */
    public static final String MODULE_NAME = "Web IDE";

    // ==================== Gateway resource mounting ====================

    /** Folder under gateway/src/main/resources/ served as mounted resources. */
    public static final String MOUNTED_RESOURCE_FOLDER = "mounted";

    /**
     * Alias for the module's mounted resource path ({@code /res/{alias}/*}) and
     * the base of every {@code /data/{alias}/*} route. Single source of truth is
     * {@link ScriptIdePaths#MOUNT_ALIAS}.
     */
    public static final String MOUNT_PATH_ALIAS = ScriptIdePaths.MOUNT_ALIAS;

    // ==================== Gateway home-page launch tile ====================
    //
    // The IDE is a standalone full-page SPA at ScriptIdePaths.SPA_LAUNCH_TARGET,
    // not a page embedded in the Gateway nav shell. NavigationModel has no plain
    // link/href page type — every nav mount pairs an in-shell route with a
    // component — so a trivial launcher component that redirects the browser out
    // to the full page is the only way to get a clickable door.

    /** Gateway home-page navigation category key. */
    public static final String GATEWAY_NAV_CATEGORY = "ScriptIdeModule";

    /**
     * Gateway home-page navigation page key.
     *
     * <p>MEASURED 31/08/2026: the nav shell renders this KEY as the visible link
     * text under the category, NOT {@link #GATEWAY_NAV_PAGE_TITLE}. So the tile
     * reads "Web IDE" > "Launch". Change this constant, not the title, if the
     * link wording ever needs to change.</p>
     */
    public static final String GATEWAY_NAV_PAGE = "Launch";

    /** Category label shown to users — this one IS rendered. */
    public static final String GATEWAY_NAV_LABEL = "Web IDE";

    /**
     * Page title passed to {@code page.title(...)}.
     *
     * <p>Not the nav link text — see {@link #GATEWAY_NAV_PAGE}. It surfaces on
     * the in-shell page itself rather than in the sidebar.</p>
     */
    public static final String GATEWAY_NAV_PAGE_TITLE = "Open Web IDE";

    /** In-shell route the nav tile mounts the launcher component at. */
    public static final String GATEWAY_MOUNT_PATH = "/script-ide";

    /**
     * SystemJS/UMD global + export name of the launcher bundle — must match the
     * library name registered on {@code window} by launcher.js.
     */
    public static final String LAUNCHER_BUNDLE_NAME = "ScriptIdeLauncher";
}
