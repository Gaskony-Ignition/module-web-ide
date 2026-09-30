package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompileMode;
import org.python.core.CompilerFlags;
import org.python.core.Py;
import org.python.core.PyFile;
import org.python.core.PyObject;
import org.python.core.PyStringMap;
import org.python.core.PySystemState;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The per-thread dispatcher under a project's platform {@code sys.stdout}.
 *
 * <p>The bug it fixes: a project library module loads lazily through
 * {@code ScriptManager.runCode}, which moves the calling thread onto the manager's
 * system state, so a console run's {@code print} after its first use of a fresh
 * module reached the gateway log. Here a bare {@link PySystemState} stands in for
 * the manager and {@code Py.setSystemState(manager)} for the flip.</p>
 */
class RunOutputRouterTest {

    private PySystemState manager;
    private ByteArrayOutputStream managerOut;
    private ByteArrayOutputStream managerErr;
    private PyFile originalOut;
    private PyFile originalErr;
    private PySystemState previous;

    @BeforeAll
    static void boot() {
        PySystemState.initialize();
    }

    @BeforeEach
    void setUp() {
        previous = Py.getSystemState();
        manager = new PySystemState();
        managerOut = new ByteArrayOutputStream();
        managerErr = new ByteArrayOutputStream();
        // Buffered, like the platform's: passthrough must keep its flush behaviour.
        originalOut = utf8File(managerOut, -1);
        originalErr = utf8File(managerErr, -1);
        manager.stdout = originalOut;
        manager.stderr = originalErr;
    }

    @AfterEach
    void tearDown() {
        RunOutputRouter.exit();
        RunOutputRouter.restoreAll();
        Py.setSystemState(previous);
    }

    @Test
    @DisplayName("a thread outside any run prints to the original stream, byte for byte")
    void passesThrough() {
        RunOutputRouter.install(manager);

        runAs(manager, "print 'a',\nprint 'b'\nprint u'caf\\xe9 \\u2713'\n");

        // Flushed by print, exactly as the platform's own file would be.
        assertThat(managerOut.toString(StandardCharsets.UTF_8)).isEqualTo("a b\ncafé ✓\n");
    }

    @Test
    @DisplayName("the passthrough bytes match writing to the original directly")
    void sameBytesAsTheOriginal() {
        String source = "print u'\\xe9\\u2713', 1, 'x'\nprint\nprint 'tab\\there',\n";
        runAs(manager, source);
        byte[] direct = managerOut.toByteArray();
        managerOut.reset();

        RunOutputRouter.install(manager);
        runAs(manager, source);
        originalOut.flush();

        assertThat(managerOut.toByteArray()).isEqualTo(direct);
    }

    @Test
    @DisplayName("a run's thread on the manager's state prints into the run, not the gateway")
    void routesTheRunningThread() {
        RunOutputRouter.install(manager);
        ByteArrayOutputStream runOut = new ByteArrayOutputStream();
        ByteArrayOutputStream runErr = new ByteArrayOutputStream();
        PySystemState run = new PySystemState();
        run.stdout = utf8File(runOut, -1);
        run.stderr = utf8File(runErr, -1);

        RunOutputRouter.enter(run);
        runAs(manager, "print 'after'\n");
        manager.stderr.invoke("write", Py.newString("oops\n"));
        manager.stderr.invoke("flush");

        assertThat(runOut.toString(StandardCharsets.UTF_8)).isEqualTo("after\n");
        assertThat(runErr.toString(StandardCharsets.UTF_8)).isEqualTo("oops\n");
        assertThat(managerOut.size()).isZero();
        assertThat(managerErr.size()).isZero();

        RunOutputRouter.exit();
        runAs(manager, "print 'gateway'\n");
        assertThat(managerOut.toString(StandardCharsets.UTF_8)).isEqualTo("gateway\n");
        assertThat(runOut.toString(StandardCharsets.UTF_8)).isEqualTo("after\n");
    }

    @Test
    @DisplayName("an unflushed write is routed at once, on the thread that made it")
    void holdsNothingBack() {
        RunOutputRouter.install(manager);
        ByteArrayOutputStream runOut = new ByteArrayOutputStream();
        PySystemState run = new PySystemState();
        run.stdout = utf8File(runOut, 0);

        RunOutputRouter.enter(run);
        manager.stdout.invoke("write", Py.newString("partial"));

        // No flush: a buffer in the wrapper would let another thread's flush
        // carry these bytes to the wrong place.
        assertThat(runOut.toString(StandardCharsets.UTF_8)).isEqualTo("partial");
    }

