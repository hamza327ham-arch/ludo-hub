// Copies the game page into www/ so Capacitor can pack it into the app.
const fs = require('fs'), path = require('path');
fs.mkdirSync(path.join(__dirname, 'www'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'index.html'), path.join(__dirname, 'www', 'index.html'));
console.log('index.html copied to www/');
