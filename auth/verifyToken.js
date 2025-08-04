// auth/verifyToken.js
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const TENANT = 'd048d6e2-6e9f-4af0-afcf-58a5ad036480';
const AUDIENCE = 'api://207b8fba-ea72-43e3-8c90-b3a39e58f5fc';

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
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

  // First: verify signature & audience with JWKS
  jwt.verify(
    token,
    getKey,
    {
      audience: AUDIENCE,
      algorithms: ['RS256'],
      // NOTE: do NOT pass `issuer` here; we'll validate it ourselves below.
    },
    (err, decoded) => {
      if (err) {
        // Log actual issuer to help diagnose
        try {
          const peek = jwt.decode(token) || {};
          console.error('Token verification failed:', err.message, '| iss:', peek.iss, '| tid:', peek.tid, '| ver:', peek.ver);
        } catch (_) {}
        return res.status(403).send('Token verification failed');
      }

      // Additional hard checks: correct tenant + acceptable issuer + v2 if present
      const iss = decoded.iss || '';
      const tid = decoded.tid || '';
      const ver = decoded.ver || '';

      const allowedIssuers = new Set([
        `https://login.microsoftonline.com/${TENANT}/v2.0`,
        `https://sts.windows.net/${TENANT}/`,
      ]);

      const issuerOk = allowedIssuers.has(iss);
      const tenantOk = tid === TENANT;

      if (!tenantOk || !issuerOk || (ver && ver !== '2.0')) {
        console.error('Issuer/tenant/version check failed', { iss, tid, ver });
        return res.status(403).send('Token issuer/tenant invalid');
      }

      req.user = decoded; // preferred_username, name, oid, etc.
      next();
    }
  );
}
