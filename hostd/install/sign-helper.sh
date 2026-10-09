#!/usr/bin/env bash
# Sign a strad-hostd helper with a STABLE identity.
#
#   ./install/sign-helper.sh <path-to-binary> [--identity "Developer ID Application: …"] \
#                            [--identifier com.strad.hostd-messages]
#
# Both helpers go through it: strad-hostd-ax (the default identifier) and
# strad-hostd-messages. The identifier is part of the designated requirement,
# so each keeps its own grants — Full Disk Access granted to one is not
# granted to the other.
#
# macOS keys the Accessibility, Screen Recording and Full Disk Access grants on the code
# signature's designated requirement. An ad-hoc signature (`codesign -s -`)
# has no certificate, so its requirement is the binary's own hash and every
# rebuild is a different program that has to be granted again. A signature
# from a certificate — any certificate, including a self-signed one that lives
# only in this Mac's login keychain — is recognised across rebuilds.
#
# Identity, in order: --identity, $STRAD_HOSTD_SIGN_IDENTITY, a Developer ID
# Application certificate in the keychain, an existing "strad-hostd-ax"
# certificate (trusted first if an earlier run was cancelled before it was),
# else one is created (openssl → .p12 → login keychain → trusted
# for code signing, which asks for the login password in a dialog). The
# certificate never leaves the machine and signs nothing but this helper.
set -euo pipefail

BINARY="${1:-}"
[ -n "$BINARY" ] || { echo "usage: $0 <binary> [--identity NAME]" >&2; exit 2; }
shift
IDENTITY="${STRAD_HOSTD_SIGN_IDENTITY:-}"
IDENTIFIER="com.strad.hostd-ax"
while [ $# -gt 0 ]; do
  case "$1" in
    --identity) IDENTITY="$2"; shift 2 ;;
    --identifier) IDENTIFIER="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(uname)" = "Darwin" ] || { echo "sign-helper.sh only runs on macOS" >&2; exit 1; }

CERT_NAME="strad-hostd-ax"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

say() { printf '==> %s\n' "$*"; }

if [ -z "$IDENTITY" ]; then
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
    IDENTITY="$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
    say "Signing with the Developer ID certificate in the keychain: $IDENTITY"
  elif security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$CERT_NAME\""; then
    IDENTITY="$CERT_NAME"
    say "Signing with the existing \"$CERT_NAME\" certificate"
  elif security find-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1; then
    # Imported but never trusted: the password dialog below was cancelled, or
    # there was no GUI to show it. `find-identity -v` lists only valid
    # identities, so without this branch a re-run imports a second certificate
    # of the same name and codesign then refuses the name as ambiguous.
    say "Trusting the existing \"$CERT_NAME\" certificate for code signing"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    security find-certificate -c "$CERT_NAME" -p "$KEYCHAIN" > "$TMP/cert.pem"
    security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
    IDENTITY="$CERT_NAME"
  else
    say "Creating a self-signed code-signing certificate named \"$CERT_NAME\" in the login keychain"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    cat > "$TMP/openssl.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $CERT_NAME
[ext]
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
basicConstraints = critical, CA:false
CNF
    openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
      -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/openssl.cnf" >/dev/null 2>&1
    # A throwaway export password: the .p12 exists for the seconds it takes to import it.
    # The algorithms are pinned because `security import` reads only the old
    # PKCS#12 format (3DES, SHA-1 MAC). OpenSSL 3 — Homebrew's, which `brew
    # install node` puts first on PATH — defaults to AES with a SHA-256 MAC, and
    # macOS reports that file as "MAC verification failed (wrong password?)".
    # LibreSSL, macOS's own /usr/bin/openssl, takes the same flags.
    openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/identity.p12" \
      -name "$CERT_NAME" -passout pass:strad-hostd-ax \
      -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
    security import "$TMP/identity.p12" -k "$KEYCHAIN" -P strad-hostd-ax -T /usr/bin/codesign -T /usr/bin/security >/dev/null
    # codesign refuses an identity whose chain it cannot trust. This marks the
    # certificate trusted for code signing, for this user only; macOS asks for
    # the login password in a dialog.
    security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
    IDENTITY="$CERT_NAME"
  fi
fi

say "Signing $BINARY as $IDENTITY"
codesign --force --sign "$IDENTITY" --identifier "$IDENTIFIER" --timestamp=none "$BINARY"
codesign --verify --verbose=2 "$BINARY"
codesign --display --requirements - "$BINARY" 2>&1 | grep -E "designated|identifier" || true
