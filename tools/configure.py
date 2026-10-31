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
    # Accesso ai cloud già pronto: le app di Scrigno registrate presso Google, Dropbox e Microsoft.
    # Gli ID pubblici possono stare in scrigno.config.json; il client secret di Google arriva dai segreti di GitHub.
    cloud = {k: dict(v) for k, v in (cfg.get('cloud') or {}).items()}
    env = lambda n: (os.environ.get(n) or '').strip()
    if env('SCRIGNO_GDRIVE_CLIENT_ID'): cloud.setdefault('gdrive', {})['clientId'] = env('SCRIGNO_GDRIVE_CLIENT_ID')
    if env('SCRIGNO_GDRIVE_CLIENT_SECRET'): cloud.setdefault('gdrive', {})['clientSecret'] = env('SCRIGNO_GDRIVE_CLIENT_SECRET')
    if env('SCRIGNO_DROPBOX_APP_KEY'): cloud.setdefault('dropbox', {})['appKey'] = env('SCRIGNO_DROPBOX_APP_KEY')
    if env('SCRIGNO_ONEDRIVE_CLIENT_ID'): cloud.setdefault('onedrive', {})['clientId'] = env('SCRIGNO_ONEDRIVE_CLIENT_ID')
    # Google senza secret scadrebbe ogni ora: in quel caso non lo si propone come già pronto.
    if 'gdrive' in cloud and not cloud['gdrive'].get('clientSecret'):
        del cloud['gdrive']
    cfg['cloud'] = {k: v for k, v in cloud.items() if any(v.values())}
    return cfg


def public(cfg):
    return {'pagesUrl': cfg.get('pagesUrl', ''), 'version': cfg['version'], 'repo': cfg.get('repo', ''), 'cloud': cfg.get('cloud', {})}


if __name__ == '__main__':
    cfg = load()
    with open(os.path.join(ROOT, 'web', 'js', 'config.js'), 'w') as f:
        f.write('// Generato da tools/configure.py: indirizzo della web app pubblicata, usato per i login OAuth delle app.\n')
        f.write(f"self.SCRIGNO_CONFIG = {json.dumps(public(cfg))};\n")
    print('pagesUrl =', cfg.get('pagesUrl') or '(non impostato)')
    print('cloud già pronti =', ', '.join(cfg['cloud']) or '(nessuno)')
