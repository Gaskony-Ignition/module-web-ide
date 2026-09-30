package com.gaskony.scriptide.gateway.lang;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Every safety rule in {@link ImportOrganiser}, one test per rule, named for the
 * rule it proves.
 *
 * <p>The rules matter more than the sorting: a tool that reorders imports
 * wrongly is annoying, one that silently deletes a line of somebody's code is a
 * broken module. Most tests here are built as a pair — something that SHOULD be
 * removed, and something that looks the same but must not be — because the
 * dangerous half of this feature is proven by what it leaves alone.</p>
 */
class ImportOrganiserTest {

    private static final ImportOrganiser.Lookup NO_PROJECT_HITS = name -> Optional.empty();

    @Test
    @DisplayName("a syntax error leaves the file byte-identical")
    void syntaxErrorLeavesSourceUnchanged() {
        String source = "import os\ndef f(:\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).isEqualTo(source);
        assertThat(result.removed()).isEmpty();
        assertThat(result.suggestions()).isEmpty();
        assertThat(result.notes()).isNotEmpty();
    }

    @Test
    @DisplayName("a module docstring above the imports is skipped, not treated as code")
    void docstringIsNotCode() {
        // The defect this pins: treating the docstring as code made the whole
        // feature a no-op on exactly the files that are written well. Almost
        // every module in this estate opens with one.
        String source = "\"\"\"What this module is for.\"\"\"\nimport sys\nimport os\n\nprint(os, sys)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).startsWith("\"\"\"What this module is for.\"\"\"\n");
        assertThat(result.source()).contains("import os\nimport sys\n");
    }

    @Test
    @DisplayName("a docstring spanning several lines is skipped whole")
    void multiLineDocstring() {
        String source = String.join("\n",
            "\"\"\"Line one.",
            "",
            "Line two, which mentions import os and should not confuse anything.",
            "\"\"\"",
            "import sys",
            "import os",
            "",
            "print(os, sys)",
            "");
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os\nimport sys\n");
        assertThat(result.source()).startsWith("\"\"\"Line one.");
    }

    @Test
    @DisplayName("a shebang and a comment header above the docstring are kept in place")
    void headerSurvives() {
        String source = String.join("\n",
            "# -*- coding: utf-8 -*-",
            "\"\"\"Doc.\"\"\"",
            "import sys",
            "import os",
            "",
            "print(os, sys)",
            "");
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).startsWith("# -*- coding: utf-8 -*-\n\"\"\"Doc.\"\"\"\n");
        assertThat(result.source()).contains("import os\nimport sys\n");
    }

    @Test
    @DisplayName("a one-line docstring in single quotes counts, an assignment does not")
    void singleQuotedDocstringButNotAnAssignment() {
        String doc = "'Doc.'\nimport sys\nimport os\n\nprint(os, sys)\n";
        assertThat(ImportOrganiser.organise(doc, NO_PROJECT_HITS).source())
            .contains("import os\nimport sys\n");

        // An assignment is CODE, and imports below code are never touched.
        String assigned = "x = 'a'\nimport sys\nimport os\n\nprint(os, sys, x)\n";
        assertThat(ImportOrganiser.organise(assigned, NO_PROJECT_HITS).source())
            .isEqualTo(assigned);
    }

    @Test
    @DisplayName("only the FIRST string is a docstring — a second one is code")
    void secondStringIsCode() {
        // `"""a"""` then `"""b"""` then imports: the second string is a
        // statement, so the imports are below code and must not move.
        String source = "\"\"\"Doc.\"\"\"\n\"\"\"Not a docstring.\"\"\"\nimport sys\nimport os\n\nprint(os, sys)\n";
        assertThat(ImportOrganiser.organise(source, NO_PROJECT_HITS).source()).isEqualTo(source);
    }

    @Test
    @DisplayName("a backslash line continuation refuses the whole rewrite")
    void backslashContinuationRefuses() {
        String source = "import os, \\\n    sys\n\nprint(os, sys)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).isEqualTo(source);
        assertThat(result.notes()).anyMatch(n -> n.toLowerCase().contains("backslash"));
    }

    @Test
    @DisplayName("an unclosed bracket refuses the whole rewrite")
    void unbalancedBracketsRefuse() {
        String source = "from foo import (\n    bar,\n    baz,\n)\n\nprint(bar, baz)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).isEqualTo(source);
        assertThat(result.notes()).anyMatch(n -> n.toLowerCase().contains("bracket"));
    }

    @Test
    @DisplayName("tabs and a missing trailing newline survive a reorder")
    void tabsAndMissingTrailingNewlineSurvive() {
        // No trailing newline, and the body below the block is indented with a
        // tab — neither is touched by the reorder above it.
        String source = "import sys\nimport os\n\ndef f():\n\treturn os.getcwd() + sys.argv[0]";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).doesNotEndWith("\n");
        assertThat(result.source()).contains("\treturn os.getcwd() + sys.argv[0]");
        // Reordered alphabetically: os before sys.
        assertThat(result.source()).startsWith("import os\nimport sys\n");
        assertThat(result.removed()).isEmpty();
    }

    @Test
    @DisplayName("CRLF line endings are preserved through a reorder")
    void crlfLineEndingsSurvive() {
        String source = "import sys\r\nimport os\r\n\r\nprint(os, sys)\r\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source())
            .isEqualTo("import os\r\nimport sys\r\nprint(os, sys)\r\n");
    }

    @Test
    @DisplayName("an unused import is removed when nothing else in the file mentions its name")
    void unusedImportIsRemoved() {
        String source = "import os\n\nprint(1)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).isEqualTo("print(1)\n");
        assertThat(result.removed()).containsExactly("import os");
    }

    @Test
    @DisplayName("a used import is never removed even when only used inside a string")
    void importMentionedOnlyInsideAStringIsKept() {
        // "os" appears nowhere as code — only inside a string literal — and the
        // rule is a plain word-boundary search that does not distinguish code
        // from a string. Over-counting a use is the safe direction.
        String source = "import os\n\nmsg = \"please import os for this\"\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os");
        assertThat(result.removed()).isEmpty();
    }

    @Test
    @DisplayName("an import with a trailing # noqa comment is never removed")
    void noqaImportSurvives() {
        String source = "import os  # noqa\n\nprint(1)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os  # noqa");
        assertThat(result.removed()).isEmpty();
    }

    @Test
    @DisplayName("a from __future__ import is never removed even when unused")
    void futureImportIsNeverRemoved() {
        String source = "from __future__ import annotations\n\nprint(1)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("from __future__ import annotations");
        assertThat(result.removed()).isEmpty();
    }

    @Test
    @DisplayName("exec in the module means nothing is removed, but duplicates are still dropped and the block still sorted")
    void execDisablesRemovalButNotDedupeOrSort() {
        String source = "import sys\nimport sys\nimport os\n\nexec(code)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        // Neither os nor sys is used anywhere outside the block, but exec() means
        // neither is removed as "unused" — only the exact duplicate goes.
        assertThat(result.source()).contains("import os").contains("import sys");
        assertThat(result.removed()).containsExactly("import sys");
        assertThat(result.notes()).anyMatch(n -> n.contains("exec"));
        // Still sorted: os before sys.
        assertThat(result.source().indexOf("import os"))
            .isLessThan(result.source().indexOf("import sys"));
    }

    @Test
    @DisplayName("eval( in the module disables unused-import removal")
    void evalDisablesRemoval() {
        String source = "import os\n\nx = eval(\"1\")\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os");
        assertThat(result.notes()).anyMatch(n -> n.contains("eval("));
    }

    @Test
    @DisplayName("globals() in the module disables unused-import removal")
    void globalsCallDisablesRemoval() {
        String source = "import os\n\nx = globals()\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os");
        assertThat(result.notes()).anyMatch(n -> n.contains("globals()"));
    }

    @Test
    @DisplayName("locals() in the module disables unused-import removal")
    void localsCallDisablesRemoval() {
        String source = "import os\n\nx = locals()\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os");
        assertThat(result.notes()).anyMatch(n -> n.contains("locals()"));
    }

    @Test
    @DisplayName("a star import disables unused-import removal, but not dedupe or sort")
    void starImportDisablesRemovalButNotDedupeOrSort() {
        String source = "import os\nimport os\nfrom pkg import *\n\nprint(1)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).contains("import os");
        assertThat(result.removed()).containsExactly("import os");
        assertThat(result.notes()).anyMatch(n -> n.toLowerCase().contains("star import"));
    }

    @Test
    @DisplayName("comments travel with the import immediately below them, even after a reorder")
    void commentsTravelWithTheirImport() {
        // "os" sorts ahead of "sys" alphabetically, so a correct implementation
        // must carry "# widely used" to the NEW position of "import os", not
        // leave it behind where "import os" used to sit.
        String source = "import sys\n# widely used\nimport os\n\nprint(os, sys)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).startsWith("# widely used\nimport os\nimport sys\n");
    }

    @Test
    @DisplayName("a comment with no import left under it moves to the top of the block")
    void orphanCommentMovesToTheTop() {
        // "os" is used below, so it survives to show the comment moving around
        // it rather than surviving only because the import (and its comment)
        // were both dropped as unused.
        String source = "import os\n# trailing note\n\ndef f():\n\treturn os.getcwd()\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).startsWith("# trailing note\nimport os\n");
    }

    @Test
    @DisplayName("groups sort future first, then plain imports, then from-imports, alphabetically within each")
    void groupsSortInOrder() {
        String source = "from zeta import a\n"
            + "import sys\n"
            + "from __future__ import annotations\n"
            + "import os\n"
            + "from alpha import b\n"
            + "\n"
            + "print(a, b, os, sys)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);
        String out = result.source();

        int future = out.indexOf("from __future__ import annotations");
        int os = out.indexOf("import os");
        int sys = out.indexOf("import sys");
        int alpha = out.indexOf("from alpha import b");
        int zeta = out.indexOf("from zeta import a");

        assertThat(future).isGreaterThanOrEqualTo(0);
        assertThat(future).isLessThan(os);
        assertThat(os).isLessThan(sys);
        assertThat(sys).isLessThan(alpha);
        assertThat(alpha).isLessThan(zeta);
    }

    @Test
    @DisplayName("an import appearing after other top-level code is left untouched")
    void importBelowCodeIsUntouched() {
        String source = "x = 1\nimport os\n\nprint(os)\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).isEqualTo(source);
        assertThat(result.removed()).isEmpty();
    }

    @Test
    @DisplayName("an import nested inside a function is left untouched")
    void importInsideAFunctionIsUntouched() {
        String source = "def run():\n\timport os\n\treturn os.getcwd()\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.source()).isEqualTo(source);
    }

    @Test
    @DisplayName("a project-defined unknown name is suggested as a from-import from its module")
    void suggestsProjectDefinedName() {
        String source = "def run():\n\treturn compute(1)\n";
        ImportOrganiser.Lookup lookup =
            name -> "compute".equals(name) ? Optional.of("util.helpers") : Optional.empty();

        ImportOrganiser.Result result = ImportOrganiser.organise(source, lookup);

        assertThat(result.suggestions())
            .contains(new ImportOrganiser.Suggestion(
                "compute", "from util.helpers import compute", "project"));
    }

    @Test
    @DisplayName("a project hit is preferred over the built-in table for the same name")
    void projectLookupTakesPrecedenceOverBuiltins() {
        String source = "def run():\n\treturn json.dumps({})\n";
        ImportOrganiser.Lookup lookup =
            name -> "json".equals(name) ? Optional.of("mypackage.json") : Optional.empty();

        ImportOrganiser.Result result = ImportOrganiser.organise(source, lookup);

        assertThat(result.suggestions())
            .contains(new ImportOrganiser.Suggestion(
                "json", "from mypackage.json import json", "project"));
        assertThat(result.suggestions()).noneMatch(s -> "library".equals(s.origin()));
    }

    @Test
    @DisplayName("an unknown name with no project hit falls back to the built-in table")
    void suggestsBuiltinName() {
        String source = "def run():\n\treturn json.dumps({})\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.suggestions())
            .contains(new ImportOrganiser.Suggestion("json", "import json", "library"));
    }

    @Test
    @DisplayName("a builtin suggestion can point at a different module than the name itself")
    void suggestsBuiltinNameFromADifferentModule() {
        String source = "def run():\n\treturn datetime.now()\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.suggestions())
            .contains(new ImportOrganiser.Suggestion(
                "datetime", "from datetime import datetime", "library"));
    }

    @Test
    @DisplayName("no suggestion is offered for a name the file already imports")
    void doesNotSuggestAnAlreadyImportedName() {
        String source = "import os\n\ndef run():\n\treturn os.getcwd()\n";
        ImportOrganiser.Result result = ImportOrganiser.organise(source, NO_PROJECT_HITS);

        assertThat(result.suggestions()).isEmpty();
    }
}
