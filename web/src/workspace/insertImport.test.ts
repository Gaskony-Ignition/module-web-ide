import { describe, expect, it } from 'vitest';
import { insertImportAtTopOfBlock } from './insertImport';

describe('insertImportAtTopOfBlock', () => {
  it('inserts ahead of an existing leading import block', () => {
    const text = 'import os\nimport sys\n\nprint(os, sys)\n';
    expect(insertImportAtTopOfBlock(text, 'import json')).toBe(
      'import json\nimport os\nimport sys\n\nprint(os, sys)\n'
    );
  });

  it('inserts after a header comment, ahead of the first import', () => {
    const text = '# stdlib\nimport os\n\nprint(os)\n';
    expect(insertImportAtTopOfBlock(text, 'import json')).toBe(
      '# stdlib\nimport json\nimport os\n\nprint(os)\n'
    );
  });

  it('inserts at the very top when the file opens with code, not an import', () => {
    const text = 'x = 1\nprint(x)\n';
    expect(insertImportAtTopOfBlock(text, 'import json')).toBe(
      'import json\nx = 1\nprint(x)\n'
    );
  });

  it('inserts at the top of an empty buffer', () => {
    expect(insertImportAtTopOfBlock('', 'import json')).toBe('import json\n');
  });

  it('does not touch anything below the insertion point', () => {
    const text = 'import os\n\ndef f():\n\treturn os.getcwd()\n';
    const result = insertImportAtTopOfBlock(text, 'from datetime import datetime');
    expect(result).toContain('\treturn os.getcwd()');
    expect(result.startsWith('from datetime import datetime\nimport os\n')).toBe(true);
  });
});
