// auth/verifyToken.js
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

//
// === Your tenant & API app settings ===
//
const TENANT_ID = 'd048d6e2-6e9f-4af0-afcf-58a5ad036480';                  // Azure AD tenant
const API_APP_ID = '207b8fba-ea72-43e3-8c90-b3a39e58f5fc';                 // Backend App Registration (Application (client) ID)
const API_APP_URI = `api://${API_APP_ID}`;                                 // App ID URI (Expose an API)

//
// Accept both v2 and v1 issuers (the signing keys are the same)
//
const ACCEPTED_ISSUERS = [
  `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
  `https://sts.windows.net/${TENANT_ID}/`,
];

//
// Accept both GUID and api:// GUID as audience
//
const ACCEPTED_AUDIENCES = [
  API_APP_ID,
  API_APP_URI,
  `${API_APP_URI}/.default`,
];

//
// JWKS (v2 endpoint works for both; shares keys with v1)
//
const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

export default function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Missing or invalid token');
  }

  const token = authHeader.slice('Bearer '.length);

  jwt.verify(
    token,
    getKey,
    {
      algorithms: ['RS256'],
      issuer: ACCEPTED_ISSUERS,
      audience: ACCEPTED_AUDIENCES,
      ignoreExpiration: false,
    },
    (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(403).send('Token verification failed');
      }

      // Optional diagnostics you can keep for now:
      if (decoded?.iss && !ACCEPTED_ISSUERS.includes(decoded.iss)) {
        console.warn('Issuer/tenant/version check (diagnostic):', {
          iss: decoded.iss,
          tid: decoded.tid,
          ver: decoded.ver,
        });
      }

      req.user = decoded; // contains oid, tid, ver, upn/preferred_username, etc.
      next();
    }
  );
}
