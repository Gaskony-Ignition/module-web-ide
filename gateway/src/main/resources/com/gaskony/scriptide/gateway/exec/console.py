"""Two printing helpers, seeded into every execution namespace this module makes.

`cprint(text, colour)` writes colour; `jsonPrint(value)` writes readable JSON.
Both emit ANSI escapes, which the console renders and which are harmless
anywhere else -- a gateway log gets the escape bytes and the text, not a crash.

They are defined here rather than in Java because they are Python, and because a
function compiled into the run's own namespace resolves `print` at CALL time,
through whichever `PySystemState` the run is on. Building the escape in Java and
asking the user to print it would work too, and would be a worse thing to write.

Available in the script console and in a test run. NOT in ordinary gateway code:
they live in the namespace this module creates for an execution, and nothing
outside one has that namespace.
"""

_SCRIPTIDE_COLOURS = {
    'black': 30, 'red': 31, 'green': 32, 'yellow': 33,
    'blue': 34, 'magenta': 35, 'cyan': 36, 'white': 37,
    'grey': 90, 'gray': 90,
    'brightred': 91, 'brightgreen': 92, 'brightyellow': 93,
    'brightblue': 94, 'brightmagenta': 95, 'brightcyan': 96, 'brightwhite': 97,
}


def _scriptide_sgr(colour, bold):
    """The escape prefix for a colour name or `#rrggbb`, or '' for neither."""
    codes = []
    if bold:
        codes.append('1')
    if colour:
        name = str(colour).strip().lower()
        if name.startswith('#') and len(name) == 7:
            try:
                codes.append('38;2;%d;%d;%d' % (int(name[1:3], 16),
                                                int(name[3:5], 16),
                                                int(name[5:7], 16)))
            except ValueError:
                # A colour that will not parse is not worth failing a print for.
                pass
        elif name in _SCRIPTIDE_COLOURS:
            codes.append(str(_SCRIPTIDE_COLOURS[name]))
    if not codes:
        return ''
    return '\x1b[' + ';'.join(codes) + 'm'


def cprint(text, colour=None, bold=False):
    """Print in colour.

        cprint('started', 'green')
        cprint('careful', '#ff8800', bold=True)

    `colour` is one of black red green yellow blue magenta cyan white grey, any
    of those prefixed `bright`, or `#rrggbb`. An unknown one prints plainly
    rather than raising: a colour is not worth failing a print for.
    """
    prefix = _scriptide_sgr(colour, bold)
    if not prefix:
        print str(text)
    else:
        print prefix + str(text) + '\x1b[0m'


def jsonPrint(value, indent=2):
    """Print a value as indented, coloured JSON.

    Anything `json` cannot encode -- a Dataset, a QualifiedValue, a Java object
    -- falls back to `repr`, printed plainly. Refusing to print at all would be
    the wrong answer to "show me what this is".
    """
    import json as _json
    import re as _re
    try:
        text = _json.dumps(value, indent=indent, sort_keys=True)
    except Exception:
        print repr(value)
        return

    def _paint(match):
        token = match.group(0)
        if match.group('key') is not None:
            return '\x1b[36m' + token + '\x1b[0m'
        if token.startswith('"'):
            return '\x1b[32m' + token + '\x1b[0m'
        if token in ('true', 'false', 'null'):
            return '\x1b[35m' + token + '\x1b[0m'
        return '\x1b[33m' + token + '\x1b[0m'

    # One pass, keys first so a key is never painted as a string value. The
    # string pattern honours backslash escapes, or a value containing \" ends
    # the match early and the rest of the line is coloured as if it were code.
    pattern = _re.compile(
        r'(?P<key>"(?:[^"\\]|\\.)*")\s*(?=:)'
        r'|"(?:[^"\\]|\\.)*"'
        r'|\btrue\b|\bfalse\b|\bnull\b'
        r'|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?')
    print pattern.sub(_paint, text)
