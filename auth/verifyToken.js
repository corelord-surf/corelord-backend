// auth/verifyToken.js
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const TENANT = 'd048d6e2-6e9f-4af0-afcf-58a5ad036480';
const API_APP_ID = '207b8fba-ea72-43e3-8c90-b3a39e58f5fc'; // your API app (client) ID

// Accept both audience forms that AAD may issue
const AUDIENCES = [
  `api://${API_APP_ID}`,
  API_APP_ID
];

// Accept both v2 and v1 issuers
const ISSUERS = [
  `https://login.microsoftonline.com/${TENANT}/v2.0`,
  `https://sts.windows.net/${TENANT}/`
];

// JWKS (works for both v1 & v2 tokens)
const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

export default function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).send('Missing or invalid token');
  }

  const token = auth.slice('Bearer '.length);

  jwt.verify(
    token,
    getKey,
    {
      algorithms: ['RS256'],
      audience: AUDIENCES,
      issuer: ISSUERS,
      clockTolerance: 5 // seconds
    },
    (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(403).send('Token verification failed');
      }

      // Optional: enforce the scope your SPA requests
      // v2 = 'scp', v1 = 'roles'
      const scp = decoded.scp || '';
      const roles = decoded.roles || [];
      const hasScope =
        (typeof scp === 'string' && scp.split(' ').includes('user_impersonation')) ||
        (Array.isArray(roles) && roles.includes('user_impersonation'));

      if (!hasScope) {
        return res.status(403).send('Required scope missing');
      }

      req.user = decoded;
      next();
    }
  );
}
