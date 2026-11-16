/* ScobeTube – Passkey-Hilfen (WebAuthn) */
(() => {
  "use strict";
  const b64uToBuf = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  };
  const bufToB64u = (buf) => {
    let bin = "";
    new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  function creationOptions(json) {
    if (window.PublicKeyCredential && PublicKeyCredential.parseCreationOptionsFromJSON) {
      return PublicKeyCredential.parseCreationOptionsFromJSON(json);
    }
    return {
      ...json,
      challenge: b64uToBuf(json.challenge),
      user: { ...json.user, id: b64uToBuf(json.user.id) },
      excludeCredentials: (json.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
  }

  function requestOptions(json) {
    if (window.PublicKeyCredential && PublicKeyCredential.parseRequestOptionsFromJSON) {
      return PublicKeyCredential.parseRequestOptionsFromJSON(json);
    }
    return {
      ...json,
      challenge: b64uToBuf(json.challenge),
      allowCredentials: (json.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
  }

  function credentialToJSON(cred) {
    if (typeof cred.toJSON === "function") {
      try { return cred.toJSON(); } catch { /* manuell weiter */ }
    }
    const r = cred.response, out = {
      id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: { clientDataJSON: bufToB64u(r.clientDataJSON) },
    };
    if (r.attestationObject) {
      out.response.attestationObject = bufToB64u(r.attestationObject);
      if (r.getTransports) out.response.transports = r.getTransports();
    } else {
      out.response.authenticatorData = bufToB64u(r.authenticatorData);
      out.response.signature = bufToB64u(r.signature);
      if (r.userHandle) out.response.userHandle = bufToB64u(r.userHandle);
    }
    return out;
  }

  const friendlyError = (err) => {
    if (!err) return "Unbekannter Fehler";
    if (err.name === "NotAllowedError") return "Abgebrochen oder Zeit abgelaufen";
    if (err.name === "InvalidStateError") return "Dieser Passkey ist schon für dein Konto gespeichert";
    if (err.name === "SecurityError") return "Passkeys gehen nur über HTTPS (oder localhost)";
    if (err.name === "NotSupportedError") return "Dein Browser oder Gerät unterstützt keine Passkeys";
    return err.message || String(err);
  };

  window.ScobePasskey = {
    available: () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext),
    secure: () => window.isSecureContext,
    async create(optionsJSON) {
      try {
        const cred = await navigator.credentials.create({ publicKey: creationOptions(optionsJSON) });
        return credentialToJSON(cred);
      } catch (err) { throw new Error(friendlyError(err)); }
    },
    async get(optionsJSON) {
      try {
        const cred = await navigator.credentials.get({ publicKey: requestOptions(optionsJSON) });
        return credentialToJSON(cred);
      } catch (err) { throw new Error(friendlyError(err)); }
    },
  };
})();
