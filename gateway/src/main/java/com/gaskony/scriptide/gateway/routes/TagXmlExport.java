package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.TagProvider;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.function.Function;

/**
 * The Designer's XML tag export, written by the platform's own
 * {@code TagExport} (what {@code system.tag.exportTags(exportType='xml')} runs).
 * That class lives in the gateway jar, not the SDK's gateway-api, so it is
 * reached by reflection; if a future gateway moves it, the caller gets
 * {@link Unavailable} and the route answers 501 rather than failing opaquely.
 */
final class TagXmlExport {

    private static final String EXPORT_CLASS = "com.inductiveautomation.ignition.gateway.tags.TagExport";
    private static final String FUNCTION1 = "kotlin.jvm.functions.Function1";

    /** The platform exporter is not reachable on this gateway. */
    static final class Unavailable extends Exception {
        private static final long serialVersionUID = 1L;

        Unavailable(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private TagXmlExport() {
    }

    /** The fourth argument is "include UDT definitions": false silently drops them from the output. */
    static String export(List<TagPath> paths, Function<String, TagProvider> providers) throws Exception {
        Class<?> exporter;
        Class<?> function1;
        Method method;
        Object instance;
        try {
            ClassLoader loader = TagPath.class.getClassLoader();
            exporter = Class.forName(EXPORT_CLASS, true, loader);
            function1 = Class.forName(FUNCTION1, true, loader);
            method = exporter.getMethod("exportTags", List.class, boolean.class, String.class, boolean.class,
                function1, java.io.OutputStream.class);
            instance = exporter.getDeclaredConstructor().newInstance();
        } catch (ReflectiveOperationException | LinkageError e) {
            throw new Unavailable("TagExport not reachable", e);
        }
        Object lookup = Proxy.newProxyInstance(function1.getClassLoader(), new Class<?>[] {function1},
            (proxy, m, args) -> "invoke".equals(m.getName()) ? providers.apply((String) args[0]) : null);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        Object result;
        try {
            result = method.invoke(instance, paths, true, "xml", true, lookup, out);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw cause instanceof Exception ex ? ex : e;
        }
        String outcome = result == null ? "" : result.getClass().getSimpleName();
        if (!"Success".equals(outcome)) {
            throw new IllegalStateException("XML export failed: " + result);
        }
        return out.toString(StandardCharsets.UTF_8);
    }
}
