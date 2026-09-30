package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceType;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Reading an uploaded archive — the half of import that is attacker-facing.
 *
 * <p>The route turns a file somebody uploaded into resources in a running
 * gateway, so what is asserted here is mostly what it REFUSES. Each limit is
 * checked against the decompressed stream, because all of them are trivial to
 * satisfy in a compressed one.</p>
 *
 * <p>The write half is not unit-testable at this level — it needs a real
 * ProjectManager and a push — and is covered end to end by
 * {@code validate_v27_transfer.py}, which round-trips a real export through a
 * real import on the rig.</p>
 */
class TransferRouteHandlerTest {

    /** A zip built entry by entry, so a test can put anything in it. */
    private static byte[] zip(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                zip.putNextEntry(new ZipEntry(entry.getKey()));
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return out.toByteArray();
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }

    private static Map<String, byte[]> oneScript(String path) {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("project.json", bytes("{\"title\":\"Demo\",\"parent\":\"\"}"));
        entries.put(path + "/resource.json",
            bytes("{\"scope\":\"A\",\"version\":1,\"files\":[\"code.py\"]}"));
        entries.put(path + "/code.py", bytes("def f():\n\treturn 1\n"));
        return entries;
    }

    private static TransferRouteHandler.Archive read(byte[] archive) throws Exception {
        return TransferRouteHandler.read(new ByteArrayInputStream(archive));
    }

    // ---- the happy path, so the refusals below mean something ----

    @Test
    @DisplayName("groups a resource by the directory holding its resource.json")
    void groupsByResourceJson() throws Exception {
        var archive = read(zip(oneScript("ignition/script-python/util/helpers")));
        assertThat(archive.resources()).containsOnlyKeys("ignition/script-python/util/helpers");
        assertThat(archive.resources().get("ignition/script-python/util/helpers"))
            .containsOnlyKeys("resource.json", "code.py");
        assertThat(archive.projectJson()).isNotNull();
    }

    @Test
    @DisplayName("a directory with no resource.json is not a resource")
    void ignoresDirectoriesWithoutAManifest() throws Exception {
        Map<String, byte[]> entries = oneScript("ignition/script-python/util/helpers");
        // A stray file beside the real resource: the parent package directory,
        // an editor's backup, a README somebody put in the zip.
        entries.put("ignition/script-python/util/README.txt", bytes("notes"));
        var archive = read(zip(entries));
        assertThat(archive.resources()).containsOnlyKeys("ignition/script-python/util/helpers");
    }

    @Test
    @DisplayName("a zip with no resource.json anywhere is refused, and says why")
    void refusesAnArchiveWithNoResources() throws Exception {
        byte[] archive = zip(Map.of("notes.txt", bytes("hello")));
        assertThatThrownBy(() -> read(archive))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
            .hasMessageContaining("resource.json");
    }

    // ---- traversal ----

    @Test
    @DisplayName("refuses a traversal entry rather than sanitising it")
    void refusesTraversal() throws Exception {
        // Sanitising would invent a destination the user did not choose, and
        // these names become ResourcePaths — not filenames — so the usual
        // "strip the .." leaves something that still resolves somewhere.
        for (String evil : new String[] {
            "../../etc/passwd/resource.json",
            "ignition/../../../secret/resource.json",
            "/absolute/resource.json",
            "C:\\windows\\resource.json",
            "ignition\\script-python\\x\\resource.json",
        }) {
            byte[] archive = zip(Map.of(evil, bytes("{}")));
            assertThatThrownBy(() -> read(archive))
                .describedAs("entry %s", evil)
                .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
                .hasMessageContaining("Unsafe path");
        }
    }

