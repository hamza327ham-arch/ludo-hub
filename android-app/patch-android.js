// Adds the AdMob App ID and the permissions Ludo Hub needs to the generated Android manifest.
// Run from android-app/ after "npx cap add android". The App ID comes from the ADMOB_APP_ID environment
// variable (GitHub: Settings > Secrets and variables > Actions > Variables). Without it the Ludo Hub App ID below is used.
const fs = require('fs');
const p = 'android/app/src/main/AndroidManifest.xml';
let x = fs.readFileSync(p, 'utf8');
const id = process.env.ADMOB_APP_ID || 'ca-app-pub-3697668089255708~9068063502';
if (!/^ca-app-pub-\d{16}~\d{10}$/.test(id)) { console.error('ADMOB_APP_ID looks wrong: ' + id); process.exit(1); }
if (!x.includes('com.google.android.gms.ads.APPLICATION_ID')) {
  x = x.replace('</application>', `    <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${id}"/>\n    </application>`);
}
for (const perm of ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS']) {
  if (!x.includes(perm)) x = x.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
fs.writeFileSync(p, x);
console.log('Manifest patched. AdMob App ID: ' + id);
