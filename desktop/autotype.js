'use strict';
/*
 * Auto-Type: digita utente e password nell'app in primo piano, con gli strumenti del sistema.
 *  - Windows: SendKeys via PowerShell (testo passato in una variabile d'ambiente, non sulla riga di comando)
 *  - macOS:   System Events via osascript (script passato su stdin; serve il permesso Accessibilità)
 *  - Linux:   xdotool (X11) oppure wtype (Wayland), testo passato su stdin
 */
const { spawn } = require('child_process');

function run(cmd, args, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { env: { ...process.env, ...(env || {}) }, windowsHide: true }); } catch (e) { reject(e); return; }
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} terminato con codice ${code}`))));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

const sendKeysEscape = s => s.replace(/[+^%~(){}[\]]/g, c => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
const appleString = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

async function activeWindowTitle() {
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }
"@
$b = New-Object System.Text.StringBuilder 512; [void][W]::GetWindowText([W]::GetForegroundWindow(), $b, 512); $b.ToString()`;
      return await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    }
    if (process.platform === 'darwin') {
      return await run('osascript', ['-'], { input: 'tell application "System Events" to get name of first application process whose frontmost is true' });
    }
    if (process.env.XDG_SESSION_TYPE !== 'wayland') return await run('xdotool', ['getactivewindow', 'getwindowname']);
  } catch { /* titolo non disponibile */ }
  return '';
}

async function typeLogin({ username, password, enter }) {
  if (process.platform === 'win32') {
    let keys = '';
    if (username) keys += sendKeysEscape(username) + '{TAB}';
    keys += sendKeysEscape(password || '');
    if (enter) keys += '{ENTER}';
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:SCRIGNO_KEYS)'], { env: { SCRIGNO_KEYS: keys } });
    return;
  }
  if (process.platform === 'darwin') {
    const lines = ['tell application "System Events"'];
    if (username) lines.push(`keystroke ${appleString(username)}`, 'key code 48');
    lines.push(`keystroke ${appleString(password || '')}`);
    if (enter) lines.push('key code 36');
    lines.push('end tell');
    try { await run('osascript', ['-'], { input: lines.join('\n') }); } catch (e) {
      throw new Error('macOS non consente ancora a Scrigno di digitare: apri Impostazioni di Sistema › Privacy e sicurezza › Accessibilità e attiva Scrigno. (' + e.message + ')');
    }
    return;
  }
  // Linux
  const wayland = process.env.XDG_SESSION_TYPE === 'wayland';
  const typeText = async text => {
    if (!text) return;
    if (wayland) await run('wtype', ['-'], { input: text });
    else await run('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--file', '-'], { input: text });
  };
  const key = async k => { if (wayland) await run('wtype', ['-k', k]); else await run('xdotool', ['key', '--clearmodifiers', k]); };
  try {
    if (username) { await typeText(username); await key(wayland ? 'Tab' : 'Tab'); }
    await typeText(password);
    if (enter) await key('Return');
  } catch (e) {
    throw new Error(wayland ? 'Per l\'Auto-Type su Wayland installa “wtype”.' : 'Per l\'Auto-Type installa “xdotool” (sudo apt install xdotool).');
  }
}

module.exports = { activeWindowTitle, typeLogin, sendKeysEscape, appleString };
