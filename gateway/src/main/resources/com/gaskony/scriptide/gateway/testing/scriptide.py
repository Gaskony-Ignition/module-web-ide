"""Test helpers for the Web IDE's runner: decorators, assertions and mocks.

Import it from a test module:

    from scriptide import test, assertEquals, mockTags

This module exists only while a test run is executing. The runner puts it in
`sys.modules` before it executes any test module and it is gone afterwards, so it
is not something a gateway event script or a production library can depend on.
That is deliberate: a helper that ordinary gateway code could import would be a
second script library nobody administers.

Two things about the environment shape everything below.

**Each test module is executed into a namespace private to the run.** The runner
does not `__import__` it. An imported project-library module object is the
manager's, shared with every script on the gateway and outliving the run --
measured 07/09/2026: the same `id()` came back from two runs, and a module global
set in one was read by the next. So a mock that wrote `system` into an imported
module's globals would change what every other user's scripts see. Executing the
source ourselves gives a namespace that is ours to write to, and it means module
state no longer carries between runs either.

**The limit that follows, stated plainly.** A mock replaces `system` in the TEST
module's namespace. Production code the test calls lives in its own module, whose
`system` is untouched, so it still reaches the real gateway. Mocking that too
would mean writing into shared modules, which is the thing this design refuses to
do.
"""
import sys as _sys
import time as _time
import traceback as _tb

__all__ = [
    'test', 'skip', 'timeout', 'cases',
    'beforeAll', 'afterAll', 'beforeEach', 'afterEach',
    'assertEquals', 'assertNotEquals', 'assertTrue', 'assertFalse',
    'assertNone', 'assertNotNone', 'assertIn', 'assertNotIn',
    'assertAlmostEquals', 'assertRaises', 'assertTagValue', 'assertDbRowCount',
    'mockTags', 'mockQuery',
]

# Attributes hung on a function by the decorators. Named with the module prefix
# because they land on the user's own functions.
_TEST = '_scriptide_test'
_SKIP = '_scriptide_skip'
_TIMEOUT = '_scriptide_timeout'
_CASES = '_scriptide_cases'
_HOOK = '_scriptide_hook'

# What the runner is executing right now. One entry, because a run is one
# execution on one thread -- there is no second test in flight to confuse it.
_active = {'namespace': None, 'system': None, 'private': False}


# ==================== decorators ====================

def test(function):
    """Mark a function as a test even though its name does not begin `test_`.

    The module rule still applies: it must live in a test module. Widening
    discovery past that is how `plc.diagnostics.test_connection` ends up under a
    Run All button.
    """
    setattr(function, _TEST, True)
    return function


def skip(reason):
    """`@skip` or `@skip('why')`. The test is listed, reported, and not called."""
    if callable(reason):
        setattr(reason, _SKIP, '')
        return reason

    def apply(function):
        setattr(function, _SKIP, reason or '')
        return function
    return apply


def timeout(seconds):
    """A time BUDGET for one test, not an interrupt.

    The test is allowed to finish and then fails if it took longer than this. It
    cannot be an interrupt: stopping a running Jython call needs the mechanism
    that stops the whole execution, and using it here would end the run rather
    than the test. The run-wide timeout is still what saves you from a hang.
    """
    def apply(function):
        setattr(function, _TIMEOUT, float(seconds))
        return function
    return apply


def cases(*rows):
    """Run one function once per row, each row being the arguments.

        @cases((2, 3, 5), (0, 0, 0))
        def test_adds(a, b, expected):
            assertEquals(a + b, expected)

    A single value may be given bare: `@cases(1, 2, 3)` passes one argument each
    time. Every row reports as its own result, so a failing row names itself.
    """
    def apply(function):
        setattr(function, _CASES, list(rows))
        setattr(function, _TEST, True)
        return function
    return apply


def _hook(name):
    def apply(function):
        setattr(function, _HOOK, name)
        return function
    return apply


beforeAll = _hook('beforeAll')
afterAll = _hook('afterAll')
beforeEach = _hook('beforeEach')
afterEach = _hook('afterEach')


# ==================== assertions ====================

def _fail(message, default):
    raise AssertionError(message if message else default)


def assertEquals(actual, expected, message=None):
    """Equal by `==`, which is what the code under test will use."""
    if not actual == expected:
        _fail(message, 'expected %r, got %r' % (expected, actual))


def assertNotEquals(actual, unexpected, message=None):
    if actual == unexpected:
        _fail(message, 'expected something other than %r' % (unexpected,))


def assertTrue(value, message=None):
    if not value:
        _fail(message, 'expected a true value, got %r' % (value,))


def assertFalse(value, message=None):
    if value:
        _fail(message, 'expected a false value, got %r' % (value,))


def assertNone(value, message=None):
    if value is not None:
        _fail(message, 'expected None, got %r' % (value,))


def assertNotNone(value, message=None):
    if value is None:
        _fail(message, 'expected something other than None')