    @Test
    @DisplayName("a concurrent thread outside the run keeps writing to the gateway")
    void isolatesThreads() throws Exception {
        RunOutputRouter.install(manager);
        ByteArrayOutputStream runOut = new ByteArrayOutputStream();
        PySystemState run = new PySystemState();
        run.stdout = utf8File(runOut, -1);
        PyObject shared = manager.stdout;

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            CyclicBarrier start = new CyclicBarrier(2);
            Future<?> inRun = pool.submit(() -> {
                RunOutputRouter.enter(run);
                try {
                    start.await();
                    for (int i = 0; i < 500; i++) {
                        shared.invoke("write", Py.newString("RUN\n"));
                    }
                } finally {
                    RunOutputRouter.exit();
                }
                return null;
            });
            Future<?> outside = pool.submit(() -> {
                start.await();
                for (int i = 0; i < 500; i++) {
                    shared.invoke("write", Py.newString("GW\n"));
                }
                return null;
            });
            inRun.get(10, TimeUnit.SECONDS);
            outside.get(10, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }
        run.stdout.invoke("flush");
        originalOut.flush();

        assertThat(runOut.toString(StandardCharsets.UTF_8)).isEqualTo("RUN\n".repeat(500));
        assertThat(managerOut.toString(StandardCharsets.UTF_8)).isEqualTo("GW\n".repeat(500));
    }

    @Test
    @DisplayName("installing again, even concurrently, never wraps the wrapper")
    void installIsIdempotent() throws Exception {
        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> done = new ArrayList<>();
        try {
            for (int i = 0; i < threads; i++) {
                done.add(pool.submit(() -> {
                    go.await();
                    RunOutputRouter.install(manager);
                    return null;
                }));
            }
            go.countDown();
            for (Future<?> f : done) {
                f.get(10, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        PyObject wrapped = manager.stdout;
        RunOutputRouter.install(manager);

        assertThat(manager.stdout).isSameAs(wrapped).isNotSameAs(originalOut);
        // One layer: a single restore gets straight back to the original.
        RunOutputRouter.restoreAll();
        assertThat(manager.stdout).isSameAs(originalOut);
        assertThat(manager.stderr).isSameAs(originalErr);
    }

    @Test
    @DisplayName("restore puts the originals back, and leaves a stream someone else replaced")
    void restores() {
        PySystemState other = new PySystemState();
        PyFile otherOut = utf8File(new ByteArrayOutputStream(), -1);
        other.stdout = otherOut;
        RunOutputRouter.install(manager);
        RunOutputRouter.install(other);
        PyFile replacedLater = utf8File(new ByteArrayOutputStream(), -1);
        other.stdout = replacedLater;

        RunOutputRouter.restoreAll();

        assertThat(manager.stdout).isSameAs(originalOut);
        assertThat(manager.stderr).isSameAs(originalErr);
        assertThat(other.stdout).isSameAs(replacedLater);
        RunOutputRouter.restoreAll();
        assertThat(manager.stdout).isSameAs(originalOut);
    }

    @Test
    @DisplayName("the wrapper looks like the file it replaced")
    void looksLikeAFile() {
        RunOutputRouter.install(manager);

        assertThat(manager.stdout.getType().getName()).isEqualTo("file");
        assertThat(manager.stdout.__findattr__("encoding").toString()).isEqualTo("UTF-8");
        assertThat(manager.stdout.__findattr__("name").toString())
            .isEqualTo(originalOut.__findattr__("name").toString());
    }

    @Test
    @DisplayName("a run whose own stdout IS the wrapper falls back rather than recursing")
    void noRecursion() {
        RunOutputRouter.install(manager);
        PySystemState run = new PySystemState();
        run.stdout = manager.stdout;

        RunOutputRouter.enter(run);
        manager.stdout.invoke("write", Py.newString("loop?\n"));
        originalOut.flush();

        assertThat(managerOut.toString(StandardCharsets.UTF_8)).isEqualTo("loop?\n");
    }

    @Test
    @DisplayName("a stream that is not a file is left alone")
    void leavesNonFilesAlone() {
        PyObject notAFile = new PyStringMap();
        manager.stdout = notAFile;

        RunOutputRouter.install(manager);

        assertThat(manager.stdout).isSameAs(notAFile);
        assertThat(manager.stderr).isNotSameAs(originalErr);
    }

    private static PyFile utf8File(ByteArrayOutputStream sink, int bufsize) {
        PyFile file = new PyFile(sink, "<test>", "w", bufsize, false);
        file.encoding = "UTF-8";
        return file;
    }

    /** Run {@code source} with the thread on {@code state}, as a library load leaves it. */
    private static void runAs(PySystemState state, String source) {
        PySystemState before = Py.getSystemState();
        Py.setSystemState(state);
        try {
            PyStringMap ns = new PyStringMap();
            Py.runCode(Py.compile_flags(source, "<test>", CompileMode.exec, new CompilerFlags()),
                ns, ns);
        } finally {
            Py.setSystemState(before);
        }
    }
}