    @Test
    @DisplayName("a single-dot segment is refused too")
    void refusesSingleDotSegments() throws Exception {
        byte[] archive = zip(Map.of("ignition/./script-python/x/resource.json", bytes("{}")));
        assertThatThrownBy(() -> read(archive))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class);
    }

    // ---- size and count ----

    @Test
    @DisplayName("refuses an archive that decompresses past the total cap")
    void refusesAZipBomb() throws Exception {
        // Highly compressible: ~130 MB of zeroes in a few kilobytes of zip. The
        // per-entry and upload caps both pass; the TOTAL cap is the one that has
        // to catch this, which is the whole reason it exists.
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("a/resource.json", bytes("{}"));
        for (int i = 0; i < 20; i++) {
            entries.put("a/big" + i + ".py", new byte[7 * 1024 * 1024]);
        }
        byte[] archive = zip(entries);
        assertThat(archive.length).isLessThan(TransferRouteHandler.MAX_UPLOAD_BYTES);
        assertThatThrownBy(() -> read(archive))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
            .hasMessageContaining("expands to more than");
    }

    @Test
    @DisplayName("refuses one oversized entry")
    void refusesAnOversizedEntry() throws Exception {
        byte[] archive = zip(Map.of(
            "a/resource.json", bytes("{}"),
            "a/code.py", new byte[TransferRouteHandler.MAX_ENTRY_BYTES + 1]));
        assertThatThrownBy(() -> read(archive))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
            .hasMessageContaining("larger than");
    }

    @Test
    @DisplayName("refuses an archive with too many entries")
    void refusesTooManyEntries() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        for (int i = 0; i <= TransferRouteHandler.MAX_ENTRIES; i++) {
            entries.put("a" + i + "/resource.json", bytes("{}"));
        }
        byte[] archive = zip(entries);
        assertThatThrownBy(() -> read(archive))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
            .hasMessageContaining("entries");
    }

    @Test
    @DisplayName("something that is not a zip is refused in the words a user can act on")
    void refusesNonZip() {
        byte[] archive = bytes("this is a python file, not an export");
        assertThatThrownBy(() -> read(archive))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
            .hasMessageContaining("readable zip");
    }

    @Test
    @DisplayName("an empty upload is refused")
    void refusesEmpty() {
        assertThatThrownBy(() -> read(new byte[0]))
            .isInstanceOf(TransferRouteHandler.ArchiveRejected.class)
            .hasMessageContaining("empty");
    }

    // ---- what may be written ----

    @Test
    @DisplayName("only resource types this IDE can open are importable")
    void limitsWhatMayBeWritten() {
        assertThat(TransferRouteHandler.isImportable(
            "ignition/script-python/util/helpers")).isTrue();
        assertThat(TransferRouteHandler.isImportable(
            "ignition/script-timer/PlantSim")).isTrue();
        // Read and listed so the client can SAY the file contains it, never
        // written: nothing here can open, check or undo a Perspective view.
        assertThat(TransferRouteHandler.isImportable(
            "com.inductiveautomation.perspective/views/Home")).isFalse();
        assertThat(TransferRouteHandler.isImportable(
            "ignition/images/logo.png")).isFalse();
    }

    // ---- the manifest ----

    @Test
    @DisplayName("carries scope, version and plain attributes; never the modification stamp")
    void appliesTheManifestWithoutTheStamp() {
        JsonObject manifest = JsonParser.parseString("""
            {
              "scope": "A",
              "version": 1,
              "restricted": false,
              "overridable": true,
              "files": ["code.py"],
              "attributes": {
                "hintScope": 2,
                "lastModificationSignature": "deadbeef",
                "lastModification": {"actor": "someone-else", "timestamp": "2020-01-01T00:00:00Z"}
              }
            }
            """).getAsJsonObject();

        Resource built = applyTo(manifest);

        assertThat(built.getApplicationScope()).isEqualTo(7);
        assertThat(built.getVersion()).isEqualTo(1);
        assertThat(built.isOverridable()).isTrue();
        assertThat(built.isRestricted()).isFalse();
        assertThat(String.valueOf(built.getAttributes().get("hintScope"))).isEqualTo("2");
        // The exporting gateway's opinion of when this last changed is not this
        // gateway's history. The platform stamps it for the actor doing the push,
        // and carrying somebody else's would make the project say a change
        // happened before it did.
        assertThat(built.getAttributes()).doesNotContainKey("lastModification");
        assertThat(built.getAttributes()).doesNotContainKey("lastModificationSignature");
    }

    @Test
    @DisplayName("a manifest missing everything is applied without throwing")
    void toleratesAnEmptyManifest() {
        Resource built = applyTo(new JsonObject());
        assertThat(built.getAttributes()).isEmpty();
    }

    @Test
    @DisplayName("a non-primitive attribute is dropped, not stringified")
    void dropsNonPrimitiveAttributes() {
        // An attribute rendered as its own JSON text is a different value that
        // happens to print the same, and it would come back out of the next
        // export quoted.
        JsonObject manifest = JsonParser.parseString(
            "{\"attributes\": {\"nested\": {\"a\": 1}, \"plain\": \"kept\"}}")
            .getAsJsonObject();
        Resource built = applyTo(manifest);
        assertThat(built.getAttributes()).doesNotContainKey("nested");
        assertThat(String.valueOf(built.getAttributes().get("plain"))).contains("kept");
    }

    /** Apply a manifest to a real builder and build it, so assertions see the real object. */
    private static Resource applyTo(JsonObject manifest) {
        ResourceBuilder builder = Resource.newBuilder()
            .setResourceCollectionName("Demo")
            .setResourcePath(new ResourcePath(
                new ResourceType("ignition", "script-python"), "util/helpers"));
        TransferRouteHandler.applyManifest(builder, manifest);
        return builder.build();
    }
}
