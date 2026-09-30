"""The loop that runs a project's tests. Private to the runner; never importable.

The flat harness executes this into a namespace of its own and calls `run`. It is
a separate file from `scriptide.py` for one reason: everything here would
otherwise be part of the module people import, and a helper library whose public
surface includes its own scheduler invites someone to call it.

**Why the test module's source is executed rather than imported.** Measured on
8.3.8, 07/09/2026: `__import__` of a project-library module hands back the
manager's own module object -- the same `id()` from two separate runs, with a
global set in one visible in the next, on every user's behalf. Executing the
source into a fresh dict gives a namespace private to this run, which is what
makes a mock safe to install and what stops one run's module state reaching the
next. When the source is not available the loop falls back to importing, and
tells `scriptide` that the namespace is shared so a mock refuses instead of
quietly writing to it.

**The two passes are the same two passes as before, and for the same reason.**
Every module is prepared before anything is printed: writing to `sys.stdout` and
then executing a project-library import loses the whole execution's output. The
private system state is re-asserted afterwards, because resolving an import moves
the thread onto the platform's state and leaves it there.
"""
import sys as _sys
import time as _time
import traceback as _tb

import scriptide as _api

_TEST = '_scriptide_test'
_SKIP = '_scriptide_skip'
_TIMEOUT = '_scriptide_timeout'
_CASES = '_scriptide_cases'
_HOOK = '_scriptide_hook'

_HOOK_NAMES = ('beforeAll', 'afterAll', 'beforeEach', 'afterEach')


def _mark(marker, text):
    _sys.stdout.write(marker + text + chr(10))


def _prepare(module, sources, systemObject):
    """A namespace for one test module: ours if we can, the gateway's if we must.

    Returns `(namespace, private, error)`. `error` is a `(message, traceback)`
    pair when the module could not be prepared at all, in which case every test
    in it reports as an error -- per test, because the panel's row is where
    somebody looks.
    """
    source = sources.get(module)
    if source is not None:
        namespace = {
            '__name__': module,
            '__builtins__': __builtins__,
            'system': systemObject,
        }
        try:
            code = compile(source, '<scriptide-test:' + module + '>', 'exec')
            exec code in namespace
        except Exception as error:
            return (None, True, (error.__class__.__name__ + ': ' + str(error),
                                 _tb.format_exc()))
        return (namespace, True, None)
    try:
        imported = __import__(module, {}, {}, ['*'])
    except Exception as error:
        return (None, False, (error.__class__.__name__ + ': ' + str(error),
                              _tb.format_exc()))
    return (imported.__dict__, False, None)


def _hooks(namespace):
    """What brackets the tests in one module: the decorators, then the old names."""
    found = {}
    for name in _HOOK_NAMES:
        found[name] = None
    for name in list(namespace.keys()):
        try:
            kind = getattr(namespace[name], _HOOK, None)
        except Exception:
            continue
        if kind in found and found[kind] is None:
            found[kind] = namespace[name]
    # setUp and tearDown keep working. They are the unittest names, which is the
    # meaning a reader already has, and projects written against the old runner
    # must not stop working because a decorator now exists.
    if found['beforeEach'] is None and callable(namespace.get('setUp')):
        found['beforeEach'] = namespace['setUp']
    if found['afterEach'] is None and callable(namespace.get('tearDown')):
        found['afterEach'] = namespace['tearDown']
    return found


def _resolve(namespace, spec):
    """The callable one spec names, instantiating the class if there is one."""
    if spec[1]:
        owner = namespace[spec[1]]()
        return getattr(owner, spec[2])
    return namespace[spec[2]]


def _label(args):
    if len(args) == 1:
        return repr(args[0])
    return repr(tuple(args))


def _expand(spec, target):
    """One entry per case, or a single entry for an ordinary test.

    Each is `(id, case label, args)`. The id of a case is the parent's with an
    index appended, so it is stable across runs even when a label is unwieldy.
    """
    rows = getattr(target, _CASES, None)
    if rows is None:
        return [(spec[3], None, ())]
    items = []
    index = 0
    for row in rows:
        args = tuple(row) if isinstance(row, (list, tuple)) else (row,)
        items.append((spec[3] + '[' + str(index) + ']', _label(args), args))
        index = index + 1
    return items


