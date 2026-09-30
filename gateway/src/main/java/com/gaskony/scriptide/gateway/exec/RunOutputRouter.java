package com.gaskony.scriptide.gateway.exec;

import org.python.core.Py;
import org.python.core.PyFile;
import org.python.core.PyObject;
import org.python.core.PySystemState;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Sends output written to a project's platform {@code sys.stdout}/{@code sys.stderr}
 * to the Web IDE run on the writing thread, when there is one.
 *
 * <h2>Why</h2>
 *
 * <p>Ignition loads a project library module lazily, on first attribute access,
 * through {@code ScriptManager.runCode} — which calls
 * {@code Py.setSystemState(manager.sys)} on the calling thread and never restores
 * it. The load can happen anywhere: in the console's own code, or deep inside
 * project code the console called. From then on {@code print} resolves the
 * MANAGER's streams, so without this class everything the run printed after its
 * first use of a not-yet-loaded module went to the gateway's own log instead.
 * Measured on 8.3.9: {@code import M; M.probe()}, a bare {@code M.probe()},
 * {@code P.sub.probe()} and {@code M1.call()} reaching a fresh {@code M2} all lost
 * every line after the load, on the first run only.</p>
 *
 * <p>Intercepting every load point is not possible, so the flip is made harmless
 * instead: each manager's {@code sys.stdout} and {@code sys.stderr} are replaced,
 * once, by an unbuffered {@link PyFile} over a {@link Dispatch} stream. A thread
 * inside {@link PrivateStateRunner#run} has its run's private state registered
 * here, and its writes go to that state's stream; every other thread's writes go
 * to the manager's original file object.</p>
 *
 * <h2>Transparent to everything else</h2>
 *
 * <ul>
 *   <li>The replacement is a real {@code PyFile}, so {@code print} takes Jython's
 *       file fast path exactly as before — including the flush after every
 *       {@code print}. A plain {@code PyObject} proxy would fall to the generic
 *       path, which never flushes, and gateway scripts' output would sit in a
 *       buffer.</li>
 *   <li>It is UNBUFFERED, so bytes are routed on the thread that produced them.
 *       A buffer here would let one thread's flush carry another thread's bytes,
 *       which is the cross-talk {@code runCode} itself suffers from.</li>
 *   <li>Its {@code encoding} and {@code errors} are copied from the original, so a
 *       unicode {@code print} encodes to the same bytes; the original keeps its
 *       own buffering below.</li>
 *   <li>{@code softspace} lives on the replacement and is shared by every thread
 *       writing to it — as it was on the original.</li>
 * </ul>
 *
 * <p>Only a manager whose stream is a {@code PyFile} is wrapped; anything else is
 * left alone. {@link #restoreAll} puts every original back on module shutdown, so
 * no project keeps a reference into an unloaded module.</p>
 */
public final class RunOutputRouter {

    private static final Logger logger = LoggerFactory.getLogger(RunOutputRouter.class);

    /** The private state of the Web IDE run executing on this thread, if any. */
    private static final ThreadLocal<PySystemState> CURRENT_RUN = new ThreadLocal<>();

    /** Guards wrapping and restoring; the write path never takes it. */
    private static final Object LOCK = new Object();

    /** Every manager state wrapped so far, weakly: a rebuilt library drops its old one. */
    private static final List<WeakReference<PySystemState>> WRAPPED = new ArrayList<>();

    private RunOutputRouter() { }

    /** Route this thread's writes to {@code run}'s streams until {@link #exit}. */
    static void enter(PySystemState run) {
        CURRENT_RUN.set(run);
    }

    /** Stop routing this thread; its writes go to the original streams again. */
    static void exit() {
        CURRENT_RUN.remove();
    }

    /**
     * Wrap {@code manager}'s stdout and stderr, unless already wrapped. Cheap
     * enough to call on every run.
     */
    static void install(PySystemState manager) {
        if (manager == null || (isOurs(manager.stdout) && isOurs(manager.stderr))) {
            return;
        }
        synchronized (LOCK) {
            boolean wrapped = false;
            if (!isOurs(manager.stdout)) {
                PyFile replacement = wrap(manager, manager.stdout, false);
                if (replacement != null) {
                    manager.stdout = replacement;
                    wrapped = true;
                }
            }
            if (!isOurs(manager.stderr)) {
                PyFile replacement = wrap(manager, manager.stderr, true);
                if (replacement != null) {
                    manager.stderr = replacement;
                    wrapped = true;
                }
            }
            if (wrapped) {
                WRAPPED.removeIf(ref -> ref.get() == null);
                WRAPPED.add(new WeakReference<>(manager));
            }
        }
    }

    /** Put every wrapped manager's original streams back. Safe to call twice. */
    public static void restoreAll() {
        synchronized (LOCK) {
            for (WeakReference<PySystemState> ref : WRAPPED) {
                PySystemState manager = ref.get();
                if (manager == null) {
                    continue;
                }
                // Only undo our own wrapper: something may have replaced it since.
                if (isOurs(manager.stdout)) {
                    manager.stdout = original(manager.stdout);
                }
                if (isOurs(manager.stderr)) {
                    manager.stderr = original(manager.stderr);
                }
            }
            WRAPPED.clear();
        }
    }

    private static PyFile wrap(PySystemState manager, PyObject current, boolean stderr) {
        if (!(current instanceof PyFile original)) {
            logger.debug("Not wrapping sys.{}: it is a {}, not a file", stderr ? "stderr" : "stdout",
                current == null ? "null" : current.getClass().getName());
            return null;
        }
        // A PyFile registers its closer with the thread's CURRENT system state, so
        // build it under the manager's: its lifetime is the manager's, not
        // whichever run happened to install it.
        PySystemState previous = Py.getSystemState();
        Py.setSystemState(manager);
        try {
            PyFile replacement = new RoutedFile(original, stderr);
            replacement.encoding = original.encoding;
            replacement.errors = original.errors;
            return replacement;
        } finally {
            Py.setSystemState(previous);
        }
    }

    private static boolean isOurs(PyObject stream) {
        return stream instanceof RoutedFile;
    }

    private static PyObject original(PyObject ours) {
        return ((RoutedFile) ours).original;
    }

    /**
     * The replacement: an ordinary unbuffered {@code file} whose bytes go to a
     * {@link Dispatch}. A subclass only so it can be recognised and unwrapped; it
     * overrides nothing, and its Python type is {@code file}.
     */
    static final class RoutedFile extends PyFile {
        // PyObject is Serializable; this never is, but the id is declared rather
        // than left to the compiler.
        private static final long serialVersionUID = 1L;

        private final PyFile original;

        RoutedFile(PyFile original, boolean stderr) {
            super(new Dispatch(original, stderr), String.valueOf(original.name), "w", 0, false);
            // A Java subclass otherwise gets a derived Python type of its own name.
            this.objtype = PyFile.TYPE;
            this.original = original;
        }
    }

    /**
     * The per-thread switch under the replacement file.
     *
     * <p>Bytes are handed on as a Python byte string (ISO-8859-1 maps each byte to
     * one char), so the target sees exactly what the replacement encoded.</p>
     */
    static final class Dispatch extends OutputStream {
        private final PyFile original;
        private final boolean stderr;

        Dispatch(PyFile original, boolean stderr) {
            this.original = original;
            this.stderr = stderr;
        }

        private PyObject target() {
            PySystemState run = CURRENT_RUN.get();
            if (run != null) {
                PyObject mine = stderr ? run.stderr : run.stdout;
                // A run whose own sys.stdout was pointed at this wrapper would
                // otherwise recurse until the stack ran out.
                if (mine != null && !isOurs(mine)) {
                    return mine;
                }
            }
            return original;
        }

        @Override
        public void write(int b) {
            write(new byte[] {(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] b, int off, int len) {
            if (len == 0) {
                return;
            }
            target().invoke("write",
                Py.newString(new String(b, off, len, StandardCharsets.ISO_8859_1)));
        }

        @Override
        public void flush() {
            target().invoke("flush");
        }

        /** Never closes the original: the manager still owns it. */
        @Override
        public void close() {
            flush();
        }
    }
}
