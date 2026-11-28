#!/bin/sh
# Create the self-signed macOS signing identity that keeps Waffle's identity stable across
# releases (docs/ci.md, "Stable macOS signing identity"). Run once on the build Mac.
#
#   scripts/create-signing-identity.sh [BACKUP.p12]
#
# - Generates an RSA key and a 20-year code-signing certificate named "Waffle EDA"
#   (WAFFLE_SIGN_IDENTITY to choose another name; it is public: codesign shows it as Authority).
# - Stores both in their own keychain, ~/Library/Keychains/waffle-release-signing.keychain-db,
#   locked with a random password in ~/Library/Application Support/waffle-release-signing
#   (folder mode 0700, file keychain-password, mode 0600).
# - Writes a password-protected backup .p12; its password is backup-password in the same folder.
#   Copy the backup and its password somewhere safe, such as a password manager. Losing the key
#   changes the app's identity one more time.
# - Prints the certificate's SHA-1, the value to pin in WAFFLE_SIGN_LEAF.
# Nothing is written into the checkout; refuses to replace an existing identity.
set -eu
name=${WAFFLE_SIGN_IDENTITY:-Waffle EDA}
keychain="$HOME/Library/Keychains/waffle-release-signing.keychain-db"
secrets="$HOME/Library/Application Support/waffle-release-signing"
backup=${1:-"$HOME/Documents/waffle-release-signing.p12"}
[ ! -e "$keychain" ] || { echo "A signing keychain already exists: $keychain" >&2; exit 1; }
[ ! -e "$backup" ] || { echo "The backup file already exists: $backup" >&2; exit 1; }
[ ! -e "$secrets" ] || { echo "The signing secrets folder already exists: $secrets" >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/waffle-sign.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
umask 077
cat > "$work/cert.cnf" <<CNF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$name
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
subjectKeyIdentifier=hash
CNF
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 7300 -keyout "$work/key.pem" -out "$work/cert.pem" -config "$work/cert.cnf" 2>/dev/null
keychain_password=$(openssl rand -hex 32); export keychain_password
backup_password=$(openssl rand -base64 18); export backup_password
# Store the passwords first, so a later failure never leaves a key nobody can unlock.
mkdir -m 700 "$secrets"
printf '%s\n' "$keychain_password" > "$secrets/keychain-password"
printf '%s\n' "$backup_password" > "$secrets/backup-password"
# macOS reads PKCS#12 only with the older SHA-1/3DES protection.
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$name" -out "$work/id.p12" \
  -passout env:keychain_password -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$name" -out "$backup" \
  -passout env:backup_password -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings "$keychain"   # no automatic lock timeout; it locks at logout
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/id.p12" -k "$keychain" -P "$keychain_password" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
leaf=$(openssl x509 -in "$work/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f')
echo "Created the signing identity \"$name\" in $keychain"
echo "Backup: $backup"
echo "Backup password: $secrets/backup-password"
echo "WAFFLE_SIGN_LEAF=$leaf"