def assertIn(member, container, message=None):
    if member not in container:
        _fail(message, '%r is not in %r' % (member, container))


def assertNotIn(member, container, message=None):
    if member in container:
        _fail(message, '%r is in %r, and should not be' % (member, container))


def assertAlmostEquals(actual, expected, places=7, message=None):
    """For floats. `places` is decimal places, as in unittest."""
    if round(float(actual) - float(expected), places) != 0:
        _fail(message, 'expected %r, got %r (to %d decimal places)'
              % (expected, actual, places))


class _Raises(object):
    """The `with` form of assertRaises. The caught exception is on `.exception`."""

    def __init__(self, expected, message):
        self.expected = expected
        self.message = message
        self.exception = None

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        if kind is None:
            _fail(self.message, 'expected %s, and nothing was raised'
                  % _describe(self.expected))
        if not issubclass(kind, self.expected):
            # NOT ours: let it out. This is also what keeps a Stop working --
            # it arrives as a Java Error, is a subclass of nothing anyone asked
            # for here, and must reach the runner rather than be swallowed.
            return False
        self.exception = value
        return True


def assertRaises(expected, function=None, *args, **kwargs):
    """Either form:

        with assertRaises(ValueError) as raised:
            parse('nope')
        assertIn('nope', str(raised.exception))

        raised = assertRaises(ValueError, parse, 'nope')
    """
    if function is None:
        return _Raises(expected, kwargs.get('message'))
    try:
        function(*args, **kwargs)
    except expected as caught:
        return caught
    _fail(None, 'expected %s, and nothing was raised' % _describe(expected))


def assertTagValue(path, expected, message=None):
    """Read one tag and compare. Reads through a mock when one is active."""
    values = _system().tag.readBlocking([path])
    actual = values[0].value
    if not actual == expected:
        _fail(message, 'tag %s is %r, expected %r' % (path, actual, expected))
    return actual


def assertDbRowCount(query, expected, database='', message=None):
    """Run a query and compare its row count. Goes through a mock when active."""
    rows = _system().db.runQuery(query, database)
    actual = len(rows)
    if actual != expected:
        _fail(message, 'the query returned %d row(s), expected %d' % (actual, expected))
    return actual


def _describe(expected):
    name = getattr(expected, '__name__', None)
    return name if name else repr(expected)


# ==================== mocks ====================

class _Value(object):
    """What `system.tag.readBlocking` hands back, as much of it as a test uses."""

    def __init__(self, value):
        self.value = value
        self.quality = 'Good'
        self.timestamp = None

    def getValue(self):
        return self.value

    def getQuality(self):
        return self.quality

    def __repr__(self):
        return '<mock value %r>' % (self.value,)


class _Good(object):
    """A stand-in for the QualityCode `writeBlocking` returns."""

    def isGood(self):
        return True

    def isNotGood(self):
        return False

    def __repr__(self):
        return 'Good'


class _Dataset(list):
    """A list that also answers the few Dataset methods a test reaches for."""

    def getRowCount(self):
        return len(self)

    def getColumnCount(self):
        return len(self[0]) if len(self) else 0

    def getValueAt(self, row, column):
        return self[row][column]


class _Tags(object):
    """`system.tag`, faked for the paths the test named and delegating the rest."""

    def __init__(self, real, values, reads, writes):
        self._real = real
        self._values = values
        self._reads = reads
        self._writes = writes

    def __getattr__(self, name):
        # browse, configure, everything not faked: the real thing.
        if self._real is None:
            raise AttributeError(name)
        return getattr(self._real, name)

    def readBlocking(self, paths, *rest):
        out = []
        for path in paths:
            self._reads.append(path)
            if path not in self._values:
                # Loudly, not None. A mock that quietly answers None for a path
                # nobody set turns a missing fixture into a puzzling assertion
                # failure three lines further down.
                raise AssertionError(
                    'mockTags has no value for %s -- add it to the dict, or let '
                    'the read reach the real gateway by not mocking it.' % path)
            out.append(_Value(self._values[path]))
        return out

    def writeBlocking(self, paths, values, *rest):
        for index in range(len(paths)):
            value = values[index] if index < len(values) else None
            self._writes.append((paths[index], value))
            # A written tag reads back, which is what a test that writes then
            # asserts expects of a real gateway.
            self._values[paths[index]] = value
        return [_Good() for _ in paths]

    def writeAsync(self, paths, values, *rest):
        return self.writeBlocking(paths, values)


