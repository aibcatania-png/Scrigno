#!/usr/bin/env python3
"""Scrive web/js/config.js a partire da scrigno.config.json (o da variabili d'ambiente in CI)."""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load():
    cfg = json.load(open(os.path.join(ROOT, 'scrigno.config.json')))
    if os.environ.get('SCRIGNO_PAGES_URL'):
        cfg['pagesUrl'] = os.environ['SCRIGNO_PAGES_URL']
    if not cfg.get('pagesUrl') and os.environ.get('GITHUB_REPOSITORY'):
        owner, repo = os.environ['GITHUB_REPOSITORY'].split('/')
        cfg['pagesUrl'] = f'https://{owner.lower()}.github.io/{repo}/'
    if not cfg.get('repo') and os.environ.get('GITHUB_REPOSITORY'):
        cfg['repo'] = os.environ['GITHUB_REPOSITORY']
    if cfg.get('pagesUrl') and not cfg['pagesUrl'].endswith('/'):
        cfg['pagesUrl'] += '/'
    return cfg


if __name__ == '__main__':
    cfg = load()
    with open(os.path.join(ROOT, 'web', 'js', 'config.js'), 'w') as f:
        f.write('// Generato da tools/configure.py: indirizzo della web app pubblicata, usato per i login OAuth delle app.\n')
        f.write(f"self.SCRIGNO_CONFIG = {json.dumps({'pagesUrl': cfg.get('pagesUrl', ''), 'version': cfg['version'], 'repo': cfg.get('repo', '')})};\n")
    print('pagesUrl =', cfg.get('pagesUrl') or '(non impostato)')
