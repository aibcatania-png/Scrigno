# Scrigno

Password manager multipiattaforma in stile Enpass: un unico vault cifrato, sincronizzato sul **tuo** cloud, con compilazione automatica e passkey su telefono, computer e browser.

| Piattaforma | Cosa ottieni | Compilazione automatica | Passkey |
|---|---|---|---|
| Android 8+ | APK | Servizio di compilazione automatica di Android (app e browser) | Android 14+ (Credential Manager) |
| iPhone / iPad | Web app installabile da Safari (“Aggiungi a Home”) | — (vedi sotto) | — |
| Windows | Installer `.exe` | Estensione browser + Auto-Type nelle app (`Ctrl Alt A`) | Nei siti, con l'estensione |
| macOS | `.dmg` (Apple Silicon e Intel) | Estensione browser + Auto-Type (`⌘ ⌥ A`) | Nei siti, con l'estensione |
| Linux | `.AppImage` e `.deb` | Estensione browser + Auto-Type (`Ctrl Alt A`) | Nei siti, con l'estensione |
| Chrome, Edge, Firefox | Estensione | Menu nei campi di accesso, salvataggio dei nuovi login | Sì, creazione e accesso |
| Qualsiasi browser | Web app installabile | — | — |

Cloud supportati: **Dropbox, OneDrive, Google Drive, WebDAV/Nextcloud, iCloud Drive** (iCloud su iPhone, iPad e Mac; su Windows e Linux puoi usare anche la cartella sincronizzata di OneDrive o Dropbox).

## Funzioni

