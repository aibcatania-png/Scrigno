#!/usr/bin/env python3
"""Crea le versioni dell'estensione in dist/extension/.

  chromium  Chrome, Edge, Brave, Opera, Vivaldi, Arc... da installare a mano (ID fisso grazie a "key")
  store     stessa estensione senza "key", da caricare su Chrome Web Store, Edge Add-ons, Opera Add-ons
  firefox   Firefox per computer e per Android (da firmare su addons.mozilla.org)
"""
import json, os, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from configure import load  # noqa: E402

SRC = os.path.join(ROOT, 'extension', 'src')
SHARED = ['core.js', 'words.js', 'cloud.js', 'vaults.js', 'passkey.js']
BG = ['config.js'] + SHARED + ['bg.js']
BROWSERS = ('chromium', 'store', 'firefox')


def manifest(browser, cfg):
    m = {
        'manifest_version': 3,
        'name': 'Scrigno',
        'version': cfg['version'],
        'description': 'Password manager: compila login, salva password e gestisce le passkey. Vault cifrato e sincronizzato sul tuo cloud.',
        'permissions': ['storage', 'tabs', 'alarms', 'identity', 'clipboardWrite'],
        'host_permissions': ['<all_urls>'],
        'action': {'default_popup': 'popup.html', 'default_title': 'Scrigno',
                   'default_icon': {str(n): f'icons/icon-{n}.png' for n in (16, 32, 48)}},
        'options_ui': {'page': 'options.html', 'open_in_tab': True},
        'icons': {str(n): f'icons/icon-{n}.png' for n in (16, 32, 48, 128)},
        'content_scripts': [
            {'matches': ['<all_urls>'], 'js': ['content.js'], 'run_at': 'document_start', 'all_frames': True},
            {'matches': ['https://*/*', 'http://localhost/*'], 'js': ['page.js'], 'run_at': 'document_start', 'all_frames': True, 'world': 'MAIN'},
        ],
        'commands': {'fill-login': {'suggested_key': {'default': 'Ctrl+Shift+L', 'mac': 'Command+Shift+L'}, 'description': 'Mostra i login per questo sito'}},
    }
    if browser != 'firefox':
        m['background'] = {'service_worker': 'sw.js'}
        if browser == 'chromium' and cfg.get('chromeKey'):
            m['key'] = cfg['chromeKey']  # ID fisso, così l'indirizzo di ritorno OAuth non cambia
    else:
        m['background'] = {'scripts': BG}
        m['browser_specific_settings'] = {'gecko': {'id': cfg['firefoxId'], 'strict_min_version': '128.0'},
                                          'gecko_android': {'strict_min_version': '128.0'}}
    return m


def build():
    cfg = load()
    out_root = os.path.join(ROOT, 'dist', 'extension')
    shutil.rmtree(out_root, ignore_errors=True)
    for browser in BROWSERS:
        out = os.path.join(out_root, browser)
        shutil.copytree(SRC, out)
        for f in SHARED:
            shutil.copy(os.path.join(ROOT, 'web', 'js', f), os.path.join(out, f))
        with open(os.path.join(out, 'config.js'), 'w') as fh:
            fh.write('self.SCRIGNO_CONFIG = ' + json.dumps({'pagesUrl': cfg.get('pagesUrl', ''), 'version': cfg['version']}) + ';\n')
        if browser != 'firefox':
            with open(os.path.join(out, 'sw.js'), 'w') as fh:
                fh.write('importScripts(' + ', '.join(repr(f) for f in BG) + ');\n')
        with open(os.path.join(out, 'manifest.json'), 'w') as fh:
            json.dump(manifest(browser, cfg), fh, indent=2, ensure_ascii=False)
        z = os.path.join(out_root, f'scrigno-{browser}-{cfg["version"]}.zip')
        with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
            for dp, _, files in os.walk(out):
                for f in files:
                    p = os.path.join(dp, f)
                    zf.write(p, os.path.relpath(p, out))
        print('creato', os.path.relpath(z, ROOT))


if __name__ == '__main__':
    build()
