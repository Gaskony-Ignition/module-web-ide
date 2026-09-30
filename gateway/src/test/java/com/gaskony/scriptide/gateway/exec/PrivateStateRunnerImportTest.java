package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.Py;
import org.python.core.PyObject;
import org.python.core.PyStringMap;
import org.python.core.PySystemState;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The import hook, and the two ways it could be worse than the bug it fixes.
 *
 * <p><b>What it is for:</b> an import that loads a project library module runs
 * that module through {@code ScriptManager.runCode}, which calls
 * {@code Py.setSystemState(manager.sys)} on the calling thread and never puts it
 * back. The hook restores the run's own state when {@code __import__} returns, so
 * the run's {@code sys} stays private. (Output is kept right by
 * {@link RunOutputRouter} whether or not the hook saw the load.)</p>
 *
 * <p><b>The first way to make it worse</b> is the one that actually happened while
 * diagnosing it. Jython hands every {@code PySystemState} the SAME
 * {@code getDefaultBuiltins()} table, so writing {@code __import__} into
 * "the namespace's builtins" replaces it for the entire JVM — every project
 * script and every gateway event script — with a closure belonging to one
 * console session. That is asserted here, because it is invisible from inside a
 * run: the run that does it looks completely correct.</p>
 *
 * <p><b>The second</b> is chaining. The console's namespace survives between runs,
 * so a hook copied FORWARD would wrap the previous run's hook and restore a
 * system state that had already been finished — sending the new run's output
 * into a dead capture. Each install therefore copies from the state's own
 * builtins, which is always the pristine table.</p>
 */
class PrivateStateRunnerImportTest {

    @BeforeAll
    static void boot() {
        PySystemState.initialize();
    }

    @Test
    @DisplayName("the JVM-wide builtins table is never touched")
    void leavesTheSharedTableAlone() {
        PyObject shared = PySystemState.getDefaultBuiltins();
        PyObject realImport = shared.__finditem__("__import__");
        assertThat(realImport).isNotNull();

        PySystemState state = new PySystemState();
        PrivateStateRunnerImportTest.install(state, new PyStringMap());

        assertThat(PySystemState.getDefaultBuiltins()).isSameAs(shared);
        assertThat(shared.__finditem__("__import__")).isSameAs(realImport);
    }

    @Test
    @DisplayName("the run gets its OWN table, and the namespace points at it")
    void givesTheRunItsOwnTable() {
        PySystemState state = new PySystemState();
        PyStringMap locals = new PyStringMap();
        install(state, locals);

        PyObject mine = state.getBuiltins();
        assertThat(mine).isNotSameAs(PySystemState.getDefaultBuiltins());
        assertThat(mine.__finditem__("__import__"))
            .isNotSameAs(PySystemState.getDefaultBuiltins().__finditem__("__import__"));
        // The frame reads its builtins from the globals when they name one, so
        // both have to be set or a persistent namespace keeps the old table.
        assertThat(locals.__finditem__("__builtins__")).isSameAs(mine);
        // Everything else is still there: this is a copy, not a replacement.
        assertThat(mine.__finditem__("len")).isNotNull();
        assertThat(mine.__finditem__("Exception")).isNotNull();
    }

    @Test
    @DisplayName("calling it puts this run's system state back")
    void restoresTheState() {
        PySystemState state = new PySystemState();
        PyStringMap locals = new PyStringMap();
        install(state, locals);
        PyObject hook = state.getBuiltins().__finditem__("__import__");

        PySystemState previous = Py.getSystemState();
        try {
            // Stand in for what the platform's importer does to the thread.
            Py.setSystemState(new PySystemState());
            hook.__call__(new PyObject[] { Py.newString("sys") }, new String[0]);
            assertThat(Py.getSystemState()).isSameAs(state);
        } finally {
            Py.setSystemState(previous);
        }
    }

    @Test
    @DisplayName("a second run's hook restores the SECOND run's state, not the first's")
    void doesNotChain() {
        // The same namespace twice, which is exactly what the console does: its
        // locals — and therefore its `__builtins__` — outlive every run.
        PyStringMap locals = new PyStringMap();
        PySystemState first = new PySystemState();
        install(first, locals);
        PyObject firstHook = state(locals);

        PySystemState second = new PySystemState();
        install(second, locals);
        PyObject secondHook = state(locals);

        assertThat(secondHook).isNotSameAs(firstHook);

        PySystemState previous = Py.getSystemState();
        try {
            Py.setSystemState(new PySystemState());
            secondHook.__call__(new PyObject[] { Py.newString("sys") }, new String[0]);
            // Not `first`: restoring the earlier run's state would send this
            // run's output into a capture that has already been closed.
            assertThat(Py.getSystemState()).isSameAs(second);
        } finally {
            Py.setSystemState(previous);
        }
    }

    @Test
    @DisplayName("the import still imports")
    void stillImports() {
        PySystemState state = new PySystemState();
        PyStringMap locals = new PyStringMap();
        install(state, locals);
        PyObject hook = state.getBuiltins().__finditem__("__import__");

        PySystemState previous = Py.getSystemState();
        try {
            PyObject module = hook.__call__(new PyObject[] { Py.newString("sys") }, new String[0]);
            assertThat(module).isNotNull();
            assertThat(module.__findattr__("modules")).isNotNull();
        } finally {
            Py.setSystemState(previous);
        }
    }

    private static void install(PySystemState state, PyObject locals) {
        PrivateStateRunner.installImportHook(state, locals);
    }

    /** The hook currently installed in this namespace. */
    private static PyObject state(PyStringMap locals) {
        return locals.__finditem__("__builtins__").__finditem__("__import__");
    }
}