- **Più vault** (es. Personale e Lavoro): ognuno con la sua password e il suo file sul cloud; sbloccando il principale si aprono tutti.
- **Allegati cifrati** (fino a 5 MB l'uno): foto di documenti, PDF, ricevute.
- **Modelli**: login, carte, identità, note, Wi-Fi, conti bancari, documenti, licenze, server, account email, più i **modelli personalizzati** con i campi che vuoi.
- **Controllo sicurezza**: password deboli, riutilizzate, vecchie e **trovate in violazioni di dati** (Have I Been Pwned, in forma anonima).
- **Monitoraggio 2FA e passkey**: indica i tuoi siti che offrono la verifica in due passaggi o le passkey e che non stai ancora usando (elenchi di 2fa.directory).
- **Keyfile**: un file da tenere su chiavetta o telefono, richiesto oltre alla master password.
- **Cestino** (30 giorni) e **cronologia delle password**.
- Codici 2FA integrati, generatore di password, importazione da Enpass/CSV, sblocco biometrico.

## Come è fatto

```
web/        interfaccia condivisa (web app, app Android, iOS e desktop) + nucleo crittografico JS
extension/  estensione per Chrome, Edge e Firefox (compilazione, salvataggio login, passkey)
desktop/    app per Windows, macOS e Linux (Electron) con Auto-Type e cartelle sincronizzate
android/    app Android (Kotlin): WebView + servizio di compilazione automatica + fornitore di passkey
ios/        app iOS (Swift): WebView + estensione AutoFill per password e passkey
tests/      test automatici (crittografia, sincronizzazione, interfaccia, estensione, compatibilità tra linguaggi)
tools/      script di build (configurazione, estensione, icone)
```

Lo stesso formato di vault è implementato in JavaScript, Kotlin e Swift, e i test verificano che ogni linguaggio legga ciò che scrivono gli altri.

## Build

Le build girano su **GitHub Actions** a ogni push su `main` (workflow `.github/workflows/build.yml`):

- `test`: test della crittografia, dell'interfaccia e dell'estensione in Chromium
- `android`: test Kotlin + APK
- `desktop`: installer per Windows, macOS e Linux
- `extension`: zip per Chrome/Edge e Firefox
- `ios`: disattivato di default (si avvia solo a mano); vedi “iPhone e iPad”
- `pages`: pubblica la web app e la pagina di ritorno per gli accessi ai cloud
- `release`: ogni build riuscita su `main` aggiorna la release della versione indicata in `scrigno.config.json`

I file si scaricano dalla pagina della singola esecuzione (Actions › esecuzione › Artifacts) o dalla release.

### Segreti di GitHub (Settings › Secrets and variables › Actions)

| Segreto | A cosa serve |
|---|---|
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` | Firma stabile dell'APK (senza, ogni build è firmata con una chiave diversa e non si aggiorna sopra la precedente) |
| `APPLE_TEAM_ID` | Team ID dell'account Apple Developer |
| `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` | Chiave API di App Store Connect (ruolo *App Manager*), contenuto del file `.p8` |

Per iOS crea prima l'app in App Store Connect (I miei app › +) con il bundle ID indicato in `scrigno.config.json` (`appId`). Alla prima build TestFlight chiede una volta la conformità sull'esportazione della crittografia.

### GitHub Pages

Settings › Pages › Source: **GitHub Actions**. Su un account gratuito Pages funziona solo con repository pubblici. L'indirizzo (es. `https://utente.github.io/scrigno/`) ospita la web app e le pagine `oauth.html` / `oauth-app.html` usate per i login ai cloud.

## iPhone e iPad

Senza un account Apple Developer (a pagamento) un'app non si può installare stabilmente su iPhone, e la compilazione automatica di iOS è riservata alle app installate. Su iPhone e iPad si usa quindi la **web app**: apri l'indirizzo GitHub Pages in Safari › Condividi › *Aggiungi alla schermata Home*. Ha lo stesso vault sincronizzato, la ricerca, la copia di utente e password e i codici 2FA, ma non compila da sola i campi e non gestisce le passkey.

Il codice dell'app iOS (cartella `ios/`) resta nel progetto: se in futuro attivi l'account Apple Developer, basta aggiungere i segreti indicati sopra e avviare il workflow a mano.

## Configurare i cloud

Ogni servizio richiede una tua “app” gratuita presso il fornitore, con questi indirizzi di ritorno (sostituisci con il tuo indirizzo Pages):

| Dove | Indirizzo di ritorno |
|---|---|
| Web app | `https://utente.github.io/scrigno/oauth.html` |
| App Android, iOS e desktop | `https://utente.github.io/scrigno/oauth-app.html` |
| Estensione Chrome/Edge | `https://fcamedobbplknjdnnldngkghapdcakik.chromiumapp.org/oauth` |
| Estensione Firefox | mostrato nelle impostazioni dell'estensione |

- **Dropbox** — dropbox.com/developers › Create app › *Scoped access* › *App folder*. In Permissions abilita `files.content.read` e `files.content.write`. Aggiungi gli indirizzi di ritorno e copia la *App key*.
- **OneDrive** — portale Microsoft Entra › Registrazioni app › Nuova (account personali e aziendali). Autenticazione: piattaforma *Applicazione a pagina singola* con `oauth.html` e l'indirizzo dell'estensione; piattaforma *App per dispositivi mobili e desktop* con `oauth-app.html`. Autorizzazioni: `Files.ReadWrite.AppFolder`, `offline_access`. Copia l'*ID applicazione (client)*.
- **Google Drive** — Google Cloud Console › API Google Drive attiva › schermata di consenso con scope `drive.appdata` › Client ID *Applicazione web* con gli indirizzi di ritorno. L'accesso Google va rinnovato ogni ora: per le app conviene Dropbox o OneDrive.
- **WebDAV / Nextcloud** — indirizzo completo del file (es. `https://cloud.tuo.it/remote.php/dav/files/UTENTE/scrigno-vault.json`) e una password per app. Nelle app native funziona senza configurazioni; nella web app il server deve consentire CORS.
- **iCloud Drive** — su iPhone/iPad e Mac scegli “iCloud Drive o cartella sincronizzata” e indica una cartella in iCloud Drive.

Il vault viene caricato già cifrato: il cloud non vede mai password o nomi.

## Attivare la compilazione automatica

- **Android** — Scrigno › Impostazioni › *Imposta compilazione automatica*. Per le passkey (Android 14+): Impostazioni di sistema › Password, passkey e account › attiva Scrigno. In Chrome per Android attiva anche, se presente, *Compilazione automatica con un altro servizio*.
- **iPhone/iPad** — Impostazioni › Generali › Compilazione automatica e password › attiva Scrigno.
- **Computer** — installa l'estensione (Chrome/Edge: `chrome://extensions` › Modalità sviluppatore › Carica estensione non pacchettizzata, oppure pubblicala sul Chrome Web Store; Firefox: va firmata gratis su addons.mozilla.org). Nelle app desktop usa la scorciatoia Auto-Type. Su macOS concedi a Scrigno il permesso *Accessibilità*; su Linux installa `xdotool` (X11) o `wtype` (Wayland).

## Sicurezza

- AES-256-GCM con chiave casuale, protetta dalla master password (PBKDF2-SHA256, 600.000 iterazioni).
- Biometria: Android Keystore, portachiavi iOS (Face ID/Touch ID), Touch ID su Mac.
- La chiave del vault sbloccato resta in memoria (o nel portachiavi del dispositivo su iOS) solo fino al blocco automatico.
- Passkey ES256 sincronizzabili, con attestazione “none”, verifica dell'origine nei browser e verifica dell'utente (impronta, volto o PIN).
- La master password non è recuperabile.

## Limiti noti

- Installer desktop non firmati: Windows SmartScreen e macOS Gatekeeper mostrano un avviso al primo avvio (su Mac: clic destro › Apri). La firma richiede certificati a pagamento (Apple Developer ID, certificato Authenticode).
- Passkey nelle app desktop native (non browser): non supportate.
- Safari su Mac: non c'è l'estensione; su iPhone/iPad Safari è coperto dall'estensione AutoFill.
- Le app native possono usare passkey solo se il sito le ha associate all'app (Digital Asset Links / Associated Domains), come per qualsiasi gestore.

## Test in locale

```
npm install && npx playwright install chromium
npm test
```
