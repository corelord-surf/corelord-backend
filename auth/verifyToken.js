// auth/verifyToken.js
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const TENANT = 'd048d6e2-6e9f-4af0-afcf-58a5ad036480';
const AUDIENCE = 'api://207b8fba-ea72-43e3-8c90-b3a39e58f5fc';

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 minutes
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
      audience: AUDIENCE,
      issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      algorithms: ['RS256'],
    },
    (err, decoded) => {
      if (err) {
        console.error('Token verification failed:', err.message);
        return res.status(403).send('Token verification failed');
      }
      req.user = decoded; // includes preferred_username, name, oid, etc.
      next();
    }
  );
}
