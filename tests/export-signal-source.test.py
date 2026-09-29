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
    def test_separate_locked_index_exports_patched_sources_and_untracked_voice_files(self):
        temp_base = pathlib.Path(os.environ.get('TEMP', tempfile.gettempdir()))
        with tempfile.TemporaryDirectory(prefix='hellodog-source-export-', dir=temp_base) as folder:
            root = pathlib.Path(folder)
            core = root / 'integrations/signal-desktop'
            core.mkdir(parents=True)
            index = root / 'upstream-index'
            (root / 'scripts').mkdir()
            shutil.copyfile(REPO / 'scripts/export-signal-source.py', root / 'scripts/export-signal-source.py')
            (root / 'package.json').write_text('{"version":"0.0.0-source-test"}', encoding='utf8')
            subprocess.run(['git', 'init', '--quiet', str(index)], check=True, capture_output=True)
            (index / 'LICENSE').write_text('Synthetic upstream source fixture\n', encoding='utf8')
            subprocess.run(['git', 'add', 'LICENSE'], cwd=index, check=True, capture_output=True)
            subprocess.run(['git', '-c', 'user.name=Source Export Test', '-c', 'user.email=source@example.invalid',
                            '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture'],
                           cwd=index, check=True, capture_output=True)
            revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=index).decode().strip()
            lock = root / 'integrations/signal-desktop.lock.json'
            lock.write_text(json.dumps({'commit': revision}), encoding='utf8')
            (core / 'LICENSE').write_text('Synthetic patched source fixture\n', encoding='utf8')
            maintained = root / 'integrations/hellodog-source/hellodog.send-status.std.ts'
            maintained.parent.mkdir(parents=True)
            actual = REPO / 'integrations/hellodog-source/hellodog.send-status.std.ts'
            shutil.copyfile(actual, maintained)
            native = core / SEND_STATUS
            native.parent.mkdir(parents=True)
            shutil.copyfile(actual, native)
            voices = ['hellodog.voice.preload.ts', 'hellodog.voice.dom.ts', 'hellodog.voice-audio.std.ts']
            for name in voices:
                (native.parent / name).write_text('synthetic patched ' + name, encoding='utf8')
            shutil.copyfile(REPO / 'scripts/patch-signal-send-status.mjs', root / 'scripts/patch-signal-send-status.mjs')
            for private in ['.env.local', 'node_modules/private.js', 'config/local.json']:
                path = core / private
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('synthetic-private-marker', encoding='utf8')
            command = [sys.executable, str(root / 'scripts/export-signal-source.py'),
                       '--signal-index', str(index), '--signal-source', str(core)]
            result = subprocess.run(command, cwd=root,
                                    check=True, capture_output=True, text=True)
            manifest = json.loads(result.stdout)
            archive_path = root / 'release' / manifest['file']
            with zipfile.ZipFile(archive_path) as archive:
                names = archive.namelist()
                self.assertEqual(archive.read('hellodog/integrations/signal-desktop/LICENSE'), (core / 'LICENSE').read_bytes())
                for name in voices:
                    self.assertEqual(archive.read('hellodog/integrations/signal-desktop/ts/hellodog/' + name),
                                     (native.parent / name).read_bytes())
                self.assertEqual(archive.read('hellodog/integrations/signal-desktop/' + SEND_STATUS), actual.read_bytes())
                self.assertEqual(archive.read('hellodog/integrations/hellodog-source/hellodog.send-status.std.ts'), actual.read_bytes())
                self.assertEqual(archive.read('hellodog/scripts/patch-signal-send-status.mjs'),
                                 (REPO / 'scripts/patch-signal-send-status.mjs').read_bytes())
                self.assertEqual(len(names), manifest['files'])
                self.assertEqual(len(names), len(set(names)))
                self.assertFalse(any('.env' in name or 'node_modules/' in name or name.endswith('config/local.json') for name in names))
            self.assertEqual(hashlib.sha256(archive_path.read_bytes()).hexdigest(), manifest['sha256'])
            self.assertEqual(archive_path.stat().st_size, manifest['size'])
            lock.write_text(json.dumps({'commit': '0' * 40}), encoding='utf8')
            rejected = subprocess.run(command, cwd=root, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('does not match', rejected.stderr)
            lock.write_text(json.dumps({'commit': revision}), encoding='utf8')
            (index / 'private.txt').write_text('synthetic-private-marker', encoding='utf8')
            subprocess.run(['git', 'add', 'private.txt'], cwd=index, check=True, capture_output=True)
            rejected = subprocess.run(command, cwd=root, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(hashlib.sha256(archive_path.read_bytes()).hexdigest(), manifest['sha256'])


if __name__ == '__main__':
    unittest.main()