class _Db(object):
    """`system.db`, answering by SQL fragment and delegating the rest."""

    def __init__(self, real, answers, queries, updates):
        self._real = real
        self._answers = answers
        self._queries = queries
        self._updates = updates

    def __getattr__(self, name):
        if self._real is None:
            raise AttributeError(name)
        return getattr(self._real, name)

    def _answer(self, query):
        for fragment in self._answers:
            if fragment in query:
                return self._answers[fragment]
        raise AssertionError(
            'mockQuery has no answer for this query. Add a fragment of it as a '
            'key: %s' % ' '.join(query.split())[:160])

    def runQuery(self, query, database='', *rest):
        self._queries.append(query)
        return _Dataset(self._answer(query))

    def runPrepQuery(self, query, args=None, database='', *rest):
        self._queries.append(query)
        return _Dataset(self._answer(query))

    def runScalarQuery(self, query, database='', *rest):
        self._queries.append(query)
        answer = self._answer(query)
        if isinstance(answer, (list, tuple)):
            if not len(answer):
                return None
            first = answer[0]
            return first[0] if isinstance(first, (list, tuple)) else first
        return answer

    def runPrepUpdate(self, query, args=None, database='', *rest):
        self._updates.append(query)
        return self._answer(query) if self._matches(query) else 1

    def runUpdateQuery(self, query, database='', *rest):
        self._updates.append(query)
        return self._answer(query) if self._matches(query) else 1

    def _matches(self, query):
        for fragment in self._answers:
            if fragment in query:
                return True
        return False


class _Proxy(object):
    """`system`, with one or two packages replaced and everything else real."""

    def __init__(self, real, tag=None, db=None):
        self._real = real
        self._tag = tag
        self._db = db

    def __getattr__(self, name):
        if name == 'tag' and self._tag is not None:
            return self._tag
        if name == 'db' and self._db is not None:
            return self._db
        if self._real is None:
            raise AttributeError(
                "there is no `system` here: %s cannot be reached outside a test run" % name)
        return getattr(self._real, name)


class _Swap(object):
    """Put a proxy `system` in the running test module's namespace, and take it out.

    Nesting works because the proxy wraps whatever `system` is bound to at the
    moment it is entered, so `with mockTags(...), mockQuery(...)` gives both.
    """

    def __init__(self):
        self._namespace = None
        self._had = False
        self._previous = None

    def _install(self, build):
        self._namespace = _namespace()
        self._had = 'system' in self._namespace
        self._previous = self._namespace.get('system')
        real = self._previous if self._had else _active['system']
        self._namespace['system'] = build(real)
        return self

    def __exit__(self, kind, value, traceback):
        if self._had:
            self._namespace['system'] = self._previous
        elif 'system' in self._namespace:
            del self._namespace['system']
        # Never True: swallowing here would eat the test's own failure, and a
        # Stop with it.
        return False


class mockTags(_Swap):
    """Answer tag reads from a dict, and record every write.

        with mockTags({'[default]Tank/Level': 8.2}) as tags:
            pumps.step()
        assertEquals(tags.writes, [('[default]Pump/Cmd', 1)])

    A read of a path the dict does not hold raises rather than returning None.
    """

    def __init__(self, values=None):
        _Swap.__init__(self)
        self.values = dict(values or {})
        self.reads = []
        self.writes = []

    def __enter__(self):
        return self._install(lambda real: _Proxy(
            real, tag=_Tags(getattr(real, 'tag', None), self.values,
                            self.reads, self.writes)))

    def value(self, path):
        """What the mock now holds for a path, including anything written to it."""
        return self.values.get(path)


class mockQuery(_Swap):
    """Answer `system.db` queries by SQL fragment, and record every call.

        with mockQuery({'FROM orders': [[1, 'a'], [2, 'b']]}) as db:
            assertEquals(reports.count(), 2)
        assertEquals(len(db.queries), 1)

    The key is any fragment of the SQL. A query matching no fragment raises.
    """

    def __init__(self, answers=None):
        _Swap.__init__(self)
        self.answers = dict(answers or {})
        self.queries = []
        self.updates = []

    def __enter__(self):
        return self._install(lambda real: _Proxy(
            real, db=_Db(getattr(real, 'db', None), self.answers,
                         self.queries, self.updates)))


def _namespace():
    """The running test module's own namespace -- and only if it IS its own.

    The interlock, not a formality. The runner normally executes a test module's
    source into a fresh dict, which is ours to write to. When it cannot get the
    source it falls back to importing the module, and what comes back then is the
    gateway's shared module object: writing `system` into that would change what
    every other script on the gateway sees for as long as the mock is open. So a
    mock refuses rather than silently doing that.
    """
    namespace = _active['namespace']
    if namespace is None:
        raise AssertionError(
            'a mock only works inside a test the Web IDE runner is running')
    if not _active['private']:
        raise AssertionError(
            'this test module was imported rather than executed for the run, so its '
            'namespace is shared with the whole gateway and a mock cannot be '
            'installed in it safely')
    return namespace


def _system():
    namespace = _active['namespace']
    if namespace is not None and 'system' in namespace:
        return namespace['system']
    if _active['system'] is not None:
        return _active['system']
    raise AssertionError(
        "this helper needs Ignition's `system` object and the runner supplied none")
