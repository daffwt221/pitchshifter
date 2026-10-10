"""Verify that the release ZIP contains the intended version and source files."""
import json
import os
from pathlib import Path
import shutil
import zipfile

release_dir = Path(os.environ['RELEASE_DIR'])
metadata = json.loads((release_dir / 'metadata.json').read_text())
archive = Path('web-ext-artifacts') / metadata['asset']
required = {'manifest.json', 'injected.js', 'content.js', 'soundtouch-worklet.js',
            'phase-vocoder-worklet.js', 'soundtouch-worklet.LICENSE.txt', 'LICENSE',
            'popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'icons/icon.svg'}
with zipfile.ZipFile(archive) as package:
    assert required <= set(package.namelist()), 'Missing required extension files'
    assert json.loads(package.read('manifest.json'))['version'] == metadata['version']
    for entry in package.infolist():
        if entry.is_dir():
            continue
        parts = Path(entry.filename).parts
        assert not any(part.startswith('.') or part in {'node_modules', 'diagnostics', 'web-ext-artifacts', 'screenshots'} for part in parts), entry.filename
        assert entry.filename not in {'web-ext-config.cjs', 'store-listing.md', 'relatorio.md'}, entry.filename
        assert package.read(entry) == Path(entry.filename).read_bytes(), entry.filename
shutil.copyfile(archive, release_dir / metadata['asset'])
print(f'Verified {metadata["asset"]}: packaged files match the checkout')
