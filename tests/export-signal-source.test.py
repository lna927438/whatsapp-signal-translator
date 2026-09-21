"""Exercise the real source exporter in a synthetic checkout, never release/."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile


REPO = pathlib.Path(__file__).resolve().parents[1]
SEND_STATUS = 'ts/hellodog/hellodog.send-status.std.ts'


class SourceExport(unittest.TestCase):
    def test_untracked_send_status_and_maintained_patch_are_in_actual_archive(self):
        temp_base = pathlib.Path(os.environ.get('TEMP', tempfile.gettempdir()))
        with tempfile.TemporaryDirectory(prefix='hellodog-source-export-', dir=temp_base) as folder:
            root = pathlib.Path(folder)
            core = root / 'integrations/signal-desktop'
            core.mkdir(parents=True)
            (root / 'scripts').mkdir()
            shutil.copyfile(REPO / 'scripts/export-signal-source.py', root / 'scripts/export-signal-source.py')
            (root / 'package.json').write_text('{"version":"0.0.0-source-test"}', encoding='utf8')
            subprocess.run(['git', 'init', '--quiet', str(core)], check=True, capture_output=True)
            (core / 'LICENSE').write_text('Synthetic AGPL source fixture\n', encoding='utf8')
            subprocess.run(['git', 'add', 'LICENSE'], cwd=core, check=True, capture_output=True)
            maintained = root / 'integrations/hellodog-source/hellodog.send-status.std.ts'
            maintained.parent.mkdir(parents=True)
            actual = REPO / 'integrations/hellodog-source/hellodog.send-status.std.ts'
            shutil.copyfile(actual, maintained)
            native = core / SEND_STATUS
            native.parent.mkdir(parents=True)
            shutil.copyfile(actual, native)
            shutil.copyfile(REPO / 'scripts/patch-signal-send-status.mjs', root / 'scripts/patch-signal-send-status.mjs')
            for private in ['.env.local', 'node_modules/private.js', 'config/local.json']:
                path = core / private
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('synthetic-private-marker', encoding='utf8')
            result = subprocess.run([sys.executable, str(root / 'scripts/export-signal-source.py')], cwd=root,
                                    check=True, capture_output=True, text=True)
            manifest = json.loads(result.stdout)
            archive_path = root / 'release' / manifest['file']
            with zipfile.ZipFile(archive_path) as archive:
                names = archive.namelist()
                self.assertEqual(archive.read('hellodog/integrations/signal-desktop/' + SEND_STATUS), actual.read_bytes())
                self.assertEqual(archive.read('hellodog/integrations/hellodog-source/hellodog.send-status.std.ts'), actual.read_bytes())
                self.assertEqual(archive.read('hellodog/scripts/patch-signal-send-status.mjs'),
                                 (REPO / 'scripts/patch-signal-send-status.mjs').read_bytes())
                self.assertEqual(len(names), manifest['files'])
                self.assertEqual(len(names), len(set(names)))
                self.assertFalse(any('.env' in name or 'node_modules/' in name or name.endswith('config/local.json') for name in names))
            self.assertEqual(hashlib.sha256(archive_path.read_bytes()).hexdigest(), manifest['sha256'])
            self.assertEqual(archive_path.stat().st_size, manifest['size'])


if __name__ == '__main__':
    unittest.main()
