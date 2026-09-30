# Writing tests

A test runs on the gateway, in the same isolated interpreter the script console
uses: a private system state, a bounded pool, a timeout, a Stop and an audit
line. Running one is running arbitrary code and is gated as such — a test that
calls `system.tag.writeBlocking` writes a tag.

## Where a test lives

A test is:

- a top-level `def test_*`, or
- a `test_*` method on a class named `Test*`, or
- any function marked `@test`,

in a module whose **last name starts with `test`** or that sits under a `tests`
package. `orders.test_totals` and `orders.tests.totals` both qualify;
`orders.totals` does not, whatever is written inside it.

That module rule is doing the important work and no decorator widens it.
Discovering `def test_*` anywhere in a project would put
`plc.diagnostics.test_connection` under a Run All button — a function whose job is
to open a socket to a PLC.

## The helpers

```python
from scriptide import test, assertEquals, mockTags
```

`scriptide` exists only while a run is executing. It is not a script library and
a gateway event script cannot import it; a helper ordinary gateway code could
reach would be a second library nobody administers.

**So a module that imports it at the top is not importable outside a run** — from
the Designer's console, or by another module, it raises `ImportError`. The runner
never imports a test module (it executes the source), so this costs a test run
nothing. If you want a test module that stays importable, import inside the
function:

```python
def test_totals():
    from scriptide import assertEquals
    assertEquals(orders.total([1, 2]), 3)
```

### Decorators

| | |
| --- | --- |
| `@test` | a test whatever it is called |
| `@skip` / `@skip('why')` | listed, reported, never called |
| `@timeout(seconds)` | a **budget** — see below |
| `@cases(...)` | one run per row, each reporting separately |
| `@beforeAll` / `@afterAll` | once per module |
| `@beforeEach` / `@afterEach` | around each test. `setUp` / `tearDown` still work |

```python
@cases((2, 3, 5), (0, 0, 0))
def test_adds(a, b, expected):
    assertEquals(a + b, expected)
```

**`@timeout` is a budget, not an interrupt.** The test finishes and then fails if
it took longer. Stopping a running Jython call needs the mechanism that stops the
whole execution, and using it here would end the run rather than the test. The
run-wide timeout is still what saves you from a hang.

### Assertions

`assertEquals` · `assertNotEquals` · `assertTrue` · `assertFalse` · `assertNone`
· `assertNotNone` · `assertIn` · `assertNotIn` · `assertAlmostEquals` ·
`assertRaises` · `assertTagValue` · `assertDbRowCount`

A plain `assert` still works. The helpers exist because their failure message
says what it wanted and what it got.

```python
with assertRaises(ValueError) as raised:
    parse('nope')
assertIn('nope', str(raised.exception))
```

### Mocks

```python
with mockTags({'[default]Tank/Level': 8.2}) as tags:
    pumps.step()
assertEquals(tags.writes, [('[default]Pump/Cmd', 1)])

with mockQuery({'FROM orders': [[1, 'a'], [2, 'b']]}) as db:
    assertEquals(reports.count(), 2)
```

A read or a query the mock was not given **raises**. A quiet `None` turns a
missing fixture into a puzzling assertion failure three lines later.

## What a mock does and does not reach

**It replaces `system` in the test module's own namespace.** Production code the
test calls lives in its own module, whose `system` is untouched, so it still
reaches the real gateway.

That limit is not laziness, it is the safe boundary. Measured on 8.3.8,
07/09/2026: `__import__` of a project-library module hands back the **manager's
own module object**, shared with every script on the gateway — the same `id()`
from two separate runs, and a module global set in one run read back by the next.
`system` lives in each module's own globals. So writing `system` into a module the
test calls would change what every other user's scripts see for as long as the
`with` block is open.

The runner instead executes each selected test module's **source** into a
namespace private to the run, which is ours to write to. When it cannot read the
source it imports the module instead and a mock **refuses**, rather than quietly
writing into the gateway's copy.

## What a run shares

Each run executes every module into a namespace private to that run, so
module-level state does not carry between runs. The tests **within** one run
still share that namespace and one interpreter with each other: a test that
leaves a module global set has affected the next one in the same run.

One execution for the whole run is also why one pool slot, one audit line and one
Stop cover a run of two hundred — and why stopping one loses the results already
collected.

## Reading the result

| | |
| --- | --- |
| `pass` | the function returned |
| `fail` | it raised `AssertionError` — it ran, and the thing it asserts is not true |
| `error` | it raised anything else — it never got far enough to have an opinion |
| `skip` | it carries `@skip` |

`fail` and `error` are kept apart because collapsing them sends you to read an
assertion that never executed.

**Re-run failed** sends the parent ids of everything that failed or errored; a
parameterised case is not separately runnable, so re-running one re-runs its
whole set.
