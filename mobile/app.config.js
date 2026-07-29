// Dynamic wrapper over app.json so two files stay OPTIONAL at build time:
// - google-services.json (Firebase/push): absent = the app builds and works,
//   just without push notifications; add the file and rebuild to get them.
// - pairing.json (written by scripts/bake-pairing.cjs in the repo root): when
//   present, the pairing is baked in and the app auto-connects on first
//   launch — no QR scan needed for an APK built on your own PC.
const fs = require('fs')
const path = require('path')
const base = require('./app.json')

module.exports = () => {
  const expo = { ...base.expo, android: { ...base.expo.android } }
  if (!fs.existsSync(path.join(__dirname, 'google-services.json'))) {
    delete expo.android.googleServicesFile
  }
  const pairingPath = path.join(__dirname, 'pairing.json')
  if (fs.existsSync(pairingPath)) {
    expo.extra = {
      ...expo.extra,
      defaultPairing: JSON.parse(fs.readFileSync(pairingPath, 'utf8'))
    }
  }
  return { expo }
}