def _reassert():
    """Put the thread back on our private system state -- see the module docstring."""
    try:
        from org.python.core import Py
        Py.setSystemState(_sys)
    except Exception:
        pass


def run(specs, sources, marker, systemObject):
    """Run the selected tests and return a list of result dicts.

    `specs` is a list of `[module, class, function, id]`, seeded as data. Nothing
    a user named is ever formatted into source here, which is the property that
    keeps holding when somebody adds a feature later.
    """
    order = []
    grouped = {}
    for spec in specs:
        if spec[0] not in grouped:
            grouped[spec[0]] = []
            order.append(spec[0])
        grouped[spec[0]].append(spec)

    # ---- pass one: prepare every module. Nothing is printed in this loop.
    prepared = {}
    for module in order:
        prepared[module] = _prepare(module, sources, systemObject)
    _reassert()

    # ---- pass two: markers, and the runs.
    results = []
    for module in order:
        namespace, private, failure = prepared[module]
        specsForModule = grouped[module]
        hooks = _hooks(namespace) if namespace is not None else None
        moduleStarted = False
        # beforeAll runs inside the FIRST selected test's marker window and
        # afterAll inside the last's, so whatever they print is attributed
        # somewhere rather than dropped. Said out loud because it means a
        # fixture's output appears under a test that did not write it.
        lastIndex = len(specsForModule) - 1
        for position in range(len(specsForModule)):
            spec = specsForModule[position]
            target = None
            resolveFailure = failure
            if namespace is not None:
                try:
                    target = _resolve(namespace, spec)
                except Exception as error:
                    resolveFailure = (error.__class__.__name__ + ': ' + str(error),
                                      _tb.format_exc())
            items = _expand(spec, target) if target is not None \
                else [(spec[3], None, ())]
            for itemPosition in range(len(items)):
                identifier, case, args = items[itemPosition]
                _mark(marker, '>' + identifier)
                status = 'pass'
                message = ''
                trace = ''
                started = _time.time()
                if resolveFailure is not None:
                    status = 'error'
                    message = resolveFailure[0]
                    trace = resolveFailure[1]
                elif hasattr(target, _SKIP):
                    status = 'skip'
                    message = getattr(target, _SKIP) or 'skipped'
                else:
                    _api._active['namespace'] = namespace
                    _api._active['system'] = systemObject
                    _api._active['private'] = private
                    first = not moduleStarted
                    moduleStarted = True
                    last = position == lastIndex and itemPosition == len(items) - 1
                    try:
                        if first and hooks['beforeAll'] is not None:
                            hooks['beforeAll']()
                        try:
                            if hooks['beforeEach'] is not None:
                                hooks['beforeEach']()
                            try:
                                target(*args)
                            finally:
                                # afterEach runs even when the test raised, which
                                # is the whole reason anyone writes one.
                                if hooks['afterEach'] is not None:
                                    hooks['afterEach']()
                        finally:
                            if last and hooks['afterAll'] is not None:
                                hooks['afterAll']()
                    except AssertionError as error:
                        status = 'fail'
                        message = str(error)
                        if not message:
                            message = 'assertion failed'
                        trace = _tb.format_exc()
                    except Exception as error:
                        status = 'error'
                        message = error.__class__.__name__ + ': ' + str(error)
                        trace = _tb.format_exc()
                    _api._active['namespace'] = None
                    _api._active['private'] = False
                _mark(marker, '<')
                elapsed = int((_time.time() - started) * 1000)
                budget = getattr(target, _TIMEOUT, None)
                if budget is not None and status == 'pass' \
                        and elapsed > int(budget * 1000):
                    # A budget, not an interrupt: the test finished and took too
                    # long. An existing failure is left alone -- it is the more
                    # useful of the two facts.
                    status = 'fail'
                    message = ('took %.2f s, over its %.2f s budget'
                               % (elapsed / 1000.0, budget))
                results.append({
                    'id': identifier,
                    'parentId': spec[3],
                    'case': case,
                    'module': spec[0],
                    'function': spec[2],
                    'status': status,
                    'message': message,
                    'traceback': trace,
                    'elapsedMs': elapsed})
    return results
