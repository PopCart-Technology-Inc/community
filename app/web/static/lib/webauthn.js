// WebAuthn JSON <-> browser objects, without a library. The server (@simplewebauthn/server) sends
// options with base64url strings; the browser wants ArrayBuffers, and gives back ArrayBuffers that we
// send as base64url. Pure: tests run these with plain objects.
import { b64urlToBuffer, bytesToB64url } from './b64.js';

const desc = (d) => ({ ...d, id: b64urlToBuffer(d.id) });

/** PublicKeyCredentialCreationOptionsJSON -> options for navigator.credentials.create({ publicKey }). */
export function creationOptionsFromJSON(o) {
  return {
    ...o,
    challenge: b64urlToBuffer(o.challenge),
    user: { ...o.user, id: b64urlToBuffer(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map(desc),
  };
}

/** PublicKeyCredentialRequestOptionsJSON -> options for navigator.credentials.get({ publicKey }). */
export function requestOptionsFromJSON(o) {
  const out = { ...o, challenge: b64urlToBuffer(o.challenge) };
  if (o.allowCredentials) out.allowCredentials = o.allowCredentials.map(desc);
  return out;
}

const b = (v) => (v ? bytesToB64url(v) : undefined);

/** A PublicKeyCredential (registration or authentication) -> the JSON the server verifies. */
export function credentialToJSON(cred) {
  const r = cred.response || {};
  const response = { clientDataJSON: b(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = b(r.attestationObject);
    if (typeof r.getTransports === 'function') response.transports = r.getTransports();
    if (typeof r.getPublicKeyAlgorithm === 'function') response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
    if (typeof r.getPublicKey === 'function') { const pk = r.getPublicKey(); if (pk) response.publicKey = b(pk); }
    if (typeof r.getAuthenticatorData === 'function') response.authenticatorData = b(r.getAuthenticatorData());
  } else {
    response.authenticatorData = b(r.authenticatorData);
    response.signature = b(r.signature);
    if (r.userHandle) response.userHandle = b(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: b(cred.rawId),
    type: cred.type,
    response,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {},
  };
}
