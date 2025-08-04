// db.js
import sql from 'mssql';

// Azure SQL config for your server & DB
const config = {
  user: 'sqladmin',
  password: '6dHAy!g#qa^tSuBR',
  server: 'corelord-sqlserver.database.windows.net',
  database: 'CoreLordDB',
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
};

// Create and share one connection pool across the app
const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log('Connected to SQL database');
    return pool;
  })
  .catch((err) => {
    console.error('SQL connection error:', err);
    throw err;
  });

export { sql, poolPromise };
