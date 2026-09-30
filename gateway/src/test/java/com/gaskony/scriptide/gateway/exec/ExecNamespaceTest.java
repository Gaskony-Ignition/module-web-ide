package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompileMode;
import org.python.core.CompilerFlags;
import org.python.core.Py;
import org.python.core.PyCode;
import org.python.core.PyException;
import org.python.core.PyObject;
import org.python.core.PyStringMap;
import org.python.core.PySystemState;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

/**
 * The defect this class exists to prevent: a console that cannot run a function.
 *
 * <p>Measured on the rig on 02/09/2026, on 1.6.0. Every one of these failed:</p>
 *
 * <pre>
 *   x = 41
 *   def f(): return x + 1        NameError: global name 'x' is not defined
 *
 *   import math
 *   def f(): return math.floor(1.5)   NameError: global name 'math' is not defined
 *
 *   def f(): return system.date.now() NameError: global name 'system' is not defined
 * </pre>
 *
 * <p>The cause is the classic {@code exec(code, globals, locals)} trap, and it is
 * invisible from a one-liner: {@link PrivateStateRunner} ran module-level code
 * with the console's locals map as <em>locals</em> and the ScriptManager's
 * (empty) globals as <em>globals</em>. A top-level assignment is an assignment,
 * so it lands in locals; a {@code def} compiled in the same module captures
 * <em>globals</em> as its {@code __globals__}. The function therefore sees
 * nothing the script above it defined — including {@code system}, which the
 * platform seeds into the LOCALS map, so it resolved at module level and
 * vanished one indent in.</p>
 *
 * <p>These tests use {@code Py.runCode} directly, exactly as the runner calls it.
 * The runner itself cannot boot at this level — {@code createUtf8PySystemState}
 * needs the Python stdlib and the {@code jython-ia} jar carries none — so what is
 * pinned here is the namespace rule, which is the whole of the defect. The live
 * exec suite covers it end to end through the socket.</p>
 */
class ExecNamespaceTest {

    @BeforeAll
    static void boot() {
        PySystemState.initialize();
    }

    private static PyCode compile(String source) {
        return Py.compile_flags(source, "<test>", CompileMode.exec, new CompilerFlags());
    }

    /** Run the way the runner does now: ONE dict for both namespaces. */
    private static PyObject runInOneNamespace(String source) {
        PyObject locals = new PyStringMap();
        Py.runCode(compile(source), locals, locals);
        return locals;
    }

    /** Run the way it did until 1.6.1: locals and globals as separate dicts. */
    private static PyObject runInTwoNamespaces(String source) {
        PyObject locals = new PyStringMap();
        Py.runCode(compile(source), locals, new PyStringMap());
        return locals;
    }

    @Test
    @DisplayName("a function sees a variable the script defined above it")
    void functionSeesModuleVariable() {
        PyObject locals = runInOneNamespace("x = 41\ndef f():\n\treturn x + 1\nresult = f()\n");
        assertThat(locals.__finditem__("result").asInt()).isEqualTo(42);
    }

    @Test
    @DisplayName("a function sees a module the script imported above it")
    void functionSeesModuleImport() {
        PyObject locals = runInOneNamespace(
            "import math\ndef f():\n\treturn math.floor(1.5)\nresult = f()\n");
        assertThat(locals.__finditem__("result").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("a class body sees it too")
    void classBodySeesModuleVariable() {
        PyObject locals = runInOneNamespace(
            "V = 7\nclass C:\n\tdef m(self):\n\t\treturn V\nresult = C().m()\n");
        assertThat(locals.__finditem__("result").asInt()).isEqualTo(7);
    }

    @Test
    @DisplayName("a name seeded into the namespace before the run — as `system` is — reaches a function")
    void functionSeesASeededName() {
        // This is the one that mattered most. `system` is not defined by the
        // user's script: ScriptManager.createLocalsMap() puts it in the LOCALS
        // map, so with two namespaces it was reachable at module level and
        // invisible inside every function — which is most Ignition code.
        PyObject locals = new PyStringMap();
        locals.__setitem__("seeded", Py.newInteger(5));
        Py.runCode(compile("def f():\n\treturn seeded * 2\nresult = f()\n"), locals, locals);
        assertThat(locals.__finditem__("result").asInt()).isEqualTo(10);
    }

    @Test
    @DisplayName("globals() at module level is the namespace the script is writing into")
    void globalsIsTheRunningNamespace() {
        // It came back EMPTY on the rig even after an assignment, which is the
        // signature of the two-dict bug and the quickest way to spot a relapse.
        PyObject locals = runInOneNamespace("x = 1\nnames = sorted(globals().keys())\n");
        assertThat(locals.__finditem__("names").toString()).contains("'x'");
    }

    @Test
    @DisplayName("with two namespaces every one of those raises NameError — the defect itself")
    void twoNamespacesBreakEveryCase() {
        // Kept as a live demonstration rather than a comment: if a later change
        // makes this pass, Jython's semantics have moved and the rule above needs
        // re-deriving rather than trusting.
        for (String source : new String[] {
            "x = 41\ndef f():\n\treturn x + 1\nresult = f()\n",
            "import math\ndef f():\n\treturn math.floor(1.5)\nresult = f()\n",
            "V = 7\nclass C:\n\tdef m(self):\n\t\treturn V\nresult = C().m()\n",
        }) {
            Throwable thrown = catchThrowable(() -> runInTwoNamespaces(source));
            assertThat(thrown).as("source: %s", source).isInstanceOf(PyException.class);
            assertThat(thrown.toString()).contains("NameError");
        }
    }
}
