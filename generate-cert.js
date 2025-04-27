const selfsigned = require('selfsigned');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'secrets');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir);
}

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 365 });

fs.writeFileSync(path.join(dir, 'private-key.pem'), pems.private);
fs.writeFileSync(path.join(dir, 'public-certificate.pem'), pems.cert);

console.log('Certificate generated!');