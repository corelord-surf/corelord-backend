import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: `https://login.microsoftonline.com/d048d6e2-6e9f-4af0-afcf-58a5ad036480/discovery/v2.0/keys`
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, function(err, key) {
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

export default function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Missing or invalid token');
  }

  const token = authHeader.split(' ')[1];

  jwt.verify(token, getKey, {
    audience: 'api://207b8fba-ea72-43e3-8c90-b3a39e58f5fc',
    issuer: 'https://login.microsoftonline.com/d048d6e2-6e9f-4af0-afcf-58a5ad036480/v2.0'
  }, (err, decoded) => {
    if (err) {
      return res.status(403).send('Token verification failed');
    }

    req.user = decoded;
    next();
  });
}
